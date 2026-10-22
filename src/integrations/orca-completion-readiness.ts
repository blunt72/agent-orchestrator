import { isDeepStrictEqual } from "node:util";
import { OrcaReadOnlyStore } from "./orca-read-only-store.js";
import { readOrcaLocalEnrollment } from "./orca-local-enrollment.js";
import { parseOrcaCompletionBinding, inspectOrcaEvidenceManifest } from "./orca-evidence-manifest.js";
import { inspectOrcaAcceptance, hashOrcaReviewRun } from "./orca-acceptance.js";
import { hashOrcaTestRun } from "./orca-review.js";
import { inspectOrcaFileAttribution } from "./orca-baseline.js";
import { inspectOrcaDeliveryEvidenceBytes } from "./orca-delivery-evidence.js";
import { inspectOrcaReviewSourceBytes } from "./orca-review-source.js";
import { decodeOrcaJson } from "./orca-json.js";
import { fingerprintOrcaWorkspace } from "./orca-tests.js";
import type { Task } from "../tasks/task.js";

const blockers = ["EXACT_HUMAN_COMPLETION_APPROVAL_ABSENT", "TRUSTED_SOURCE_EXTRACTION_NOT_IMPLEMENTED",
  "STARTUP_BINDING_CLEANUP_SEMANTICS_NOT_IMPLEMENTED", "COMPLETION_WRITEBACK_DISABLED"];

/** Prepare local approval subjects, without issuing an approval or writing any state.
 * Roots are trusted caller configuration, never read from a manifest/environment.
 */
export async function inspectOrcaCompletionReadiness(projectRoot: string, sessionsRoot: string,
  taskId: string, rawManifest: string, manifestDigest: string) {
  return inspectReadiness(projectRoot, sessionsRoot, taskId, rawManifest, manifestDigest);
}

/** Immutable pre-completion snapshot diagnostic, not transition authority. */
export async function inspectOrcaCompletionSnapshotReadiness(projectRoot: string, sessionsRoot: string,
  taskId: string, rawManifest: string, manifestDigest: string, original: Task) {
  return inspectReadiness(projectRoot, sessionsRoot, taskId, rawManifest, manifestDigest,
    JSON.parse(JSON.stringify(original)) as Task);
}

