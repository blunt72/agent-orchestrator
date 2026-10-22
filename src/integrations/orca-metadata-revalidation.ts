import { isDeepStrictEqual } from "node:util";
import type { ProjectStore } from "../projects/project-store.js";
import { inspectOrcaFileAttribution } from "./orca-baseline.js";
import { fingerprintOrcaWorkspace } from "./orca-tests.js";
import { validatedOrcaCommit, OrcaImportError } from "./orca-import.js";
import { validOrcaEvidenceRef, type OrcaEvidenceRef } from "./orca-evidence.js";

/** Explicit operator reconciliation of macOS metadata only. No baseline/whitelist change. */
export async function prepareOrcaMetadataRevalidation(store: ProjectStore, taskId: string, approval: {
  revision: number; workspaceHash: string; reviewId: string; executionStopped: true; authorizationEvidence: OrcaEvidenceRef;
}) {
  const expected = structuredClone(approval);
  if (!Number.isSafeInteger(expected.revision) || !/^[a-f0-9]{64}$/.test(expected.workspaceHash) ||
      expected.executionStopped !== true || !validOrcaEvidenceRef(expected.authorizationEvidence)) throw new OrcaImportError("INVALID_METADATA_REVALIDATION");
  return store.runTaskExecutionExclusive(taskId, async () => {
    const task = await store.getTask(taskId);
    validatedOrcaCommit(task);
    if (!task || task.status !== "REVIEW" || task.revision !== expected.revision || task.result !== undefined ||
        task.orcaReviewRun?.id !== expected.reviewId || task.orcaReviewRun.phase !== "RUNNING" ||
        task.orcaTestRun?.phase !== "COMPLETED" || task.orcaTestRun.outcome !== "PASS" ||
        (task.orcaRevalidationHistory?.length ?? 0) >= 8) throw new OrcaImportError("METADATA_REVALIDATION_NOT_READY");
    await store.readOrcaEvidence(expected.authorizationEvidence);
    if (task.orcaTestRun.outputEvidence) await store.readOrcaEvidence(task.orcaTestRun.outputEvidence);
    const attribution = await inspectOrcaFileAttribution(store, taskId);
    if (attribution.workspaceHash !== expected.workspaceHash || attribution.outsideWhitelist.length !== 1 ||
        attribution.outsideWhitelist[0] !== ".DS_Store" ||
        attribution.changes.find(c => c.file === ".DS_Store")?.kind !== "MODIFIED") throw new OrcaImportError("UNAPPROVED_WORKSPACE_DRIFT");
    const priorTaskEvidence = await store.putOrcaEvidence(Buffer.from(JSON.stringify(task)));
    if (await fingerprintOrcaWorkspace(task.orcaBinding!.workspacePath) !== expected.workspaceHash ||
        !isDeepStrictEqual(await store.getTask(taskId), task)) throw new OrcaImportError("REVALIDATION_SNAPSHOT_CHANGED");
    task.orcaRevalidationHistory = [...(task.orcaRevalidationHistory ?? []), {priorTaskEvidence,
      authorizationEvidence: expected.authorizationEvidence, workspaceHash: expected.workspaceHash, recordedAt: new Date().toISOString()}];
    // Inactive receipts remain byte-for-byte in the retained prior task, not discarded.
    delete task.orcaTestRun;
    delete task.orcaReviewRun;
    task.updatedAt = new Date().toISOString();
    task.nextAction = "Approved metadata drift archived; current-workspace limited tests and new review required";
    await store.saveTask(task);
    return {revision: task.revision!, priorTaskEvidence};
  });
}
