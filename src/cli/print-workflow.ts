import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { decodeOrcaJson } from "../integrations/orca-json.js";
import { inspectOrcaProjectPolicyPaths, formatOrcaPolicyTestCommand } from "../integrations/orca-project-policy.js";
import { OrcaReadOnlyStore } from "../integrations/orca-read-only-store.js";
import { readOrcaPrintTaskSnapshot, readOrcaPrintTaskEventSnapshot } from "../integrations/orca-print-completion-readiness.js";
import { inspectOrcaPrintLimitedReadiness } from "../integrations/orca-print-limited-readiness.js";
import { fingerprintOrcaPrintCompletionImplementation, completeOrcaPrintTaskLimited } from "../integrations/orca-print-task-completion.js";
import { inspectOrcaPrintCompletionRuntime } from "../integrations/orca-print-completion-runtime.js";
import { verifyTaskEventBytes } from "../integrations/task-event-store.js";

export type PrintWorkflowAction = "status" | "preflight" | "request" | "complete" | "reconcile";
export interface PrintWorkflowOptions { input: string; sha256: string; output?: string }
const fail = (): never => { throw Error("PRINT_WORKFLOW_REJECTED"); };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(v);
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: object, keys: string[]) => isDeepStrictEqual(Object.keys(v).sort(), [...keys].sort());
const absolute = (v: unknown): v is string => typeof v === "string" && path.isAbsolute(v) && path.resolve(v) === v && !/[\x00-\x1f\x7f]/.test(v);

/** Original-byte pin and synchronous recheck, including across subsequent awaits. */
function pinnedFile(file: string, pin: string, max: number) {
  if (!absolute(file) || !digest(pin) || fs.realpathSync(file) !== file) return fail();
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(max) ||
      before.uid !== BigInt(process.getuid!()) || (before.mode & 0o022n)) return fail();
  const same = (s: typeof before) => s.isFile() && s.dev === before.dev && s.ino === before.ino && s.size === before.size &&
    s.mode === before.mode && s.uid === before.uid && s.nlink === before.nlink && s.mtimeNs === before.mtimeNs && s.ctimeNs === before.ctimeNs;
  const revalidate = () => { if (fs.realpathSync(file) !== file || !same(fs.lstatSync(file, { bigint: true }))) return fail(); };
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    if (!same(fs.fstatSync(fd, { bigint: true }))) return fail();
    const b = Buffer.alloc(Number(before.size) + 1); let n = 0;
    while (n < b.length) { const k = fs.readSync(fd, b, n, b.length - n, n); if (!k) break; n += k; }
    if (n !== Number(before.size) || !same(fs.fstatSync(fd, { bigint: true }))) return fail();
    bytes = b.subarray(0, n);
  } finally { fs.closeSync(fd); }
  revalidate(); if (sha(bytes) !== pin) return fail();
  return { bytes, revalidate };
}
function json(bytes: Buffer): any {
  const p = decodeOrcaJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return p.ok ? p.value : fail();
}
function ref(v: unknown) {
  if (!object(v) || !exact(v, ["path", "sha256"]) || !absolute(v.path) || !digest(v.sha256)) return fail();
  return v as { path: string; sha256: string };
}
function publish(file: string, value: unknown) {
  if (!absolute(file) || fs.realpathSync(path.dirname(file)) !== path.dirname(file)) return fail();
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  if (bytes.length > 32768) return fail();
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  return { requestPath: file, requestSha256: sha(bytes), approvalIssued: false, canCompleteTask: false };
}