async function inspectReadiness(projectRoot: string, sessionsRoot: string,
  taskId: string, rawManifest: string, manifestDigest: string, original?: Task) {
  const checks: string[] = [];
  let stage = "INPUT";
  const fail = (): never => { throw new Error("READINESS_CHECK_FAILED"); };
  try {
    if (typeof taskId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}(?![\s\S])/.test(taskId) ||
      typeof rawManifest !== "string" || rawManifest.length > 32768 || Buffer.byteLength(rawManifest) > 32768 ||
      typeof manifestDigest !== "string" || !/^[a-f0-9]{64}(?![\s\S])/.test(manifestDigest)) fail();
    // Construct the store here so enrollment and task reads cannot target different roots.
    const liveStore = new OrcaReadOnlyStore(projectRoot);
    stage = "CURRENT_TASK";
    const liveBefore = await liveStore.getTask(taskId);
    const store = original ? { getTask: async (id: string) => id === taskId ? JSON.parse(JSON.stringify(original)) as Task : null,
      readOrcaEvidence: liveStore.readOrcaEvidence.bind(liveStore), verifyTaskEventReadOnly: liveStore.verifyTaskEventReadOnly.bind(liveStore) } : liveStore;
    const current = original ?? liveBefore;
    if (!current?.orcaBinding || !current.orcaDelivery || !current.orcaTestRun || !current.orcaReviewRun ||
      !current.orcaBaseline || current.pendingAgentTurn || current.status !== "REVIEW" || current.result !== undefined ||
      current.id !== taskId || !Number.isSafeInteger(current.revision) || Number(current.revision) < 1 ||
      Number(current.revision) >= Number.MAX_SAFE_INTEGER) fail();
    const task = current!;
    const rawBinding = JSON.stringify(task.orcaBinding);
    const bound = parseOrcaCompletionBinding(rawBinding);
    const binding = bound.binding;
    if (binding.agenthubTaskId !== taskId || task.orcaGeneration !== binding.generation) fail();
    checks.push(stage);
    stage = "LOCAL_ENROLLMENT";
    const expected = { taskId, projectId: binding.projectId, generation: binding.generation, bindingDigest: bound.digest };
    const enrollment = readOrcaLocalEnrollment(projectRoot, sessionsRoot, expected);
    checks.push(stage);
    stage = "LOCAL_ACCEPTANCE";
    const tests = task.orcaTestRun!, review = task.orcaReviewRun!;
    const acceptance = await inspectOrcaAcceptance(store, taskId, { revision: task.revision!, generation: binding.generation,
      digest: task.orcaDelivery!.digest, workspaceHash: tests.workspaceHash,
      testRunHash: hashOrcaTestRun(tests), reviewRunHash: hashOrcaReviewRun(review) });
    checks.push(stage);
    stage = "FILE_ATTRIBUTION";
    const attribution = await inspectOrcaFileAttribution(store, taskId);
    if (!attribution.withinWhitelist || attribution.workspaceHash !== tests.workspaceHash ||
      attribution.baselineHash !== task.orcaBaseline!.evidence.sha256) fail();
    const bytes = await store.readOrcaEvidence(task.orcaBaseline!.evidence);
    const baseline = decodeOrcaJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    const files = baseline.ok ? (baseline.value as { allowedFiles?: unknown } | null)?.allowedFiles : undefined;
    if (!Array.isArray(files) || files.length < 1 || files.length > 256 || files.some((file, index) =>
      typeof file !== "string" || file.length < 1 || file.length > 4096 || /[\x00-\x1f\\]/.test(file) ||
      file.startsWith("/") || file.split("/").some((part: string) => !part || part === "." || part === ".." || part === ".git") ||
      (index > 0 && files[index - 1] >= file))) fail();
    const allowedFiles = files as string[];
    checks.push(stage);
    stage = "MANIFEST_INTEGRITY";
    const manifest = await inspectOrcaEvidenceManifest(store, rawManifest, rawBinding, manifestDigest);
    const entry = (role: typeof manifest.manifest.entries[number]["role"]) => manifest.manifest.entries.find(e => e.role === role)!;
    if (!tests.outputEvidence || !isDeepStrictEqual(tests.outputEvidence, entry("test_output").evidence) ||
      entry("review_response").evidence.sha256 !== review.responseHash ||
      entry("test_output").sourceReceipt !== tests.id || entry("review_response").sourceReceipt !== review.id ||
      entry("worker_done").sourceReceipt !== task.orcaDelivery!.messageId) fail();
    checks.push(stage);
    stage = "DELIVERY_SOURCE";
    inspectOrcaDeliveryEvidenceBytes(rawBinding, await store.readOrcaEvidence(entry("worker_done").evidence),
      await store.readOrcaEvidence(entry("settlement").evidence), JSON.stringify({ deliveryDigest: task.orcaDelivery!.digest,
        messageId: task.orcaDelivery!.messageId, workerDoneSha256: entry("worker_done").evidence.sha256,
        settlementSha256: entry("settlement").evidence.sha256 }));
    checks.push(stage);
    stage = "REVIEW_TEST_SOURCE";
    inspectOrcaReviewSourceBytes(await store.readOrcaEvidence(entry("review_response").evidence),
      await store.readOrcaEvidence(entry("test_output").evidence), JSON.stringify({ reviewId: review.id, taskId,
        digest: task.orcaDelivery!.digest, generation: binding.generation, workspaceHash: tests.workspaceHash,
        testRunId: tests.id, testRunHash: hashOrcaTestRun(tests), responseSha256: review.responseHash,
        testOutputSha256: tests.outputHash, testOutputBytes: tests.outputEvidence!.bytes }));
    checks.push(stage);
    stage = "FINAL_SNAPSHOT";
    await inspectOrcaEvidenceManifest(store, rawManifest, rawBinding, manifestDigest);
    const finalTask = await store.getTask(taskId);
    const finalWorkspace = await fingerprintOrcaWorkspace(binding.workspacePath);
    if (!isDeepStrictEqual(finalTask, task) || finalWorkspace !== tests.workspaceHash ||
      (original !== undefined && !isDeepStrictEqual(await liveStore.getTask(taskId), liveBefore)) ||
      !isDeepStrictEqual(readOrcaLocalEnrollment(projectRoot, sessionsRoot, expected), enrollment)) fail();
    checks.push(stage);
    return { taskId, checks, localChecksPassed: true, enrollmentDigest: enrollment.digest, acceptance,
      approvalSubjects: { operator: enrollment.operator, taskId, projectId: binding.projectId, expectedRevision: task.revision!,
        generation: binding.generation, dispatchId: binding.dispatchId, runId: binding.runId, runtimeId: binding.runtimeId,
        orcaTaskId: binding.taskId, ownerId: binding.ownerId, reviewerId: binding.reviewer, claimId: binding.claimId,
        bindingDigest: bound.digest, deliveryDigest: task.orcaDelivery!.digest, testReceiptDigest: hashOrcaTestRun(tests),
        reviewReceiptDigest: hashOrcaReviewRun(review), workspaceDigest: tests.workspaceHash,
        baselineDigest: attribution.baselineHash, manifestDigest, allowedFiles },
      approvalIssued: false, sourceAuthenticated: false, canCompleteTask: false,
      scope: "LOCAL_COMPLETION_APPROVAL_PREPARATION", blockers: [...blockers] };
  } catch {
    return { taskId, checks, localChecksPassed: false, approvalIssued: false, sourceAuthenticated: false, canCompleteTask: false,
      scope: "LOCAL_COMPLETION_APPROVAL_PREPARATION", blockers: [`${stage}_FAILED`, ...blockers] };
  }
}
