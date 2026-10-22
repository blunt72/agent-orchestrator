/** Trusted local human records, not provider authentication. No log-based approval. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {bindingFor, type BridgeEvent} from './gemini-task-event-bridge.js';
import type {Task} from '../tasks/task.js';

export interface TranscriptRecovery {
  eventId: string;
  humanAuthorized: true;
  approvalFile: string;
  approvalSha256: string;
  evidenceFile: string;
  evidenceSha256: string;
}
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function read(filename: string, expected: string): Buffer {
  if (!path.isAbsolute(filename) || !/^[a-f0-9]{64}$/.test(expected)) throw Error('PINNED_ABSOLUTE_EVIDENCE_REQUIRED');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 4 * 1024 * 1024 || st.size === 0) throw Error('UNSAFE_RECOVERY_EVIDENCE');
    const bytes = fs.readFileSync(fd);
    if (sha(bytes) !== expected) throw Error('RECOVERY_EVIDENCE_HASH_MISMATCH');
    return bytes;
  } finally { fs.closeSync(fd); }
}
export function verifyTranscriptRecovery(task: Task, event: BridgeEvent, request: TranscriptRecovery): boolean {
  if (request.humanAuthorized !== true) throw Error('EXPLICIT_HUMAN_AUTHORIZATION_REQUIRED');
  const approval = JSON.parse(read(request.approvalFile, request.approvalSha256).toString('utf8'));
  const evidence = JSON.parse(read(request.evidenceFile, request.evidenceSha256).toString('utf8'));
  const bound = (record: any) => record?.taskId === task.id && record.eventId === event.id &&
    record.taskRevision === task.revision && Number.isSafeInteger(record.taskRevision) &&
    JSON.stringify(record.binding) === JSON.stringify(bindingFor(task));
  if (!bound(approval) || !bound(evidence) || event.id !== request.eventId ||
      approval.version !== 1 || approval.decision !== 'authorize_saved_turn_and_pipeline' ||
      approval.humanAuthorized !== true || typeof approval.approvedBy !== 'string' || !approval.approvedBy.trim() ||
      !Number.isFinite(Date.parse(approval.approvedAt)) || approval.evidenceSha256 !== request.evidenceSha256 ||
      evidence.version !== 1 || evidence.kind !== 'independent_original_turn_review' ||
      typeof evidence.reviewedBy !== 'string' || !evidence.reviewedBy.trim() ||
      ['gemini','codex'].includes(evidence.reviewedBy.toLowerCase()) ||
      !Number.isFinite(Date.parse(evidence.reviewedAt)) ||
      evidence.originalSessionIdentityChecked !== true || evidence.fullTurnResponseChecked !== true ||
      evidence.safeToRestoreSavedTurn !== true || typeof evidence.rationale !== 'string' || !evidence.rationale.trim())
    throw Error('INDEPENDENT_HUMAN_REVIEW_REQUIRED');
  // A separately retained human review report is required in addition to JSON decisions.
  // Its truth is a human trust boundary: a hash proves integrity, not authenticity.
  const report = evidence.report;
  if (!report || [request.approvalFile, request.evidenceFile].includes(report.path) ||
      /transcript\.jsonl$/.test(report.path) || report.sha256 === event.rowSha256)
    throw Error('INDEPENDENT_REVIEW_REPORT_REQUIRED');
  read(report.path, report.sha256);
  return true;
}
