import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('phase1', Path(__file__).parents[1] / 'scripts/collaboration_phase1.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class PhaseOne(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.task = {'id': 'SYNTHETIC-TASK', 'revision': 5, 'status': 'DOING',
                     'orcaBinding': {'revision': '4'}, 'orcaBaseline': {'hash': 'synthetic'}}
        self.original = json.dumps(self.task).encode()
        self.packet = {'purpose': 'HISTORICAL_RECONCILIATION_PROPOSAL_ONLY',
                       'sourceAuthenticated': False, 'canCompleteTask': False,
                       'subjects': {'taskId': self.task['id'], 'taskRevision': 5,
                                    'sourceTaskSha256': hashlib.sha256(self.original).hexdigest()},
                       'unresolvedGaps': ['SYNTHETIC_REVISION_GAP', 'SYNTHETIC_CLI_REVIEW']}
        self.decision = {'purpose': 'ISOLATED_HISTORICAL_CLOSURE_DECISION',
                         'operationId': 'synthetic-operation', 'operator': 'synthetic-operator',
                         'packetDigest': m.digest(self.packet), 'acceptedGaps': self.packet['unresolvedGaps']}
        self.ledger = m.IsolatedHistoricalLedger(self.root / 'isolated')
        self.addCleanup(self.ledger.close)

    def commit(self, decision=None, fault=lambda point: None, reader=None):
        return self.ledger.commit(self.packet, decision or self.decision, reader or (lambda: self.original), fault)

    def counts(self):
        return [self.ledger.db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0]
                for table in ['records', 'outbox', 'projected_events']]

    def test_commit_and_replay_preserve_source_and_result_type(self):
        committed = self.commit()
        self.assertEqual(committed['state'], 'committed')
        self.assertEqual(self.commit()['state'], 'same_commit')
        self.assertEqual(self.counts(), [1, 1, 0])
        saved = json.loads(self.ledger.db.execute('SELECT record FROM records').fetchone()[0])
        self.assertEqual(saved['sourceTask'], self.task)
        self.assertEqual(saved['type'], 'HISTORICAL_CLOSED_WITH_GAPS')
        self.assertFalse(saved['agenthubTaskCompleted'])
        self.assertFalse(saved['normalAcceptancePassed'])

    def test_every_precommit_failure_rolls_back_record_and_outbox(self):
        for point in ['before_insert', 'after_record', 'before_commit']:
            def crash(actual):
                if actual == point:
                    raise RuntimeError('synthetic crash')
            with self.subTest(point=point), self.assertRaises(RuntimeError):
                self.commit(fault=crash)
            self.assertEqual(self.counts(), [0, 0, 0])

    def test_lost_receipt_and_reopen_do_not_create_second_commit(self):
        def crash(point):
            if point == 'after_commit':
                raise RuntimeError('lost receipt')
        with self.assertRaises(RuntimeError):
            self.commit(fault=crash)
        self.ledger.db.close()
        self.ledger.db = sqlite3.connect(self.ledger.database)
        self.assertEqual(self.commit()['state'], 'same_commit')
        self.assertEqual(self.counts(), [1, 1, 0])

    def test_projection_crash_and_duplicate_are_atomic(self):
        event = self.commit()['eventId']
        def crash(point):
            raise RuntimeError('projection crash')
        with self.assertRaises(RuntimeError):
            self.ledger.project(event, crash)
        self.assertEqual(self.counts(), [1, 1, 0])
        self.assertEqual(self.ledger.db.execute('SELECT projected FROM outbox').fetchone()[0], 0)
        self.ledger.project(event)
        self.ledger.project(event)
        self.assertEqual(self.counts(), [1, 1, 1])

    def test_source_drift_before_or_during_commit_refused(self):
        with self.assertRaisesRegex(ValueError, 'CAS'):
            self.commit(reader=lambda: b'changed')
        reads = [self.original, b'changed']
        with self.assertRaisesRegex(ValueError, 'SOURCE_CHANGED'):
            self.commit(reader=lambda: reads.pop(0))
        self.assertEqual(self.counts(), [0, 0, 0])

    def test_decision_and_gap_mutations_refused(self):
        for key, value in [('acceptedGaps', []), ('packetDigest', 'wrong'), ('operator', '')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.commit(decision={**self.decision, key: value})
        self.assertEqual(self.counts(), [0, 0, 0])

    def test_second_operation_for_same_task_refused(self):
        self.commit()
        with self.assertRaisesRegex(ValueError, 'CONFLICT'):
            self.commit(decision={**self.decision, 'operationId': 'second-operation'})
        self.assertEqual(self.counts(), [1, 1, 0])

    def test_snapshot_preserves_exact_bytes_and_does_not_reconstruct_revision(self):
        source = self.root / 'task.json'
        source.write_bytes(self.original)
        target = self.root / 'snapshots'
        target.mkdir()
        result = m.snapshot_task(source, target, 5)
        self.assertEqual(Path(result['path']).read_bytes(), self.original)
        self.assertEqual(m.snapshot_task(source, target, 5), result)
        with self.assertRaisesRegex(ValueError, 'REVISION'):
            m.snapshot_task(source, target, 4)
        self.assertEqual(source.read_bytes(), self.original)

    def test_symlink_snapshot_source_rejected(self):
        source = self.root / 'task.json'
        source.write_bytes(self.original)
        link = self.root / 'link.json'
        link.symlink_to(source)
        with self.assertRaises(OSError):
            m.file_bytes(link)

    def test_duplicate_same_scope_blocked_but_new_scope_never_auto_authorized(self):
        report = {'taskId': self.task['id'], 'taskRevision': 5, 'retainedDeliveryCorroborated': True}
        request = {'taskId': self.task['id'], 'intent': 'same_scope'}
        self.assertEqual(m.duplicate_preflight(self.task, report, request)['decision'], 'BLOCK_DUPLICATE_DISPATCH')
        with self.assertRaises(ValueError):
            m.duplicate_preflight(self.task, report, {**request, 'intent': 'repair'})
        result = m.duplicate_preflight(self.task, report, {**request, 'intent': 'repair', 'scopeEvidence': 'synthetic defect'})
        self.assertFalse(result['canDispatch'])
        with self.assertRaisesRegex(ValueError, 'STALE'):
            m.duplicate_preflight(self.task, {**report, 'taskRevision': 4}, request)
