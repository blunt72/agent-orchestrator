import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/tasks/task.js";
import { planOrcaDelivery } from "../../src/integrations/orca-delivery.js";
import { ORCA_MANIFEST_ROLES, parseOrcaCompletionBinding } from "../../src/integrations/orca-evidence-manifest.js";
import { OrcaReadOnlyStore } from "../../src/integrations/orca-read-only-store.js";
import { inspectOrcaOperationalSources, ORCA_OPERATIONAL_ROLES, type OrcaOperationalSourcePolicy,
  type OrcaOperationalSourcePin } from "../../src/integrations/orca-operational-sources.js";

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` :
  v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
const ts = (minute: number) => `2026-10-12T00:${String(minute).padStart(2, "0")}:00.000Z`;
const wrap = (v: unknown) => JSON.stringify({ chunk_id: "synthetic", exit_code: 0, original_token_count: 1,
  wall_time_seconds: 0.1, output: JSON.stringify(v) });
let root: string, sessions: string;
let f: Awaited<ReturnType<typeof fixture>>;

function journal(sessionId: string, outputs: { role: string; text: string; timestamp: string }[]) {
  const rows: any[] = [{ ordinal: 0, type: "session_meta", payload: { id: sessionId } }];
  const pins: Record<string, OrcaOperationalSourcePin> = {};
  for (const { role, text, timestamp } of outputs) {
    const ordinal = rows.length + 1, callId = `call_${role}`;
    rows.push({ ordinal: ordinal - 1, type: "response_item", payload: { type: "custom_tool_call", call_id: callId, name: "exec" } });
    const row = { ordinal, timestamp, type: "response_item", payload: { type: "custom_tool_call_output", call_id: callId,
      output: [{ type: "input_text", text }] } };
    rows.push(row);
    pins[role] = { sessionId, callId, toolName: "exec", ordinal, blockIndex: 0,
      recordSha256: sha(JSON.stringify(row) + "\n"), outputSha256: sha(text), timestamp };
  }
  return { bytes: Buffer.from(rows.map(r => JSON.stringify(r)).join("\n") + "\n"), pins };
}
async function retain(bytes: Buffer) {
  const ref = { version: 1 as const, sha256: sha(bytes), bytes: bytes.length };
  await fs.writeFile(path.join(root, "data/orca-evidence-v1", ref.sha256), bytes);
  return ref;
}
async function fixture() {
  const binding = { agenthubTaskId: "hub", projectId: "project", revision: "3", generation: 1, runtimeId: "runtime", hostId: "local",
    runId: "run", taskId: "task", dispatchId: "dispatch", workspaceId: "workspace", workspacePath: root, terminalHandle: "terminal",
    developer: "gemini" as const, reviewer: "codex" as const, provider: "antigravity" as const, ownerId: "gemini", claimId: null };
  const q = { id: "question", type: "question", delivery_contract: "current_delivery", run_id: "run", from_handle: "dispatch:dispatch",
    to_handle: "run:run", payload: JSON.stringify({ taskId: "task", dispatchId: "dispatch" }), created_at: ts(0) };
  const waiting = { runId: "run", count: 1, messages: [q], replayed: false, acknowledged: null,
    timedOut: false, cancelled: false, connectionLost: false };
  const resource = { ownerDispatchId: "dispatch", originDispatchId: "dispatch", releaseState: "not_requested" };
  const prebinding = { dispatch: { id: "dispatch", runId: "run", taskId: "task", status: "dispatched", assigneeHandle: "terminal" },
    worker: { dispatchId: "dispatch", runtimeEpoch: "runtime", agentTerminalHandle: "terminal", worktreeId: "workspace", startOptions: { agent: "antigravity" } },
    terminal: { handle: "terminal", worktreeId: "workspace", worktreePath: root },
    projection: { dispatchId: "dispatch", runId: "run", taskId: "task", provider: { id: "antigravity" }, host: { id: "local" }, workspace: { id: "workspace" } },
    observation: { exactWorker: true }, terminalResource: resource };
  const execution_reply = { message: { id: "answer", type: "status", delivery_contract: "current_delivery", run_id: "run",
    from_handle: "run:run", to_handle: "dispatch:dispatch", thread_id: "question", body: "synthetic answer", payload: null, created_at: ts(4) },
    question: { message_id: "question", run_id: "run", dispatch_id: "dispatch", asker_handle: "terminal", status: "answered",
      answer_message_id: "answer", answer_body: "synthetic answer", created_at: ts(0), answered_at: ts(4) },
    duplicate: false, mutation: { replayed: false } };
  const worker = { id: "done", type: "worker_done", delivery_contract: "current_delivery", run_id: "run", from_handle: "terminal", to_handle: "run:run",
    payload: { taskId: "task", dispatchId: "dispatch", outcome: "succeeded" }, created_at: ts(5) };
  const worker_done = { runId: "run", deliveryId: "delivery", count: 1, messages: [worker], replayed: false, acknowledged: null,
    timedOut: false, cancelled: false, connectionLost: false };
  const settlement = { dispatch: { ...prebinding.dispatch, status: "completed", completedAt: ts(5), hostScope: { kind: "local", hostId: "local" } },
    worker: { ...prebinding.worker, state: "succeeded", stage: "settled" },
    projection: { ...prebinding.projection, id: "dispatch", role: "worker", host: { kind: "local", id: "local" }, outcome: "succeeded",
      stage: { dispatch: "completed", worker: "succeeded" }, evidence: { durable: true }, resource: { terminalState: "reclaimable" } },
    terminal: prebinding.terminal, terminalResource: resource };
  const cleanup = { dispatchId: "dispatch", state: "released", processAction: "closed_agent_terminal", archive: { source: "terminal", status: "captured" },
    mutation: { replayed: false } };
  const values: Record<string, any> = { waiting, prebinding, execution_reply, worker_done, settlement, cleanup };
  const outputs = ORCA_OPERATIONAL_ROLES.map((role, i) => ({ role, timestamp: ts([0, 1, 4, 5, 6, 7][i]),
    text: wrap({ id: role, ok: true, _meta: { runtimeId: "runtime" }, result: values[role] }) }));
  const coordinator = journal("11111111-1111-4111-8111-111111111111", outputs);
  await fs.writeFile(path.join(sessions, "coordinator.jsonl"), coordinator.bytes);
  const ackReceipt: any = { taskId: "hub", revision: 3, bound: true, baselineVerified: true, developmentReleased: false };
  const mechanism = journal("22222222-2222-4222-8222-222222222222", [{ role: "ack", timestamp: ts(3), text: wrap(ackReceipt) }]);
  await fs.writeFile(path.join(sessions, "mechanism.jsonl"), mechanism.bytes);
  const baseline = { version: 1, taskId: "hub", generation: 1, bindingRevision: "3", workspacePath: root, capturedAt: ts(2),
    provenance: "LOCAL_PRE_BINDING_SNAPSHOT", head: "a".repeat(40), files: {}, allowedFiles: ["synthetic.ts"] };
  const baselineBytes = Buffer.from(JSON.stringify(baseline)), baselineRef = await retain(baselineBytes);
  const baselineReceipt = { version: 1, evidence: baselineRef, workspaceHash: sha(JSON.stringify({ head: baseline.head, files: [] })) };
  const confirmation: any = { taskId: "hub", status: "DOING", revision: 3, binding, baseline: baselineReceipt, authorizationQuestion: "question",
    developmentReleased: false, canCompleteTask: false, sourceAuthenticated: false };
  const plan = planOrcaDelivery(binding, { taskId: "hub", projectId: "project", revision: "3", generation: 1, status: "DOING",
    ownerId: "gemini", claimId: null, reviewerId: "codex" }, worker, { ok: true, _meta: { runtimeId: "runtime" }, result: settlement });
  if (plan.kind !== "candidate") throw Error("INVALID_SYNTHETIC_PLAN");
  const task = { id: "hub", projectId: "project", revision: 10, status: "REVIEW", ownerId: "gemini", reviewerId: "codex", workspace: root,
    orcaGeneration: 1, orcaBinding: binding, orcaBaseline: baselineReceipt,
    orcaDelivery: { digest: plan.digest, messageId: "done", dispatchId: "dispatch", generation: 1, bindingRevision: "3" } } as Task;
  const retained: Record<string, Buffer> = { startup_wait: Buffer.from(outputs[0].text), binding_confirmation: Buffer.from(JSON.stringify(confirmation)),
    worker_done: Buffer.from(outputs[3].text), settlement: Buffer.from(outputs[4].text), cleanup: Buffer.from(outputs[5].text),
    test_output: Buffer.from("synthetic test output"), review_response: Buffer.from("synthetic review response") };
  const bindingDigest = parseOrcaCompletionBinding(JSON.stringify(binding)).digest;
  const entries = [];
  for (const role of ORCA_MANIFEST_ROLES) entries.push({ role, source: "LOCAL_ORIGINAL_BYTES_UNAUTHENTICATED", mediaType: "application/json", schemaVersion: 1,
    taskId: "hub", dispatchId: "dispatch", runId: "run", capturedAt: ts(8), sourceReceipt: role, evidence: await retain(retained[role]) });
  const manifest = { version: 1, bindingDigest, entries };
  const policy: OrcaOperationalSourcePolicy = { version: 1, coordinator: { relativeFile: "coordinator.jsonl", sourceSha256: sha(coordinator.bytes),
    selectors: coordinator.pins as OrcaOperationalSourcePolicy["coordinator"]["selectors"] },
    mechanism: { relativeFile: "mechanism.jsonl", bindingAck: mechanism.pins.ack } };
  const enrollment = { version: 1, purpose: "LOCAL_HUMAN_SUPERVISED_PILOT_ENROLLMENT", registeredAt: ts(8),
    operator: { namespace: "agenthub-local-operator-v1", subject: "aaaaaaaa-0000-4000-8000-000000000005" },
    scope: { taskId: "hub", projectId: "project", generation: 1, bindingDigest },
    evidenceRoots: [sessions, path.join(root, "data/orca-evidence-v1")], authorizationBasis: "synthetic fixture only, NOT provider E2E",
    sourceAuthenticated: false, canCompleteTask: false };
  await fs.writeFile(path.join(root, "data/orca-trust-v1/enrollment.json"), JSON.stringify(enrollment), { mode: 0o600 });
  return { task, binding, values, outputs, coordinator, mechanism, ackReceipt, baseline, baselineBytes, confirmation, retained, policy, manifest, enrollment };
}
const run = (rawPolicy = JSON.stringify(f.policy), task = f.task) => inspectOrcaOperationalSources(root, sessions, task,
  JSON.stringify(f.manifest), sha(canonical(f.manifest)), rawPolicy);
async function replaceRetained(role: string, bytes: Buffer) {
  f.manifest.entries.find(e => e.role === role)!.evidence = await retain(bytes);
}
async function repinAck(timestamp = ts(3), text = wrap(f.ackReceipt)) {
  const source = journal(f.policy.mechanism.bindingAck.sessionId, [{ role: "ack", timestamp, text }]);
  f.policy.mechanism.bindingAck = source.pins.ack;
  await fs.writeFile(path.join(sessions, "mechanism.jsonl"), source.bytes);
}
async function repinCoordinator() {
  const source = journal(f.policy.coordinator.selectors.waiting.sessionId, f.outputs);
  f.policy.coordinator.sourceSha256 = sha(source.bytes);
  f.policy.coordinator.selectors = source.pins as typeof f.policy.coordinator.selectors;
  await fs.writeFile(path.join(sessions, "coordinator.jsonl"), source.bytes);
}
async function inventory(folder: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await fs.readdir(folder)).sort()) {
    const file = path.join(folder, name), stat = await fs.lstat(file);
    result.push([name, stat.mode, stat.isDirectory() ? await inventory(file) : sha(await fs.readFile(file))]);
  }
  return result;
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orca-operational-synthetic-")));
  sessions = path.join(root, "sessions");
  for (const folder of [sessions, path.join(root, "data/orca-evidence-v1"), path.join(root, "data/orca-trust-v1")])
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  f = await fixture();
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe("operational source inspection (synthetic temporary journals, NOT provider E2E)", () => {
  it("validates actual confined sources and all retained bytes without task reads or writes", async () => {
    const before = await inventory(root), raw = JSON.stringify(f.policy);
    vi.spyOn(OrcaReadOnlyStore.prototype, "getTask").mockRejectedValue(Error("UNEXPECTED_TASK_READ"));
    const result = await run(raw);
    expect(result).toEqual({ revalidate: expect.any(Function), policyDigest: sha(raw), evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      observedSourceDigests: { coordinator: sha(f.coordinator.bytes), mechanism: sha(f.mechanism.bytes) },
      localSourcesConsistent: true, sourceAuthenticated: false, trustedClock: false, permissionDigestBound: false,
      canCompleteTask: false, scope: "LIMITED_LOCAL_OPERATIONAL_SOURCES" });
    expect(await inventory(root)).toEqual(before);
  });
  it("returns stable evidence identity across valid mechanism appends", async () => {
    const first = await run();
    await fs.appendFile(path.join(sessions, "mechanism.jsonl"), JSON.stringify({ ordinal: 3, type: "event_msg", payload: { type: "synthetic_append" } }) + "\n");
    const second = await run();
    expect(second.evidenceDigest).toBe(first.evidenceDigest); expect(second.policyDigest).toBe(first.policyDigest);
    expect(second.observedSourceDigests.mechanism).not.toBe(first.observedSourceDigests.mechanism);
    expect(second.observedSourceDigests.coordinator).toBe(first.observedSourceDigests.coordinator);
  });
  it("validates a mechanism journal larger than 32 MiB and retains stable pins", async () => {
    const parts = [f.mechanism.bytes];
    for (let i = 3; i < 70; i++) parts.push(Buffer.from(JSON.stringify({ ordinal: i, type: "event_msg", payload: { padding: "x".repeat(512 * 1024) } }) + "\n"));
    const bytes = Buffer.concat(parts);
    expect(bytes.length).toBeGreaterThan(32 * 1024 * 1024);
    const first = await run();
    await fs.writeFile(path.join(sessions, "mechanism.jsonl"), bytes);
    const result = await run();
    expect(result.observedSourceDigests.mechanism).toBe(sha(bytes)); expect(result.evidenceDigest).toBe(first.evidenceDigest);
  }, 30000);
  it("allows the supplied saved REVIEW snapshot without requiring a disk REVIEW task", async () => {
    await fs.mkdir(path.join(root, "data/tasks"));
    await fs.writeFile(path.join(root, "data/tasks/hub.json"), JSON.stringify({ ...f.task, status: "DONE", revision: 11, result: { status: "PASS" } }));
    expect((await run()).localSourcesConsistent).toBe(true);
  });
  it.each(["coordinatorSource", "coordinatorRecord", "coordinatorBlock", "coordinatorTimestamp", "ackRecord", "ackBlock", "ackTimestamp"])("rejects a stale %s pin", async kind => {
    if (kind === "coordinatorSource") f.policy.coordinator.sourceSha256 = "0".repeat(64);
    if (kind === "coordinatorRecord") f.policy.coordinator.selectors.waiting.recordSha256 = "0".repeat(64);
    if (kind === "coordinatorBlock") f.policy.coordinator.selectors.waiting.outputSha256 = "0".repeat(64);
    if (kind === "coordinatorTimestamp") f.policy.coordinator.selectors.waiting.timestamp = ts(1);
    if (kind === "ackRecord") f.policy.mechanism.bindingAck.recordSha256 = "0".repeat(64);
    if (kind === "ackBlock") f.policy.mechanism.bindingAck.outputSha256 = "0".repeat(64);
    if (kind === "ackTimestamp") f.policy.mechanism.bindingAck.timestamp = ts(2);
    await expect(run()).rejects.toThrow();
  });
  it("rejects changed ack records even when the selected block is unchanged", async () => {
    const rows = f.mechanism.bytes.toString().trimEnd().split("\n").map(r => JSON.parse(r));
    rows[2].timestamp = "2026-10-12T00:03:00.001Z";
    await fs.writeFile(path.join(sessions, "mechanism.jsonl"), rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    await expect(run()).rejects.toThrow("INVALID_ORCA_OPERATIONAL_SOURCES");
  });
  it.each(["taskId", "revision", "bound", "baselineVerified", "developmentReleased", "extra", "missing", "stringRevision"])("rejects wrong ack semantics %s with fresh pins", async key => {
    if (key === "extra") f.ackReceipt.extra = true;
    else if (key === "missing") delete f.ackReceipt.baselineVerified;
    else if (key === "stringRevision") f.ackReceipt.revision = "3";
    else f.ackReceipt[key] = key === "taskId" ? "other" : key === "revision" ? 10 : !f.ackReceipt[key];
    await repinAck(); await expect(run()).rejects.toThrow("INVALID_ORCA_OPERATIONAL_SOURCES");
  });
  it.each([ts(1), ts(2), ts(4), ts(5)])("rejects ack outside the strict baseline/answer interval: %s", async timestamp => {
    await repinAck(timestamp); await expect(run()).rejects.toThrow("INVALID_ORCA_OPERATIONAL_SOURCES");
  });
  it.each(["startup_wait", "worker_done", "settlement", "cleanup"])("rejects different original manifest %s bytes even with valid new manifest integrity", async role => {
    await replaceRetained(role, Buffer.concat([f.retained[role], Buffer.from(" ")]));
    await expect(run()).rejects.toThrow("INVALID_ORCA_OPERATIONAL_SOURCES");
  });
  it.each(["binding", "baseline", "revision", "question", "released"])("rejects original binding confirmation mismatch %s", async kind => {
    if (kind === "binding") f.confirmation.binding = { ...f.binding, dispatchId: "other" };
    if (kind === "baseline") f.confirmation.baseline = { ...f.confirmation.baseline, workspaceHash: "0".repeat(64) };
    if (kind === "revision") f.confirmation.revision = 4;
    if (kind === "question") f.confirmation.authorizationQuestion = "other";
    if (kind === "released") f.confirmation.developmentReleased = true;
    await replaceRetained("binding_confirmation", Buffer.from(JSON.stringify(f.confirmation)));
    await expect(run()).rejects.toThrow();
  });
  it.each(["chronology", "runtime", "answerThread"])("reuses chronology semantics for %s even after repinning source bytes", async kind => {
    if (kind === "chronology") f.outputs[5].timestamp = ts(3);
    if (kind === "runtime") f.outputs[1].text = wrap({ ok: true, _meta: { runtimeId: "other" }, result: f.values.prebinding });
    if (kind === "answerThread") {
      f.values.execution_reply.message.thread_id = "other";
      f.outputs[2].text = wrap({ ok: true, _meta: { runtimeId: "runtime" }, result: f.values.execution_reply });
    }
    await repinCoordinator(); await expect(run()).rejects.toThrow("INVALID_ORCA_LIFECYCLE_CHRONOLOGY");
  });
  it.each(["status", "project", "generation", "owner", "reviewer", "claim", "workspace", "baseline", "delivery"])("rejects passed task mismatch %s", async key => {
    if (key === "status") f.task.status = "DONE";
    if (key === "project") f.task.projectId = "other";
    if (key === "generation") f.task.orcaGeneration = 2;
    if (key === "owner") f.task.ownerId = "other";
    if (key === "reviewer") f.task.reviewerId = "other";
    if (key === "claim") f.task.claim = { id: "other", ownerId: "gemini", previousOwnerId: "user", claimedAt: ts(0) };
    if (key === "workspace") f.task.workspace = "/other";
    if (key === "baseline") f.task.orcaBaseline!.workspaceHash = "0".repeat(64);
    if (key === "delivery") f.task.orcaDelivery!.digest = "0".repeat(64);
    await expect(run()).rejects.toThrow();
  });
  it.each(["taskId", "bindingRevision", "workspacePath", "generation", "files"])("rejects retained baseline identity/integrity mismatch %s", async key => {
    const b: any = { ...f.baseline, [key]: key === "generation" ? 2 : key === "files" ? { "../escape": {} } : "other" };
    f.task.orcaBaseline!.evidence = await retain(Buffer.from(JSON.stringify(b)));
    f.confirmation.baseline = f.task.orcaBaseline;
    await replaceRetained("binding_confirmation", Buffer.from(JSON.stringify(f.confirmation)));
    await expect(run()).rejects.toThrow("INVALID_ORCA_OPERATIONAL_SOURCES");
  });
  it.each(["top", "coordinator", "mechanism", "selector", "ack", "missingRole", "invalidTime", "absolute", "traversal", "extraSourceHash"])("rejects nonexact/malformed policy %s", async kind => {
    const p: any = f.policy;
    if (kind === "top") p.extra = true;
    if (kind === "coordinator") p.coordinator.extra = true;
    if (kind === "mechanism") p.mechanism.extra = true;
    if (kind === "selector") p.coordinator.selectors.waiting.extra = true;
    if (kind === "ack") p.mechanism.bindingAck.extra = true;
    if (kind === "missingRole") delete p.coordinator.selectors.cleanup;
    if (kind === "invalidTime") p.mechanism.bindingAck.timestamp = "2026-02-30T00:00:00Z";
    if (kind === "absolute") p.mechanism.relativeFile = path.join(sessions, "mechanism.jsonl");
    if (kind === "traversal") p.mechanism.relativeFile = "../mechanism.jsonl";
    if (kind === "extraSourceHash") p.mechanism.sourceSha256 = sha(f.mechanism.bytes);
    await expect(run()).rejects.toThrow("INVALID_ORCA_OPERATIONAL_SOURCES");
  });
  it("rejects duplicate JSON keys, oversized policy and invalid Unicode", async () => {
    const raw = JSON.stringify(f.policy);
    for (const bad of [raw.replace('"version":1', '"version":1,"version":1'), raw + " ".repeat(32769),
      raw.replace("coordinator.jsonl", "\ud800.jsonl"), "{}", null, 123]) await expect(run(bad as string)).rejects.toThrow();
  });
  it.each(["symlinkFile", "symlinkDirectory", "hardlink", "rootAlias"])("rejects source confinement failure %s", async kind => {
    const file = path.join(sessions, "mechanism.jsonl");
    if (kind === "symlinkFile") {
      await fs.rename(file, path.join(root, "outside.jsonl")); await fs.symlink(path.join(root, "outside.jsonl"), file);
    }
    if (kind === "symlinkDirectory") {
      await fs.symlink(root, path.join(sessions, "alias")); f.policy.mechanism.relativeFile = "alias/sessions/mechanism.jsonl";
    }
    if (kind === "hardlink") await fs.link(file, path.join(root, "hardlink.jsonl"));
    if (kind === "rootAlias") {
      await fs.symlink(sessions, path.join(root, "sessions-alias")); sessions = path.join(root, "sessions-alias");
    }
    await expect(run()).rejects.toThrow();
  });
  it.each(["coordinator", "mechanism"])("rejects %s truncation/malformed tail despite preserved selected records", async source => {
    const file = path.join(sessions, `${source}.jsonl`), original = await fs.readFile(file);
    for (const bytes of [original.subarray(0, original.length - 1), Buffer.concat([original, Buffer.from("{bad}\n")]),
      Buffer.concat([original, Buffer.from([0xff, 0x0a])]), Buffer.concat([original, Buffer.from('{"ordinal":1,"type":"event_msg","payload":{}}\n')])]) {
      await fs.writeFile(file, bytes);
      if (source === "coordinator") f.policy.coordinator.sourceSha256 = sha(bytes);
      await expect(run()).rejects.toThrow();
    }
  });
  it.each(["coordinator", "mechanism"])("rejects %s exceeding its independent byte bound before buffering", async source => {
    const handle = await fs.open(path.join(sessions, `${source}.jsonl`), "r+");
    try { await handle.truncate((source === "coordinator" ? 32 : 64) * 1024 * 1024 + 1); } finally { await handle.close(); }
    await expect(run()).rejects.toThrow("INVALID_ORCA_OPERATIONAL_SOURCES");
  });
  it("rejects source replacement between lstat and secure open", async () => {
    const original = fs.open; let changed = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith("coordinator.jsonl") && !changed) {
        changed = true; await fs.rename(String(args[0]), path.join(sessions, "old.jsonl"));
        await fs.writeFile(String(args[0]), f.coordinator.bytes);
      }
      return Reflect.apply(original, fs, args);
    });
    await expect(run()).rejects.toThrow("INVALID_ORCA_OPERATIONAL_SOURCES"); expect(changed).toBe(true);
  });
  it.each(["task", "source", "enrollment", "manifest-delete", "manifest-replace", "baseline-delete", "baseline-replace"])("rejects %s drift during the final asynchronous evidence read", async kind => {
    const original = OrcaReadOnlyStore.prototype.readOrcaEvidence; let baselines = 0;
    vi.spyOn(OrcaReadOnlyStore.prototype, "readOrcaEvidence").mockImplementation(async function (this: OrcaReadOnlyStore, ref) {
      const bytes = await original.call(this, ref);
      if (ref.sha256 === f.task.orcaBaseline!.evidence.sha256 && ++baselines === 2) {
        if (kind === "task") f.task.revision = 11;
        if (kind === "source") await fs.appendFile(path.join(sessions, "mechanism.jsonl"), '{"ordinal":3,"type":"event_msg","payload":{}}\n');
        if (kind === "enrollment") {
          f.enrollment.operator.subject = "11111111-1111-4111-8111-111111111111";
          await fs.writeFile(path.join(root, "data/orca-trust-v1/enrollment.json"), JSON.stringify(f.enrollment));
        }
        if (kind.startsWith("manifest-") || kind.startsWith("baseline-")) {
          const target = path.join(root, "data/orca-evidence-v1", kind.startsWith("manifest-")
            ? f.manifest.entries[0].evidence.sha256 : ref.sha256);
          if (kind.endsWith("delete")) await fs.unlink(target);
          else { const sameBytes = await fs.readFile(target); await fs.rename(target, target + ".old"); await fs.writeFile(target, sameBytes); }
        }
      }
      return bytes;
    });
    await expect(run()).rejects.toThrow("INVALID_ORCA_OPERATIONAL_SOURCES"); expect(baselines).toBe(2);
  });
  it("retains deferred guards after return without persisting a function as evidence", async () => {
    const inspection = await run();
    const { revalidate, ...proof } = inspection;
    expect(typeof revalidate).toBe("function"); expect(proof.localSourcesConsistent).toBe(true);
    await fs.unlink(path.join(root, "data/orca-evidence-v1", f.manifest.entries[0].evidence.sha256));
    expect(revalidate).toThrow("INVALID_ORCA_OPERATIONAL_SOURCES");
    expect(JSON.stringify(proof)).not.toContain("revalidate");
  });
  it("rejects an enrollment for a different binding", async () => {
    f.enrollment.scope.bindingDigest = "0".repeat(64);
    await fs.writeFile(path.join(root, "data/orca-trust-v1/enrollment.json"), JSON.stringify(f.enrollment));
    await expect(run()).rejects.toThrow("INVALID_LOCAL_ENROLLMENT");
  });
  it("rejects a stale manifest digest and missing retained evidence", async () => {
    await expect(inspectOrcaOperationalSources(root, sessions, f.task, JSON.stringify(f.manifest), "0".repeat(64), JSON.stringify(f.policy)))
      .rejects.toThrow("STALE_ORCA_MANIFEST");
    await fs.unlink(path.join(root, "data/orca-evidence-v1", f.manifest.entries[0].evidence.sha256));
    await expect(run()).rejects.toThrow();
  });
});
