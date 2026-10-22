#!/usr/bin/env python3
"""One-shot terminal change -> durable local outbox -> public Orca status message.
Run live commands only in the sender's own ordinary Orca shell, after authorization.
"""
import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import time

# Local paths come from the environment; see README.
CLI = os.environ.get('AIHUB_ORCA_CLI', '/Applications/Orca.app/Contents/Resources/bin/orca')
WORKSPACE = os.environ.get('AIHUB_WORKSPACE', '/path/to/orca-workspace')
PROFILE = os.environ.get('AIHUB_ORCA_PROFILE', str(Path.home() / 'Library/Application Support/orca'))
TERMINAL = re.compile(r'term_[0-9a-f-]{36}\Z')


def fail(code):
    raise RuntimeError(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def load(filename):
    p = Path(filename)
    if p.is_symlink() or p.stat().st_size > 1048576:
        fail('UNSAFE_OR_OVERSIZED_JSON')
    return json.loads(p.read_text())


def inspect_business_mapping(expected, call):
    """Two public inspection calls only; never enables a business watcher.

    call is an injected native transport, not a shell or a copied identity.
    The caller must separately establish authorization and its native identity.
    No worker-show, terminal read, send, Run mutation or recovery is used here.
    """
    keys = ['runtimeId', 'dispatchId', 'taskId', 'runId', 'terminalHandle',
            'workspacePath', 'leafId', 'ptyId']
    if not isinstance(expected, dict) or any(
            not isinstance(expected.get(k), str) or not expected[k] for k in keys):
        fail('EXACT_BUSINESS_INSPECTION_MAPPING_REQUIRED')
    spec = importlib.util.spec_from_file_location(
        'orca_business_receipt_audit', Path(__file__).with_name('orca-business-receipt-audit.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    dispatch = call(['orchestration', 'dispatch-show', '--task', expected['taskId']])
    # Fail before querying the terminal if the task now points to another dispatch.
    module.audit(dispatch, expected)
    terminal = call(['terminal', 'show', '--terminal', expected['terminalHandle']])
    result = module.audit_pair(dispatch, terminal, expected)
    result.update(mode='two_step_inspection_only', runtimeQueried=True,
                  businessReady=False, messagesSent=0)
    return result


def validate(c, prepared=False):
    if c.get('version') != 1 or c.get('scope') != 'mechanism_terminal_only':
        fail('BUSINESS_DISPATCH_MAPPING_ADAPTER_NOT_IMPLEMENTED')
    if c.get('cli') != CLI or c.get('workspace') != WORKSPACE:
        fail('UNVERIFIED_CLI_OR_WORKSPACE')
    for key in ['sender', 'receiver', 'observedTerminal']:
        if not isinstance(c.get(key), str) or not TERMINAL.fullmatch(c[key]):
            fail('EXACT_TERMINAL_REQUIRED')
    if c['sender'] == c['receiver'] or not re.fullmatch(r'run_[a-zA-Z0-9]+', c.get('runId', '')):
        fail('EXACT_RUN_AND_SEPARATE_PARTIES_REQUIRED')
    if not c.get('runtimeId') or type(c.get('consumerGeneration')) is not int or c['consumerGeneration'] < 1:
        fail('RUNTIME_AND_CONSUMER_GENERATION_REQUIRED')
    if c.get('triggerLine') is not None and not re.fullmatch(r'ORCA-OBSERVER-CHANGE-[A-Za-z0-9_-]{1,80}', c['triggerLine']):
        fail('INVALID_TEST_TRIGGER')
    if prepared:
        if not re.fullmatch('[0-9a-f]{64}', c.get('baselineSha256') or ''):
            fail('FRESH_BASELINE_REQUIRED')
        for key in ['senderIdentity', 'receiverIdentity', 'observedIdentity']:
            r = c.get(key, {})
            if not r.get('leafId') or not r.get('ptyId'):
                fail('FRESH_PTY_IDENTITY_REQUIRED')
    return c


class PublicCLI:
    def __init__(self, c, role='sender'):
        # Never synthesize a caller or copy S's variables from a config file.
        if os.environ.get('CODEX_SANDBOX'):
            fail('CODEX_SANDBOX_LIVE_ENTRY_DISABLED')
        if role not in ['sender', 'receiver']:
            fail('INVALID_PROCESS_ROLE')
        if os.environ.get('ORCA_TERMINAL_HANDLE') != c[role] or not os.environ.get('ORCA_PANE_KEY'):
            fail('START_IN_SENDERS_OWN_ORCA_SHELL' if role == 'sender' else 'START_IN_RECEIVERS_OWN_ORCA_SHELL')
        if os.environ.get('ORCA_AGENT_SESSION_ID'):
            fail('MODEL_FREE_TERMINAL_SENDER_REQUIRED')
        if any(os.environ.get(k) for k in ['ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE', 'ORCA_REMOTE_PAIRING']):
            fail('REMOTE_SELECTION_NOT_ALLOWED')
        if os.environ.get('ORCA_USER_DATA_PATH', PROFILE) != PROFILE:
            fail('PROFILE_MISMATCH')
        self.c = c

    def __call__(self, args):
        # Fixed public executable, no shell, no --from, no terminal send/retry.
        try:
            p = subprocess.run([CLI, *args, '--json'], cwd=WORKSPACE, capture_output=True,
                               text=True, timeout=80)
            if len(p.stdout.encode()) > 1048576:
                return {'ok': False, 'error': {'code': 'OUTPUT_TOO_LARGE'}}
            value = json.loads(p.stdout)
            if not isinstance(value, dict):
                raise ValueError()
            if p.returncode and value.get('ok') is True:
                return {'ok': False, 'error': {'code': 'EXIT_RECEIPT_CONFLICT'}}
            return value
        except (subprocess.TimeoutExpired, ValueError, OSError):
            # No original request ID is invented on a local process failure.
            return {'ok': False, 'error': {'code': 'LOCAL_PROCESS_OUTCOME_UNKNOWN'}}


class Bridge:
    def __init__(self, c, call):
        self.c, self.call = validate(c), call

    def rpc(self, args):
        value = self.call(args)
        if value.get('ok') is not True:
            fail('PUBLIC_CLI_REFUSED:' + str(value.get('error', {}).get('code', 'unknown')))
        if value.get('_meta', {}).get('runtimeId') != self.c['runtimeId']:
            fail('RUNTIME_ID_MISMATCH')
        return value.get('result', {})

    def terminal(self, handle):
        r = self.rpc(['terminal', 'show', '--terminal', handle]).get('terminal', {})
        if r.get('handle') != handle or r.get('worktreePath') != self.c['workspace'] or r.get('connected') is not True:
            fail('TERMINAL_IDENTITY_MISMATCH')
        if not r.get('leafId') or not r.get('ptyId'):
            fail('PTY_IDENTITY_UNVERIFIABLE')
        return {k: r[k] for k in ['handle', 'worktreePath', 'leafId', 'ptyId']}

    def check(self, pinned=True):
        r = self.rpc(['orchestration', 'run-show', '--id', self.c['runId']]).get('run', {})
        if (r.get('id'), r.get('coordinator_handle'), r.get('consumer_generation')) != (
                self.c['runId'], self.c['receiver'], self.c['consumerGeneration']):
            fail('RECIPIENT_RUN_OWNER_OR_GENERATION_MISMATCH')
        identities = {key: self.terminal(self.c[handle]) for key, handle in [
            ('senderIdentity', 'sender'), ('receiverIdentity', 'receiver'), ('observedIdentity', 'observedTerminal')]}
        if pinned and any(self.c.get(k) != v for k, v in identities.items()):
            fail('TERMINAL_PTY_REPLACED')
        return identities

    def read_digest(self):
        self.check()
        r = self.rpc(['terminal', 'read', '--terminal', self.c['observedTerminal'], '--limit', '80']).get('terminal', {})
        if r.get('handle') != self.c['observedTerminal'] or not isinstance(r.get('tail'), list) or not all(isinstance(x, str) for x in r['tail']):
            fail('TERMINAL_TEXT_SCHEMA_MISMATCH')
        text = '\n'.join(r['tail'])
        if len(text.encode()) > 262144:
            fail('TERMINAL_TEXT_TOO_LARGE')
        self.trigger_seen = bool(self.c.get('triggerLine') and self.c['triggerLine'] in text.splitlines())
        self.check()  # close the asynchronous read window before any publication
        return hashlib.sha256(text.encode()).hexdigest()

    def prepare(self):
        c = dict(self.c)
        c.update(self.check(pinned=False))
        bridge = Bridge(c, self.call)
        c['baselineSha256'] = bridge.read_digest()
        if bridge.trigger_seen:
            fail('TEST_TRIGGER_ALREADY_PRESENT_IN_BASELINE')
        return validate(c, prepared=True)


@contextlib.contextmanager
def journal(directory, c):
    p = Path(directory)
    if not p.is_absolute():
        fail('ABSOLUTE_PRIVATE_JOURNAL_REQUIRED')
    p.mkdir(mode=0o700, parents=True, exist_ok=True)
    if p.is_symlink() or p.stat().st_uid != os.getuid() or p.stat().st_mode & 0o077:
        fail('PRIVATE_TRUSTED_JOURNAL_REQUIRED')
    for name in ['observer.lock', 'outbox.sqlite3']:
        if (p / name).is_symlink():
            fail('UNSAFE_JOURNAL_FILE')
    lock = os.open(p / 'observer.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    db = None
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail('OBSERVER_ALREADY_RUNNING')
        old = os.umask(0o077)
        try:
            db = sqlite3.connect(p / 'outbox.sqlite3')
        finally:
            os.umask(old)
        db.execute('PRAGMA synchronous=FULL')
        db.execute('CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, body TEXT NOT NULL, state TEXT NOT NULL, request_id TEXT, message_id TEXT, query_state TEXT)')
        db.execute('CREATE TABLE IF NOT EXISTS send_receipts (event_id TEXT PRIMARY KEY, receipt TEXT NOT NULL)')
        prior = db.execute('SELECT hash FROM config WHERE id=1').fetchone()
        if prior and prior[0] != digest(c):
            fail('JOURNAL_CONFIG_CHANGED_NO_AUTOMATIC_REBIND')
        db.execute('INSERT OR IGNORE INTO config VALUES (1,?)', (digest(c),))
        db.commit()
        yield db
    finally:
        if db:
            db.close()
        os.close(lock)  # only our process lock; never delete historical/business locks


def notify_once(c, bridge, db, observed, grant, cancelled=lambda: False):
    if grant != {'version': 1, 'configSha256': digest(c), 'authorizeOneStatusMessage': True}:
        fail('EXACT_ONE_MESSAGE_AUTHORIZATION_REQUIRED')
    if c.get('triggerLine') and not getattr(bridge, 'trigger_seen', False):
        fail('AGREED_TEST_TRIGGER_NOT_OBSERVED')
    event = {'version': 1, 'binding': {k: c[k] for k in ['runtimeId', 'workspace', 'observedTerminal']},
             'baselineSha256': c['baselineSha256'], 'observedSha256': observed,
             'state': 'pending_verification', 'approvalIssued': False, 'canCompleteTask': False,
             'canResume': False, 'sourceAuthenticated': False, 'requiresIndependentReview': True}
    if c.get('triggerLine'):
        event.update(matchedTestTrigger=True, triggerLineSha256=hashlib.sha256(c['triggerLine'].encode()).hexdigest())
    eid = digest([digest(c), event])
    if observed == c['baselineSha256']:
        return {'event': 'no_change'}
    previous = db.execute('SELECT state FROM events WHERE id=?', (eid,)).fetchone()
    if previous:
        return {'event': 'duplicate_suppressed', 'id': eid, 'state': previous[0]}
    # The grant permits ONE attempted message across process restarts, not one per run.
    if db.execute('SELECT COUNT(*) FROM events').fetchone()[0]:
        fail('ONE_MESSAGE_BUDGET_OR_UNRESOLVED_EVENT_STOP')
    db.execute('INSERT INTO events(id,body,state) VALUES (?,?,?)', (eid, json.dumps(event, sort_keys=True), 'pending'))
    db.commit()
    bridge.check()
    if cancelled():
        return {'event': 'cancelled_before_send', 'id': eid}
    db.execute("UPDATE events SET state='sending' WHERE id=?", (eid,))
    db.commit()  # crash after this point NEVER authorizes sending again
    args = ['orchestration', 'send', '--to', 'run:' + c['runId'], '--type', 'status',
            '--subject', 'ORCA-CHANGE-UNVERIFIED:' + eid,
            '--body', json.dumps({'eventId': eid, **event}, sort_keys=True)]
    result = bridge.call(args)
    err = result.get('error', {})
    request = err.get('data', {}).get('orchestrationRequestId')
    if not isinstance(request, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', request):
        request = None
    message = result.get('result', {}).get('message', {}).get('id')
    enqueued = (result.get('ok') is True and result.get('_meta', {}).get('runtimeId') == c['runtimeId']
                and isinstance(message, str) and re.fullmatch(r'msg_[a-zA-Z0-9]+', message))
    state = 'enqueued' if enqueued else 'unknown'
    db.execute('UPDATE events SET state=?,request_id=?,message_id=? WHERE id=?',
               (state, request, message if enqueued else None, eid))
    native_message = result.get('result', {}).get('message', {})
    receipt = {'ok': result.get('ok'), '_meta': {'runtimeId': result.get('_meta', {}).get('runtimeId')},
               'result': {'message': {k: native_message[k] for k in ['id', 'from_handle', 'to_handle', 'run_id', 'type', 'subject', 'body'] if k in native_message}},
               'errorCode': err.get('code'), 'requestId': request}
    db.execute('INSERT INTO send_receipts VALUES (?,?)', (eid, json.dumps(receipt, sort_keys=True)))
    db.commit()
    return {'event': state, 'id': eid, 'messageId': message if enqueued else None,
            'requestId': request, 'recipientReadOrModelWakeVerified': False}


def recover(c, bridge, db):
    rows = db.execute("SELECT id,state,request_id FROM events WHERE state!='enqueued'").fetchall()
    result = []
    for eid, state, request in rows:
        if not request:
            result.append({'id': eid, 'state': state, 'action': 'HUMAN_RECONCILIATION_NO_ORIGINAL_REQUEST_ID'})
            continue
        # Original sender and runtime only. Query never calls send or retry-request.
        r = bridge.rpc(['orchestration', 'request-show', '--request', request])
        if r.get('requestId') != request or r.get('state') not in ['completed', 'pending', 'absent']:
            fail('REQUEST_QUERY_SCHEMA_UNVERIFIED')
        db.execute('UPDATE events SET query_state=? WHERE id=?', (r['state'], eid))
        db.commit()
        result.append({'id': eid, 'requestId': request, 'queryState': r['state'],
                       'action': 'REVIEW_ORIGINAL_OUTCOME_NO_RESEND'})
    return result


def watch_once(c, bridge, db, grant, interval_ms, timeout_ms, stopped,
               clock=time.monotonic, sleep=time.sleep):
    deadline = clock() + timeout_ms / 1000
    while not stopped() and clock() < deadline:
        value = bridge.read_digest()
        if stopped():
            break
        if clock() >= deadline:
            return {'event': 'timeout_no_change', 'messagesSent': 0, 'lateReadIgnored': True}
        if value != c['baselineSha256'] and (not c.get('triggerLine') or getattr(bridge, 'trigger_seen', False)):
            return notify_once(c, bridge, db, value, grant, lambda: stopped() or clock() >= deadline)
        wait_until = min(deadline, clock() + interval_ms / 1000)
        while not stopped() and clock() < wait_until:
            sleep(min(0.1, max(0, wait_until - clock())))
    return {'event': 'cancelled' if stopped() else 'timeout_no_change', 'messagesSent': 0}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode', choices=['validate', 'prepare', 'watch', 'recover', 'outbox'])
    p.add_argument('config')
    p.add_argument('--output')
    p.add_argument('--store')
    p.add_argument('--grant')
    p.add_argument('--interval-ms', type=int, default=5000)
    p.add_argument('--timeout-ms', type=int, default=60000)
    a = p.parse_args()
    c = validate(load(a.config), prepared=a.mode in ['watch', 'recover'])
    if a.mode == 'validate':
        print(json.dumps({'ok': True, 'configSha256': digest(c), 'liveCallMade': False}))
        return
    if a.mode == 'outbox':
        if not a.store or not Path(a.store).is_absolute():
            fail('ABSOLUTE_PERSISTENT_STORE_REQUIRED')
        database = Path(a.store) / 'outbox.sqlite3'
        if database.is_symlink() or not database.is_file():
            fail('EXISTING_OUTBOX_REQUIRED')
        from urllib.parse import quote
        db = sqlite3.connect('file:' + quote(str(database)) + '?mode=ro', uri=True)
        try:
            db.execute('PRAGMA query_only=ON')
            if db.execute('SELECT hash FROM config WHERE id=1').fetchone() != (digest(c),):
                fail('JOURNAL_CONFIG_CHANGED_NO_AUTOMATIC_REBIND')
            rows = db.execute('SELECT id,state,request_id,message_id,query_state FROM events').fetchall()
            print(json.dumps({'events': [dict(zip(['id', 'state', 'requestId', 'messageId', 'queryState'], r)) for r in rows],
                              'liveCalls': 0}))
        finally:
            db.close()
        return
    bridge = Bridge(c, PublicCLI(c))
    if a.mode == 'prepare':
        if not a.output or not Path(a.output).is_absolute():
            fail('NEW_ABSOLUTE_OUTPUT_REQUIRED')
        c = bridge.prepare()
        fd = os.open(a.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump(c, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        print(json.dumps({'preparedConfig': a.output, 'configSha256': digest(c), 'messagesSent': 0}))
        return
    if not a.store:
        fail('PERSISTENT_STORE_REQUIRED')
    with journal(a.store, c) as db:
        if a.mode == 'recover':
            if bridge.terminal(c['sender']) != c['senderIdentity']:
                fail('ORIGINAL_SENDER_PTY_REPLACED')
            print(json.dumps({'queries': recover(c, bridge, db), 'messagesSent': 0}))
            return
        if not a.grant:
            fail('EXPLICIT_GRANT_REQUIRED')
        grant = load(a.grant)
        if grant != {'version': 1, 'configSha256': digest(c), 'authorizeOneStatusMessage': True}:
            fail('EXACT_ONE_MESSAGE_AUTHORIZATION_REQUIRED')
        if not 1000 <= a.interval_ms <= 60000 or not 1000 <= a.timeout_ms <= 600000:
            fail('INVALID_WAIT_BOUNDS')
        stopped = [False]
        for sig in [signal.SIGTERM, signal.SIGINT]:
            signal.signal(sig, lambda *_: stopped.__setitem__(0, True))
        print(json.dumps(watch_once(c, bridge, db, grant, a.interval_ms, a.timeout_ms, lambda: stopped[0])))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'code': str(error) if isinstance(error, RuntimeError) else type(error).__name__,
                          'automaticRetry': False, 'approvalIssued': False}))
        raise SystemExit(1)