/** No scheduling, model invocation, test execution, approval issuance or implicit retries. */
export async function runPrintWorkflow(action: PrintWorkflowAction, options: PrintWorkflowOptions) {
  const o = structuredClone(options);
  if (!["status", "preflight", "request", "complete", "reconcile"].includes(action) || !object(o) ||
      !exact(o, action === "request" ? ["input", "sha256", "output"] : ["input", "sha256"])) return fail();
  // Request/commit must run inside the reviewed frozen entry, never the normal CLI.
  const runtime = ["request", "complete", "reconcile"].includes(action) ? inspectOrcaPrintCompletionRuntime() : null;
  const input = pinnedFile(o.input, o.sha256, 32768), c = json(input.bytes);
  const common = ["version", "action", "projectRoot", "taskId"];
  const completed = action === "complete" || action === "reconcile";
  const keys = action === "status" ? [...common, "expectedRevision"] : completed ?
    [...common, "sessionsRoot", "settlement", "release", "approvalSha256", "implementationSha256", "runtimeArtifactDigest"] :
    [...common, "sessionsRoot", "projectPolicy", "settlement", "release", "expectation", ...(action === "request" ? ["runtimeArtifactDigest"] : [])];
  if (!object(c) || !exact(c, keys) || c.version !== 1 || c.action !== action || !absolute(c.projectRoot) ||
      typeof c.taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?![\s\S])/.test(c.taskId)) return fail();
  if (runtime && c.runtimeArtifactDigest !== runtime.digest) return fail();
  if (action === "status") {
    const task = readOrcaPrintTaskSnapshot(c.projectRoot, c.taskId);
    if (!Number.isSafeInteger(c.expectedRevision) || c.expectedRevision < 1 || task.revision !== c.expectedRevision) return fail();
    const record = task.orcaPrintTaskCompletion;
    if (record?.outbox.state === "PROJECTED") verifyTaskEventBytes(readOrcaPrintTaskEventSnapshot(c.projectRoot, c.taskId), record.outbox.event);
    input.revalidate();
    if (!isDeepStrictEqual(readOrcaPrintTaskSnapshot(c.projectRoot, c.taskId), task)) return fail();
    return { taskId: task.id, status: task.status, revision: task.revision, outboxState: record?.outbox.state ?? null,
      completionEventVerified: record?.outbox.state === "PROJECTED", historicalSnapshot: !!record,
      sourceAuthenticated: false, canCompleteTask: false, globalGateApproved: false, scope: "READ_ONLY_PERSISTED_STATE" };
  }
  if (!absolute(c.sessionsRoot)) return fail();
  const s = ref(c.settlement), r = ref(c.release);
  const settlement = pinnedFile(s.path, s.sha256, 262144), release = pinnedFile(r.path, r.sha256, 262144);
  if (completed) {
    if (!digest(c.approvalSha256) || !digest(c.implementationSha256)) return fail();
    input.revalidate(); settlement.revalidate(); release.revalidate();
    return completeOrcaPrintTaskLimited({ projectRoot: c.projectRoot, sessionsRoot: c.sessionsRoot, taskId: c.taskId,
      expectedApprovalDigest: c.approvalSha256, expectedImplementationDigest: c.implementationSha256,
      action, settlement: settlement.bytes, release: release.bytes });
  }
  const e = c.expectation;
  if (!object(e) || !exact(e, ["revision", "attempt", "finalizationHash", "enrollmentDigest", "settlementSha256", "releaseSha256", "workerIncarnation"]) ||
      !Number.isSafeInteger(e.revision) || e.revision < 1 || !["initial", "recovery"].includes(e.attempt) ||
      !digest(e.finalizationHash) || !digest(e.enrollmentDigest) || e.settlementSha256 !== s.sha256 || e.releaseSha256 !== r.sha256 ||
      typeof e.workerIncarnation !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(e.workerIncarnation)) return fail();
  const p = ref(c.projectPolicy), policy = pinnedFile(p.path, p.sha256, 32768);
  const checked = await inspectOrcaProjectPolicyPaths(new TextDecoder("utf-8", { fatal: true }).decode(policy.bytes), p.sha256);
  const task = readOrcaPrintTaskSnapshot(c.projectRoot, c.taskId), b = task.orcaBinding, profile = checked.policy;
  if (!b || task.status !== "REVIEW" || task.orcaPrintTaskCompletion || task.revision !== e.revision ||
      profile.projectId !== task.projectId || profile.workspace !== b.workspacePath || profile.developer !== "codex" || profile.reviewer !== "gemini" ||
      profile.developer !== b.developer || profile.reviewer !== b.reviewer || task.testCommand !== formatOrcaPolicyTestCommand(profile) || !task.orcaBaseline) return fail();
  const reader = new OrcaReadOnlyStore(c.projectRoot), baseline = json(await reader.readOrcaEvidence(task.orcaBaseline.evidence));
  if (!object(baseline) || !isDeepStrictEqual(baseline.allowedFiles, [...profile.writeFiles].sort())) return fail();
  const ready = await inspectOrcaPrintLimitedReadiness(c.projectRoot, c.sessionsRoot, c.taskId,
    e as Parameters<typeof inspectOrcaPrintLimitedReadiness>[3], settlement.bytes, release.bytes);
  input.revalidate(); policy.revalidate(); settlement.revalidate(); release.revalidate();
  if (!isDeepStrictEqual(readOrcaPrintTaskSnapshot(c.projectRoot, c.taskId), task)) return fail();
  const report = { taskId: c.taskId, revision: e.revision, attempt: e.attempt, localChecksPassed: ready.localChecksPassed,
    projectPolicyDigest: p.sha256, subjects: ready.subjects, proposedRetainedGaps: ready.proposedRetainedGaps,
    approvalIssued: false, canCompleteTask: false, sourceAuthenticated: false, globalGateApproved: false,
    automaticRetry: false, blockers: ["EXACT_TASK_SCOPED_HUMAN_APPROVAL_REQUIRED"] };
  if (action === "preflight") return report;
  if (!runtime) return fail();
  inspectOrcaPrintCompletionRuntime();
  const request = { version: 1, purpose: "TASK_SCOPED_PRINT_LIMITED_COMPLETION_FINAL_APPROVAL_REQUEST", status: "NOT_APPROVED",
    ...report, subjects: { ...ready.subjects, attempt: e.attempt, implementationDigest: fingerprintOrcaPrintCompletionImplementation(), runtimeArtifactDigest: runtime.digest } };
  return publish(o.output!, request);
}

export async function runPrintWorkflowCli(action: PrintWorkflowAction, options: PrintWorkflowOptions) {
  try { console.log(JSON.stringify({ ok: true, report: await runPrintWorkflow(action, options) })); }
  catch { console.log(JSON.stringify({ ok: false, code: "PRINT_WORKFLOW_REJECTED", automaticRetry: false, outcome: "UNKNOWN_OR_REJECTED" })); process.exitCode = 1; }
}
