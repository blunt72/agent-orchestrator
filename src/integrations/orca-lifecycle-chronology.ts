import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeOrcaJson, decodeOrcaSessionRecordJson } from "./orca-json.js";
import { extractOrcaSessionTextBlock, ORCA_SESSION_MAX_BYTES } from "./orca-session-source.js";
import { decodeOrcaExecEvidenceBytes, inspectOrcaDeliveryEvidenceBytes } from "./orca-delivery-evidence.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";
const roles = ["waiting", "prebinding", "execution_reply", "worker_done", "settlement", "cleanup"] as const;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const invalid = (): never => { throw Error("INVALID_ORCA_LIFECYCLE_CHRONOLOGY"); };
const token = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}(?![\s\S])/.test(v);
function parse(b: Buffer, sessionRecord = false): any {
  try {
    const text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(b);
    const p = sessionRecord ? decodeOrcaSessionRecordJson(text) : decodeOrcaJson(text);
    if (!p.ok || !p.value || typeof p.value !== "object" || Array.isArray(p.value)) return invalid();
    return p.value;
  } catch { return invalid(); }
}
function time(v: unknown): number {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z(?![\s\S])/.test(v)) return invalid();
  const n = Date.parse(v);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== (v.length === 20 ? v.slice(0, -1) + ".000Z" : v)) return invalid();
  return n;
}

