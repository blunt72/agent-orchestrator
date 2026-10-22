"""Offline phase-one primitives. No providers, RPC, task-store writes or dispatch.

The isolated historical ledger below is a prototype, not an AgentHub completion
entry point. It never writes a source task, binding or baseline.
"""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def file_bytes(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > 4 * 1024 * 1024:
            raise ValueError('UNSAFE_FILE')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            value = stream.read(4 * 1024 * 1024 + 1)
        after = os.fstat(fd)
        if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError('FILE_CHANGED_DURING_READ')
        if len(value) != before.st_size:
            raise ValueError('INCOMPLETE_FILE')
        return value
    finally:
        os.close(fd)


def duplicate_preflight(task, historical_report, request):
    """Decision support only. It cannot grant dispatch permission."""
    if task.get('id') != historical_report.get('taskId') or request.get('taskId') != task.get('id'):
        raise ValueError('TASK_MISMATCH')
    if task.get('revision') != historical_report.get('taskRevision'):
        raise ValueError('STALE_REPORT')
    # Literal request intent is mandatory; no task text heuristics.
    intent = request.get('intent')
    if intent not in ['same_scope', 'new_scope', 'repair']:
        raise ValueError('EXPLICIT_SCOPE_INTENT_REQUIRED')
    if intent == 'same_scope' and historical_report.get('retainedDeliveryCorroborated') is True:
        return {'decision': 'BLOCK_DUPLICATE_DISPATCH', 'next': 'historical_reconciliation', 'canDispatch': False}
    if intent != 'same_scope' and not request.get('scopeEvidence'):
        raise ValueError('NEW_SCOPE_OR_DEFECT_EVIDENCE_REQUIRED')
    return {'decision': 'REQUIRES_CONTROLLER_REVIEW', 'next': 'review_scope_and_authorization', 'canDispatch': False}


def snapshot_task(task_path, destination, expected_revision):
    """Preserve complete bytes at a capture point; no reconstructed history.

    Caller must hold the real task execution lock when integrating this helper.
    Without that lock, this records a stable observed file only, not a binding
    transaction or protection against a later writer.
    """
    destination = Path(destination)
    if destination.is_symlink() or not destination.is_dir():
        raise ValueError('EXISTING_SNAPSHOT_DIRECTORY_REQUIRED')
    raw = file_bytes(task_path)
    task = json.loads(raw)
    if type(expected_revision) is not int or task.get('revision') != expected_revision:
        raise ValueError('SNAPSHOT_REVISION_MISMATCH')
    if not isinstance(task.get('id'), str) or not task['id']:
        raise ValueError('INVALID_TASK')
    hashed = hashlib.sha256(raw).hexdigest()
    target = destination / (hashed + '.task.json')
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        if file_bytes(target) != raw:
            raise ValueError('SNAPSHOT_CONFLICT')
    else:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    if file_bytes(task_path) != raw:
        raise ValueError('SOURCE_CHANGED_SNAPSHOT_IS_NOT_A_COMMIT')
    folder = os.open(destination, os.O_RDONLY)
    try:
        os.fsync(folder)
    finally:
        os.close(folder)
    return {'taskId': task['id'], 'revision': expected_revision, 'sha256': hashed,
            'bytes': len(raw), 'path': str(target), 'sourceWritten': False,
            'scope': 'OBSERVED_TASK_BYTES_ONLY', 'bindingCommitVerified': False}


class IsolatedHistoricalLedger:
    """Create only a NEW disposable SQLite prototype. No production CLI."""
    def __init__(self, directory):
        directory = Path(directory)
        directory.mkdir(mode=0o700)  # never attach to an existing or authoritative store
        self.database = directory / 'prototype.sqlite3'
        self.db = sqlite3.connect(self.database)
        os.chmod(self.database, 0o600)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
          CREATE TABLE records(task_id TEXT PRIMARY KEY, operation TEXT UNIQUE NOT NULL,
            proposal_hash TEXT NOT NULL, source_hash TEXT NOT NULL, record TEXT NOT NULL);
          CREATE TABLE outbox(event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, projected INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE projected_events(event_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        ''')
        self.db.commit()

    def close(self):
        self.db.close()

    def commit(self, packet, decision, read_source, fault=lambda point: None):
        """Synthetic decision is not human authentication; all fields stay explicit."""
        packet = json.loads(canonical(packet))
        decision = json.loads(canonical(decision))
        if (packet.get('purpose') != 'HISTORICAL_RECONCILIATION_PROPOSAL_ONLY' or
                packet.get('sourceAuthenticated') is not False or packet.get('canCompleteTask') is not False):
            raise ValueError('INVALID_PROPOSAL')
        expected_keys = {'purpose', 'operationId', 'operator', 'packetDigest', 'acceptedGaps'}
        if (set(decision) != expected_keys or decision['purpose'] != 'ISOLATED_HISTORICAL_CLOSURE_DECISION' or
                not isinstance(decision['operationId'], str) or not decision['operationId'] or
                not isinstance(decision['operator'], str) or not decision['operator'].strip() or
                decision['packetDigest'] != digest(packet) or
                decision['acceptedGaps'] != packet.get('unresolvedGaps')):
            raise ValueError('EXACT_ISOLATED_DECISION_REQUIRED')
        subjects = packet['subjects']
        original = read_source()
        source_hash = hashlib.sha256(original).hexdigest()
        if source_hash != subjects.get('sourceTaskSha256'):
            raise ValueError('SOURCE_CAS_MISMATCH')
        source = json.loads(original)
        if source['id'] != subjects['taskId'] or source['revision'] != subjects['taskRevision']:
            raise ValueError('SOURCE_IDENTITY_MISMATCH')
        packet_hash = digest(packet)
        record = {'type': 'HISTORICAL_CLOSED_WITH_GAPS', 'scope': 'ISOLATED_PROTOTYPE_ONLY',
                  'sourceTask': source, 'sourceTaskStatusUnchanged': source['status'],
                  'decision': decision, 'packet': packet, 'sourceAuthenticated': False,
                  'normalAcceptancePassed': False, 'agenthubTaskCompleted': False}
        payload = canonical(record)
        event_id = digest([subjects['taskId'], decision['operationId'], packet_hash])
        self.db.execute('BEGIN IMMEDIATE')
        try:
            previous = self.db.execute('SELECT operation,proposal_hash,source_hash,record FROM records WHERE task_id=?',
                                       (subjects['taskId'],)).fetchone()
            if previous:
                if previous != (decision['operationId'], packet_hash, source_hash, payload):
                    raise ValueError('DUPLICATE_OR_DECISION_CONFLICT')
                if read_source() != original:
                    raise ValueError('SOURCE_CHANGED')
                self.db.rollback()
                return {'state': 'same_commit', 'eventId': event_id}
            fault('before_insert')
            self.db.execute('INSERT INTO records VALUES(?,?,?,?,?)',
                            (subjects['taskId'], decision['operationId'], packet_hash, source_hash, payload))
            fault('after_record')
            self.db.execute('INSERT INTO outbox(event_id,payload) VALUES(?,?)', (event_id, payload))
            fault('before_commit')
            if read_source() != original:
                raise ValueError('SOURCE_CHANGED')
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise
        fault('after_commit')  # lost receipt: original operation can only reconcile
        return {'state': 'committed', 'eventId': event_id}

    def project(self, event_id, fault=lambda point: None):
        """Local event projection, never a cross-session notification."""
        self.db.execute('BEGIN IMMEDIATE')
        try:
            row = self.db.execute('SELECT payload FROM outbox WHERE event_id=?', (event_id,)).fetchone()
            if row is None:
                raise ValueError('NO_COMMITTED_EVENT')
            old = self.db.execute('SELECT payload FROM projected_events WHERE event_id=?', (event_id,)).fetchone()
            if old and old != row:
                raise ValueError('EVENT_CONFLICT')
            self.db.execute('INSERT OR IGNORE INTO projected_events VALUES(?,?)', (event_id, row[0]))
            fault('after_event')
            self.db.execute('UPDATE outbox SET projected=1 WHERE event_id=?', (event_id,))
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise
