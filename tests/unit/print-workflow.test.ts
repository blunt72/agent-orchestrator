import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ task: {} as any, ready: vi.fn(), complete: vi.fn(), event: vi.fn(), runtime: vi.fn(), baseline: {} as any }));
vi.mock("../../src/integrations/orca-print-completion-readiness.js", () => ({
  readOrcaPrintTaskSnapshot: () => structuredClone(mocks.task), readOrcaPrintTaskEventSnapshot: () => Buffer.from("event") }));
vi.mock("../../src/integrations/orca-print-limited-readiness.js", () => ({ inspectOrcaPrintLimitedReadiness: mocks.ready }));
vi.mock("../../src/integrations/orca-print-task-completion.js", () => ({
  completeOrcaPrintTaskLimited: mocks.complete, fingerprintOrcaPrintCompletionImplementation: () => "b".repeat(64) }));
vi.mock("../../src/integrations/orca-print-completion-runtime.js", () => ({ inspectOrcaPrintCompletionRuntime: mocks.runtime }));
vi.mock("../../src/integrations/task-event-store.js", () => ({ verifyTaskEventBytes: mocks.event }));
vi.mock("../../src/integrations/orca-read-only-store.js", () => ({ OrcaReadOnlyStore: class {
  async readOrcaEvidence() { return Buffer.from(JSON.stringify(mocks.baseline)); }
} }));
import { runPrintWorkflow } from "../../src/cli/print-workflow.js";
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
let root: string;
function put(name: string, value: unknown) {
  const file = path.join(root, name), raw = JSON.stringify(value);
  fs.writeFileSync(file, raw, { mode: 0o600 }); return { path: file, sha256: sha(raw) };
}
function fixture(projectId = "education") {
  fs.mkdirSync(path.join(root, "src")); fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(path.join(root, "README.md"), "synthetic documentation");
  fs.writeFileSync(path.join(root, "src/catalog.mjs"), "");
  const executable = fs.realpathSync(process.execPath), files = ["src/tutor.mjs", "test/tutor.test.mjs"];
  const policy = { version: 2, projectId, workspace: root, documentation: ["README.md"],
    readFiles: ["src/catalog.mjs"], writeFiles: files, coordinator: "antigravity", developer: "codex", reviewer: "gemini",
    command: { profile: "node-test", executable, args: ["--test", "test/tutor.test.mjs"], cwd: root },
    limits: { timeoutMs: 60000, maxReworks: 1, maxDispatches: 2 } };
  const settlement = put("settlement.json", { original: "settlement" }), release = put("release.json", { original: "retained" });
  mocks.task = { id: "task-one", projectId, status: "REVIEW", revision: 15,
    testCommand: `${executable} --test test/tutor.test.mjs`, orcaBaseline: { evidence: {} },
    orcaBinding: { workspacePath: root, developer: "codex", reviewer: "gemini" } };
  mocks.baseline = { allowedFiles: files };
  mocks.ready.mockResolvedValue({ localChecksPassed: true, subjects: { taskId: "task-one", revision: 15, changedFiles: files },
    proposedRetainedGaps: ["USER_OWNED_RETAINED_TERMINAL", "SOURCE_NOT_AUTHENTICATED", "HISTORICAL_LIFECYCLE_ONLY"] });
  const config = { version: 1, action: "preflight", projectRoot: root, sessionsRoot: root, taskId: "task-one",
    projectPolicy: put("policy.json", policy), settlement, release,
    expectation: { revision: 15, attempt: "initial", finalizationHash: "a".repeat(64), enrollmentDigest: "c".repeat(64),
      settlementSha256: settlement.sha256, releaseSha256: release.sha256, workerIncarnation: "11111111-2222-3333-4444-555555555555" } };
  return { policy, config };
}
function options(config: unknown, extra = {}) { const f = put("input.json", config); return { input: f.path, sha256: f.sha256, ...extra }; }
beforeEach(() => {
  vi.clearAllMocks();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "print-workflow-")));
  mocks.runtime.mockReturnValue({ digest: "d".repeat(64), root }); mocks.complete.mockResolvedValue({ status: "DONE", outboxState: "PENDING" });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
