import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const stages = vi.hoisted(() => ({ acceptance: vi.fn(), attribution: vi.fn(), fingerprint: vi.fn() }));
vi.mock("../../src/integrations/orca-acceptance.js", async original => ({ ...await original<any>(), inspectOrcaAcceptance: stages.acceptance }));
vi.mock("../../src/integrations/orca-baseline.js", () => ({ inspectOrcaFileAttribution: stages.attribution }));
vi.mock("../../src/integrations/orca-tests.js", async original => ({ ...await original<any>(), fingerprintOrcaWorkspace: stages.fingerprint }));
import { inspectOrcaUnifiedPreflight } from "../../src/integrations/orca-unified-preflight.js";
import { inspectOrcaDeliveryEvidenceBytes } from "../../src/integrations/orca-delivery-evidence.js";
import { OrcaEvidenceStore } from "../../src/integrations/orca-evidence.js";
import { planOrcaDelivery } from "../../src/integrations/orca-delivery.js";
import { parseOrcaCompletionBinding, ORCA_MANIFEST_ROLES } from "../../src/integrations/orca-evidence-manifest.js";
import { hashOrcaTestRun } from "../../src/integrations/orca-review.js";
import { hashOrcaReviewRun } from "../../src/integrations/orca-acceptance.js";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const operator = { namespace: "agenthub-local-operator-v1" as const, subject: "11111111-1111-4111-8111-111111111111" };
// Independent replacer oracle for manifest canonical encoding.
const manifestKeys = ["bindingDigest", "bytes", "capturedAt", "dispatchId", "entries", "evidence", "mediaType", "role", "runId", "schemaVersion", "sha256", "source", "sourceReceipt", "taskId", "version"];
let root: string, artifacts: OrcaEvidenceStore, task: any, approval: any, manifest: any, store: any;
beforeEach(async () => {
  vi.clearAllMocks(); root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orca-unified-"))); artifacts = new OrcaEvidenceStore(root);
  const binding: any = { agenthubTaskId: "task", projectId: "project", revision: "2", generation: 1, runtimeId: "runtime", hostId: "local", runId: "run", taskId: "orca-task", dispatchId: "dispatch", workspaceId: "workspace", workspacePath: "/synthetic", terminalHandle: "terminal", developer: "gemini", reviewer: "codex", provider: "antigravity", ownerId: "gemini", claimId: null };
  const message = { id: "message", type: "worker_done", run_id: "run", from_handle: "terminal", to_handle: "run:run", payload: { taskId: "orca-task", dispatchId: "dispatch", outcome: "succeeded" } };
  const receipt = { ok: true, _meta: { runtimeId: "runtime" }, result: {
    dispatch: { id: "dispatch", runId: "run", taskId: "orca-task", assigneeHandle: "terminal", hostScope: { kind: "local", hostId: "local" }, status: "completed", completedAt: "2026-10-12T00:00:00.000Z" },
    worker: { dispatchId: "dispatch", runtimeEpoch: "runtime", worktreeId: "workspace", agentTerminalHandle: "terminal", startOptions: { agent: "antigravity" }, state: "succeeded", stage: "settled" },
    projection: { id: "dispatch", dispatchId: "dispatch", taskId: "orca-task", runId: "run", role: "worker", host: { kind: "local", id: "local" }, workspace: { id: "workspace" }, provider: { id: "antigravity" }, outcome: "succeeded", stage: { dispatch: "completed", worker: "succeeded" }, evidence: { durable: true } }, terminal: { handle: "terminal", worktreeId: "workspace", worktreePath: "/synthetic" } } };
  const plan = planOrcaDelivery(binding, { taskId: "task", projectId: "project", revision: "2", generation: 1, status: "DOING", ownerId: "gemini", claimId: null, reviewerId: "codex" }, message, receipt);
  if (plan.kind !== "candidate") throw Error();
  const output = await artifacts.put(Buffer.from("synthetic test output"));
  const tests: any = { id: "22222222-2222-4222-8222-222222222222", workspaceHash: "b".repeat(64), outputEvidence: output, outputHash: output.sha256 };
  const testHash = hashOrcaTestRun(tests);
  const response = JSON.stringify({ reviewId: "33333333-3333-4333-8333-333333333333", taskId: "task", digest: plan.digest, generation: 1, workspaceHash: tests.workspaceHash, testRunId: tests.id, testRunHash: testHash, verdict: "PASS" });
  const review: any = { id: "33333333-3333-4333-8333-333333333333", responseHash: sha(response) };
  const baseline = await artifacts.put(Buffer.from(JSON.stringify({ allowedFiles: ["test.ts"] })));
  task = { id: "task", revision: 10, orcaBinding: binding, orcaDelivery: { digest: plan.digest, messageId: "message" }, orcaTestRun: tests, orcaReviewRun: review, orcaBaseline: { evidence: baseline } };
  const entries = [];
  for (const role of ORCA_MANIFEST_ROLES) entries.push({ role, source: "LOCAL_ORIGINAL_BYTES_UNAUTHENTICATED", mediaType: "application/json", schemaVersion: 1, taskId: "task", dispatchId: "dispatch", runId: "run", capturedAt: "2026-10-12T00:00:00.000Z", sourceReceipt: role === "worker_done" ? "message" : role,
    evidence: role === "test_output" ? output : await artifacts.put(Buffer.from(role === "worker_done" ? JSON.stringify(message) : role === "settlement" ? JSON.stringify(receipt) : role === "review_response" ? response : "synthetic unverified")) });
  const bindingDigest = parseOrcaCompletionBinding(JSON.stringify(binding)).digest;
  manifest = { version: 1, bindingDigest, entries };
  approval = { version: 1, purpose: "SCOPED_ORCA_PILOT_COMPLETION", approvalId: "44444444-4444-4444-8444-444444444444", approvedAt: "2026-10-12T00:00:00.000Z", operator, taskId: "task", projectId: "project", dispatchId: "dispatch", runId: "run", runtimeId: "runtime", orcaTaskId: "orca-task", ownerId: "gemini", reviewerId: "codex", claimId: null, expectedRevision: 10, generation: 1, bindingDigest, deliveryDigest: plan.digest, testReceiptDigest: testHash, reviewReceiptDigest: hashOrcaReviewRun(review), workspaceDigest: tests.workspaceHash, baselineDigest: baseline.sha256, manifestDigest: sha(JSON.stringify(manifest, manifestKeys)), allowedFiles: ["test.ts"] };
  stages.acceptance.mockResolvedValue({}); stages.attribution.mockResolvedValue({ withinWhitelist: true, workspaceHash: tests.workspaceHash, baselineHash: baseline.sha256 }); stages.fingerprint.mockResolvedValue(tests.workspaceHash);
  store = { getTask: vi.fn(async () => structuredClone(task)), readOrcaEvidence: (ref: any) => artifacts.read(ref), saveTask: vi.fn(), appendTaskEventOnce: vi.fn() };
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const run = () => inspectOrcaUnifiedPreflight(store, "task", JSON.stringify(approval), JSON.stringify(manifest), [operator]);
async function wrapDelivery(mutate: (worker: any, settlement: any) => void = () => {}) {
  const workerEntry = manifest.entries.find((e: any) => e.role === "worker_done");
  const settlementEntry = manifest.entries.find((e: any) => e.role === "settlement");
  const message = JSON.parse((await artifacts.read(workerEntry.evidence)).toString());
  message.delivery_contract = "current_delivery";
  const envelope = { id: "receipt", ok: true, _meta: { runtimeId: "runtime" }, result: {
    runId: "run", deliveryId: "delivery", count: 1, messages: [message], replayed: false,
    acknowledged: null, timedOut: false, cancelled: false, connectionLost: false } };
  const wrap = (output: string) => ({ chunk_id: "chunk", exit_code: 0, original_token_count: 10, wall_time_seconds: 0.1, output });
  const worker = wrap(JSON.stringify(envelope)), settlement = wrap((await artifacts.read(settlementEntry.evidence)).toString());
  mutate(worker, settlement);
  workerEntry.evidence = await artifacts.put(Buffer.from(JSON.stringify(worker)));
  settlementEntry.evidence = await artifacts.put(Buffer.from(JSON.stringify(settlement)));
  // Adding delivery_contract changes the delivery digest; retain a fresh independently planned fixture.
  const plan = planOrcaDelivery(task.orcaBinding, { taskId: "task", projectId: "project", revision: "2", generation: 1,
    status: "DOING", ownerId: "gemini", claimId: null, reviewerId: "codex" }, message, JSON.parse(settlement.output));
  if (plan.kind !== "candidate") throw Error("bad fixture");
  task.orcaDelivery.digest = approval.deliveryDigest = plan.digest;
  const reviewEntry = manifest.entries.find((e: any) => e.role === "review_response");
  const review = JSON.parse((await artifacts.read(reviewEntry.evidence)).toString()); review.digest = plan.digest;
  reviewEntry.evidence = await artifacts.put(Buffer.from(JSON.stringify(review)));
  task.orcaReviewRun.responseHash = reviewEntry.evidence.sha256;
  approval.reviewReceiptDigest = hashOrcaReviewRun(task.orcaReviewRun);
  approval.manifestDigest = sha(JSON.stringify(manifest, manifestKeys));
}
describe("unified orchestration (synthetic receipts, mocked acceptance/attribution, real artifact bytes; NOT E2E)", () => {
  it("accepts exact wrapped evidence with explicit derived lineage and unchanged hard blockers", async () => {
    await wrapDelivery();
    const result = await run();
    expect(result).toMatchObject({ localChecksPassed: true, sourceAuthenticated: false, canCompleteTask: false,
      deliveryEvidence: { representation: "EXEC_WRAPPED_ENVELOPE", lineage: { messageId: "message", deliveryId: "delivery" } } });
    expect((result as any).deliveryEvidence.lineage.originalWorkerSha256).toBe(manifest.entries[2].evidence.sha256);
    expect(result.blockers).toContain("TRUSTED_SOURCE_EXTRACTION_NOT_IMPLEMENTED");
    expect(store.saveTask).not.toHaveBeenCalled();
  });
  it.each(["exit", "extra", "duplicate", "runtime", "replayed", "count", "nested", "wall", "tokens", "chunk", "chunk-lf", "chunk-cr", "oversized"])("rejects wrapped %s before acceptance", async kind => {
    await wrapDelivery(worker => {
      if (kind === "exit") worker.exit_code = 1;
      if (kind === "extra") worker.extra = true;
      if (kind === "duplicate") worker.output = worker.output.replace('"ok":true', '"ok":true,"ok":true');
      if (kind === "nested") worker.output = JSON.stringify(worker);
      if (kind === "wall") worker.wall_time_seconds = -1;
      if (kind === "tokens") worker.original_token_count = 1.5;
      if (kind === "chunk") worker.chunk_id = "bad\nchunk";
      if (kind === "chunk-lf") worker.chunk_id = "chunk\n";
      if (kind === "chunk-cr") worker.chunk_id = "chunk\r";
      if (kind === "oversized") worker.output = " ".repeat(262145);
      if (["runtime", "replayed", "count"].includes(kind)) {
        const envelope = JSON.parse(worker.output);
        if (kind === "runtime") envelope._meta.runtimeId = "other";
        if (kind === "replayed") envelope.result.replayed = true;
        if (kind === "count") envelope.result.count = 2;
        worker.output = JSON.stringify(envelope);
      }
    });
    expect((await run()).blockers).toContain("DELIVERY_SOURCE_FAILED");
    expect(store.saveTask).not.toHaveBeenCalled();
  });
  it("rejects invalid caller inputs before any buffer copies", () => {
    const small = Buffer.from("{}"), large = Buffer.alloc(262145), hugeExpectation = "x".repeat(32769);
    const cases: any[][] = [[large, small, "{}"], [small, large, "{}"], [null, small, "{}"],
      [small, {}, "{}"], [Buffer.alloc(0), small, "{}"], [small, small, null], [small, small, hugeExpectation]];
    for (const [worker, settlement, expected] of cases) {
      const copy = vi.spyOn(Buffer, "from").mockImplementation(() => { throw Error("UNBOUNDED_COPY"); });
      let error;
      try { inspectOrcaDeliveryEvidenceBytes("{}", worker, settlement, expected); } catch (e) { error = e; }
      copy.mockRestore();
      expect(error).toMatchObject({ message: "INVALID_ORCA_DELIVERY_EVIDENCE" });
    }
  });
  it("accepts the exact original-byte limit and rejects one byte above it", async () => {
    await wrapDelivery();
    const worker = await artifacts.read(manifest.entries[2].evidence), settlement = await artifacts.read(manifest.entries[3].evidence);
    const exact = Buffer.concat([worker, Buffer.alloc(262144 - worker.length, 32)]);
    const expectation = (input: Buffer) => JSON.stringify({ deliveryDigest: task.orcaDelivery.digest, messageId: "message",
      workerDoneSha256: createHash("sha256").update(input).digest("hex"), settlementSha256: createHash("sha256").update(settlement).digest("hex") });
    expect(inspectOrcaDeliveryEvidenceBytes(JSON.stringify(task.orcaBinding), exact, settlement, expectation(exact))).toMatchObject({
      representation: "EXEC_WRAPPED_ENVELOPE", check: { semanticMatch: true }, canCompleteTask: false });
    const over = Buffer.concat([exact, Buffer.from(" ")]);
    expect(() => inspectOrcaDeliveryEvidenceBytes(JSON.stringify(task.orcaBinding), over, settlement, expectation(over))).toThrow("INVALID_ORCA_DELIVERY_EVIDENCE");
  });
  it("rejects mixed raw/wrapped evidence without falling back", async () => {
    await wrapDelivery();
    const entry = manifest.entries.find((e: any) => e.role === "settlement");
    const wrapper = JSON.parse((await artifacts.read(entry.evidence)).toString());
    entry.evidence = await artifacts.put(Buffer.from(wrapper.output));
    approval.manifestDigest = sha(JSON.stringify(manifest, manifestKeys));
    expect((await run()).blockers).toContain("DELIVERY_SOURCE_FAILED");
  });
  it("rejects invalid UTF-8 and duplicate outer wrapper keys with otherwise consistent hashes", async () => {
    await wrapDelivery();
    const entry = manifest.entries.find((e: any) => e.role === "worker_done");
    const raw = (await artifacts.read(entry.evidence)).toString();
    entry.evidence = await artifacts.put(Buffer.from(raw.replace('"exit_code":0', '"exit_code":0,"exit_code":0')));
    approval.manifestDigest = sha(JSON.stringify(manifest, manifestKeys));
    expect((await run()).blockers).toContain("DELIVERY_SOURCE_FAILED");
    entry.evidence = await artifacts.put(Buffer.concat([Buffer.from(raw), Buffer.from([255])]));
    approval.manifestDigest = sha(JSON.stringify(manifest, manifestKeys));
    expect((await run()).blockers).toContain("DELIVERY_SOURCE_FAILED");
  });
  it("connects all local stages yet retains explicit blockers and no writes", async () => {
    expect(await run()).toMatchObject({ localChecksPassed: true, sourceAuthenticated: false, canCompleteTask: false,
      blockers: expect.arrayContaining(["TRUSTED_SOURCE_EXTRACTION_NOT_IMPLEMENTED", "COMPLETION_WRITEBACK_DISABLED"]) });
    expect(stages.acceptance).toHaveBeenCalledWith(store, "task", expect.objectContaining({ testRunHash: approval.testReceiptDigest }));
    expect(store.saveTask).not.toHaveBeenCalled(); expect(store.appendTaskEventOnce).not.toHaveBeenCalled();
  });
  it.each(["expectedRevision", "generation", "bindingDigest", "testReceiptDigest", "reviewReceiptDigest", "claimId"])("rejects stale approval %s", key => {
    approval[key] = typeof approval[key] === "number" ? approval[key] + 1 : key === "claimId" ? "other" : "e".repeat(64);
    return expect(run()).resolves.toMatchObject({ localChecksPassed: false, blockers: expect.arrayContaining(["CURRENT_TASK_FAILED"]) });
  });
  it("stops at unregistered approval before task IO", async () => {
    approval.operator = { ...operator, subject: "55555555-5555-4555-8555-555555555555" };
    expect((await run()).blockers).toContain("APPROVAL_FAILED"); expect(store.getTask).not.toHaveBeenCalled();
  });
  it("rejects acceptance failure, attribution mismatch and whitelist change", async () => {
    stages.acceptance.mockRejectedValueOnce(new Error("private path /secret")); expect((await run()).blockers).toContain("LOCAL_ACCEPTANCE_FAILED");
    stages.attribution.mockResolvedValueOnce({ withinWhitelist: false }); expect((await run()).blockers).toContain("FILE_ATTRIBUTION_FAILED");
    approval.allowedFiles = ["other.ts"]; expect((await run()).blockers).toContain("FILE_ATTRIBUTION_FAILED");
  });
  it("rejects manifest receipt relabeling", async () => {
    manifest.entries.find((e: any) => e.role === "worker_done").sourceReceipt = "other";
    approval.manifestDigest = sha(JSON.stringify(manifest, manifestKeys)); expect((await run()).blockers).toContain("MANIFEST_INTEGRITY_FAILED");
  });
  it("rejects corrupt artifact from an otherwise valid bundle", async () => {
    expect((await run()).localChecksPassed).toBe(true);
    const ref = manifest.entries[0].evidence; await fs.writeFile(path.join(root, "data/orca-evidence-v1", ref.sha256), "broken");
    expect((await run()).blockers).toContain("MANIFEST_INTEGRITY_FAILED");
  });
  it("connects a legitimate empty test output through every local stage", async () => {
    const empty = await artifacts.put(Buffer.alloc(0));
    task.orcaTestRun.outputEvidence = empty; task.orcaTestRun.outputHash = empty.sha256;
    approval.testReceiptDigest = hashOrcaTestRun(task.orcaTestRun);
    manifest.entries.find((e: any) => e.role === "test_output").evidence = empty;
    const entry = manifest.entries.find((e: any) => e.role === "review_response");
    const response = JSON.parse((await artifacts.read(entry.evidence)).toString()); response.testRunHash = approval.testReceiptDigest;
    entry.evidence = await artifacts.put(Buffer.from(JSON.stringify(response)));
    task.orcaReviewRun.responseHash = entry.evidence.sha256; approval.reviewReceiptDigest = hashOrcaReviewRun(task.orcaReviewRun);
    approval.manifestDigest = sha(JSON.stringify(manifest, manifestKeys));
    expect(await run()).toMatchObject({localChecksPassed:true,canCompleteTask:false});
  });
  it("rejects final task/workspace change and pending turn", async () => {
    stages.fingerprint.mockResolvedValueOnce("f".repeat(64)); expect((await run()).blockers).toContain("FINAL_SNAPSHOT_FAILED");
    store.getTask.mockResolvedValueOnce(structuredClone(task)).mockResolvedValueOnce({ ...task, revision: 11 });
    expect((await run()).blockers).toContain("FINAL_SNAPSHOT_FAILED");
    task.pendingAgentTurn = {}; expect((await run()).blockers).toContain("CURRENT_TASK_FAILED");
  });
  it("rejects semantically wrong delivery despite consistent manifest hashes", async () => {
    const entry = manifest.entries.find((e: any) => e.role === "worker_done");
    const message = JSON.parse((await artifacts.read(entry.evidence)).toString()); message.from_handle = "different-terminal";
    entry.evidence = await artifacts.put(Buffer.from(JSON.stringify(message)));
    approval.manifestDigest = sha(JSON.stringify(manifest, manifestKeys));
    expect((await run()).blockers).toContain("DELIVERY_SOURCE_FAILED");
  });
  it("rejects review-test identity mismatch even with updated review and manifest hashes", async () => {
    const entry = manifest.entries.find((e: any) => e.role === "review_response");
    const response = JSON.parse((await artifacts.read(entry.evidence)).toString()); response.testRunId = "66666666-6666-4666-8666-666666666666";
    entry.evidence = await artifacts.put(Buffer.from(JSON.stringify(response)));
    task.orcaReviewRun.responseHash = entry.evidence.sha256; approval.reviewReceiptDigest = hashOrcaReviewRun(task.orcaReviewRun);
    approval.manifestDigest = sha(JSON.stringify(manifest, manifestKeys));
    expect((await run()).blockers).toContain("REVIEW_TEST_SOURCE_FAILED");
  });
  it("detects task mutation during the final manifest recheck", async () => {
    let reads = 0;
    store.readOrcaEvidence = async (ref: any) => {
      reads++;
      // baseline(1), first manifest(7), delivery(2), review/test(2), final manifest starts at 13.
      if (reads === 13) task.revision++;
      return artifacts.read(ref);
    };
    expect((await run()).blockers).toContain("FINAL_SNAPSHOT_FAILED");
  });
});
