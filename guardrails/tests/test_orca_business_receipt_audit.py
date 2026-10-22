import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('audit', Path(__file__).parents[1] / 'scripts/orca-business-receipt-audit.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ReceiptAudit(unittest.TestCase):
    def setUp(self):
        self.expected = dict(runtimeId='synthetic-runtime', dispatchId='synthetic-dispatch',
                             taskId='synthetic-task', runId='synthetic-run', terminalHandle='synthetic-terminal')
        self.receipt = {'ok': True, '_meta': {'runtimeId': 'synthetic-runtime'}, 'result': {'dispatch': {
            'id': 'synthetic-dispatch', 'task_id': 'synthetic-task', 'run_id': 'synthetic-run',
            'assignee_handle': 'synthetic-terminal'}}}

    def test_matching_receipt_cannot_enable_business(self):
        result = m.audit(self.receipt, self.expected)
        self.assertFalse(result['businessReady'])
        self.assertFalse(result['runtimeQueried'])
        self.assertTrue(result['remainingEvidence'])

    def test_each_identity_mismatch_refused(self):
        for key in self.expected:
            with self.subTest(key=key), self.assertRaises(ValueError):
                m.audit(self.receipt, {**self.expected, key: 'different'})

    def test_worker_show_aliases_not_guessed(self):
        self.receipt['result']['dispatch'] = dict(id='synthetic-dispatch', taskId='synthetic-task',
                                                runId='synthetic-run', assigneeHandle='synthetic-terminal')
        with self.assertRaises(ValueError):
            m.audit(self.receipt, self.expected)

    def test_null_dispatch_and_failed_receipt_refused(self):
        self.receipt['result']['dispatch'] = None
        with self.assertRaises(ValueError):
            m.audit(self.receipt, self.expected)

    def test_two_step_inspector_exact_operations_and_remaining_gates(self):
        spec = importlib.util.spec_from_file_location('observer_inspection', Path(__file__).parents[1] / 'scripts/orca-observer-notify.py')
        observer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(observer)
        expected = {**self.expected, 'workspacePath': '/synthetic/business', 'leafId': 'leaf', 'ptyId': 'pty'}
        terminal = {'ok': True, '_meta': self.receipt['_meta'], 'result': {'terminal': {
            'handle': expected['terminalHandle'], 'worktreePath': expected['workspacePath'],
            'connected': True, 'leafId': 'leaf', 'ptyId': 'pty'}}}
        calls = []
        def call(args):
            calls.append(args)
            if args == ['orchestration', 'dispatch-show', '--task', expected['taskId']]:
                return self.receipt
            if args == ['terminal', 'show', '--terminal', expected['terminalHandle']]:
                return terminal
            self.fail('Unexpected operation: ' + repr(args))
        result = observer.inspect_business_mapping(expected, call)
        self.assertEqual(len(calls), 2)
        self.assertTrue(result['terminalFieldsMatched'])
        self.assertFalse(result['businessReady'])
        self.assertFalse(result['generationVerified'])
        self.assertFalse(result['atomicSnapshot'])
        for field in ['handle', 'worktreePath', 'leafId', 'ptyId', 'connected']:
            with self.subTest(field=field):
                saved = terminal['result']['terminal'][field]
                terminal['result']['terminal'][field] = False if field == 'connected' else 'drift'
                with self.assertRaises(ValueError):
                    observer.inspect_business_mapping(expected, call)
                terminal['result']['terminal'][field] = saved
        calls.clear()
        self.receipt['result']['dispatch']['id'] = 'superseded'
        with self.assertRaises(ValueError):
            observer.inspect_business_mapping(expected, call)
        self.assertEqual(len(calls), 1)

    def test_terminal_wrong_runtime_and_missing_expected_pin_refused(self):
        terminal = {'ok': True, '_meta': {'runtimeId': 'wrong'}, 'result': {}}
        with self.assertRaisesRegex(ValueError, 'TERMINAL_RUNTIME'):
            m.audit_pair(self.receipt, terminal, self.expected)
        self.receipt['ok'] = False
        with self.assertRaises(ValueError):
            m.audit(self.receipt, self.expected)