describe("print workflow guard/composition unit tests; readiness/runtime are synthetic", () => {
  it.each(["education", "other-project"])("preflights %s without approval or task writes", async id => {
    const { config } = fixture(id), before = structuredClone(mocks.task);
    expect(await runPrintWorkflow("preflight", options(config))).toMatchObject({ localChecksPassed: true, approvalIssued: false,
      canCompleteTask: false, sourceAuthenticated: false, globalGateApproved: false, attempt: "initial" });
    expect(mocks.task).toEqual(before); expect(mocks.complete).not.toHaveBeenCalled(); expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it("keeps recovery explicit rather than inferring it", async () => {
    const { config } = fixture(); config.expectation.attempt = "recovery";
    expect(await runPrintWorkflow("preflight", options(config))).toMatchObject({ attempt: "recovery" });
    expect(mocks.ready.mock.calls[0][3].attempt).toBe("recovery");
  });
  it("requests exact frozen subjects without issuing approval, overwriting or completing", async () => {
    const { config } = fixture(), output = path.join(root, "request.json");
    const o = options({ ...config, action: "request", runtimeArtifactDigest: "d".repeat(64) }, { output });
    expect(await runPrintWorkflow("request", o)).toMatchObject({ approvalIssued: false, canCompleteTask: false });
    const raw = fs.readFileSync(output), request = JSON.parse(raw.toString());
    expect(request).toMatchObject({ status: "NOT_APPROVED", projectPolicyDigest: config.projectPolicy.sha256,
      subjects: { taskId: "task-one", attempt: "initial", runtimeArtifactDigest: "d".repeat(64), implementationDigest: "b".repeat(64) } });
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    await expect(runPrintWorkflow("request", o)).rejects.toThrow();
    expect(fs.readFileSync(output)).toEqual(raw); expect(mocks.complete).not.toHaveBeenCalled();
  });
  it.each(["complete", "reconcile"] as const)("delegates exactly one %s without chaining actions", async action => {
    const { config } = fixture();
    const c = { version: 1, action, projectRoot: root, sessionsRoot: root, taskId: "task-one", settlement: config.settlement,
      release: config.release, approvalSha256: "a".repeat(64), implementationSha256: "b".repeat(64), runtimeArtifactDigest: "d".repeat(64) };
    await runPrintWorkflow(action, options(c));
    expect(mocks.complete).toHaveBeenCalledTimes(1); expect(mocks.complete.mock.calls[0][0]).toMatchObject({ action,
      expectedApprovalDigest: c.approvalSha256, expectedImplementationDigest: c.implementationSha256 });
    expect(mocks.ready).not.toHaveBeenCalled();
  });
  it("does not retry a writer exception with an ambiguous outcome", async () => {
    const { config } = fixture(); mocks.complete.mockRejectedValueOnce(Error("unknown"));
    const c = { version: 1, action: "complete", projectRoot: root, sessionsRoot: root, taskId: "task-one", settlement: config.settlement,
      release: config.release, approvalSha256: "a".repeat(64), implementationSha256: "b".repeat(64), runtimeArtifactDigest: "d".repeat(64) };
    await expect(runPrintWorkflow("complete", options(c))).rejects.toThrow(); expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
  it("rejects ordinary/unpinned runtimes before any write", async () => {
    const { config } = fixture(), output = path.join(root, "request.json");
    const o = options({ ...config, action: "request", runtimeArtifactDigest: "e".repeat(64) }, { output });
    await expect(runPrintWorkflow("request", o)).rejects.toThrow(); expect(fs.existsSync(output)).toBe(false);
    mocks.runtime.mockImplementationOnce(() => { throw Error("FROZEN_PRINT_RUNTIME_REQUIRED"); });
    await expect(runPrintWorkflow("request", o)).rejects.toThrow(); expect(mocks.complete).not.toHaveBeenCalled();
  });
  it.each(["action", "extra", "revision", "attempt", "receiptPin", "project", "roles", "whitelist", "command"])("rejects %s mismatch", async field => {
    const { config } = fixture(); const c: any = structuredClone(config);
    if (field === "action") c.action = "complete";
    if (field === "extra") c.approve = true;
    if (field === "revision") c.expectation.revision++;
    if (field === "attempt") c.expectation.attempt = "auto";
    if (field === "receiptPin") c.expectation.releaseSha256 = "f".repeat(64);
    if (field === "project") mocks.task.projectId = "other";
    if (field === "roles") mocks.task.orcaBinding.reviewer = "codex";
    if (field === "whitelist") mocks.baseline.allowedFiles.push("src/extra.mjs");
    if (field === "command") mocks.task.testCommand += " && touch /tmp/evil";
    await expect(runPrintWorkflow("preflight", options(c))).rejects.toThrow(); expect(mocks.complete).not.toHaveBeenCalled();
  });
  it.each(["policy", "input", "settlement", "release", "task"])("closes post-await %s drift", async field => {
    const { config } = fixture(), o = options(config);
    mocks.ready.mockImplementationOnce(async () => {
      if (field === "task") mocks.task.revision++;
      else fs.appendFileSync(field === "input" ? o.input : field === "policy" ? config.projectPolicy.path : config[field as "settlement" | "release"].path, " ");
      return { localChecksPassed: true, subjects: {}, proposedRetainedGaps: [] };
    });
    await expect(runPrintWorkflow("preflight", o)).rejects.toThrow();
  });
  it.each(["pin", "symlink", "hardlink", "oversize", "utf8", "duplicate"])("rejects unsafe %s input", async kind => {
    const { config } = fixture(); const o = options(config);
    if (kind === "pin") o.sha256 = "0".repeat(64);
    if (kind === "symlink") { const alias = path.join(root, "alias.json"); fs.symlinkSync(o.input, alias); o.input = alias; }
    if (kind === "hardlink") fs.linkSync(o.input, path.join(root, "alias.json"));
    if (kind === "oversize") fs.writeFileSync(o.input, " ".repeat(32769));
    if (kind === "utf8") { const b = Buffer.from([0xc3, 0x28]); fs.writeFileSync(o.input, b); o.sha256 = sha(b); }
    if (kind === "duplicate") { const b = '{"version":1,"version":1}'; fs.writeFileSync(o.input, b); o.sha256 = sha(b); }
    await expect(runPrintWorkflow("preflight", o)).rejects.toThrow(); expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("reports retained completed state without opening it for development", async () => {
    mocks.task = { id: "finished", status: "DONE", revision: 17, orcaPrintTaskCompletion: { outbox: { state: "PROJECTED", event: { id: "exact" } } } };
    expect(await runPrintWorkflow("status", options({ version: 1, action: "status", projectRoot: root, taskId: "finished", expectedRevision: 17 })))
      .toMatchObject({ status: "DONE", historicalSnapshot: true, completionEventVerified: true, canCompleteTask: false });
    expect(mocks.event).toHaveBeenCalledTimes(1); expect(mocks.ready).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled();
  });
});
