#!/usr/bin/env python3
"""Offline dispatch-show receipt audit. Never enables business observation."""
import argparse
import json
from pathlib import Path


def audit(receipt, expected):
    if receipt.get('ok') is not True:
        raise ValueError('SUCCESS_RECEIPT_REQUIRED')
    if not expected.get('runtimeId') or receipt.get('_meta', {}).get('runtimeId') != expected['runtimeId']:
        raise ValueError('RUNTIME_MISMATCH')
    dispatch = receipt.get('result', {}).get('dispatch')
    if not isinstance(dispatch, dict):
        raise ValueError('RAW_DISPATCH_SHOW_REQUIRED')
    # Installed dispatchShow returns its raw DB context; workerShow has a
    # different shape and can mutate start/stop-unknown state after a restart.
    fields = {'id': 'dispatchId', 'task_id': 'taskId', 'run_id': 'runId',
              'assignee_handle': 'terminalHandle'}
    for raw, key in fields.items():
        if not isinstance(expected.get(key), str) or not expected[key] or dispatch.get(raw) != expected[key]:
            raise ValueError('EXACT_MAPPING_MISMATCH:' + key)
    return {'mode': 'offline_review_only', 'dispatchFieldsMatched': True,
            'businessReady': False, 'runtimeQueried': False,
            'remainingEvidence': [
                'fresh run coordinator and consumer_generation receipt',
                'authoritative worker attempt/generation definition and read-only query contract',
                'fresh terminal workspace/leafId/ptyId and dispatch process ownership mapping',
                'sender identity, separate notification target and explicit operation authorization'],
            'note': 'Matching retained fields neither authenticates their author nor proves current runtime state.'}


def audit_pair(dispatch_receipt, terminal_receipt, expected):
    result = audit(dispatch_receipt, expected)
    if terminal_receipt.get('ok') is not True:
        raise ValueError('TERMINAL_SUCCESS_RECEIPT_REQUIRED')
    if terminal_receipt.get('_meta', {}).get('runtimeId') != expected['runtimeId']:
        raise ValueError('TERMINAL_RUNTIME_MISMATCH')
    terminal = terminal_receipt.get('result', {}).get('terminal')
    if not isinstance(terminal, dict) or terminal.get('connected') is not True:
        raise ValueError('CONNECTED_TERMINAL_REQUIRED')
    for raw, key in {'handle': 'terminalHandle', 'worktreePath': 'workspacePath',
                     'leafId': 'leafId', 'ptyId': 'ptyId'}.items():
        if not isinstance(expected.get(key), str) or not expected[key] or terminal.get(raw) != expected[key]:
            raise ValueError('EXACT_TERMINAL_MAPPING_MISMATCH:' + key)
    result.update(terminalFieldsMatched=True, atomicSnapshot=False,
                  generationVerified=False, processOwnershipVerified=False)
    result['remainingEvidence'] = [
        'fresh run coordinator and consumer_generation receipt',
        'authoritative worker attempt/generation definition and read-only query contract',
        'dispatch process ownership and read/send window revalidation contract',
        'sender identity, separate notification target and explicit operation authorization']
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('receipt', help='retained native dispatch-show JSON; never a history scan')
    parser.add_argument('expected', help='operator mapping from the authorized new dispatch receipt')
    parser.add_argument('--terminal-receipt', help='retained native terminal-show JSON; enables two-receipt audit')
    args = parser.parse_args()
    try:
        receipt = json.loads(Path(args.receipt).read_text())
        expected = json.loads(Path(args.expected).read_text())
        result = (audit_pair(receipt, json.loads(Path(args.terminal_receipt).read_text()), expected)
                  if args.terminal_receipt else audit(receipt, expected))
        print(json.dumps(result, ensure_ascii=False))
    except (ValueError, OSError, TypeError, AttributeError) as error:
        print(json.dumps({'ok': False, 'businessReady': False, 'error': str(error)}))
        raise SystemExit(1)
