import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ProjectStore } from "../projects/project-store.js";
import { OrcaImportError, validatedOrcaCommit } from "./orca-import.js";
import { hashOrcaTestRun, validatedPassedOrcaTests, type OrcaReviewApproval, type OrcaReviewRun } from "./orca-review.js";
import { fingerprintOrcaWorkspace } from "./orca-tests.js";
import { validOrcaEvidenceRef } from "./orca-evidence.js";
import { validateCodexReviewTransport } from "../agents/codex-review-transport.js";

const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function hashOrcaReviewRun(run: OrcaReviewRun): string {
  return createHash("sha256").update(JSON.stringify(Object.keys(run).sort().map(key => [key, (run as any)[key]]))).digest("hex");
}

export interface OrcaAcceptanceExpectation extends OrcaReviewApproval {
  reviewRunHash: string;
}

/** Read-only local consistency snapshot, NOT permission to complete a task or provider attestation. */
export async function inspectOrcaAcceptance(store: Pick<ProjectStore, "getTask" | "verifyTaskEventReadOnly" | "readOrcaEvidence">,
  taskId: string, expectation: OrcaAcceptanceExpectation) {
  const expected = { ...expectation };
  if (!Number.isSafeInteger(expected.revision) || expected.revision < 1 || !Number.isSafeInteger(expected.generation) || expected.generation < 1 ||
    ![expected.digest, expected.workspaceHash, expected.testRunHash, expected.reviewRunHash].every(validHash))
    throw new OrcaImportError("INVALID_ACCEPTANCE_EXPECTATION");
  const task = await store.getTask(taskId);
  const commit = validatedOrcaCommit(task);
  const binding = task!.orcaBinding!;
  if (task!.revision !== expected.revision || commit.digest !== expected.digest || commit.generation !== expected.generation)
    throw new OrcaImportError("STALE_ACCEPTANCE_EXPECTATION");
  if (task!.status !== "REVIEW" || task!.result !== undefined || commit.outbox.state !== "PROJECTED" ||
    (commit.outbox.event.details as any).to !== "REVIEW" || task!.ownerType !== "AGENT" || task!.owner !== binding.developer ||
    task!.ownerId !== binding.ownerId || (task!.reviewerId ?? task!.reviewer) !== binding.reviewer ||
    (task!.claim?.id ?? null) !== binding.claimId || (task!.claim && task!.claim.ownerId !== binding.ownerId))
    throw new OrcaImportError("ACCEPTANCE_GATE_NOT_READY");
  const tests = validatedPassedOrcaTests(task!);
  if (tests.outputEvidence) await store.readOrcaEvidence(tests.outputEvidence);
  if (hashOrcaTestRun(tests) !== expected.testRunHash || tests.workspaceHash !== expected.workspaceHash)
    throw new OrcaImportError("STALE_TEST_RECEIPT");
  const review = task!.orcaReviewRun;
  const keys = ["id", "phase", "digest", "generation", "workspaceHash", "testRunId", "testRunHash", "reviewer", "startedRevision",
    "startedAt", "completedAt", "afterWorkspaceHash", "verdict", "responseHash", "provider", "adapter", "provenance",
    ...(review?.responseEvidence === undefined ? [] : ["responseEvidence"]),
    ...(review?.transportEvidence === undefined ? [] : ["transportEvidence"]), ...(review?.context === undefined ? [] : ["context"])];
  if (!review || JSON.stringify(Object.keys(review).sort()) !== JSON.stringify(keys.sort()) ||
    typeof review.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(review.id) ||
    review.phase !== "COMPLETED" || review.verdict !== "PASS" || review.digest !== commit.digest || review.generation !== commit.generation ||
    review.workspaceHash !== tests.workspaceHash || review.afterWorkspaceHash !== review.workspaceHash ||
    review.testRunId !== tests.id || review.testRunHash !== expected.testRunHash || review.reviewer !== binding.reviewer ||
    review.reviewer === binding.developer || review.provenance !== "LOCAL_REVIEW_ADAPTER" || !validHash(review.responseHash) ||
    review.provider !== (binding.reviewer === "codex" ? "openai" : "google") ||
    (binding.reviewer === "codex" ? !["codex-acp", "codex-exec"].includes(review.adapter!) : review.adapter !== "antigravity-agentapi") ||
    !Number.isSafeInteger(review.startedRevision) || review.startedRevision <= tests.startedRevision + 1 || review.startedRevision >= task!.revision! ||
    typeof review.startedAt !== "string" || !Number.isFinite(Date.parse(review.startedAt)) || Date.parse(review.startedAt) < Date.parse(tests.completedAt!) ||
    typeof review.completedAt !== "string" || !Number.isFinite(Date.parse(review.completedAt)) || Date.parse(review.completedAt) < Date.parse(review.startedAt))
    throw new OrcaImportError("INVALID_REVIEW_RECEIPT");
  if (review.responseEvidence !== undefined) {
    if (!validOrcaEvidenceRef(review.responseEvidence) || review.responseEvidence.sha256 !== review.responseHash)
      throw new OrcaImportError("INVALID_REVIEW_RECEIPT");
    await store.readOrcaEvidence(review.responseEvidence);
  }
  if (review.adapter === "codex-exec") {
    if (!validOrcaEvidenceRef(review.transportEvidence) || !validOrcaEvidenceRef(review.responseEvidence))
      throw new OrcaImportError("INVALID_REVIEW_RECEIPT");
    validateCodexReviewTransport((await store.readOrcaEvidence(review.transportEvidence)).toString("utf8"), review.responseHash!);
  } else if (review.transportEvidence !== undefined) throw new OrcaImportError("INVALID_REVIEW_RECEIPT");
  if (!isDeepStrictEqual(review.context, task!.orcaReviewContext)) throw new OrcaImportError("INVALID_REVIEW_RECEIPT");
  if (review.context) {
    if (Object.keys(review.context).sort().join(",") !== "priorTask,reconciliation,requirements" ||
        !Object.values(review.context).every(validOrcaEvidenceRef)) throw new OrcaImportError("INVALID_REVIEW_RECEIPT");
    for (const ref of Object.values(review.context)) await store.readOrcaEvidence(ref);
  }
  if (hashOrcaReviewRun(review) !== expected.reviewRunHash) throw new OrcaImportError("STALE_REVIEW_RECEIPT");
  await store.verifyTaskEventReadOnly(commit.outbox.event);
  if (await fingerprintOrcaWorkspace(binding.workspacePath) !== expected.workspaceHash) throw new OrcaImportError("WORKSPACE_CHANGED");
  if (!isDeepStrictEqual(await store.getTask(taskId), task)) throw new OrcaImportError("ACCEPTANCE_SNAPSHOT_CHANGED");
  return { taskId, revision: expected.revision, generation: expected.generation, digest: expected.digest,
    workspaceHash: expected.workspaceHash, testRunId: tests.id, reviewRunId: review.id,
    testRunHash: expected.testRunHash, reviewRunHash: expected.reviewRunHash,
    localEvidenceConsistent: true as const, canCompleteTask: false as const, scope: "LOCAL_ACCEPTANCE_PREFLIGHT" as const,
    blockers: ["REAL_PROVIDER_E2E_NOT_VERIFIED", "COMPLETION_WRITEBACK_DISABLED"] as const };
}
