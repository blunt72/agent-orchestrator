#!/usr/bin/env python3
"""Ordinary macOS Terminal metadata inventory. No argv/env/HTTP/runtime actions."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(os.environ.get('AIHUB_AGENTHUB_ROOT', Path(__file__).resolve().parents[2]))
OUT = Path(os.environ.get('AIHUB_HOME', Path(__file__).resolve().parents[1])) / 'outputs'


def run(args):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=2)
        return p.returncode, p.stdout
    except (OSError, subprocess.TimeoutExpired):
        return None, ''


def main():
    if os.environ.get('CODEX_SANDBOX'):
        raise SystemExit('STOP: run in ordinary macOS Terminal; do not alter sandbox variables.')
    code, output = run(['/bin/ps', '-axo', 'pid=,ppid=,comm='])
    if code != 0:
        raise SystemExit('STOP: process metadata unavailable; no permission changes attempted.')
    candidates = []
    failures = []
    started = time.monotonic()
    for line in output.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) != 3:
            continue
        pid, parent, executable = parts
        if not pid.isdecimal() or Path(executable).name not in ['node', 'bun', 'deno', 'tsx']:
            continue
        if len(candidates) >= 64 or time.monotonic() - started >= 20:
            failures.append('inventory_budget_reached_results_incomplete')
            break
        cwd_code, cwd_out = run(['/usr/sbin/lsof', '-a', '-p', pid, '-d', 'cwd', '-Fn'])
        cwd = next((v[1:] for v in cwd_out.splitlines() if v.startswith('n')), None)
        port_code, ports_out = run(['/usr/sbin/lsof', '-nP', '-a', '-p', pid, '-iTCP', '-sTCP:LISTEN', '-Fn'])
        ports = [v[1:] for v in ports_out.splitlines() if v.startswith('n')]
        entry = {'pid': int(pid), 'parentPid': int(parent), 'executableName': Path(executable).name,
                 'cwd': cwd, 'listeningTcp': ports,
                 'cwdMatchesAgentHub': cwd is not None and Path(cwd).resolve() == ROOT.resolve(),
                 'identity': 'UNCONFIRMED_PROCESS_METADATA_ONLY'}
        if cwd_code not in [0, 1] or port_code not in [0, 1]:
            failures.append('metadata_query_unavailable_for_pid_' + pid)
        candidates.append(entry)
    report = {'time': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'targetRoot': str(ROOT), 'candidates': candidates, 'queryFailures': failures,
              'serviceIdentityVerified': False, 'allWritersQuiescentVerified': False,
              'limitations': ['No command arguments or environment read.',
                             'cwd/port do not prove service identity or version.',
                             'Non-Node writers and services started from another cwd may not be identified.',
                             'An empty result does not prove no AgentHub process exists.'],
              'httpRequests': 0, 'orcaCalls': 0, 'models': 0, 'processActions': 0}
    directory = Path(tempfile.mkdtemp(prefix='agenthub-runtime-inventory-20261019-', dir=OUT))
    target = directory / 'inventory.json'
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
        f.flush(); os.fsync(f.fileno())
    print(json.dumps({'evidenceDir': str(directory), 'candidateCount': len(candidates),
                      'matchingCwdPids': [v['pid'] for v in candidates if v['cwdMatchesAgentHub']],
                      'queryFailures': failures, 'processActions': 0,
                      'serviceIdentityVerified': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
