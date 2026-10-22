import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('acceptance', Path(__file__).resolve().parents[1] / 'scripts/orca-notify-acceptance.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


class AcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.d = Path(self.temp.name)
        self.c = a.m.load(a.ROOT / 'config/orca-observer-notify.test.json')
        self.c.update(triggerLine='ORCA-OBSERVER-CHANGE-synthetic', baselineSha256='a' * 64)
        for key, handle in [('senderIdentity', self.c['sender']), ('receiverIdentity', self.c['receiver']), ('observedIdentity', self.c['observedTerminal'])]:
            self.c[key] = {'handle': handle, 'worktreePath': self.c['workspace'], 'leafId': 'synthetic-leaf', 'ptyId': 'synthetic-pty'}
        a.write(self.d / 'prepared.json', self.c)
        a.write(self.d / 'R-preflight.json', {'ok': True, 'configSha256': a.m.digest(self.c)})
        self.body = {'version': 1, 'binding': {k: self.c[k] for k in ['runtimeId', 'workspace', 'observedTerminal']},
                     'baselineSha256': 'a' * 64, 'observedSha256': 'b' * 64, 'state': 'pending_verification',
                     'approvalIssued': False, 'canCompleteTask': False, 'canResume': False,
                     'sourceAuthenticated': False, 'requiresIndependentReview': True,
                     'matchedTestTrigger': True, 'triggerLineSha256': hashlib.sha256(self.c['triggerLine'].encode()).hexdigest()}
        self.eid = a.m.digest([a.m.digest(self.c), self.body])
        self.message = {'id': 'msg_synthetic1', 'from_handle': self.c['sender'], 'to_handle': self.c['receiver'],
                        'run_id': self.c['runId'], 'type': 'status', 'subject': 'ORCA-CHANGE-UNVERIFIED:' + self.eid,
                        'body': json.dumps({'eventId': self.eid, **self.body})}
        with a.m.journal(str(self.d / 'outbox'), self.c) as db:
            db.execute('INSERT INTO events(id,body,state,message_id) VALUES (?,?,?,?)', (self.eid, json.dumps(self.body), 'enqueued', self.message['id']))
            receipt = {'ok': True, '_meta': {'runtimeId': self.c['runtimeId']}, 'result': {'message': self.message}}
            db.execute('INSERT INTO send_receipts VALUES (?,?)', (self.eid, json.dumps(receipt)))
            db.commit()
        self.raw = {'ok': True, '_meta': {'runtimeId': self.c['runtimeId']}, 'result': {
            'count': 1, 'messages': [self.message], 'deliveryId': 'delivery_synthetic1',
            'timedOut': False, 'cancelled': False, 'connectionLost': False}}
        a.write(self.d / 'R-wait.json', self.raw)
        (self.d / 'R-wait.stderr.txt').write_text(json.dumps({'_keepalive': True, 'elapsedMs': 15001}) + '\n')
        (self.d / 'R-wait.exit.txt').write_text('0\n')

    def test_five_stage_report_stays_pending_until_real_ack_file(self):
        result = a.verify_delivery(str(self.d))
        self.assertEqual(result['messageId'], self.message['id'])
        self.assertEqual(result['ack'], 'not yet confirmed by this check')
        report = a.report(str(self.d))['stages']
        self.assertEqual(report['ack'], 'pending')
        self.assertEqual(report['modelWake'], 'not tested')

    def test_report_keeps_enqueue_proof_when_receive_file_is_missing(self):
        (self.d / 'R-wait.json').unlink()
        result = a.report(str(self.d))['stages']
        self.assertEqual(result['enqueue'], 'native success receipt matches message')
        self.assertEqual(result['blockingReceive'], 'pending')
        self.assertEqual(result['ack'], 'pending')

    def test_unexpected_second_message_refuses_ack_before_native_mutation(self):
        self.raw['result']['count'] = 2
        self.raw['result']['messages'].append({'id': 'msg_foreign'})
        (self.d / 'R-wait.json').write_text(json.dumps(self.raw))
        with patch.object(a.m, 'PublicCLI') as cli, patch.object(a.m.Bridge, 'check'):
            with self.assertRaisesRegex(RuntimeError, 'UNEXPECTED_DELIVERY'):
                a.ack(str(self.d))
            cli.return_value.assert_not_called()
        self.assertFalse((self.d / 'R-ack-attempt.json').exists())

    def test_wrong_sender_unknown_wait_and_missing_keepalive_stop(self):
        for change in ['sender', 'timeout', 'keepalive']:
            raw = json.loads(json.dumps(self.raw))
            if change == 'sender':
                raw['result']['messages'][0]['from_handle'] = 'term_00000000-0000-0000-0000-00000000000c'
            elif change == 'timeout':
                raw['result']['timedOut'] = True
            else:
                (self.d / 'R-wait.stderr.txt').write_text('')
            (self.d / 'R-wait.json').write_text(json.dumps(raw))
            with self.assertRaises(RuntimeError):
                a.verify_delivery(str(self.d))

    def test_ack_exact_delivery_once_and_never_confirms_returned_extra_batch(self):
        calls = []
        def native(args):
            calls.append(args)
            return {'ok': True, '_meta': {'runtimeId': self.c['runtimeId']},
                    'result': {'deliveryId': 'delivery_other', 'messages': [{'id': 'msg_foreign'}], 'count': 1}}
        with patch.object(a.m, 'PublicCLI', return_value=native), patch.object(a.m.Bridge, 'check'):
            result = a.ack(str(self.d))
            self.assertFalse(result['finalMailboxEmpty'])
            with self.assertRaises(FileExistsError):
                a.ack(str(self.d))
        self.assertEqual(calls, [['orchestration', 'check', '--run', self.c['runId'], '--ack', 'delivery_synthetic1']])

    def test_shadow_sender_config_refused_and_no_live_calls(self):
        c = {**self.c, 'sender': 'term_00000000-0000-0000-0000-00000000000c'}
        with patch.object(a.m, 'PublicCLI') as cli:
            with self.assertRaisesRegex(RuntimeError, 'TARGET_MISMATCH'):
                a.exact(c)
            cli.assert_not_called()

    def test_setup_cannot_allocate_second_directory_under_same_authorization(self):
        (self.d / 'config').mkdir()
        (self.d / 'outputs').mkdir()
        candidate = {**self.c}
        (self.d / 'config/orca-observer-notify.test.json').write_text(json.dumps(candidate))
        a.write(self.d / 'outputs/observer-acceptance-once-20261018.json', {'evidenceDir': 'synthetic-existing'})
        with patch.object(a, 'ROOT', self.d), patch.object(a.m, 'PublicCLI'), patch.object(a.m.Bridge, 'prepare') as prepare:
            with self.assertRaisesRegex(RuntimeError, 'ALREADY_HAS_AN_EVIDENCE'):
                a.setup()
            prepare.assert_not_called()


if __name__ == '__main__':
    unittest.main()
