import { isDeepStrictEqual } from "node:util";
import type { ProjectStore } from "../projects/project-store.js";
import { parseOrcaCompletionApproval, type OrcaOperatorIdentity } from "./orca-completion-approval.js";
import { inspectOrcaAcceptance, hashOrcaReviewRun } from "./orca-acceptance.js";
import { hashOrcaTestRun } from "./orca-review.js";
import { inspectOrcaFileAttribution } from "./orca-baseline.js";
import { inspectOrcaEvidenceManifest, parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";
import { inspectOrcaDeliveryEvidenceBytes } from "./orca-delivery-evidence.js";
import { inspectOrcaReviewSourceBytes } from "./orca-review-source.js";
import { decodeOrcaJson } from "./orca-json.js";
import { fingerprintOrcaWorkspace } from "./orca-tests.js";

/** Unified read-only diagnostic. Never a completion capability, even if local checks pass.
 * Enrolled identities must be supplied by a trusted human-managed caller.
 */
export async function inspectOrcaUnifiedPreflight(store: ProjectStore, taskId: string, rawApproval: string,
  rawManifest: string, enrolled: readonly OrcaOperatorIdentity[]) {
  const checks: string[] = [];
  let stage = "APPROVAL";
  const fail = (code: string): never => { throw new Error(code); };
  const fixedBlockers = ["TRUSTED_SOURCE_EXTRACTION_NOT_IMPLEMENTED", "STARTUP_BINDING_CLEANUP_SEMANTICS_NOT_IMPLEMENTED", "COMPLETION_WRITEBACK_DISABLED"];
  try {
    // Parse before IO; no references to caller-owned metadata survive an await.
    const approval = parseOrcaCompletionApproval(rawApproval, enrolled).approval;
    if (approval.taskId !== taskId) fail("APPROVAL_TASK_MISMATCH");
    checks.push(stage);
    stage = "CURRENT_TASK";
    const task = await store.getTask(taskId);
    if (!task?.orcaBinding || !task.orcaDelivery || !task.orcaTestRun || !task.orcaReviewRun || task.pendingAgentTurn)
      fail("CURRENT_RECEIPTS_MISSING_OR_PENDING");
    const current = task!;
    const binding = current.orcaBinding!;
    const rawBinding = JSON.stringify(binding);
    const bound = parseOrcaCompletionBinding(rawBinding);
    const tests = current.orcaTestRun!;
    const review = current.orcaReviewRun!;
    if (approval.expectedRevision !== current.revision || approval.generation !== binding.generation ||
      approval.projectId !== binding.projectId || approval.dispatchId !== binding.dispatchId || approval.runId !== binding.runId ||
      approval.runtimeId !== binding.runtimeId || approval.orcaTaskId !== binding.taskId || approval.ownerId !== binding.ownerId ||
      approval.reviewerId !== binding.reviewer || approval.claimId !== binding.claimId || approval.bindingDigest !== bound.digest ||
      approval.deliveryDigest !== current.orcaDelivery!.digest || approval.testReceiptDigest !== hashOrcaTestRun(tests) ||
      approval.reviewReceiptDigest !== hashOrcaReviewRun(review) || approval.workspaceDigest !== tests.workspaceHash)
      fail("APPROVAL_CURRENT_TASK_MISMATCH");
    checks.push(stage);
    stage = "LOCAL_ACCEPTANCE";
    await inspectOrcaAcceptance(store, taskId, { revision: approval.expectedRevision, generation: approval.generation,
      digest: approval.deliveryDigest, workspaceHash: approval.workspaceDigest, testRunHash: approval.testReceiptDigest,
      reviewRunHash: approval.reviewReceiptDigest });
    checks.push(stage);
    stage = "FILE_ATTRIBUTION";
    const attribution = await inspectOrcaFileAttribution(store, taskId);
    if (!attribution.withinWhitelist || attribution.workspaceHash !== approval.workspaceDigest || attribution.baselineHash !== approval.baselineDigest)
      fail("APPROVAL_ATTRIBUTION_MISMATCH");
    const baselineRaw = await store.readOrcaEvidence(current.orcaBaseline!.evidence);
    const baseline = decodeOrcaJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(baselineRaw));
    if (!baseline.ok || !isDeepStrictEqual((baseline.value as any)?.allowedFiles, approval.allowedFiles)) fail("APPROVAL_WHITELIST_MISMATCH");
    checks.push(stage);
    stage = "MANIFEST_INTEGRITY";
    const inspected = await inspectOrcaEvidenceManifest(store, rawManifest, rawBinding, approval.manifestDigest);
    const entries = inspected.manifest.entries;
    const entry = (role: typeof entries[number]["role"]) => entries.find(value => value.role === role)!;
    if (!tests.outputEvidence || !isDeepStrictEqual(entry("test_output").evidence, tests.outputEvidence) ||
      entry("review_response").evidence.sha256 !== review.responseHash ||
      entry("worker_done").sourceReceipt !== current.orcaDelivery!.messageId) fail("MANIFEST_RECEIPT_LINK_MISMATCH");
    checks.push(stage);
    stage = "DELIVERY_SOURCE";
    const deliveryEvidence = inspectOrcaDeliveryEvidenceBytes(rawBinding, await store.readOrcaEvidence(entry("worker_done").evidence),
      await store.readOrcaEvidence(entry("settlement").evidence), JSON.stringify({ deliveryDigest: approval.deliveryDigest,
        messageId: current.orcaDelivery!.messageId, workerDoneSha256: entry("worker_done").evidence.sha256,
        settlementSha256: entry("settlement").evidence.sha256 }));
    checks.push(stage);
    stage = "REVIEW_TEST_SOURCE";
    inspectOrcaReviewSourceBytes(await store.readOrcaEvidence(entry("review_response").evidence),
      await store.readOrcaEvidence(entry("test_output").evidence), JSON.stringify({ reviewId: review.id, taskId,
        digest: approval.deliveryDigest, generation: approval.generation, workspaceHash: approval.workspaceDigest,
        testRunId: tests.id, testRunHash: approval.testReceiptDigest, responseSha256: review.responseHash,
        testOutputSha256: tests.outputHash, testOutputBytes: tests.outputEvidence!.bytes }));
    checks.push(stage);
    stage = "FINAL_SNAPSHOT";
    if (!isDeepStrictEqual(await store.getTask(taskId), current) || await fingerprintOrcaWorkspace(binding.workspacePath) !== approval.workspaceDigest)
      fail("PREFLIGHT_SNAPSHOT_CHANGED");
    // Recheck artifact integrity after semantic reads; still not an atomic filesystem snapshot.
    await inspectOrcaEvidenceManifest(store, rawManifest, rawBinding, approval.manifestDigest);
    if (!isDeepStrictEqual(await store.getTask(taskId), current) || await fingerprintOrcaWorkspace(binding.workspacePath) !== approval.workspaceDigest)
      fail("PREFLIGHT_SNAPSHOT_CHANGED");
    checks.push(stage);
    return { taskId, checks, deliveryEvidence, localChecksPassed: true, sourceAuthenticated: false, canCompleteTask: false,
      scope: "UNIFIED_READ_ONLY_PREFLIGHT", blockers: fixedBlockers };
  } catch {
    // Do not expose arbitrary filesystem/adapter exception text or source content.
    return { taskId, checks, localChecksPassed: false, sourceAuthenticated: false, canCompleteTask: false,
      scope: "UNIFIED_READ_ONLY_PREFLIGHT", blockers: [`${stage}_FAILED`, ...fixedBlockers] };
  }
}
