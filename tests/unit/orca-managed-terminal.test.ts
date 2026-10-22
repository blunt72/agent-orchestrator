import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { inspectOrcaManagedSettlement, inspectOrcaManagedReleaseEvidence } from "../../src/integrations/orca-managed-terminal.js";
const incarnation = "11111111-1111-4111-8111-111111111111";
const binding = { agenthubTaskId: "task", projectId: "project", revision: "4", generation: 1, runtimeId: "runtime", hostId: "local",
  runId: "run", taskId: "orca-task", dispatchId: "dispatch", workspaceId: "workspace", workspacePath: "/workspace",
  terminalHandle: "terminal", developer: "codex", reviewer: "gemini", provider: "codex", ownerId: "codex", claimId: null };
const encode = (v: unknown) => Buffer.from(JSON.stringify(v));
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function fixture(): any { return { settlement: { ok: true, _meta: { runtimeId: "runtime" }, result: {
  dispatch: { id: "dispatch", runId: "run", taskId: "orca-task", assigneeHandle: "terminal", status: "completed" },
  worker: { dispatchId: "dispatch", runtimeEpoch: "runtime", agentTerminalHandle: "terminal", worktreeId: "workspace", state: "succeeded", stage: "settled" },
  projection: { dispatchId: "dispatch", runId: "run", taskId: "orca-task", outcome: "succeeded",
    resource: { id: "resource", state: "owned", releaseState: "not_requested", terminalState: "reclaimable" } },
  terminal: { handle: "terminal", worktreeId: "workspace", worktreePath: "/workspace", incarnationId: incarnation, ptyId: "pty" },
  terminalResource: { id: "resource", ownershipState: "owned", releaseState: "not_requested", retainedReason: null,
    terminalHandle: "terminal", worktreeId: "workspace", endpointId: "runtime", endpointIncarnation: `pty:${incarnation}`,
    ownerDispatchId: "dispatch", originDispatchId: "dispatch" }
} }, release: { ok: true, _meta: { runtimeId: "runtime" }, result: { dispatchId: "dispatch", state: "released",
  processAction: "closed_agent_terminal", archive: { source: "terminal", status: "captured" }, mutation: { replayed: false } } } }; }
function args(f = fixture()) {
  const s = encode(f.settlement), r = encode(f.release);
  return [JSON.stringify(binding), s, r, { settlementSha256: hash(s), releaseSha256: hash(r), workerIncarnation: incarnation, resourceId: "resource" }] as const;
}
it("synthetic settlement remains unreleased and grants no lifecycle or completion authority", () => {
  const [b, s, , e] = args();
  const r = inspectOrcaManagedSettlement(b, s, { settlementSha256: e.settlementSha256, workerIncarnation: incarnation, resourceId: "resource" });
  expect(r).toMatchObject({ settlementEvidenceConsistent: true, releaseReceiptRequired: true, canReleaseWorker: false,
    currentLivenessVerified: false, chronologyVerified: false, sourceAuthenticated: false, approvalIssued: false, canCompleteTask: false });
});
it.each(["closed_agent_terminal", "closed_exited_terminal"])("matches supplied %s receipts without proving current exit or archive bytes", action => {
  const f = fixture(); f.release.result.processAction = action;
  expect(inspectOrcaManagedReleaseEvidence(...args(f))).toMatchObject({ releaseReceiptConsistent: true, releaseReceiptRequired: false,
    actualProcessExitVerified: false, currentResourceStateVerified: false, archiveContentVerified: false, canReleaseWorker: false, canCompleteTask: false });
});
it.each([
  ["dispatch", "id", "other"], ["dispatch", "runId", "other"], ["dispatch", "taskId", "other"],
  ["dispatch", "status", "dispatched"], ["dispatch", "assigneeHandle", "other"],
  ["worker", "state", "failed"], ["worker", "stage", "input_accepted"], ["worker", "runtimeEpoch", "other"],
  ["terminal", "incarnationId", "other"], ["terminal", "worktreePath", "/other"],
  ["terminalResource", "id", "other"], ["terminalResource", "ownershipState", "user_owned"],
  ["terminalResource", "releaseState", "retained"], ["terminalResource", "retainedReason", "user_takeover"],
  ["terminalResource", "endpointIncarnation", "other"], ["terminalResource", "ownerDispatchId", "other"],
  ["terminalResource", "originDispatchId", "other"]
])("rejects settlement %s.%s contradiction with recomputed byte pins", (section, key, value) => {
  const f = fixture(); f.settlement.result[section][key] = value;
  expect(() => inspectOrcaManagedReleaseEvidence(...args(f))).toThrow();
});
it.each(["state", "id", "releaseState", "terminalState", "ownerDispatchId", "originDispatchId", "terminalHandle", "worktreeId", "endpointId", "endpointIncarnation"])
  ("rejects contradictory projected resource %s", key => {
    const f = fixture(); f.settlement.result.projection.resource[key] = "other";
    expect(() => inspectOrcaManagedReleaseEvidence(...args(f))).toThrow();
  });
