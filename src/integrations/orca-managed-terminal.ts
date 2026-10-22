import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";

export interface ManagedSettlementExpectation {
  settlementSha256: string;
  workerIncarnation: string;
  resourceId: string;
}
const fail = (): never => { throw Error("INVALID_MANAGED_TERMINAL_EVIDENCE"); };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(v);
const token = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}(?![\s\S])/.test(v);
function decode(b: Buffer): any {
  if (!Buffer.isBuffer(b) || b.length < 1 || b.length > 262144) return fail();
  const p = decodeOrcaJson(new TextDecoder("utf-8", { fatal: true }).decode(b));
  if (!p.ok || !p.value || typeof p.value !== "object" || Array.isArray(p.value)) return fail();
  return p.value;
}

/** Supplied pre-release settlement only. Never observes or releases a live resource. */
export function inspectOrcaManagedSettlement(rawBinding: string, settlement: Buffer, expectation: ManagedSettlementExpectation) {
  if (!expectation || typeof expectation !== "object" || Array.isArray(expectation) ||
      Object.keys(expectation).sort().join(",") !== "resourceId,settlementSha256,workerIncarnation" ||
      !digest(expectation.settlementSha256) || !token(expectation.resourceId) || typeof expectation.workerIncarnation !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(expectation.workerIncarnation)) return fail();
  const e = { ...expectation }, s = decode(settlement), { binding: b, digest: bindingDigest } = parseOrcaCompletionBinding(rawBinding);
  if (sha(settlement) !== e.settlementSha256 || b.hostId !== "local") return fail();
  const r = s.result, d = r?.dispatch, w = r?.worker, p = r?.projection, t = r?.terminal, x = r?.terminalResource;
  if (s.ok !== true || s._meta?.runtimeId !== b.runtimeId || d?.id !== b.dispatchId || d.runId !== b.runId ||
      d.taskId !== b.taskId || d.assigneeHandle !== b.terminalHandle || d.status !== "completed" ||
      w?.dispatchId !== b.dispatchId || w.runtimeEpoch !== b.runtimeId || w.agentTerminalHandle !== b.terminalHandle ||
      w.worktreeId !== b.workspaceId || w.state !== "succeeded" || w.stage !== "settled" ||
      p?.dispatchId !== b.dispatchId || p.runId !== b.runId || p.taskId !== b.taskId || p.outcome !== "succeeded" ||
      p.resource?.state !== "owned" || p.resource.id !== e.resourceId || p.resource.releaseState !== "not_requested" ||
      p.resource.terminalState !== "reclaimable" || t?.handle !== b.terminalHandle || t.worktreeId !== b.workspaceId ||
      t.worktreePath !== b.workspacePath || t.incarnationId !== e.workerIncarnation || typeof t.ptyId !== "string" || !t.ptyId ||
      x?.id !== e.resourceId || x.ownershipState !== "owned" || x.releaseState !== "not_requested" || x.retainedReason !== null ||
      x.terminalHandle !== b.terminalHandle || x.worktreeId !== b.workspaceId || x.endpointId !== b.runtimeId ||
      x.ownerDispatchId !== b.dispatchId || x.originDispatchId !== b.dispatchId || x.endpointIncarnation !== `${t.ptyId}:${e.workerIncarnation}`) return fail();
  const optional: [unknown, unknown][] = [[d.task_id, b.taskId], [d.processIncarnation, x.endpointIncarnation],
    [d.hostScope?.kind, "local"], [d.hostScope?.hostId, b.hostId], [t.executionHostId, b.hostId],
    [t.agentIdentity, b.provider], [t.orphaned, false], [w.startOptions?.agent, b.provider],
    [w.startOptions?.resolvedWorktreeId, b.workspaceId], [w.startOptions?.launch?.effective?.agent, b.provider],
    [p.id, b.dispatchId], [p.role, "worker"], [p.provider?.id, b.provider], [p.workspace?.id, b.workspaceId],
    [p.host?.kind, "local"], [p.host?.id, b.hostId], [p.stage?.dispatch, "completed"], [p.stage?.worker, "succeeded"],
    [x.releaseRequestedAt, null], [x.releaseCompletedAt, null], [x.releaseError, null]];
  for (const key of ["ownerDispatchId", "originDispatchId", "terminalHandle", "worktreeId", "endpointId", "endpointIncarnation"])
    optional.push([p.resource?.[key], x[key]]);
  if (optional.some(([v, expected]) => v !== undefined && v !== expected)) return fail();
  return { taskId: b.agenthubTaskId, bindingDigest, dispatchId: b.dispatchId, resourceId: e.resourceId,
    workerIncarnation: e.workerIncarnation, settlementSha256: e.settlementSha256,
    settlementEvidenceConsistent: true, releaseReceiptRequired: true, canReleaseWorker: false,
    currentLivenessVerified: false, chronologyVerified: false, sourceAuthenticated: false,
    approvalIssued: false, canCompleteTask: false, scope: "SUPPLIED_MANAGED_SETTLEMENT_ONLY" };
}

/** Historical receipt consistency, not proof of current exit, archive availability or permission. */
export function inspectOrcaManagedReleaseEvidence(rawBinding: string, settlement: Buffer, release: Buffer,
  expectation: ManagedSettlementExpectation & { releaseSha256: string }) {
  if (!expectation || typeof expectation !== "object" || Array.isArray(expectation) ||
      Object.keys(expectation).sort().join(",") !== "releaseSha256,resourceId,settlementSha256,workerIncarnation" ||
      !digest(expectation.releaseSha256)) return fail();
  const e = { ...expectation };
  const checked = inspectOrcaManagedSettlement(rawBinding, settlement,
    { settlementSha256: e.settlementSha256, resourceId: e.resourceId, workerIncarnation: e.workerIncarnation });
  const r = decode(release), c = r.result, { binding: b } = parseOrcaCompletionBinding(rawBinding);
  if (sha(release) !== e.releaseSha256 || r.ok !== true || r._meta?.runtimeId !== b.runtimeId ||
      c?.dispatchId !== b.dispatchId || c.state !== "released" ||
      !["closed_agent_terminal", "closed_exited_terminal"].includes(c.processAction) ||
      c.archive?.source !== "terminal" || c.archive.status !== "captured" ||
      (c.reason !== undefined && c.reason !== null) || (c.lastError !== undefined && c.lastError !== null) ||
      (c.mutation?.replayed !== undefined && c.mutation.replayed !== false)) return fail();
  const optional: [unknown, unknown][] = [[c.runId, b.runId], [c.taskId, b.taskId], [c.resourceId, e.resourceId],
    [c.terminalHandle, b.terminalHandle], [c.workerIncarnation, e.workerIncarnation], [c.worktreeId, b.workspaceId],
    [c.endpointId, b.runtimeId]];
  if (optional.some(([v, expected]) => v !== undefined && v !== expected)) return fail();
  return { ...checked, releaseSha256: e.releaseSha256, releaseReceiptRequired: false, releaseReceiptConsistent: true,
    processAction: c.processAction as "closed_agent_terminal" | "closed_exited_terminal",
    actualProcessExitVerified: false, currentResourceStateVerified: false, archiveContentVerified: false,
    scope: "SUPPLIED_MANAGED_RELEASE_RECEIPTS_ONLY" };
}
