import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const collect = vi.hoisted(() => vi.fn());
vi.mock("../../src/integrations/orca-collector.js", () => ({ collectOrcaWorker: collect }));
import { ProjectStore } from "../../src/projects/project-store.js";
import { persistOrcaBinding } from "../../src/integrations/orca-binding.js";
import { importOrcaDelivery, projectOrcaDelivery } from "../../src/integrations/orca-import.js";
import type { Task } from "../../src/tasks/task.js";
import { runOrcaProjection, runOrcaProjectionCli } from "../../src/cli/orca-projection.js";
import { fingerprintOrcaWorkspace, runOrcaDeliveryTests } from "../../src/integrations/orca-tests.js";
import { GitService } from "../../src/git/git-service.js";
import { TestRunner } from "../../src/testing/test-runner.js";
import { hashOrcaTestRun, reviewOrcaDelivery, recoverOrcaReview } from "../../src/integrations/orca-review.js";
import type { Agent } from "../../src/agents/agent.js";
import { hashOrcaReviewRun, inspectOrcaAcceptance } from "../../src/integrations/orca-acceptance.js";
import { inspectOrcaUnifiedPreflight } from "../../src/integrations/orca-unified-preflight.js";
import { parseOrcaCompletionBinding } from "../../src/integrations/orca-evidence-manifest.js";
import { captureOrcaBindingBaseline } from "../../src/integrations/orca-baseline.js";
import { prepareOrcaMetadataRevalidation } from "../../src/integrations/orca-metadata-revalidation.js";
import * as baselineModule from "../../src/integrations/orca-baseline.js";
import { prepareOrcaReviewContext } from "../../src/integrations/orca-review-context.js";

let root: string; let store: ProjectStore; let message: any; let receipt: any;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "orca-import-")); store = new ProjectStore(root);
  const task: Task = { id: "task", projectId: "project", title: "Import", description: "", status: "DOING",
    owner: "gemini", ownerId: "gemini", ownerType: "AGENT", reviewerId: "codex", priority: "LOW", workspace: root,
    maxRounds: 1, currentRound: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await store.saveTask(task);
  await persistOrcaBinding(store, { agenthubTaskId: "task", projectId: "project", revision: "2", generation: 1,
    runtimeId: "runtime", hostId: "local", runId: "run", taskId: "orca-task", dispatchId: "dispatch",
    workspaceId: "workspace", workspacePath: root, terminalHandle: "terminal", developer: "gemini", reviewer: "codex",
    provider: "antigravity", ownerId: "gemini", claimId: null });
  message = { id: "message", type: "worker_done", run_id: "run", from_handle: "terminal", to_handle: "run:run",
    body: "SECRET", payload: { taskId: "orca-task", dispatchId: "dispatch", outcome: "succeeded" } };
  receipt = { ok: true, _meta: { runtimeId: "runtime" }, result: {
    dispatch: { id: "dispatch", runId: "run", taskId: "orca-task", assigneeHandle: "terminal",
      hostScope: { kind: "local", hostId: "local" }, status: "completed", completedAt: "2026-10-11T00:00:00Z" },
    worker: { dispatchId: "dispatch", runtimeEpoch: "runtime", worktreeId: "workspace", agentTerminalHandle: "terminal",
      startOptions: { agent: "antigravity" }, state: "succeeded", stage: "settled" },
    projection: { id: "dispatch", dispatchId: "dispatch", taskId: "orca-task", runId: "run", role: "worker",
      host: { kind: "local", id: "local" }, workspace: { id: "workspace" }, provider: { id: "antigravity" },
      outcome: "succeeded", stage: { dispatch: "completed", worker: "succeeded" }, evidence: { durable: true } },
    terminal: { handle: "terminal", worktreeId: "workspace", worktreePath: root } } };
  collect.mockReset(); collect.mockImplementation(async () => ({ ok: true, receipt, stdoutSha256: "a".repeat(64),
    bytes: 100, provenance: "LOCAL_CLI_OBSERVATION" }));
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
const run = () => importOrcaDelivery(store, "/trusted/orca", "task", message);

async function prepareTests(script = 'console.log("SECRET-TEST-OUTPUT");') {
  await fs.writeFile(path.join(root, ".gitignore"), "data/\nlogs/\nexecution-count\n");
  await fs.writeFile(path.join(root, "test.cjs"), script);
  for (const args of [["init"], ["add", ".gitignore", "test.cjs"],
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]]) {
    expect((await GitService.exec(args, root)).exitCode).toBe(0);
  }
  const { commit } = await run();
  await projectOrcaDelivery(store, "task");
  const task = (await store.getTask("task"))!;
  task.testCommand = "node test.cjs"; await store.saveTask(task);
  return { revision: task.revision!, generation: 1, digest: commit.digest,
    workspaceHash: await fingerprintOrcaWorkspace(root), command: task.testCommand };
}

async function prepareReview() {
  const testApproval = await prepareTests();
  await runOrcaDeliveryTests(store, "task", testApproval);
  const task = (await store.getTask("task"))!;
  return { revision: task.revision!, generation: 1, digest: testApproval.digest,
    workspaceHash: testApproval.workspaceHash, testRunHash: hashOrcaTestRun(task.orcaTestRun!) };
}

function syntheticReviewer(transform: (verdict: any) => any = value => value): Agent {
  return { name: "codex", start: vi.fn(async () => {}), initialize: vi.fn(async () => {}),
    createSession: vi.fn(async () => "synthetic-session"), cancel: vi.fn(async () => {}), close: vi.fn(async () => {}),
    prompt: vi.fn(async (_session, prompt) => ({ text: JSON.stringify(transform({ ...JSON.parse(prompt).expected, verdict: "PASS" })),
      stopReason: "end_turn", provenance: { provider: "openai", adapter: "codex-acp", model: "synthetic",
        endpoint: "synthetic-only", providerSessionId: "synthetic-session" } })) };
}

function syntheticNativeReviewer(): Agent {
  const reviewer = syntheticReviewer();
  const session = "aaaaaaaa-0000-4000-8000-000000000004";
  reviewer.createSession = async () => session;
  const prompt = reviewer.prompt;
  reviewer.prompt = async (id, message) => {
    const response = await prompt(id, message);
    const thread = "01900000-0000-7000-8000-000000000002";
    response.provenance = { ...response.provenance!, adapter: "codex-exec", providerSessionId: thread, adapterSessionId: session };
    response.nativeReviewTransport = JSON.stringify({version:1,code:0,adapterSessionId:session,providerSessionId:thread,
      finalHash:createHash("sha256").update(response.text).digest("hex"),stderrBase64:"",stdout:
      [{type:"thread.started",thread_id:thread},{type:"turn.started"},{type:"turn.completed"}].map(v=>JSON.stringify(v)).join("\n")});
    return response;
  };
  return reviewer;
}

async function prepareAcceptance() {
  const approval = await prepareReview();
  await reviewOrcaDelivery(store, "task", syntheticReviewer(), approval);
  const task = (await store.getTask("task"))!;
  return { ...approval, revision: task.revision!, reviewRunHash: hashOrcaReviewRun(task.orcaReviewRun!) };
}

