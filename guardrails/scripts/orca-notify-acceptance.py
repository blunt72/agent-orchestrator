#!/usr/bin/env python3
"""Operator steps for the single authorized S -> test Run -> R acceptance."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
from urllib.parse import quote
import uuid

ROOT = Path(os.environ.get('AIHUB_HOME', Path(__file__).resolve().parents[1]))
spec = importlib.util.spec_from_file_location('observer_notify', Path(__file__).with_name('orca-observer-notify.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
# The single authorized target set. Defaults are synthetic placeholders that
# match config/orca-observer-notify.test.json; point AIHUB_ACCEPTANCE_TARGETS
# at a reviewed JSON file with the same keys for a real acceptance run.
EXPECTED = {
    'runtimeId': '00000000-0000-4000-8000-000000000000',
    'workspace': m.WORKSPACE, 'sender': 'term_00000000-0000-0000-0000-00000000000a',
    'observedTerminal': 'term_00000000-0000-0000-0000-00000000000a',
    'receiver': 'term_00000000-0000-0000-0000-00000000000b',
    'runId': 'run_synthetic01', 'consumerGeneration': 1,
}
if os.environ.get('AIHUB_ACCEPTANCE_TARGETS'):
    EXPECTED = m.load(os.environ['AIHUB_ACCEPTANCE_TARGETS'])


def write(p, value):
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f, indent=2)
        f.flush()
        os.fsync(f.fileno())


def exact(c):
    m.validate(c, prepared=True)
    if any(c.get(k) != v for k, v in EXPECTED.items()) or not c.get('triggerLine'):
        m.fail('AUTHORIZED_TEST_TARGET_MISMATCH')
    return c


def session(directory):
    d = Path(directory)
    if not d.is_absolute() or d.is_symlink() or d.stat().st_uid != os.getuid() or d.stat().st_mode & 0o077:
        m.fail('EXACT_PRIVATE_EVIDENCE_DIRECTORY_REQUIRED')
    return d, exact(m.load(d / 'prepared.json'))


def setup():
    candidate = m.load(ROOT / 'config/orca-observer-notify.test.json')
    if any(candidate.get(k) != v for k, v in EXPECTED.items()):
        m.fail('AUTHORIZED_TEST_TARGET_MISMATCH')
    transport = m.PublicCLI(candidate)  # sender's own environment, never copied
    index = ROOT / 'outputs' / 'observer-acceptance-once-20261018.json'
    if index.exists():
        m.fail('THIS_AUTHORIZATION_ALREADY_HAS_AN_EVIDENCE_DIRECTORY_READ_INDEX_NO_NEW_ATTEMPT')
    d = Path(tempfile.mkdtemp(prefix='observer-acceptance-20261018-', dir=ROOT / 'outputs'))
    write(index, {'evidenceDir': str(d), 'source': 'single_user_authorization_20261018', 'targets': EXPECTED})
    print(json.dumps({'evidenceDir': str(d), 'stage': 'setup_started', 'messagesSent': 0}), flush=True)
    write(d / 'authorization.json', {'source': 'user_authorization_20261018', 'targets': EXPECTED,
                                   'maxMessages': 1, 'expectedDeliveryAckAllowed': True})
    candidate['triggerLine'] = 'ORCA-OBSERVER-CHANGE-' + str(uuid.uuid4())
    prepared = m.Bridge(candidate, transport).prepare()
    exact(prepared)
    write(d / 'prepared.json', prepared)
    write(d / 'grant.json', {'version': 1, 'configSha256': m.digest(prepared), 'authorizeOneStatusMessage': True})
    return {'ok': True, 'evidenceDir': str(d), 'configSha256': m.digest(prepared), 'messagesSent': 0,
            'instruction': 'Use this exact directory in R and Terminal.app; setup does not send.'}


def receiver(directory):
    d, c = session(directory)
    call = m.PublicCLI(c, role='receiver')
    b = m.Bridge(c, call)
    b.check()
    r = b.rpc(['orchestration', 'run-current']).get('run', {})
    if (r.get('id'), r.get('coordinator_handle'), r.get('consumer_generation')) != (
            c['runId'], c['receiver'], c['consumerGeneration']):
        m.fail('RECEIVER_OWN_RUN_NOT_VERIFIED')
    r = b.rpc(['orchestration', 'check', '--run', c['runId'], '--peek'])
    if r.get('messages') != [] or r.get('count') != 0 or r.get('deliveryId') is not None or r.get('legacyCompatibility'):
        m.fail('UNEXPECTED_PENDING_MAIL_STOP_WITHOUT_ACK')
    write(d / 'R-preflight.json', {'ok': True, 'configSha256': m.digest(c), 'time': time.time(),
                                 'receiver': c['receiver'], 'runId': c['runId'], 'mailboxEmpty': True})
    return {'ok': True, 'action': 'Start the single native blocking check in R now; no mailbox consumed here.'}


def outbox(directory):
    d, c = session(directory)
    p = d / 'outbox' / 'outbox.sqlite3'
    if p.is_symlink() or not p.is_file():
        m.fail('OUTBOX_NOT_YET_AVAILABLE')
    db = sqlite3.connect('file:' + quote(str(p)) + '?mode=ro', uri=True)
    try:
        db.execute('PRAGMA query_only=ON')
        if db.execute('SELECT hash FROM config WHERE id=1').fetchone() != (m.digest(c),):
            m.fail('OUTBOX_CONFIG_MISMATCH')
        rows = db.execute('SELECT id,body,state,request_id,message_id FROM events').fetchall()
        receipts = dict(db.execute('SELECT event_id,receipt FROM send_receipts').fetchall())
    finally:
        db.close()
    if len(rows) != 1:
        m.fail('EXACTLY_ONE_OUTBOX_EVENT_REQUIRED')
    eid, body, state, request, message = rows[0]
    return c, {'id': eid, 'body': json.loads(body), 'state': state, 'requestId': request,
               'messageId': message, 'receipt': json.loads(receipts[eid]) if eid in receipts else None}


def verify_observation_and_send(directory):
    d, c = session(directory)
    _, e = outbox(directory)
    body = e['body']
    if e['state'] != 'enqueued' or not e['messageId']:
        m.fail('SEND_NOT_CONFIRMED_NO_ACK')
    if (body.get('matchedTestTrigger') is not True or
            body.get('triggerLineSha256') != hashlib.sha256(c['triggerLine'].encode()).hexdigest() or
            body.get('baselineSha256') != c['baselineSha256'] or body.get('observedSha256') == c['baselineSha256']):
        m.fail('OBSERVATION_TRIGGER_OR_BASELINE_MISMATCH')
    if body.get('binding') != {k: c[k] for k in ['runtimeId', 'workspace', 'observedTerminal']} or m.digest([m.digest(c), body]) != e['id']:
        m.fail('OBSERVATION_BINDING_OR_EVENT_ID_MISMATCH')
    receipt = e['receipt'] or {}
    if (receipt.get('ok') is not True or receipt.get('_meta', {}).get('runtimeId') != c['runtimeId'] or
            receipt.get('result', {}).get('message', {}).get('id') != e['messageId']):
        m.fail('NATIVE_SEND_RECEIPT_MISMATCH')
    return c, e


def verify_delivery(directory):
    d, _ = session(directory)
    c, e = verify_observation_and_send(directory)
    body = e['body']
    pre = m.load(d / 'R-preflight.json')
    if pre.get('ok') is not True or pre.get('configSha256') != m.digest(c):
        m.fail('RECEIVER_PREFLIGHT_MISSING')
    r = m.load(d / 'R-wait.json')
    if (d / 'R-wait.exit.txt').read_text().strip() != '0':
        m.fail('NATIVE_WAIT_EXIT_NOT_ZERO')
    data = r.get('result', {})
    if r.get('ok') is not True or r.get('_meta', {}).get('runtimeId') != c['runtimeId']:
        m.fail('WAIT_RECEIPT_RUNTIME_MISMATCH')
    if any(data.get(k) is not False for k in ['timedOut', 'cancelled', 'connectionLost']):
        m.fail('WAIT_DID_NOT_COMPLETE_NORMALLY')
    if data.get('legacyCompatibility') or data.get('count') != 1 or len(data.get('messages', [])) != 1:
        m.fail('UNEXPECTED_DELIVERY_STOP_NO_ACK')
    message = data['messages'][0]
    if (message.get('id'), message.get('from_handle'), message.get('run_id'), message.get('type')) != (
            e['messageId'], c['sender'], c['runId'], 'status'):
        m.fail('MESSAGE_SENDER_RUN_OR_ID_MISMATCH')
    if message.get('to_handle') not in [c['receiver'], 'run:' + c['runId']]:
        m.fail('MESSAGE_RECIPIENT_MISMATCH')
    if message.get('subject') != 'ORCA-CHANGE-UNVERIFIED:' + e['id']:
        m.fail('MESSAGE_SUBJECT_MISMATCH')
    try:
        received = json.loads(message.get('body', ''))
    except ValueError:
        m.fail('MESSAGE_BODY_SCHEMA_MISMATCH')
    if received != {'eventId': e['id'], **body}:
        m.fail('MESSAGE_EVENT_BODY_MISMATCH')
    if any(received.get(k) is not False for k in ['approvalIssued', 'canCompleteTask', 'canResume', 'sourceAuthenticated']):
        m.fail('MESSAGE_AUTHORITY_FLAGS_MISMATCH')
    delivery = data.get('deliveryId')
    if not isinstance(delivery, str) or not delivery.startswith('delivery_'):
        m.fail('EXACT_DELIVERY_ID_MISSING')
    keepalive = []
    for line in (d / 'R-wait.stderr.txt').read_text().splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if value.get('_keepalive') is True and isinstance(value.get('elapsedMs'), (float, int)):
            keepalive.append(value['elapsedMs'])
    if not any(x >= 14000 for x in keepalive):
        m.fail('BLOCKING_KEEPALIVE_EVIDENCE_MISSING_NO_ACK')
    return {'ok': True, 'eventId': e['id'], 'messageId': e['messageId'], 'deliveryId': delivery,
            'sender': c['sender'], 'recipient': 'run:' + c['runId'], 'receiver': c['receiver'],
            'observation': 'matched agreed test line; digest changed', 'outbox': 'one durable event',
            'enqueue': 'native success receipt matches message', 'blockingReceive': 'native keepalive and exact message matched',
            'keepaliveElapsedMs': keepalive, 'ack': 'not yet confirmed by this check'}


def ack(directory):
    d, c = session(directory)
    call = m.PublicCLI(c, role='receiver')
    b = m.Bridge(c, call)
    b.check()
    checked = verify_delivery(directory)
    # Persist the precise allowed ack intent BEFORE the native mutation. Never repeat it.
    write(d / 'R-ack-attempt.json', {'deliveryId': checked['deliveryId'], 'configSha256': m.digest(c), 'time': time.time()})
    raw = call(['orchestration', 'check', '--run', c['runId'], '--ack', checked['deliveryId']])
    write(d / 'R-ack.json', raw)
    if raw.get('ok') is not True or raw.get('_meta', {}).get('runtimeId') != c['runtimeId']:
        m.fail('ACK_RESULT_UNCONFIRMED_NO_RETRY')
    r = raw.get('result', {})
    empty = r.get('deliveryId') is None and r.get('messages') == [] and r.get('count') == 0
    return {'ok': True, 'ackedDeliveryId': checked['deliveryId'], 'finalMailboxEmpty': empty,
            'action': 'retain all resources' if empty else 'STOP: further mail returned, do not ack it'}


def report(directory):
    d, c = session(directory)
    result = {'source': 'local files collected from operator-executed native commands', 'targets': EXPECTED,
              'observation': 'pending', 'outbox': 'pending', 'enqueue': 'pending', 'blockingReceive': 'pending',
              'ack': 'pending', 'runtimeRestartDurability': 'not tested', 'modelWake': 'not tested', 'business': 'not run'}
    try:
        _, e = outbox(directory)
        result.update(eventId=e['id'], outbox={'state': e['state'], 'requestId': e['requestId']}, messageId=e['messageId'])
        verify_observation_and_send(directory)
        result.update(observation='matched agreed test line; digest changed',
                      enqueue='native success receipt matches message')
        checked = verify_delivery(directory)
        for key in ['observation', 'outbox', 'enqueue', 'blockingReceive', 'deliveryId']:
            result[key] = checked[key]
        if (d / 'R-ack.json').is_file():
            attempted = m.load(d / 'R-ack-attempt.json')
            a = m.load(d / 'R-ack.json')
            r = a.get('result', {})
            if (attempted.get('deliveryId') == checked['deliveryId'] and a.get('ok') is True and
                    a.get('_meta', {}).get('runtimeId') == c['runtimeId']):
                result['ack'] = {'confirmedDeliveryId': checked['deliveryId'],
                                 'finalMailboxEmpty': r.get('deliveryId') is None and r.get('messages') == [] and r.get('count') == 0}
    except Exception as error:
        result['incompleteReason'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    path = d / ('report-' + str(uuid.uuid4()) + '.json')
    write(path, result)
    return {'report': str(path), 'stages': result}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode', choices=['setup', 'receiver-preflight', 'verify', 'ack', 'report'])
    p.add_argument('directory', nargs='?')
    a = p.parse_args()
    if a.mode == 'setup':
        if a.directory:
            m.fail('SETUP_ALLOCATES_ONE_NEW_DIRECTORY')
        value = setup()
    else:
        if not a.directory:
            m.fail('EXACT_SETUP_DIRECTORY_REQUIRED')
        value = {'receiver-preflight': receiver, 'verify': verify_delivery, 'ack': ack, 'report': report}[a.mode](a.directory)
    print(json.dumps(value, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'code': str(error) if isinstance(error, RuntimeError) else type(error).__name__,
                          'automaticResend': False, 'automaticAckOfOtherMail': False}))
        raise SystemExit(1)