it.each(["retained", "already_released", "release_pending", "release_unknown", "stopped"])("rejects release outcome %s", state => {
  const f = fixture(); f.release.result.state = state; expect(() => inspectOrcaManagedReleaseEvidence(...args(f))).toThrow();
});
it.each(["runtime", "archive-source", "archive-status", "process", "reason", "error", "replay"])("rejects release %s", key => {
  const f = fixture(), r = f.release.result;
  if (key === "runtime") f.release._meta.runtimeId = "other";
  if (key === "archive-source") r.archive.source = "provider_transcript";
  if (key === "archive-status") r.archive.status = "pending";
  if (key === "process") r.processAction = "none";
  if (key === "reason") r.reason = "user_takeover";
  if (key === "error") r.lastError = "unknown";
  if (key === "replay") r.mutation.replayed = true;
  expect(() => inspectOrcaManagedReleaseEvidence(...args(f))).toThrow();
});
it.each(["runId", "taskId", "resourceId", "terminalHandle", "workerIncarnation", "worktreeId", "endpointId"])("rejects optional release identity %s", key => {
  const f = fixture(); f.release.result[key] = "other"; expect(() => inspectOrcaManagedReleaseEvidence(...args(f))).toThrow();
});
it.each(["provider", "orphaned", "agent", "host", "incarnation"])("rejects optional settlement identity %s", key => {
  const f = fixture(), s = f.settlement.result;
  if (key === "provider") s.terminal.agentIdentity = "other";
  if (key === "orphaned") s.terminal.orphaned = true;
  if (key === "agent") s.worker.startOptions = { launch: { effective: { agent: "other" } } };
  if (key === "host") s.projection.host = { kind: "remote", id: "local" };
  if (key === "incarnation") s.dispatch.processIncarnation = "other";
  expect(() => inspectOrcaManagedReleaseEvidence(...args(f))).toThrow();
});
it("rejects fixed-pin mismatches, schema expansion, invalid bytes, oversized and non-buffer callers", () => {
  const [b, s, r, e] = args();
  expect(() => inspectOrcaManagedReleaseEvidence(b, s, r, { ...e, settlementSha256: "b".repeat(64) })).toThrow();
  expect(() => inspectOrcaManagedReleaseEvidence(b, s, r, { ...e, releaseSha256: "b".repeat(64) })).toThrow();
  for (const key of ["settlementSha256", "releaseSha256", "workerIncarnation", "resourceId"])
    expect(() => inspectOrcaManagedReleaseEvidence(b, s, r, { ...e, [key]: e[key as keyof typeof e] + "\n" })).toThrow();
  expect(() => inspectOrcaManagedReleaseEvidence(b, s, r, { ...e, approve: true } as any)).toThrow();
  expect(() => inspectOrcaManagedReleaseEvidence(JSON.stringify({ ...binding, hostId: "remote" }), s, r, e)).toThrow();
  for (const bad of [Buffer.alloc(262145), Buffer.from([255]), Buffer.from('{"ok":true,"ok":true}'), Buffer.alloc(0), "not-buffer" as any]) {
    expect(() => inspectOrcaManagedReleaseEvidence(b, bad, r, e)).toThrow();
    expect(() => inspectOrcaManagedReleaseEvidence(b, s, bad, e)).toThrow();
  }
});