describe("native review retained transport integration (synthetic)", () => {
  it("retains a rejected review and binds a one-time context-complete rereview", async () => {
    const approval = await prepareReview();
    await reviewOrcaDelivery(store,"task",syntheticReviewer(v=>({...v,verdict:"REQUEST_CHANGES"})),approval);
    const rejected=(await store.getTask("task"))!;
    const requirements=await store.putOrcaEvidence(Buffer.from("synthetic exact requirements"));
    const reconciliation=await store.putOrcaEvidence(Buffer.from("synthetic operator context correction"));
    const corrected={revision:rejected.revision!,rejectedReviewHash:hashOrcaReviewRun(rejected.orcaReviewRun!),requirements,reconciliation};
    await expect(prepareOrcaReviewContext(store,"task",{...corrected,rejectedReviewHash:"a".repeat(64)})).rejects.toThrow();
    const prepared=await prepareOrcaReviewContext(store,"task",corrected);
    expect(JSON.parse((await store.readOrcaEvidence(prepared.context.priorTask)).toString())).toEqual(rejected);
    const reviewer=syntheticNativeReviewer();
    const originalPrompt=reviewer.prompt;
    reviewer.prompt=vi.fn(async(id,message)=>originalPrompt(id,message));
    const review=await reviewOrcaDelivery(store,"task",reviewer,{...approval,revision:prepared.revision});
    expect(JSON.parse((reviewer.prompt as any).mock.calls[0][1]).evidence.reviewContext.requirements).toBe("synthetic exact requirements");
    expect(review.context).toEqual(prepared.context);
    const current=(await store.getTask("task"))!;
    expect((await inspectOrcaAcceptance(store,"task",{...approval,revision:current.revision!,reviewRunHash:hashOrcaReviewRun(review)})).localEvidenceConsistent).toBe(true);
    await expect(prepareOrcaReviewContext(store,"task",{...corrected,revision:current.revision!})).rejects.toThrow();
  });
  it("archives stopped test/review receipts for explicitly approved metadata revalidation", async () => {
    const reviewApproval=await prepareReview();
    await expect(reviewOrcaDelivery(store,"task",syntheticReviewer(()=>({invalid:true})),reviewApproval)).rejects.toThrow();
    const task=(await store.getTask("task"))!;
    await fs.writeFile(path.join(root,".DS_Store"),"new");
    const authorizationEvidence=await store.putOrcaEvidence(Buffer.from("synthetic operator approval"));
    const approval={revision:task.revision!,workspaceHash:await fingerprintOrcaWorkspace(root),reviewId:task.orcaReviewRun!.id,executionStopped:true as const,authorizationEvidence};
    vi.spyOn(baselineModule,"inspectOrcaFileAttribution").mockResolvedValue({taskId:"task",revision:task.revision!,generation:1,
      workspaceHash:approval.workspaceHash,baselineHash:"a".repeat(64),changedFiles:[".DS_Store"],outsideWhitelist:[".DS_Store"],
      changes:[{file:".DS_Store",kind:"MODIFIED"}],withinWhitelist:false,scope:"LOCAL_FILE_ATTRIBUTION",canCompleteTask:false});
    await expect(prepareOrcaMetadataRevalidation(store,"task",{...approval,revision:1})).rejects.toThrow();
    const prepared=await prepareOrcaMetadataRevalidation(store,"task",approval);
    expect(JSON.parse((await store.readOrcaEvidence(prepared.priorTaskEvidence)).toString())).toEqual(task);
    const after=(await store.getTask("task"))!;
    expect(after.orcaTestRun).toBeUndefined();expect(after.orcaReviewRun).toBeUndefined();
    expect(after.orcaBaseline).toEqual(task.orcaBaseline);
    await expect(prepareOrcaMetadataRevalidation(store,"task",approval)).rejects.toThrow();
  });
  it("retains native transport and permits only consistent acceptance preflight", async () => {
    const approval = await prepareReview();
    const review = await reviewOrcaDelivery(store, "task", syntheticNativeReviewer(), approval);
    expect(review.adapter).toBe("codex-exec");
    expect(review.transportEvidence).toBeDefined();
    const task = (await store.getTask("task"))!;
    const result = await inspectOrcaAcceptance(store, "task", {...approval, revision:task.revision!,reviewRunHash:hashOrcaReviewRun(review)});
    expect(result.localEvidenceConsistent).toBe(true);
    expect(result.canCompleteTask).toBe(false);
    delete task.orcaReviewRun!.transportEvidence;
    await store.saveTask(task);
    await expect(inspectOrcaAcceptance(store,"task",{...approval,revision:task.revision!,reviewRunHash:hashOrcaReviewRun(task.orcaReviewRun!)})).rejects.toThrow();
  });
  it("rejects native responses missing bound transport without completing review", async () => {
    const approval = await prepareReview();
    const reviewer = syntheticNativeReviewer();
    const prompt = reviewer.prompt;
    reviewer.prompt = async (id,message) => { const v = await prompt(id,message); delete v.nativeReviewTransport; return v; };
    await expect(reviewOrcaDelivery(store,"task",reviewer,approval)).rejects.toThrow();
    expect((await store.getTask("task"))!.orcaReviewRun!.phase).toBe("RUNNING");
  });
});

