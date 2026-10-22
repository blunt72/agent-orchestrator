import { isDeepStrictEqual } from "node:util";
import type { ProjectStore } from "../projects/project-store.js";
import { validOrcaEvidenceRef, type OrcaEvidenceRef } from "./orca-evidence.js";
import { hashOrcaReviewRun } from "./orca-acceptance.js";
import { fingerprintOrcaWorkspace } from "./orca-tests.js";
import { validatedPassedOrcaTests } from "./orca-review.js";
import { OrcaImportError, validatedOrcaCommit } from "./orca-import.js";

/** Operator-only one-time context repair; never converts a rejected verdict to PASS. */
export async function prepareOrcaReviewContext(store: ProjectStore, taskId: string, approval: {
  revision: number; rejectedReviewHash: string; requirements: OrcaEvidenceRef; reconciliation: OrcaEvidenceRef;
}) {
  const expected = structuredClone(approval);
  if (!Number.isSafeInteger(expected.revision) || !/^[a-f0-9]{64}$/.test(expected.rejectedReviewHash) ||
      !validOrcaEvidenceRef(expected.requirements) || !validOrcaEvidenceRef(expected.reconciliation)) throw new OrcaImportError("INVALID_REVIEW_CONTEXT");
  return store.runTaskExecutionExclusive(taskId, async () => {
    const task = await store.getTask(taskId);
    validatedOrcaCommit(task);
    if (!task || task.revision !== expected.revision || task.status !== "REVIEW" || task.result !== undefined || task.orcaReviewContext ||
        task.orcaReviewRun?.phase !== "COMPLETED" || task.orcaReviewRun.verdict !== "REQUEST_CHANGES" ||
        hashOrcaReviewRun(task.orcaReviewRun) !== expected.rejectedReviewHash) throw new OrcaImportError("REVIEW_CONTEXT_NOT_READY");
    const tests = validatedPassedOrcaTests(task);
    for (const ref of [expected.requirements, expected.reconciliation]) {
      const bytes = await store.readOrcaEvidence(ref);
      if (bytes.length === 0 || bytes.length > 262144) throw new OrcaImportError("INVALID_REVIEW_CONTEXT");
      new TextDecoder("utf-8", {fatal:true}).decode(bytes);
    }
    const priorTask = await store.putOrcaEvidence(Buffer.from(JSON.stringify(task)));
    if (await fingerprintOrcaWorkspace(task.orcaBinding!.workspacePath) !== tests.workspaceHash ||
        !isDeepStrictEqual(await store.getTask(taskId), task)) throw new OrcaImportError("REVIEW_CONTEXT_SNAPSHOT_CHANGED");
    task.orcaReviewContext = {requirements:expected.requirements,reconciliation:expected.reconciliation,priorTask};
    delete task.orcaReviewRun;
    task.updatedAt = new Date().toISOString();
    task.nextAction = "Rejected review retained; one explicit context-complete independent review required";
    await store.saveTask(task);
    return {revision:task.revision!,context:task.orcaReviewContext};
  });
}
