import contextlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('wiring', Path(__file__).resolve().parents[1] / 'scripts/orca-observer-notify.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
ROOT = Path(__file__).resolve().parents[1]


class Fake:
    def __init__(self, c):
        self.c, self.calls = c, []
        self.text = 'working'
        self.send_result = None
        self.query_state = 'pending'
        self.drift = False

    def __call__(self, args):
        self.calls.append(args)
        c = self.c
        meta = {'runtimeId': c['runtimeId']}
        if args[:2] == ['terminal', 'show']:
            handle = args[3]
            result = {'terminal': {'handle': handle, 'worktreePath': c['workspace'],
                       'connected': True, 'leafId': handle + '-leaf', 'ptyId': 'replacement' if self.drift else handle + '-pty'}}
        elif args[:2] == ['terminal', 'read']:
            result = {'terminal': {'handle': c['observedTerminal'], 'tail': [self.text]}}
        elif args[:2] == ['orchestration', 'run-show']:
            result = {'run': {'id': c['runId'], 'coordinator_handle': c['receiver'], 'consumer_generation': c['consumerGeneration']}}
        elif args[:2] == ['orchestration', 'send']:
            if self.send_result is not None:
                return self.send_result
            result = {'message': {'id': 'msg_synthetic1'}}
        elif args[:2] == ['orchestration', 'request-show']:
            result = {'requestId': args[3], 'state': self.query_state, 'method': 'orchestration.send'}
        else:
            raise AssertionError('Forbidden public operation: ' + repr(args))
        return {'ok': True, 'result': result, '_meta': meta}


class WiringTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = str(Path(self.temp.name) / 'journal')
        self.candidate = json.loads((ROOT / 'config/orca-observer-notify.test.json').read_text())
        self.fake = Fake(self.candidate)
        self.c = m.Bridge(self.candidate, self.fake).prepare()
        self.b = m.Bridge(self.c, self.fake)
        self.grant = {'version': 1, 'configSha256': m.digest(self.c), 'authorizeOneStatusMessage': True}
        self.fake.calls.clear()

    def sends(self):
        return [x for x in self.fake.calls if x[:2] == ['orchestration', 'send']]

    def test_prepare_reads_exact_native_schema_and_pins_parties(self):
        self.assertEqual(self.c['observedIdentity']['handle'], self.c['sender'])
        self.assertIsNotNone(self.c['baselineSha256'])
        self.assertEqual(self.sends(), [])

    def test_no_change_never_sends(self):
        with m.journal(self.directory, self.c) as db:
            for _ in range(3):
                r = m.notify_once(self.c, self.b, db, self.c['baselineSha256'], self.grant)
                self.assertEqual(r['event'], 'no_change')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM events').fetchone()[0], 0)
        self.assertEqual(self.sends(), [])

    def test_approval_prompt_only_produces_unverified_metadata_once(self):
        self.fake.text = 'Approve? DONE'
        observed = self.b.read_digest()
        with m.journal(self.directory, self.c) as db:
            r = m.notify_once(self.c, self.b, db, observed, self.grant)
            self.assertEqual(r['event'], 'enqueued')
            self.assertFalse(r['recipientReadOrModelWakeVerified'])
        args = self.sends()[0]
        body = json.loads(args[args.index('--body') + 1])
        self.assertFalse(body['approvalIssued'])
        self.assertFalse(body['canResume'])
        self.assertFalse(body['canCompleteTask'])
        self.assertNotIn('Approve?', json.dumps(body))
        self.assertNotIn('--from', args)
        self.assertNotIn('--retry-request', args)
        self.assertEqual(args[args.index('--to') + 1], 'run:' + self.c['runId'])
        with m.journal(self.directory, self.c) as db:
            self.assertEqual(m.notify_once(self.c, self.b, db, observed, self.grant)['event'], 'duplicate_suppressed')
            with self.assertRaisesRegex(RuntimeError, 'ONE_MESSAGE'):
                m.notify_once(self.c, self.b, db, 'f' * 64, self.grant)
        self.assertEqual(len(self.sends()), 1)

    def test_missing_grant_does_not_publish_or_send(self):
        with m.journal(self.directory, self.c) as db:
            with self.assertRaisesRegex(RuntimeError, 'AUTHORIZATION'):
                m.notify_once(self.c, self.b, db, 'a' * 64, {})
            self.assertEqual(db.execute('SELECT COUNT(*) FROM events').fetchone()[0], 0)
        self.assertEqual(self.sends(), [])

    def test_cancel_before_send_retains_pending_and_cannot_dispatch_on_restart(self):
        with m.journal(self.directory, self.c) as db:
            self.assertEqual(m.notify_once(self.c, self.b, db, 'a' * 64, self.grant, lambda: True)['event'], 'cancelled_before_send')
        with m.journal(self.directory, self.c) as db:
            self.assertEqual(m.notify_once(self.c, self.b, db, 'a' * 64, self.grant)['event'], 'duplicate_suppressed')
        self.assertEqual(self.sends(), [])

    def test_timeout_original_request_query_never_resends_even_completed(self):
        self.fake.send_result = {'ok': False, 'error': {'code': 'runtime_timeout', 'data': {'orchestrationRequestId': 'synthetic-original-request'}}}
        with m.journal(self.directory, self.c) as db:
            r = m.notify_once(self.c, self.b, db, 'a' * 64, self.grant)
            self.assertEqual(r['requestId'], 'synthetic-original-request')
        for state in ['pending', 'absent', 'completed']:
            self.fake.query_state = state
            with m.journal(self.directory, self.c) as db:
                self.assertEqual(m.recover(self.c, self.b, db)[0]['queryState'], state)
                self.assertEqual(db.execute('SELECT state FROM events').fetchone()[0], 'unknown')
        self.assertEqual(len(self.sends()), 1)
        self.assertTrue(all('--retry-request' not in x for x in self.fake.calls))

    def test_lost_receipt_and_crash_after_claim_without_id_are_human_only(self):
        self.fake.send_result = {'ok': False, 'error': {'code': 'LOCAL_PROCESS_OUTCOME_UNKNOWN'}}
        with m.journal(self.directory, self.c) as db:
            m.notify_once(self.c, self.b, db, 'a' * 64, self.grant)
            db.execute("UPDATE events SET state='sending'")
            db.commit()
        with m.journal(self.directory, self.c) as db:
            r = m.recover(self.c, self.b, db)
            self.assertEqual(r[0]['action'], 'HUMAN_RECONCILIATION_NO_ORIGINAL_REQUEST_ID')
            m.notify_once(self.c, self.b, db, 'a' * 64, self.grant)
        self.assertEqual(len(self.sends()), 1)

    def test_recipient_generation_drift_and_pty_replacement_block(self):
        self.fake.drift = True
        with self.assertRaisesRegex(RuntimeError, 'PTY_REPLACED'):
            self.b.read_digest()
        self.fake.drift = False
        bad = {**self.c, 'consumerGeneration': 2}
        with self.assertRaisesRegex(RuntimeError, 'RECIPIENT_RUN'):
            m.Bridge(bad, self.fake).read_digest()
        self.assertEqual(self.sends(), [])

    def test_changed_config_cannot_rebind_existing_journal(self):
        with m.journal(self.directory, self.c):
            pass
        with self.assertRaisesRegex(RuntimeError, 'NO_AUTOMATIC_REBIND'):
            with m.journal(self.directory, {**self.c, 'runId': 'run_other'}):
                pass

    def test_concurrent_observer_refused_without_removing_other_locks(self):
        Path(self.temp.name, 'business.lock').write_text('frozen')
        with m.journal(self.directory, self.c):
            with self.assertRaisesRegex(RuntimeError, 'ALREADY_RUNNING'):
                with m.journal(self.directory, self.c):
                    pass
        self.assertEqual(Path(self.temp.name, 'business.lock').read_text(), 'frozen')

    def test_business_scope_refused_until_authoritative_dispatch_adapter_exists(self):
        with self.assertRaisesRegex(RuntimeError, 'BUSINESS_DISPATCH_MAPPING'):
            m.validate({**self.c, 'scope': 'business'})

    def test_crash_inside_send_keeps_durable_claim_and_never_reinvokes(self):
        def crash(args):
            if args[:2] == ['orchestration', 'send']:
                raise RuntimeError('PROCESS_DIED_BEFORE_REQUEST_ID_RETAINED')
            return self.fake(args)
        with m.journal(self.directory, self.c) as db:
            with self.assertRaisesRegex(RuntimeError, 'PROCESS_DIED'):
                m.notify_once(self.c, m.Bridge(self.c, crash), db, 'a' * 64, self.grant)
        with m.journal(self.directory, self.c) as db:
            self.assertEqual(db.execute('SELECT state FROM events').fetchone()[0], 'sending')
            self.assertEqual(m.notify_once(self.c, self.b, db, 'a' * 64, self.grant)['event'], 'duplicate_suppressed')
            self.assertIn('NO_ORIGINAL_REQUEST_ID', m.recover(self.c, self.b, db)[0]['action'])
        self.assertEqual(self.sends(), [])

    def test_drift_during_read_and_wrong_runtime_fail_before_send(self):
        def drift(args):
            value = self.fake(args)
            if args[:2] == ['terminal', 'read']:
                self.fake.drift = True
            return value
        with self.assertRaisesRegex(RuntimeError, 'PTY_REPLACED'):
            m.Bridge(self.c, drift).read_digest()
        self.fake.drift = False
        def wrong_runtime(args):
            return {**self.fake(args), '_meta': {'runtimeId': 'other-runtime'}}
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_ID_MISMATCH'):
            m.Bridge(self.c, wrong_runtime).read_digest()
        self.assertEqual(self.sends(), [])

    def test_live_entry_refuses_sandbox_and_wrong_sender_no_subprocess(self):
        with patch.object(m.subprocess, 'run') as execute:
            with patch.dict(os.environ, {'CODEX_SANDBOX': 'seatbelt'}):
                with self.assertRaisesRegex(RuntimeError, 'SANDBOX'):
                    m.PublicCLI(self.c)
            with patch.dict(os.environ, {'ORCA_TERMINAL_HANDLE': 'wrong'}, clear=True):
                with self.assertRaisesRegex(RuntimeError, 'SENDERS_OWN'):
                    m.PublicCLI(self.c)
            execute.assert_not_called()

    def test_wait_timeout_and_cancellation_never_send_or_publish(self):
        now = [0.0]
        def sleep(seconds):
            now[0] += seconds
        with m.journal(self.directory, self.c) as db:
            r = m.watch_once(self.c, self.b, db, self.grant, 1000, 2000, lambda: False, lambda: now[0], sleep)
            self.assertEqual(r['event'], 'timeout_no_change')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM events').fetchone()[0], 0)
            r = m.watch_once(self.c, self.b, db, self.grant, 1000, 2000, lambda: True)
            self.assertEqual(r['event'], 'cancelled')
        self.assertEqual(self.sends(), [])

    def test_late_changed_read_after_deadline_is_not_sent(self):
        now = [0.0]
        class Late:
            def read_digest(self):
                now[0] = 10.0
                return 'a' * 64
        with m.journal(self.directory, self.c) as db:
            r = m.watch_once(self.c, Late(), db, self.grant, 1000, 2000, lambda: False, lambda: now[0])
            self.assertTrue(r['lateReadIgnored'])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM events').fetchone()[0], 0)
        self.assertEqual(self.sends(), [])

    def test_trigger_line_gate_ignores_startup_echo_then_allows_exact_line(self):
        marker = 'ORCA-OBSERVER-CHANGE-synthetic-test'
        c = {**self.c, 'triggerLine': marker}
        b = m.Bridge(c, self.fake)
        grant = {'version': 1, 'configSha256': m.digest(c), 'authorizeOneStatusMessage': True}
        self.fake.text = 'prompt> launch command ' + marker
        now = [0.0]
        def sleep(seconds):
            now[0] += seconds
        with m.journal(str(Path(self.temp.name) / 'trigger'), c) as db:
            r = m.watch_once(c, b, db, grant, 1000, 2000, lambda: False, lambda: now[0], sleep)
            self.assertEqual(r['event'], 'timeout_no_change')
            self.assertEqual(self.sends(), [])
            self.fake.text = 'working\n' + marker + '\nprompt'
            now[0] = 0.0
            r = m.watch_once(c, b, db, grant, 1000, 2000, lambda: False, lambda: now[0], sleep)
            self.assertEqual(r['event'], 'enqueued')
            native = json.loads(db.execute('SELECT receipt FROM send_receipts').fetchone()[0])
            self.assertEqual(native['result']['message']['id'], r['messageId'])
        self.assertEqual(len(self.sends()), 1)

    def test_prepare_rejects_preexisting_test_trigger(self):
        marker = 'ORCA-OBSERVER-CHANGE-synthetic-test'
        self.fake.text = marker
        with self.assertRaisesRegex(RuntimeError, 'ALREADY_PRESENT'):
            m.Bridge({**self.candidate, 'triggerLine': marker}, self.fake).prepare()


if __name__ == '__main__':
    unittest.main()
