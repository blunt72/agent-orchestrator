import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const gates = vi.hoisted(() => ({ issuance: vi.fn(), readiness: vi.fn(), sources: vi.fn(), fingerprint: vi.fn() }));
vi.mock("../../src/integrations/orca-approval-registry.js", () => ({ readOrcaApprovalRegistry: gates.issuance }));
vi.mock("../../src/integrations/orca-completion-readiness.js", () => ({ inspectOrcaCompletionSnapshotReadiness: gates.readiness }));
vi.mock("../../src/integrations/orca-operational-sources.js", () => ({ inspectOrcaOperationalSources: gates.sources }));
vi.mock("../../src/integrations/orca-tests.js", () => ({ fingerprintOrcaWorkspace: gates.fingerprint }));
import { completeOrcaLimitedPilot, type LimitedCompletionOptions } from "../../src/integrations/orca-limited-completion.js";
import { parseOrcaCompletionBinding } from "../../src/integrations/orca-evidence-manifest.js";
import { TaskRevisionStore } from "../../src/integrations/task-revision-store.js";
import { withTaskFileLock } from "../../src/integrations/task-file-lock.js";
import { writeTaskEvent } from "../../src/integrations/task-event-store.js";

// Synthetic admission only, exercising real local locks/CAS/outbox. NOT provider E2E.
let root: string, task: any, issuance: any, sources: any, options: LimitedCompletionOptions;
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const save = (value = task) => fs.writeFile(path.join(root, "data/tasks/task.json"), JSON.stringify(value));
const read = async () => JSON.parse(await fs.readFile(path.join(root, "data/tasks/task.json"), "utf8"));
const run = (action: LimitedCompletionOptions["action"] = "complete") => completeOrcaLimitedPilot({ ...options, action });
const eventLog = () => path.join(root, "logs/tasks/task.jsonl");
beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "limited-completion-")));
  await fs.mkdir(path.join(root, "sessions")); await fs.mkdir(path.join(root, "data/tasks"), { recursive: true });
  const binding = { agenthubTaskId: "task", projectId: "project", revision: "3", generation: 1, runtimeId: "runtime", hostId: "local",
    runId: "run", taskId: "orca-task", dispatchId: "dispatch", workspaceId: "workspace", workspacePath: root,
    terminalHandle: "terminal", developer: "gemini", reviewer: "codex", provider: "antigravity", ownerId: "gemini", claimId: null };
  task = { id: "task", projectId: "project", revision: 10, status: "REVIEW", orcaGeneration: 1, orcaBinding: binding,
    currentRound: 0, testCommand: "focused-test", owner: "gemini", ownerId: "gemini", ownerType: "AGENT", reviewer: "codex",
    orcaDelivery: { immutable: "delivery" }, orcaTestRun: { immutable: "tests" }, orcaReviewRun: { immutable: "review" },
    orcaBaseline: { immutable: "baseline" } }; await save();
  const completion = { version: 1, purpose: "SCOPED_ORCA_PILOT_COMPLETION", approvalId: "33333333-3333-4333-8333-333333333333",
    approvedAt: "2026-10-12T00:01:00.000Z", operator: { namespace: "agenthub-local-operator-v1", subject: "11111111-1111-4111-8111-111111111111" },
    taskId: "task", projectId: "project", expectedRevision: 10, generation: 1, dispatchId: "dispatch", runId: "run", runtimeId: "runtime",
    orcaTaskId: "orca-task", ownerId: "gemini", reviewerId: "codex", claimId: null, bindingDigest: parseOrcaCompletionBinding(JSON.stringify(binding)).digest,
    deliveryDigest: "b".repeat(64), testReceiptDigest: "c".repeat(64), reviewReceiptDigest: "d".repeat(64), workspaceDigest: "e".repeat(64),
    baselineDigest: "f".repeat(64), manifestDigest: "0".repeat(64), allowedFiles: ["test.ts"] };
  issuance = { completion, historicalGap: "EXECUTION_PERMISSION_NOT_STRUCTURALLY_DIGEST_BOUND", decisionDigest: "1".repeat(64),
    approvalDigest: "2".repeat(64), proposalDigest: "3".repeat(64), registryDigest: "4".repeat(64), enrollmentDigest: "5".repeat(64),
    authorizationBasis: "synthetic only", localIssuanceRecorded: true, sourceAuthenticated: false, canCompleteTask: false, scope: "LOCAL_ISSUANCE_RECORD_ONLY" };
  sources = { policyDigest: sha("{}"), evidenceDigest: "6".repeat(64), observedSourceDigests: { mechanism: "7".repeat(64) },
    localSourcesConsistent: true, sourceAuthenticated: false, canCompleteTask: false, trustedClock: false,
    permissionDigestBound: false, scope: "LIMITED_LOCAL_OPERATIONAL_SOURCES" };
  options = { projectRoot: root, sessionsRoot: path.join(root, "sessions"), taskId: "task", expectedProposalDigest: issuance.proposalDigest,
    expectedSourcePolicyDigest: sha("{}"), rawManifest: "{}", rawSourcePolicy: "{}", action: "complete" };
  gates.issuance.mockImplementation(() => structuredClone(issuance));
  gates.readiness.mockImplementation(async () => {
    const { version, purpose, approvalId, approvedAt, ...subjects } = issuance.completion;
    return { localChecksPassed: true, approvalSubjects: subjects, enrollmentDigest: issuance.enrollmentDigest };
  });
  gates.sources.mockImplementation(async () => ({ ...structuredClone(sources), revalidate: () => {} }));
  gates.fingerprint.mockImplementation(async () => issuance.completion.workspaceDigest);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it("commits one immutable limited completion and projects its exact event", async () => {
  expect(await run()).toMatchObject({ status: "DONE", revision: 12, outboxState: "PROJECTED", replay: false, sourceAuthenticated: false, globalGateApproved: false });
  const after = await read();
  expect(after.orcaCompletion.originalTask).toEqual(task);
  for (const key of ["orcaBinding", "orcaBaseline", "orcaDelivery", "orcaTestRun", "orcaReviewRun"]) expect(after[key]).toEqual(task[key]);
  expect(after.result.summary).toContain("EXECUTION_PERMISSION_NOT_STRUCTURALLY_DIGEST_BOUND");
  expect(JSON.parse((await fs.readFile(eventLog(), "utf8")).trim())).toEqual(after.orcaCompletion.outbox.event);
  expect(await fs.readdir(path.join(root, "data/task-writes"))).toEqual([]);
  expect(await fs.readdir(path.join(root, "data/task-executions"))).toEqual([]);
});
it("identical approval replay is idempotent and allows append-only source telemetry", async () => {
  await run(); const before = await fs.readFile(eventLog());
  sources.observedSourceDigests.mechanism = "8".repeat(64);
  expect(await run()).toMatchObject({ revision: 12, replay: true, outboxState: "PROJECTED" });
  expect(await fs.readFile(eventLog())).toEqual(before);
});
it.each(["status", "revision", "pendingAgentTurn", "pendingHumanResponse", "result", "orcaGeneration", "currentRound"])("rejects unready %s without completion", async key => {
  task[key] = key === "revision" ? 11 : key === "orcaGeneration" ? 2 : key === "currentRound" ? -1 : "invalid"; await save();
  await expect(run()).rejects.toThrow("LIMITED_COMPLETION_TASK_NOT_READY"); expect(await read()).toEqual(task);
});
it.each(["readiness", "sources", "issuance"])("preserves original task on rejected %s", async key => {
  gates[key as keyof typeof gates].mockImplementation(() => { throw Error("admission denied"); });
  await expect(run()).rejects.toThrow("admission denied"); expect(await read()).toEqual(task);
});
it("rejects false readiness and mismatched subjects", async () => {
  gates.readiness.mockResolvedValue({ localChecksPassed: false });
  await expect(run()).rejects.toThrow("LIMITED_COMPLETION_ADMISSION_FAILED");
  gates.readiness.mockResolvedValue({ localChecksPassed: true, approvalSubjects: {}, enrollmentDigest: issuance.enrollmentDigest });
  await expect(run()).rejects.toThrow("LIMITED_COMPLETION_ADMISSION_FAILED"); expect(await read()).toEqual(task);
});
it("rejects workspace drift after source validation", async () => {
  gates.fingerprint.mockResolvedValue("9".repeat(64)); await expect(run()).rejects.toThrow("LIMITED_COMPLETION_ADMISSION_CHANGED");
  expect(await read()).toEqual(task);
});
it("rejects final registry change", async () => {
  gates.sources.mockImplementation(async () => { issuance.authorizationBasis = "changed"; return { ...structuredClone(sources), revalidate: () => {} }; });
  await expect(run()).rejects.toThrow("LIMITED_COMPLETION_ADMISSION_CHANGED"); expect(await read()).toEqual(task);
});
it("rejects live task mutation bypassing revision", async () => {
  gates.sources.mockImplementation(async () => { await save({ ...task, ownerId: "codex" }); return { ...structuredClone(sources), revalidate: () => {} }; });
  await expect(run()).rejects.toThrow("LIMITED_COMPLETION_ADMISSION_CHANGED"); expect((await read()).status).toBe("REVIEW");
});
it("holds both locks throughout admission and rejects competing generic writers", async () => {
  gates.sources.mockImplementation(async () => {
    await expect(new TaskRevisionStore(root).save(task, 10)).rejects.toMatchObject({ code: "BUSY" });
    await expect(withTaskFileLock(root, "task", "task-executions", () => Error("busy"), async () => true)).rejects.toThrow("busy");
    return { ...structuredClone(sources), revalidate: () => {} };
  });
  await run(); expect((await read()).revision).toBe(12);
});
it("only one concurrent completion enters admission", async () => {
  const outcomes = await Promise.allSettled([run(), run()]);
  expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(x => x.status === "rejected")).toHaveLength(1);
  expect(gates.sources).toHaveBeenCalledTimes(1); expect((await read()).revision).toBe(12);
});
it("requires explicit reconciliation of a persisted pending outbox", async () => {
  await fs.mkdir(path.join(root, "logs/tasks"), { recursive: true });
  await fs.writeFile(eventLog() + ".lock", "orphan event lock");
  expect(await run()).toMatchObject({ revision: 11, outboxState: "PENDING" });
  await fs.unlink(eventLog() + ".lock");
  expect(await run()).toMatchObject({ revision: 11, outboxState: "PENDING", replay: true });
  await expect(fs.stat(eventLog())).rejects.toMatchObject({ code: "ENOENT" });
  expect(await run("reconcile")).toMatchObject({ revision: 12, outboxState: "PROJECTED", replay: true });
});
it("does not rebuild event on a pending restart and rejects event-ID conflicts", async () => {
  await fs.mkdir(path.join(root, "logs/tasks"), { recursive: true }); await fs.writeFile(eventLog() + ".lock", "busy");
  await run(); await fs.unlink(eventLog() + ".lock");
  const pending = await read(), event = pending.orcaCompletion.outbox.event;
  await writeTaskEvent(root, { ...event, details: { different: true } }, true);
  expect(await run("reconcile")).toMatchObject({ revision: 11, outboxState: "PENDING" });
  expect((await read()).orcaCompletion.outbox.event).toEqual(event);
});
it("does not duplicate an already-written event during reconciliation", async () => {
  await fs.mkdir(path.join(root, "logs/tasks"), { recursive: true }); await fs.writeFile(eventLog() + ".lock", "busy");
  await run(); await fs.unlink(eventLog() + ".lock");
  await writeTaskEvent(root, (await read()).orcaCompletion.outbox.event, true);
  await run("reconcile"); expect((await fs.readFile(eventLog(), "utf8")).trim().split("\n")).toHaveLength(1);
});
it.each(["approvalDigest", "registryDigest", "proposalDigest"])("rejects changed issuance on replay %s", async key => {
  await run(); issuance[key] = "9".repeat(64); await expect(run()).rejects.toThrow("LIMITED_COMPLETION_REPLAY_CONFLICT");
});
it("rejects stable original-source identity change on replay", async () => {
  await run(); sources.evidenceDigest = "9".repeat(64); await expect(run()).rejects.toThrow("LIMITED_COMPLETION_SOURCE_REPLAY_CONFLICT");
});
it.each(["status", "result", "revision", "orcaBinding", "orcaDelivery"])("rejects corrupted completed task %s", async key => {
  await run(); const completed = await read(); completed[key] = key === "revision" ? 13 : "corrupt"; await save(completed);
  await expect(run()).rejects.toThrow();
});
it("generic writers cannot inject, modify or remove the completion marker", async () => {
  const store = new TaskRevisionStore(root);
  await expect(store.save({ ...task, orcaCompletion: {} }, 10)).rejects.toMatchObject({ code: "BOUND_COMPLETION_DISABLED" });
  await run(); const completed = await read();
  await expect(store.save({ ...completed, status: "REVIEW", result: undefined, orcaCompletion: undefined }, 12))
    .rejects.toMatchObject({ code: "BOUND_COMPLETION_DISABLED" });
});
it.each(["pre-rename", "post-rename", "post-rename-throw"])("reconciles persistence acknowledgement faults %s", async phase => {
  const rename = fs.rename.bind(fs), open = fs.open.bind(fs); let injected = false;
  if (phase === "post-rename-throw") vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args); if (!injected && String(args[0]).endsWith(".completion.tmp")) { injected = true; throw Error("injected rename ack"); }
  });
  else vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (!injected && ((phase === "pre-rename" && String(args[0]).endsWith(".completion.tmp")) ||
      (phase === "post-rename" && String(args[0]) === path.join(root, "data/tasks")))) {
      injected = true; vi.spyOn(handle, "sync").mockRejectedValueOnce(Error("injected fsync"));
    }
    return handle;
  });
  if (phase === "pre-rename") { await expect(run()).rejects.toThrow("injected fsync"); expect(await read()).toEqual(task); }
  else { expect(await run()).toMatchObject({ revision: 12, outboxState: "PROJECTED" }); }
  expect(injected).toBe(true);
});
it("does not reconcile before a completion exists", async () => {
  await expect(run("reconcile")).rejects.toThrow("NO_COMPLETION_TO_RECONCILE"); expect(await read()).toEqual(task);
});
it.each(["pending", "projected"])("never acknowledges a %s rename while directory sync keeps failing, including replay", async phase => {
  const open = fs.open.bind(fs), rename = fs.rename.bind(fs);
  let completionRenames = 0;
  const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args);
    if (String(args[0]).endsWith(".completion.tmp")) completionRenames++;
  });
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) === path.join(root, "data/tasks") && completionRenames >= (phase === "pending" ? 1 : 2))
      vi.spyOn(handle, "sync").mockRejectedValue(Error("persistent directory sync"));
    return handle;
  });
  await expect(run()).rejects.toThrow();
  const persisted = await read();
  expect(persisted.status).toBe("DONE"); expect(persisted.orcaCompletion.outbox.state).toBe(phase === "pending" ? "PENDING" : "PROJECTED");
  await expect(run()).rejects.toThrow("persistent directory sync");
  if (phase === "pending") {
    await fs.mkdir(path.join(root, "logs/tasks"), { recursive: true }); await fs.writeFile(eventLog() + ".lock", "busy event lock");
    await expect(run("reconcile")).rejects.toThrow("persistent directory sync");
    await fs.unlink(eventLog() + ".lock");
  }
  renameSpy.mockRestore(); openSpy.mockRestore();
  expect(await run()).toMatchObject({ outboxState: phase === "pending" ? "PENDING" : "PROJECTED" });
  if (phase === "pending") expect(await run("reconcile")).toMatchObject({ revision: 12, outboxState: "PROJECTED" });
});
it("rejects changed raw policy pin before locks or admission", async () => {
  options.rawSourcePolicy = "{ }"; await expect(run()).rejects.toThrow("INVALID_LIMITED_COMPLETION_INPUT");
  expect(gates.issuance).not.toHaveBeenCalled();
});
it("does not persist if deferred original evidence validation fails after temp sync", async () => {
  let count = 0;
  gates.sources.mockImplementation(async () => ({ ...structuredClone(sources), revalidate: () => {
    if (++count === 2) throw Error("evidence changed before rename");
  } }));
  await expect(run()).rejects.toThrow("evidence changed before rename");
  expect(await read()).toEqual(task); expect(count).toBe(2);
  expect(await fs.readdir(path.join(root, "data/tasks"))).toEqual(["task.json"]);
});
