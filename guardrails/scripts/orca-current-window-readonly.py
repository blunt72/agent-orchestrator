#!/usr/bin/env python3
"""Run manually in Terminal.app. Public status/show/read only; no sender identity."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

CLI = os.environ.get('AIHUB_ORCA_CLI', '/Applications/Orca.app/Contents/Resources/bin/orca')
WORKSPACE = os.environ.get('AIHUB_WORKSPACE', '/path/to/orca-workspace')
# Re-read from this session's environment when this preparation was made.
# This is a candidate TARGET, never a caller, sender, worker or dispatch binding.
TARGET = os.environ.get('AIHUB_TARGET_TERMINAL', '')
PROFILE = os.environ.get('AIHUB_ORCA_PROFILE', str(Path.home() / 'Library/Application Support/orca'))


def fail(code):
    raise RuntimeError(code)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['identity', 'read'])
    parser.add_argument('--confirm-mechanism-window')
    args = parser.parse_args()
    if not TARGET.startswith('term_'):
        fail('SET_AIHUB_TARGET_TERMINAL_TO_THE_EXACT_TERMINAL_HANDLE')
    if os.environ.get('CODEX_SANDBOX'):
        fail('RUN_MANUALLY_IN_TERMINAL_APP; DO_NOT_REMOVE_SANDBOX_MARKERS_TO_BYPASS')
    if args.mode == 'read' and args.confirm_mechanism_window != TARGET:
        fail('FIRST_REVIEW_IDENTITY_AND_CONFIRM_EXACT_MECHANISM_WINDOW')
    if args.mode == 'identity' and args.confirm_mechanism_window:
        fail('UNEXPECTED_CONFIRMATION')
    parent = Path(WORKSPACE) / 'outputs'
    directory = Path(tempfile.mkdtemp(prefix='orca-live-readonly-', dir=parent))
    os.chmod(directory, 0o700)
    env = {'HOME': str(Path.home()), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
           'ORCA_USER_DATA_PATH': PROFILE}
    calls = []

    def call(argv):
        calls.append(argv)
        p = subprocess.run([CLI, *argv], env=env, cwd=WORKSPACE,
                           capture_output=True, text=True, timeout=20)
        # Do not retain raw stdout/stderr, terminal body, composer text or secrets.
        try:
            value = json.loads(p.stdout)
        except (ValueError, TypeError):
            fail('PUBLIC_CLI_NON_JSON_RESPONSE')
        if p.returncode != 0 or value.get('ok') is not True:
            fail('PUBLIC_CLI_REFUSED:' + str(value.get('error', {}).get('code', 'unknown')))
        return value

    def status():
        value = call(['status', '--json'])
        r = value.get('result', {}).get('runtime', {})
        if r.get('reachable') is not True or r.get('state') != 'ready' or not r.get('runtimeId'):
            fail('RUNTIME_NOT_VERIFIED_READY')
        return {k: r.get(k) for k in ['reachable', 'state', 'connectionState', 'runtimeId']}

    def show():
        value = call(['terminal', 'show', '--terminal', TARGET, '--json'])
        r = value.get('result', {}).get('terminal', {})
        if r.get('handle') != TARGET or r.get('worktreePath') != WORKSPACE or r.get('connected') is not True:
            fail('EXACT_TERMINAL_OR_WORKSPACE_NOT_VERIFIED')
        return {k: r.get(k) for k in ['handle', 'worktreePath', 'leafId', 'ptyId', 'connected']}

    result = {'mode': args.mode, 'scope': 'CURRENT_MECHANISM_WINDOW_ONLY',
              'target': TARGET, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'modelStarted': False, 'messagesSent': 0, 'approvalsIssued': False,
              'notificationVerified': False, 'businessExecutionAuthorized': False}
    try:
        before_status, before_show = status(), show()
        result.update(runtime=before_status, terminal=before_show)
        if args.mode == 'read':
            value = call(['terminal', 'read', '--terminal', TARGET, '--limit', '80', '--json'])
            terminal = value.get('result', {}).get('terminal', {})
            tail = terminal.get('tail')
            if terminal.get('handle') != TARGET or not isinstance(tail, list) or not all(isinstance(x, str) for x in tail):
                fail('READ_RESPONSE_SHAPE_OR_HANDLE_UNVERIFIED')
            text = '\n'.join(tail)
            result['read'] = {'handle': TARGET, 'verifiedTextField': 'result.terminal.tail',
                              'source': terminal.get('source'), 'rows': len(tail),
                              'textSha256': hashlib.sha256(text.encode()).hexdigest(),
                              'textBytes': len(text.encode()), 'terminalBodyRetained': False,
                              'truncated': terminal.get('truncated'), 'limited': terminal.get('limited')}
            after_show, after_status = show(), status()
            if before_show != after_show or before_status['runtimeId'] != after_status['runtimeId']:
                fail('IDENTITY_DRIFT_RESULT_UNVERIFIABLE')
            result['identityStableAcrossRead'] = True
            result['readInterfaceVerified'] = True
        result['ok'] = True
    except Exception as error:
        # Fixed CLI/runtime error codes only; avoid printing raw subprocess output.
        result.update(ok=False, error=str(error) if isinstance(error, RuntimeError) else type(error).__name__)
    result['publicCliCalls'] = calls
    (directory / 'result.json').write_text(json.dumps(result, indent=2))
    os.chmod(directory / 'result.json', 0o600)
    print(json.dumps({'ok': result['ok'], 'evidence': str(directory / 'result.json'),
                      'runtime': result.get('runtime'), 'terminal': result.get('terminal'),
                      'error': result.get('error')}, ensure_ascii=False))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