/** Observed local chronology, not a trusted clock, durable-binding timestamp or authorization. */
export function inspectOrcaLifecycleChronology(source: Buffer, rawBinding: string, baseline: Buffer,
  rawSelection: string) {
  if (!Buffer.isBuffer(source) || !source.length || source.length > ORCA_SESSION_MAX_BYTES ||
    !Buffer.isBuffer(baseline) || !baseline.length || baseline.length > 262144 || typeof rawSelection !== "string" ||
    !rawSelection.length || Buffer.byteLength(rawSelection, "utf8") > 32768) return invalid();
  const selection = parse(Buffer.from(rawSelection)), { binding } = parseOrcaCompletionBinding(rawBinding);
  if (JSON.stringify(Object.keys(selection).sort()) !== '["baselineSha256","deliveryDigest","messageId","selectors"]' ||
    selection.baselineSha256 !== sha(baseline) || !selection.selectors ||
    JSON.stringify(Object.keys(selection.selectors).sort()) !== JSON.stringify([...roles].sort())) return invalid();
  const records: any = {}, values: any = {}, lineage: any[] = [];
  for (const role of roles) {
    const block = extractOrcaSessionTextBlock(source, JSON.stringify(selection.selectors[role]));
    const record = parse(block.recordBytes, true), timestamp = time(record.timestamp);
    const decoded = decodeOrcaExecEvidenceBytes(block.outputBytes), value = parse(decoded);
    if (value.ok !== true || value._meta?.runtimeId !== binding.runtimeId) return invalid();
    records[role] = { block, timestamp }; values[role] = value;
    lineage.push({ role, ordinal: block.ordinal, sourceSha256: block.sourceSha256, recordSha256: block.recordSha256,
      outputSha256: block.outputSha256, decodedSha256: sha(decoded), timestamp: record.timestamp });
  }
  for (let i = 1; i < roles.length; i++) {
    if (records[roles[i - 1]].block.ordinal >= records[roles[i]].block.ordinal ||
      records[roles[i - 1]].timestamp > records[roles[i]].timestamp) return invalid();
  }
  const wait = values.waiting.result, q = wait?.messages?.[0];
  if (!wait || wait.runId !== binding.runId || wait.count !== 1 || !Array.isArray(wait.messages) || wait.messages.length !== 1 ||
    wait.replayed !== false || wait.acknowledged !== null || wait.timedOut !== false || wait.cancelled !== false || wait.connectionLost !== false ||
    !q || q.type !== "question" || q.delivery_contract !== "current_delivery" || q.run_id !== binding.runId ||
    q.from_handle !== `dispatch:${binding.dispatchId}` || q.to_handle !== `run:${binding.runId}` ||
    !token(q.id) || typeof q.payload !== "string" || Buffer.byteLength(q.payload, "utf8") > 32768) return invalid();
  const qp = parse(Buffer.from(q.payload));
  if (qp.taskId !== binding.taskId || qp.dispatchId !== binding.dispatchId) return invalid();
  const pre = values.prebinding.result, d = pre?.dispatch, w = pre?.worker, t = pre?.terminal, p = pre?.projection, resource = pre?.terminalResource;
  if (d?.id !== binding.dispatchId || d.runId !== binding.runId || d.taskId !== binding.taskId || d.status !== "dispatched" ||
    d.assigneeHandle !== binding.terminalHandle || w?.dispatchId !== binding.dispatchId || w.runtimeEpoch !== binding.runtimeId ||
    w.agentTerminalHandle !== binding.terminalHandle || w.worktreeId !== binding.workspaceId || w.startOptions?.agent !== binding.provider ||
    t?.handle !== binding.terminalHandle || t.worktreeId !== binding.workspaceId || t.worktreePath !== binding.workspacePath ||
    p?.dispatchId !== binding.dispatchId || p.runId !== binding.runId || p.taskId !== binding.taskId || p.provider?.id !== binding.provider ||
    p.host?.id !== binding.hostId || p.workspace?.id !== binding.workspaceId || pre.observation?.exactWorker !== true ||
    resource?.ownerDispatchId !== binding.dispatchId || resource.originDispatchId !== binding.dispatchId || resource.releaseState !== "not_requested") return invalid();
  const b = parse(baseline), baselineTime = time(b.capturedAt);
  if (b.taskId !== binding.agenthubTaskId || b.generation !== binding.generation || b.bindingRevision !== binding.revision ||
    b.workspacePath !== binding.workspacePath || b.provenance !== "LOCAL_PRE_BINDING_SNAPSHOT" ||
    baselineTime < records.prebinding.timestamp) return invalid();
  const answer = values.execution_reply.result, m = answer?.message, aq = answer?.question;
  if (!m || !token(m.id) || m.type !== "status" || m.delivery_contract !== "current_delivery" || m.run_id !== binding.runId ||
    m.from_handle !== `run:${binding.runId}` || m.to_handle !== `dispatch:${binding.dispatchId}` || m.thread_id !== q.id ||
    !aq || aq.message_id !== q.id || aq.run_id !== binding.runId || aq.dispatch_id !== binding.dispatchId ||
    aq.asker_handle !== binding.terminalHandle || aq.status !== "answered" || aq.answer_message_id !== m.id ||
    typeof m.body !== "string" || !m.body || aq.answer_body !== m.body || answer.duplicate !== false || answer.mutation?.replayed !== false) return invalid();
  const questionTime = time(q.created_at), answerTime = time(m.created_at);
  if (time(aq.created_at) !== questionTime || time(aq.answered_at) !== answerTime || questionTime > records.waiting.timestamp ||
    baselineTime > answerTime || answerTime > records.execution_reply.timestamp) return invalid();
  const delivery = inspectOrcaDeliveryEvidenceBytes(rawBinding, records.worker_done.block.outputBytes,
    records.settlement.block.outputBytes, JSON.stringify({ deliveryDigest: selection.deliveryDigest, messageId: selection.messageId,
      workerDoneSha256: records.worker_done.block.outputSha256, settlementSha256: records.settlement.block.outputSha256 }));
  const worker = values.worker_done.result.messages[0], settled = values.settlement.result;
  const workerTime = time(worker.created_at), completedTime = time(settled.dispatch.completedAt);
  if (answerTime > workerTime || workerTime > completedTime || completedTime > records.worker_done.timestamp ||
    settled.terminalResource?.ownerDispatchId !== binding.dispatchId || settled.terminalResource.originDispatchId !== binding.dispatchId ||
    settled.terminalResource.releaseState !== "not_requested" || settled.projection.resource?.terminalState !== "reclaimable") return invalid();
  const release = values.cleanup.result;
  if (release?.dispatchId !== binding.dispatchId || release.state !== "released" || release.processAction !== "closed_agent_terminal" ||
    release.archive?.source !== "terminal" || release.archive.status !== "captured" || release.mutation?.replayed !== false) return invalid();
  return { taskId: binding.agenthubTaskId, lineage, baselineSha256: sha(baseline), baselineCapturedAt: b.capturedAt,
    replyMessageId: m.id as string, questionId: q.id as string, localChronologyConsistent: true as const, delivery,
    sourceAuthenticated: false as const, trustedClock: false as const, durableBindingTimestampProven: false as const,
    permissionDigestBound: false as const, canCompleteTask: false as const, scope: "OBSERVED_LOCAL_LIFECYCLE_CHRONOLOGY" as const,
    blockers: ["DURABLE_BINDING_CONFIRMATION_TIME_NOT_PROVEN", "EXECUTION_PERMISSION_NOT_STRUCTURALLY_DIGEST_BOUND",
      "SOURCE_AUTHENTICATION_NOT_VERIFIED", "COMPLETION_WRITEBACK_DISABLED"] as const };
}