describe("Orca bridge (synthetic collector/reviewer, real local storage/tests; NOT provider E2E)", () => {
  it.each([null, { version: 1, sha256: "0".repeat(64), bytes: 1 }])("rejects malformed or hash-mismatched retained review evidence", async evidence => {
    const expected = await prepareAcceptance();
    const task = (await store.getTask("task"))!;
    task.orcaReviewRun!.responseEvidence = evidence as any;
    await store.saveTask(task);
    await expect(inspectOrcaAcceptance(store, "task", { ...expected, revision: task.revision!,
      reviewRunHash: hashOrcaReviewRun(task.orcaReviewRun!) })).rejects.toMatchObject({ code: "INVALID_REVIEW_RECEIPT" });
  });
  it("supplies retained output to review without rerunning tests or weakening response keys", async () => {
    const approval = await prepareReview();
    const runner = vi.spyOn(TestRunner, "run");
    const reviewer = syntheticReviewer();
    await reviewOrcaDelivery(store, "task", reviewer, approval);
    const input = JSON.parse((reviewer.prompt as any).mock.calls[0][1]);
    expect(input.evidence.testOutput).toContain("SECRET-TEST-OUTPUT");
    expect(input.evidence.representation).toBe("STORE_HASH_VERIFIED_UTF8");
    expect(input.evidence.sourceAuthenticated).toBe(false);
    expect(input.evidence.baseline).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });
  it("includes stored baseline and current attribution when available (synthetic fixture)", async () => {
    const approval = await prepareReview();
    const task = (await store.getTask("task"))!;
    task.orcaBaseline = await captureOrcaBindingBaseline(store, task.orcaBinding!, ["test.cjs"]);
    // Seed a synthetic stored-record fixture, not a supported baseline backfill operation.
    await fs.writeFile(path.join(root, "data/tasks/task.json"), JSON.stringify(task));
    const reviewer = syntheticReviewer();
    await reviewOrcaDelivery(store, "task", reviewer, { ...approval, revision: task.revision! });
    const input = JSON.parse((reviewer.prompt as any).mock.calls[0][1]);
    expect(JSON.parse(input.evidence.baseline).files["test.cjs"].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(input.evidence.attribution).toMatchObject({ withinWhitelist: true, changedFiles: [], canCompleteTask: false });
  });
  it("unified preflight rejects a legacy missing baseline without task or event writes", async () => {
    const expected = await prepareAcceptance();
    const task = (await store.getTask("task"))!;
    const binding = task.orcaBinding!;
    const operator = {namespace:"agenthub-local-operator-v1" as const,subject:"11111111-1111-4111-8111-111111111111"};
    const approval = {version:1,purpose:"SCOPED_ORCA_PILOT_COMPLETION",approvalId:"22222222-2222-4222-8222-222222222222",approvedAt:"2026-10-12T00:00:00.000Z",operator,
      taskId:"task",projectId:binding.projectId,dispatchId:binding.dispatchId,runId:binding.runId,runtimeId:binding.runtimeId,orcaTaskId:binding.taskId,ownerId:binding.ownerId,reviewerId:binding.reviewer,claimId:binding.claimId,
      expectedRevision:task.revision,generation:binding.generation,bindingDigest:parseOrcaCompletionBinding(JSON.stringify(binding)).digest,deliveryDigest:expected.digest,
      testReceiptDigest:expected.testRunHash,reviewReceiptDigest:expected.reviewRunHash,workspaceDigest:expected.workspaceHash,baselineDigest:"a".repeat(64),manifestDigest:"b".repeat(64),allowedFiles:["test.cjs"]};
    const taskPath=path.join(root,"data/tasks/task.json"),logPath=path.join(root,"logs/tasks/task.jsonl");
    const beforeTask=await fs.readFile(taskPath),beforeLog=await fs.readFile(logPath);
    const result=await inspectOrcaUnifiedPreflight(store,"task",JSON.stringify(approval),"{}",[operator]);
    expect(result).toMatchObject({localChecksPassed:false,canCompleteTask:false,checks:["APPROVAL","CURRENT_TASK","LOCAL_ACCEPTANCE"]});
    expect(result.blockers).toContain("FILE_ATTRIBUTION_FAILED");
    expect((await fs.readFile(taskPath)).equals(beforeTask)).toBe(true);
    expect((await fs.readFile(logPath)).equals(beforeLog)).toBe(true);
  });
  async function interruptedReview() {
    const approval = await prepareReview();
    const reviewer = syntheticReviewer();
    vi.spyOn(reviewer, "prompt").mockRejectedValueOnce(new Error("interrupted"));
    await expect(reviewOrcaDelivery(store, "task", reviewer, approval)).rejects.toThrow("interrupted");
    const task = (await store.getTask("task"))!;
    return { approval: { ...approval, revision: task.revision! }, old: structuredClone(task.orcaReviewRun!),
      recovery: { reviewId: task.orcaReviewRun!.id, reviewHash: hashOrcaReviewRun(task.orcaReviewRun!), executionStopped: true as const,
        evidenceSha256: "e".repeat(64), confirmedAt: new Date().toISOString() } };
  }
  it("preserves rejected mixed-text evidence through explicit recovery without accepting its embedded verdict", async () => {
    const approval = await prepareReview(), first = syntheticReviewer();
    const prompt = first.prompt.bind(first);
    vi.spyOn(first, "prompt").mockImplementationOnce(async (session, text) => {
      const response = await prompt(session, text);
      return { ...response, text: "Commentary before JSON\n" + response.text };
    });
    await expect(reviewOrcaDelivery(store, "task", first, approval)).rejects.toMatchObject({ code: "INVALID_REVIEW_RESPONSE" });
    const stopped = (await store.getTask("task"))!, old = structuredClone(stopped.orcaReviewRun!);
    const recovery = { reviewId: old.id, reviewHash: hashOrcaReviewRun(old), executionStopped: true as const,
      evidenceSha256: "e".repeat(64), confirmedAt: new Date().toISOString() };
    const result = await recoverOrcaReview(store, "task", syntheticReviewer(), { ...approval, revision: stopped.revision! }, recovery);
    expect(result.verdict).toBe("PASS");
    const task = (await store.getTask("task"))!;
    expect(task.orcaReviewHistory![0].run.responseEvidence).toEqual(old.responseEvidence);
    expect((await store.readOrcaEvidence(old.responseEvidence!)).toString("utf8")).toMatch(/^Commentary before JSON\n/);
    expect(task.status).toBe("REVIEW"); expect(task.result).toBeUndefined();
  });
  it("retains response before adapter close failure, without a verdict", async () => {
    const approval = await prepareReview(), reviewer = syntheticReviewer();
    vi.mocked(reviewer.close).mockRejectedValueOnce(new Error("close failed"));
    await expect(reviewOrcaDelivery(store, "task", reviewer, approval)).rejects.toThrow("close failed");
    const task = (await store.getTask("task"))!;
    expect(task.orcaReviewRun?.phase).toBe("RUNNING");
    expect(task.orcaReviewRun?.responseEvidence).toBeDefined();
    expect(task.orcaReviewRun?.verdict).toBeUndefined();
  });
  it("explicitly recovers with atomic preserved history before a fresh static-only review", async () => {
    const f = await interruptedReview(); const reviewer = syntheticReviewer();
    const prompt = reviewer.prompt.bind(reviewer);
    vi.spyOn(reviewer, "prompt").mockImplementationOnce(async (session, text) => {
      const checkpoint = (await store.getTask("task"))!;
      expect(checkpoint.orcaReviewHistory).toEqual([{ run: f.old, recovery: f.recovery, provenance: "OPERATOR_CONFIRMED_INTERRUPTION" }]);
      expect(checkpoint.orcaReviewRun!.id).not.toBe(f.old.id);
      expect(JSON.parse(text).instructions).toContain("Do NOT run tests");
      return prompt(session, text);
    });
    expect(await recoverOrcaReview(store, "task", reviewer, f.approval, f.recovery)).toMatchObject({ verdict: "PASS" });
    const task = (await store.getTask("task"))!;
    expect(task.result).toBeUndefined(); expect(task.status).toBe("REVIEW");
    expect(task.orcaReviewHistory![0].run).toEqual(f.old);
  });
  it.each(["reviewId", "reviewHash", "executionStopped", "evidenceSha256", "confirmedAt"])(
    "rejects invalid recovery confirmation %s before reviewer contact", async key => {
      const f = await interruptedReview(); const reviewer = syntheticReviewer();
      const invalid = { ...f.recovery, [key]: key === "executionStopped" ? false : "invalid" };
      await expect(recoverOrcaReview(store, "task", reviewer, f.approval, invalid as any))
        .rejects.toMatchObject({ code: "INVALID_REVIEW_RECOVERY" });
      expect(reviewer.initialize).not.toHaveBeenCalled();
      expect((await store.getTask("task"))?.orcaReviewRun).toEqual(f.old);
    });
  it("rejects changed workspace and stale recovery revision", async () => {
    const f = await interruptedReview(); const reviewer = syntheticReviewer();
    await expect(recoverOrcaReview(store, "task", reviewer, { ...f.approval, revision: f.approval.revision - 1 }, f.recovery))
      .rejects.toMatchObject({ code: "STALE_REVIEW_APPROVAL" });
    await fs.writeFile(path.join(root, "test.cjs"), "drift");
    await expect(recoverOrcaReview(store, "task", reviewer, f.approval, f.recovery)).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
    expect(reviewer.initialize).not.toHaveBeenCalled();
  });
  it("does not contact reviewer if replacement checkpoint save acknowledgement fails", async () => {
    const f = await interruptedReview(); const reviewer = syntheticReviewer();
    vi.spyOn(store, "saveTask").mockRejectedValueOnce(new Error("save failed"));
    await expect(recoverOrcaReview(store, "task", reviewer, f.approval, f.recovery)).rejects.toThrow("save failed");
    expect(reviewer.initialize).not.toHaveBeenCalled();
    expect((await store.getTask("task"))?.orcaReviewRun).toEqual(f.old);
  });
  it("does not recover a completed review or start recovery without a prior attempt", async () => {
    const approval = await prepareReview(); const reviewer = syntheticReviewer();
    const bogus = { reviewId: "missing", reviewHash: "a".repeat(64), executionStopped: true as const,
      evidenceSha256: "e".repeat(64), confirmedAt: new Date().toISOString() };
    await expect(recoverOrcaReview(store, "task", reviewer, approval, bogus)).rejects.toMatchObject({ code: "INVALID_REVIEW_RECOVERY" });
    await reviewOrcaDelivery(store, "task", reviewer, approval);
    const task = (await store.getTask("task"))!;
    await expect(recoverOrcaReview(store, "task", reviewer, { ...approval, revision: task.revision! },
      { ...bogus, reviewId: task.orcaReviewRun!.id, reviewHash: hashOrcaReviewRun(task.orcaReviewRun!), confirmedAt: new Date().toISOString() }))
      .rejects.toMatchObject({ code: "INVALID_REVIEW_RECOVERY" });
  });
  it("returns only local consistency, without task/log mutation or completion permission", async () => {
    const expected = await prepareAcceptance();
    const taskFile = path.join(root, "data/tasks/task.json");
    const logFile = path.join(root, "logs/tasks/task.jsonl");
    const taskBefore = await fs.readFile(taskFile); const logBefore = await fs.readFile(logFile);
    const save = vi.spyOn(store, "saveTask"); const append = vi.spyOn(store, "appendTaskEventOnce");
    const proof = await inspectOrcaAcceptance(store, "task", expected);
    expect(proof).toMatchObject({ localEvidenceConsistent: true, canCompleteTask: false, scope: "LOCAL_ACCEPTANCE_PREFLIGHT",
      blockers: ["REAL_PROVIDER_E2E_NOT_VERIFIED", "COMPLETION_WRITEBACK_DISABLED"] });
    expect(save).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
    expect(await fs.readFile(taskFile)).toEqual(taskBefore); expect(await fs.readFile(logFile)).toEqual(logBefore);
    expect((await store.getTask("task"))?.status).toBe("REVIEW");
  });
  it.each([
    ["phase", "RUNNING"], ["verdict", "REQUEST_CHANGES"], ["verdict", "INVALIDATED"], ["reviewer", "gemini"],
    ["provider", "google"], ["adapter", "antigravity-agentapi"], ["testRunId", "other-test"],
    ["responseHash", ["a".repeat(64)]], ["startedRevision", 1], ["provenance", "PROVIDER_VERIFIED"],
  ])("rejects malformed review receipt %s even with an operator-confirmed hash", async (key, value) => {
    const expected = await prepareAcceptance();
    const task = (await store.getTask("task"))!;
    (task.orcaReviewRun as any)[key as string] = value; await store.saveTask(task);
    await expect(inspectOrcaAcceptance(store, "task", { ...expected, revision: task.revision!, reviewRunHash: hashOrcaReviewRun(task.orcaReviewRun!) }))
      .rejects.toMatchObject({ code: "INVALID_REVIEW_RECEIPT" });
  });
  it("rejects stale confirmations, edited source and reassigned reviewer", async () => {
    const expected = await prepareAcceptance();
    await expect(inspectOrcaAcceptance(store, "task", { ...expected, revision: expected.revision - 1 }))
      .rejects.toMatchObject({ code: "STALE_ACCEPTANCE_EXPECTATION" });
    await expect(inspectOrcaAcceptance(store, "task", { ...expected, reviewRunHash: "a".repeat(64) }))
      .rejects.toMatchObject({ code: "STALE_REVIEW_RECEIPT" });
    await fs.writeFile(path.join(root, "after-review.txt"), "changed");
    await expect(inspectOrcaAcceptance(store, "task", expected)).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
    const task = (await store.getTask("task"))!; task.reviewerId = "gemini"; await store.saveTask(task);
    await expect(inspectOrcaAcceptance(store, "task", { ...expected, revision: task.revision! }))
      .rejects.toMatchObject({ code: "ACCEPTANCE_GATE_NOT_READY" });
  });
  it("rejects missing, duplicated and ambiguous log events without repairing them", async () => {
    const expected = await prepareAcceptance();
    const file = path.join(root, "logs/tasks/task.jsonl");
    const event = (await store.getTask("task"))!.orcaDelivery!.outbox.event;
    for (const text of ["", JSON.stringify(event) + "\n" + JSON.stringify(event) + "\n",
      JSON.stringify(event).replace('"actor":"gemini"', '"actor":"codex","actor":"gemini"') + "\n"]) {
      await fs.writeFile(file, text);
      await expect(inspectOrcaAcceptance(store, "task", expected)).rejects.toThrow();
      expect(await fs.readFile(file, "utf8")).toBe(text);
    }
  });
  it("detects concurrent cancellation rather than returning a stale proof", async () => {
    const expected = await prepareAcceptance();
    const verify = store.verifyTaskEventReadOnly.bind(store);
    vi.spyOn(store, "verifyTaskEventReadOnly").mockImplementationOnce(async event => {
      await verify(event);
      const task = (await store.getTask("task"))!; task.status = "CANCELLED"; await store.saveTask(task);
    });
    await expect(inspectOrcaAcceptance(store, "task", expected)).rejects.toMatchObject({ code: "ACCEPTANCE_SNAPSHOT_CHANGED" });
    expect((await store.getTask("task"))?.status).toBe("CANCELLED");
  });
  it("detects task edits even when an external writer bypasses revision increment", async () => {
    const expected = await prepareAcceptance();
    const verify = store.verifyTaskEventReadOnly.bind(store);
    vi.spyOn(store, "verifyTaskEventReadOnly").mockImplementationOnce(async event => {
      await verify(event);
      const task = (await store.getTask("task"))!; task.title = "external change";
      await fs.writeFile(path.join(root, "data/tasks/task.json"), JSON.stringify(task));
    });
    await expect(inspectOrcaAcceptance(store, "task", expected)).rejects.toMatchObject({ code: "ACCEPTANCE_SNAPSHOT_CHANGED" });
  });
  it("records same-attempt independent adapter review, not task completion", async () => {
    const approval = await prepareReview();
    const reviewer = syntheticReviewer();
    const prompt = reviewer.prompt.bind(reviewer);
    vi.spyOn(reviewer, "prompt").mockImplementationOnce(async (session, text) => {
      expect((await store.getTask("task"))?.orcaReviewRun?.phase).toBe("RUNNING");
      return prompt(session, text);
    });
    expect(await reviewOrcaDelivery(store, "task", reviewer, approval)).toMatchObject({ phase: "COMPLETED", verdict: "PASS",
      digest: approval.digest, testRunHash: approval.testRunHash, reviewer: "codex", provenance: "LOCAL_REVIEW_ADAPTER" });
    const current = (await store.getTask("task"))!;
    expect(current.status).toBe("REVIEW"); expect(current.result).toBeUndefined();
    expect(reviewer.close).toHaveBeenCalledOnce();
    await expect(reviewOrcaDelivery(store, "task", reviewer, { ...approval, revision: current.revision! }))
      .rejects.toMatchObject({ code: "REVIEW_ALREADY_STARTED" });
  });
  it("accepts bounded citation metadata but hashes the entire original response", async () => {
    const approval = await prepareReview();
    const reviewer = syntheticReviewer();
    const prompt = reviewer.prompt.bind(reviewer);
    let raw = "";
    vi.spyOn(reviewer, "prompt").mockImplementationOnce(async (session, text) => {
      const response = await prompt(session, text);
      raw = response.text + '\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[synthetic]\n</citation_entries>\n<rollout_ids>\n</rollout_ids>\n</oai-mem-citation>';
      return { ...response, text: raw };
    });
    const result = await reviewOrcaDelivery(store, "task", reviewer, approval);
    expect(result.verdict).toBe("PASS");
    expect(result.responseHash).toBe(createHash("sha256").update(raw).digest("hex"));
    expect((await store.getTask("task"))?.result).toBeUndefined();
  });
  it("rejects self-review, stale test receipt and changed code before contacting reviewer", async () => {
    const approval = await prepareReview();
    const wrongReviewer = { ...syntheticReviewer(), name: "gemini" as const };
    await expect(reviewOrcaDelivery(store, "task", wrongReviewer, approval)).rejects.toMatchObject({ code: "REVIEW_GATE_NOT_READY" });
    const reviewer = syntheticReviewer();
    await expect(reviewOrcaDelivery(store, "task", reviewer, { ...approval, testRunHash: "b".repeat(64) }))
      .rejects.toMatchObject({ code: "STALE_TEST_RECEIPT" });
    await fs.writeFile(path.join(root, "test.cjs"), "changed");
    await expect(reviewOrcaDelivery(store, "task", reviewer, approval)).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
    expect(reviewer.initialize).not.toHaveBeenCalled(); expect(wrongReviewer.initialize).not.toHaveBeenCalled();
  });
  it.each([
    ["phase", "RUNNING"], ["outcome", "FAIL"], ["exitCode", 1], ["commandHash", "b".repeat(64)],
    ["outputHash", ["a".repeat(64)]], ["startedRevision", 1], ["reviewStatus", "PASS"], ["provenance", "PROVIDER_VERIFIED"],
  ])("rejects corrupt test receipt %s without contacting reviewer", async (key, value) => {
    const approval = await prepareReview();
    const task = (await store.getTask("task"))!;
    (task.orcaTestRun as any)[key as string] = value;
    await store.saveTask(task);
    const reviewer = syntheticReviewer();
    await expect(reviewOrcaDelivery(store, "task", reviewer, { ...approval, revision: task.revision! }))
      .rejects.toMatchObject({ code: "INVALID_TEST_RECEIPT" });
    expect(reviewer.initialize).not.toHaveBeenCalled();
  });
  it.each(["wrong-id", "extra-secret", "prose", "commentary-json", "duplicate-keys", "wrong-session"])("rejects invalid review response %s without approval", async kind => {
    const approval = await prepareReview();
    const reviewer = syntheticReviewer(value => kind === "wrong-id" ? { ...value, reviewId: "old-review" }
      : kind === "extra-secret" ? { ...value, secret: "SECRET-REVIEW" } : value);
    const prompt = reviewer.prompt.bind(reviewer);
    let original = "";
    vi.spyOn(reviewer, "prompt").mockImplementationOnce(async (session, text) => {
      const response = await prompt(session, text);
      if (kind === "prose") response.text = "PASS SECRET-REVIEW";
      if (kind === "commentary-json") response.text = "I will inspect the files.\n" + response.text;
      if (kind === "duplicate-keys") response.text = response.text.replace('"verdict":"PASS"', '"verdict":"REQUEST_CHANGES","verdict":"PASS"');
      if (kind === "wrong-session") response.provenance!.providerSessionId = "other-session";
      original = response.text;
      return response;
    });
    await expect(reviewOrcaDelivery(store, "task", reviewer, approval)).rejects.toMatchObject({
      code: kind === "wrong-session" ? "INVALID_REVIEW_PROVENANCE" : "INVALID_REVIEW_RESPONSE",
    });
    const task = (await store.getTask("task"))!;
    expect(task.orcaReviewRun?.phase).toBe("RUNNING"); expect(task.status).toBe("REVIEW");
    expect(JSON.stringify(task.orcaReviewRun)).not.toContain("SECRET-REVIEW");
    expect(task.orcaReviewRun?.responseEvidence).toBeDefined();
    expect((await store.readOrcaEvidence(task.orcaReviewRun!.responseEvidence!)).toString("utf8")).toBe(original);
    expect(task.orcaReviewRun?.responseHash).toBeUndefined();
    expect(task.orcaReviewRun?.verdict).toBeUndefined();
    expect(reviewer.prompt).toHaveBeenCalledOnce();
    expect(reviewer.close).toHaveBeenCalledOnce();
  });
  it("records REQUEST_CHANGES without completing the task", async () => {
    const approval = await prepareReview();
    const reviewer = syntheticReviewer(value => ({ ...value, verdict: "REQUEST_CHANGES" }));
    const receipt = await reviewOrcaDelivery(store, "task", reviewer, approval);
    expect(receipt).toMatchObject({ verdict: "REQUEST_CHANGES" });
    expect(receipt.responseEvidence?.sha256).toBe(receipt.responseHash);
    expect((await store.readOrcaEvidence(receipt.responseEvidence!)).toString("utf8")).toContain('"verdict":"REQUEST_CHANGES"');
  });
  it("refuses an empty session and closes the adapter after session failure", async () => {
    const approval = await prepareReview();
    const reviewer = syntheticReviewer();
    vi.spyOn(reviewer, "createSession").mockResolvedValueOnce("");
    await expect(reviewOrcaDelivery(store, "task", reviewer, approval)).rejects.toMatchObject({ code: "INVALID_REVIEW_SESSION" });
    expect(reviewer.prompt).not.toHaveBeenCalled(); expect(reviewer.close).toHaveBeenCalledOnce();
    expect((await store.getTask("task"))?.orcaReviewRun?.phase).toBe("RUNNING");
  });
  it("invalidates a PASS response if the reviewer changed workspace files", async () => {
    const approval = await prepareReview();
    const reviewer = syntheticReviewer();
    const prompt = reviewer.prompt.bind(reviewer);
    vi.spyOn(reviewer, "prompt").mockImplementationOnce(async (session, text) => {
      await fs.writeFile(path.join(root, "reviewer-edit.txt"), "unexpected edit");
      return prompt(session, text);
    });
    expect(await reviewOrcaDelivery(store, "task", reviewer, approval)).toMatchObject({ verdict: "INVALIDATED" });
  });
  it("does not contact reviewer after a lost start-save acknowledgement", async () => {
    const approval = await prepareReview();
    const save = store.saveTask.bind(store);
    vi.spyOn(store, "saveTask").mockImplementationOnce(async task => { await save(task); throw new Error("start ack lost"); });
    const reviewer = syntheticReviewer();
    await expect(reviewOrcaDelivery(store, "task", reviewer, approval)).rejects.toThrow("start ack lost");
    expect(reviewer.initialize).not.toHaveBeenCalled();
    const task = (await store.getTask("task"))!;
    await expect(reviewOrcaDelivery(new ProjectStore(root), "task", reviewer, { ...approval, revision: task.revision! }))
      .rejects.toMatchObject({ code: "REVIEW_ALREADY_STARTED" });
  });
  it("does not redispatch after a final-save failure", async () => {
    const approval = await prepareReview();
    const save = store.saveTask.bind(store);
    vi.spyOn(store, "saveTask").mockImplementationOnce(save).mockRejectedValueOnce(new Error("final save failed"));
    const reviewer = syntheticReviewer();
    await expect(reviewOrcaDelivery(store, "task", reviewer, approval)).rejects.toThrow("final save failed");
    const task = (await store.getTask("task"))!;
    await expect(reviewOrcaDelivery(new ProjectStore(root), "task", reviewer, { ...approval, revision: task.revision! }))
      .rejects.toMatchObject({ code: "REVIEW_ALREADY_STARTED" });
    expect(reviewer.prompt).toHaveBeenCalledOnce();
  });
  it("preserves cancellation during a reviewer turn", async () => {
    const approval = await prepareReview();
    const reviewer = syntheticReviewer();
    const prompt = reviewer.prompt.bind(reviewer);
    vi.spyOn(reviewer, "prompt").mockImplementationOnce(async (session, text) => {
      const task = (await store.getTask("task"))!; task.status = "CANCELLED"; await store.saveTask(task);
      return prompt(session, text);
    });
    await expect(reviewOrcaDelivery(store, "task", reviewer, approval)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await store.getTask("task")).toMatchObject({ status: "CANCELLED", orcaReviewRun: { phase: "RUNNING" } });
  });
  it("runs a real local test bound to delivery and workspace, without review or DONE approval", async () => {
    const approval = await prepareTests('require("node:assert/strict").equal(2 + 2, 4); console.log("SECRET-TEST-OUTPUT");');
    const result = await runOrcaDeliveryTests(store, "task", approval);
    expect(result).toMatchObject({ phase: "COMPLETED", outcome: "PASS", exitCode: 0, digest: approval.digest,
      workspaceHash: approval.workspaceHash, afterWorkspaceHash: approval.workspaceHash, reviewStatus: "NOT_RUN" });
    const task = (await store.getTask("task"))!;
    expect(task.status).toBe("REVIEW"); expect(task.result).toBeUndefined();
    expect(task.orcaDelivery?.testStatus).toBe("NOT_RUN");
    expect(JSON.stringify(task.orcaTestRun)).not.toContain("SECRET-TEST-OUTPUT");
    const output = await store.readOrcaEvidence(result.outputEvidence!);
    expect(output.toString('utf8')).toBe('SECRET-TEST-OUTPUT');
    expect(createHash('sha256').update(output).digest('hex')).toBe(result.outputHash);
    await expect(runOrcaDeliveryTests(store, "task", { ...approval, revision: task.revision! }))
      .rejects.toMatchObject({ code: "TEST_ALREADY_STARTED" });
  });
  it("records real assertion failure without completing the task", async () => {
    const approval = await prepareTests('require("node:assert/strict").equal(2 + 2, 5);');
    expect(await runOrcaDeliveryTests(store, "task", approval)).toMatchObject({ outcome: "FAIL", exitCode: 1 });
    expect((await store.getTask("task"))?.status).toBe("REVIEW");
  });
  it("does not dispatch review when retained test output is missing", async () => {
    const approval = await prepareReview();
    const task = (await store.getTask('task'))!;
    await fs.unlink(path.join(root,'data/orca-evidence-v1',task.orcaTestRun!.outputEvidence!.sha256));
    const reviewer = syntheticReviewer();
    await expect(reviewOrcaDelivery(store,'task',reviewer,approval)).rejects.toThrow();
    expect(reviewer.initialize).not.toHaveBeenCalled();
    expect((await store.getTask('task'))!.orcaReviewRun).toBeUndefined();
  });
  it("preserves RUNNING checkpoint after evidence persistence fails without rerunning", async () => {
    const approval = await prepareTests();
    vi.spyOn(store,'putOrcaEvidence').mockRejectedValueOnce(new Error('evidence disk failure'));
    const execute = vi.spyOn(TestRunner,'run');
    await expect(runOrcaDeliveryTests(store,'task',approval)).rejects.toThrow('evidence disk failure');
    const task = (await store.getTask('task'))!;
    expect(task.orcaTestRun?.phase).toBe('RUNNING');
    await expect(runOrcaDeliveryTests(store,'task',{...approval,revision:task.revision!})).rejects.toMatchObject({code:'TEST_ALREADY_STARTED'});
    expect(execute).toHaveBeenCalledOnce();
  });
  it("invalidates a successful command that changes the reviewed workspace", async () => {
    const approval = await prepareTests('require("node:fs").writeFileSync("changed.txt", "changed");');
    expect(await runOrcaDeliveryTests(store, "task", approval)).toMatchObject({ outcome: "INVALIDATED", exitCode: 0 });
  });
  it("rejects changed files, command or delivery confirmation before running tests", async () => {
    const approval = await prepareTests();
    const execute = vi.spyOn(TestRunner, "run");
    await expect(runOrcaDeliveryTests(store, "task", { ...approval, digest: "b".repeat(64) }))
      .rejects.toMatchObject({ code: "STALE_TEST_APPROVAL" });
    await expect(runOrcaDeliveryTests(store, "task", { ...approval, command: "node other.cjs" }))
      .rejects.toMatchObject({ code: "TEST_GATE_NOT_READY" });
    await fs.writeFile(path.join(root, "test.cjs"), "changed");
    await expect(runOrcaDeliveryTests(store, "task", approval)).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
    expect(execute).not.toHaveBeenCalled();
    expect((await store.getTask("task"))?.orcaTestRun).toBeUndefined();
  });
  it("does not execute if the start checkpoint acknowledgement is lost", async () => {
    const approval = await prepareTests();
    const execute = vi.spyOn(TestRunner, "run");
    const save = store.saveTask.bind(store);
    vi.spyOn(store, "saveTask").mockImplementationOnce(async task => { await save(task); throw new Error("start ack lost"); });
    await expect(runOrcaDeliveryTests(store, "task", approval)).rejects.toThrow("start ack lost");
    expect(execute).not.toHaveBeenCalled();
    const current = (await store.getTask("task"))!;
    expect(current.orcaTestRun?.phase).toBe("RUNNING");
    await expect(runOrcaDeliveryTests(new ProjectStore(root), "task", { ...approval, revision: current.revision! }))
      .rejects.toMatchObject({ code: "TEST_ALREADY_STARTED" });
  });
  it("does not rerun after tests executed but final record save failed", async () => {
    const approval = await prepareTests('require("node:fs").appendFileSync("execution-count", "1");');
    const save = store.saveTask.bind(store);
    vi.spyOn(store, "saveTask").mockImplementationOnce(save).mockRejectedValueOnce(new Error("result save failed"));
    await expect(runOrcaDeliveryTests(store, "task", approval)).rejects.toThrow("result save failed");
    const current = (await store.getTask("task"))!;
    expect(current.orcaTestRun?.phase).toBe("RUNNING");
    await expect(runOrcaDeliveryTests(new ProjectStore(root), "task", { ...approval, revision: current.revision! }))
      .rejects.toMatchObject({ code: "TEST_ALREADY_STARTED" });
    expect(await fs.readFile(path.join(root, "execution-count"), "utf8")).toBe("1");
  });
  it("preserves cancellation written while a real test executes", async () => {
    const approval = await prepareTests();
    const execute = TestRunner.run.bind(TestRunner);
    vi.spyOn(TestRunner, "run").mockImplementationOnce(async (command, cwd) => {
      const result = await execute(command, cwd);
      const cancelled = (await store.getTask("task"))!;
      cancelled.status = "CANCELLED"; await store.saveTask(cancelled);
      return result;
    });
    await expect(runOrcaDeliveryTests(store, "task", approval)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await store.getTask("task")).toMatchObject({ status: "CANCELLED", orcaTestRun: { phase: "RUNNING" } });
  });
  it("rejects pending projection and reviewer reassignment before test execution", async () => {
    const approval = await prepareTests();
    const task = (await store.getTask("task"))!;
    task.orcaDelivery!.outbox.state = "PENDING"; await store.saveTask(task);
    await expect(runOrcaDeliveryTests(store, "task", { ...approval, revision: task.revision! }))
      .rejects.toMatchObject({ code: "TEST_GATE_NOT_READY" });
    task.orcaDelivery!.outbox.state = "PROJECTED"; task.reviewerId = "gemini"; await store.saveTask(task);
    await expect(runOrcaDeliveryTests(store, "task", { ...approval, revision: task.revision! }))
      .rejects.toMatchObject({ code: "TEST_GATE_NOT_READY" });
  });
  it("previews without changing task bytes or initializing a missing store", async () => {
    await run();
    const file = path.join(root, "data/tasks/task.json");
    const before = await fs.readFile(file);
    const preview = await runOrcaProjection("task", { storeRoot: root });
    expect(preview).toMatchObject({ mode: "preview", revision: 3, generation: 1,
      outboxState: "PENDING", testStatus: "NOT_RUN", reviewStatus: "NOT_RUN", eventLogVerified: false });
    expect(await fs.readFile(file)).toEqual(before);
    expect(await store.getTaskEvents("task")).toEqual([]);
    const missing = path.join(root, "missing");
    await expect(runOrcaProjection("task", { storeRoot: missing })).rejects.toMatchObject({ code: "CORRUPT_COMMIT" });
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("requires explicit matching revision, generation and digest before CLI application", async () => {
    const { commit } = await run();
    const options = { storeRoot: root, apply: true, revision: "3", generation: "1", digest: commit.digest };
    for (const override of [{ revision: "2" }, { generation: "2" }, { digest: "b".repeat(64) }]) {
      await expect(runOrcaProjection("task", { ...options, ...override })).rejects.toMatchObject({ code: "STALE_PROJECTION" });
    }
    expect(await store.getTaskEvents("task")).toEqual([]);
    expect((await store.getTask("task"))?.revision).toBe(3);
    expect(await runOrcaProjection("task", options)).toMatchObject({ mode: "apply", result: "projected" });
    await expect(runOrcaProjection("task", options)).rejects.toMatchObject({ code: "STALE_PROJECTION" });
    expect(await runOrcaProjection("task", { ...options, revision: "4" })).toMatchObject({ result: "duplicate" });
  });
  it.each([
    { apply: true }, { apply: true, revision: "03", generation: "1", digest: "a".repeat(64) },
    { apply: true, revision: "3", generation: "9007199254740992", digest: "a".repeat(64) },
    { apply: true, revision: "3", generation: "1", digest: "invalid" }, { revision: "3" },
  ])("rejects invalid operator confirmation before touching a missing store: %j", async options => {
    const missing = path.join(root, "missing");
    await expect(runOrcaProjection("task", { storeRoot: missing, ...options })).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects corrupt binding generation in preview and apply", async () => {
    const { commit } = await run();
    const task = (await store.getTask("task"))!;
    task.orcaGeneration = 2; await store.saveTask(task);
    await expect(runOrcaProjection("task", { storeRoot: root })).rejects.toMatchObject({ code: "CORRUPT_COMMIT" });
    await expect(runOrcaProjection("task", { storeRoot: root, apply: true, revision: "4", generation: "1", digest: commit.digest }))
      .rejects.toMatchObject({ code: "CORRUPT_COMMIT" });
    expect(await store.getTaskEvents("task")).toEqual([]);
  });
  it("registers the real CLI command and defaults to read-only preview", async () => {
    const { commit } = await run();
    const build = await fs.mkdtemp(path.join(process.cwd(), ".orca-cli-test-"));
    try {
      await promisify(execFile)(process.execPath, ["node_modules/typescript/bin/tsc", "--outDir", path.join(build, "dist")],
        { cwd: process.cwd(), timeout: 15000 });
      const args = [path.join(build, "dist/index.js"), "task", "orca-project", "task", "--store-root", root];
      const invoke = (extra: string[] = []) => promisify(execFile)(process.execPath, [...args, ...extra], { timeout: 15000 });
      const { stdout } = await invoke();
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, mode: "preview", revision: 3, eventLogVerified: false });
      expect((await store.getTask("task"))?.revision).toBe(3);
      expect(await store.getTaskEvents("task")).toEqual([]);
      await expect(invoke(["--unexpected=SECRET-SYNTHETIC"])).rejects.toMatchObject({
        code: 1, stderr: JSON.stringify({ ok: false, code: "INVALID_OPTIONS", automaticRetry: false }) + "\n", stdout: "",
      });
      await expect(invoke(["--apply"])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("INVALID_OPTIONS") });
      const confirmed = ["--apply", "--revision", "3", "--generation", "1", "--digest", commit.digest];
      expect(JSON.parse((await invoke(confirmed)).stdout)).toMatchObject({ ok: true, result: "projected" });
      await expect(invoke(confirmed)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("STALE_PROJECTION") });
      expect(await store.getTaskEvents("task")).toHaveLength(1);
    } finally { await fs.rm(build, { recursive: true, force: true }); }
  }, 20000);
  it("returns fixed CLI errors without leaking corrupt file contents", async () => {
    await fs.writeFile(path.join(root, "data/tasks/task.json"), "SECRET-CREDENTIAL");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previous = process.exitCode;
    try {
      await runOrcaProjectionCli("task", { storeRoot: root });
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(JSON.stringify({ ok: false, code: "PROJECTION_FAILED" }));
    } finally { process.exitCode = previous; }
  });
  it("projects once across reload and accepts import replay after projection", async () => {
    await run();
    expect(await projectOrcaDelivery(store, "task")).toBe("projected");
    store = new ProjectStore(root);
    expect(await projectOrcaDelivery(store, "task")).toBe("duplicate");
    expect((await run()).kind).toBe("duplicate");
    expect(await store.getTaskEvents("task")).toHaveLength(1);
    expect((await store.getTask("task"))?.revision).toBe(4);
  });
  it("recovers an appended event after marking failed without adding another event", async () => {
    await run();
    vi.spyOn(store, "saveTask").mockRejectedValueOnce(new Error("mark failed"));
    await expect(projectOrcaDelivery(store, "task")).rejects.toThrow("mark failed");
    expect(await store.getTaskEvents("task")).toHaveLength(1);
    store = new ProjectStore(root);
    expect(await projectOrcaDelivery(store, "task")).toBe("projected");
    expect(await store.getTaskEvents("task")).toHaveLength(1);
  });
  it("fails closed for conflicting events and truncated logs", async () => {
    const { commit } = await run();
    await store.appendTaskEvent({ ...commit.outbox.event, actor: "wrong" });
    await expect(projectOrcaDelivery(store, "task")).rejects.toThrow("EVENT_ID_CONFLICT");
    await fs.writeFile(path.join(root, "logs/tasks/task.jsonl"), '{"partial":');
    await expect(projectOrcaDelivery(store, "task")).rejects.toThrow("CORRUPT_EVENT_LOG");
    expect((await store.getTask("task"))?.orcaDelivery?.outbox.state).toBe("PENDING");
  });
  it("does not overwrite cancellation during projection and can reconcile afterward", async () => {
    await run();
    const append = store.appendTaskEventOnce.bind(store);
    vi.spyOn(store, "appendTaskEventOnce").mockImplementationOnce(async event => {
      const result = await append(event);
      const current = (await store.getTask("task"))!;
      current.status = "CANCELLED"; current.nextAction = "cancelled";
      await store.saveTask(current);
      return result;
    });
    await expect(projectOrcaDelivery(store, "task")).rejects.toMatchObject({ code: "CONFLICT" });
    await projectOrcaDelivery(new ProjectStore(root), "task");
    expect(await store.getTaskEvents("task")).toHaveLength(1);
    expect(await store.getTask("task")).toMatchObject({ status: "CANCELLED", nextAction: "cancelled" });
  });
  it("commits review, dedup record and pending event together without approval or transcript", async () => {
    const result = await run(); expect(result.kind).toBe("imported");
    const task = (await store.getTask("task"))!;
    expect(task.status).toBe("REVIEW"); expect(task.revision).toBe(3);
    expect(task.orcaDelivery).toMatchObject({ testStatus: "NOT_RUN", reviewStatus: "NOT_RUN", outbox: { state: "PENDING" } });
    expect(task.result).toBeUndefined(); expect(JSON.stringify(task.orcaDelivery)).not.toContain("SECRET");
    expect(await store.getTaskEvents("task")).toEqual([]);
  });
  it("replays after reload without new revision or event; rejects changed message and new ID", async () => {
    await run(); store = new ProjectStore(root);
    const before = await store.getTask("task");
    expect((await run()).kind).toBe("duplicate"); expect(await store.getTask("task")).toEqual(before);
    message.body = "changed"; await expect(run()).rejects.toMatchObject({ code: "DUPLICATE_CONFLICT" });
    message.id = "new-message"; await expect(run()).rejects.toMatchObject({ code: "ALREADY_IMPORTED" });
  });
  it("reconciles acknowledgement loss after commit by reading the durable duplicate record", async () => {
    const save = store.saveTask.bind(store);
    vi.spyOn(store, "saveTask").mockImplementationOnce(async task => { await save(task); throw new Error("lost acknowledgement"); });
    await expect(run()).rejects.toThrow("lost acknowledgement");
    store = new ProjectStore(root);
    expect((await run()).kind).toBe("duplicate"); expect((await store.getTask("task"))?.revision).toBe(3);
  });
  it("does not leave a delivery record when the commit fails before writing", async () => {
    vi.spyOn(store, "saveTask").mockRejectedValueOnce(new Error("before commit"));
    await expect(run()).rejects.toThrow("before commit");
    expect((await store.getTask("task"))?.orcaDelivery).toBeUndefined();
    expect((await run()).kind).toBe("imported");
  });
  it("rejects cancellation during collection rather than overwriting it", async () => {
    collect.mockImplementationOnce(async () => {
      const task = (await store.getTask("task"))!; task.status = "CANCELLED"; await store.saveTask(task);
      return { ok: true, receipt, stdoutSha256: "a".repeat(64), bytes: 100, provenance: "LOCAL_CLI_OBSERVATION" };
    });
    await expect(run()).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await store.getTask("task"))?.status).toBe("CANCELLED");
    expect((await store.getTask("task"))?.orcaDelivery).toBeUndefined();
  });
  it("requires fresh collector evidence and does not trust verified flags", async () => {
    message.verified = true; collect.mockResolvedValueOnce({ ok: false, code: "CLI_FAILED" });
    await expect(run()).rejects.toMatchObject({ code: "COLLECTION_FAILED" });
    expect((await store.getTask("task"))?.revision).toBe(2);
    receipt.result.worker.worktreeId = "wrong";
    await expect(run()).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });
  it("a failed settled delivery requires attention, never DONE", async () => {
    message.payload.outcome = "failed"; receipt.result.worker.state = "failed";
    receipt.result.projection.outcome = "failed"; receipt.result.projection.stage.worker = "failed";
    await run(); expect((await store.getTask("task"))?.status).toBe("NEED_USER");
  });
  it("duplicate delivery cannot resurrect a subsequently cancelled task", async () => {
    await run(); const task = (await store.getTask("task"))!; task.status = "CANCELLED"; await store.saveTask(task);
    expect((await run()).kind).toBe("duplicate");
    expect((await store.getTask("task"))?.status).toBe("CANCELLED");
    expect((await store.getTask("task"))?.revision).toBe(4);
  });
  it("permits only one simultaneous importer and never a second state transition", async () => {
    const outcomes = await Promise.allSettled([run(), importOrcaDelivery(new ProjectStore(root), "/trusted/orca", "task", message)]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await store.getTask("task"))?.revision).toBe(3);
    expect((await run()).kind).toBe("duplicate");
  });
  it("rejects changed owner/revision before any import commit", async () => {
    const task = (await store.getTask("task"))!; task.owner = "codex"; task.ownerId = "codex"; await store.saveTask(task);
    await expect(run()).rejects.toMatchObject({ code: "STALE_BINDING" });
    expect((await store.getTask("task"))?.orcaDelivery).toBeUndefined();
  });
  it("revalidates durable settlement on replay", async () => {
    await run(); receipt.result.dispatch.completedAt = "2026-10-11T01:00:00Z";
    await expect(run()).rejects.toMatchObject({ code: "DUPLICATE_CONFLICT" });
    expect((await store.getTask("task"))?.revision).toBe(3);
  });
  it("rejects unsafe message without invoking accessors or collecting", async () => {
    let calls = 0;
    const unsafe = Object.defineProperty({}, "id", { enumerable: true, get() { calls++; return "message"; } });
    await expect(importOrcaDelivery(store, "/trusted/orca", "task", unsafe)).rejects.toMatchObject({ code: "INVALID_MESSAGE" });
    expect(calls).toBe(0); expect(collect).not.toHaveBeenCalled();
  });
  it.each(["negative-revision", "wrong-revision", "missing-outbox", "event-digest", "event-target", "event-id",
    "review-pass", "test-pass", "provenance", "receipt-hash", "receipt-hash-array", "digest-array", "extra-data"])("rejects corrupt persisted commit: %s", async fault => {
    await run(); const task = (await store.getTask("task"))!; const commit = task.orcaDelivery! as any;
    if (fault === "negative-revision") commit.committedRevision = -1;
    if (fault === "wrong-revision") commit.committedRevision = 2;
    if (fault === "missing-outbox") delete commit.outbox;
    if (fault === "event-digest") commit.outbox.event.details.digest = "b".repeat(64);
    if (fault === "event-target") commit.outbox.event.details.to = "DONE";
    if (fault === "event-id") commit.outbox.event.id = "wrong";
    if (fault === "review-pass") commit.reviewStatus = "PASS";
    if (fault === "test-pass") commit.testStatus = "PASS";
    if (fault === "provenance") commit.provenance = "VERIFIED";
    if (fault === "receipt-hash") commit.receiptSha256 = "not-a-hash";
    if (fault === "receipt-hash-array") commit.receiptSha256 = ["a".repeat(64)];
    if (fault === "digest-array") commit.digest = [commit.digest];
    if (fault === "extra-data") commit.secret = "must-not-return";
    await store.saveTask(task); const before = await store.getTask("task");
    await expect(run()).rejects.toMatchObject({ code: "CORRUPT_COMMIT" });
    expect(await store.getTask("task")).toEqual(before);
  });
});
