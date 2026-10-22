import { isDeepStrictEqual } from "node:util";
import { OrcaReadOnlyStore } from "./orca-read-only-store.js";
import { readOrcaLocalEnrollment } from "./orca-local-enrollment.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";
import { readOrcaSessionTextBlockStreaming } from "./orca-session-source.js";

/** Scoped read-only source consumption. Enrollment is local policy, not authorship. */
export async function readOrcaEnrolledSessionBlock(projectRoot: string, sessionsRoot: string,
  taskId: string, expectedRevision: number, relativeFile: string, rawSelector: string) {
  if (typeof taskId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}(?![\s\S])/.test(taskId) ||
    !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw Error("INVALID_ENROLLED_SESSION_INPUT");
  const store = new OrcaReadOnlyStore(projectRoot), current = await store.getTask(taskId);
  if (!current?.orcaBinding || current.status !== "REVIEW" || current.result !== undefined || current.pendingAgentTurn ||
    current.id !== taskId || current.revision !== expectedRevision) throw Error("ENROLLED_SESSION_TASK_NOT_READY");
  const { binding, digest } = parseOrcaCompletionBinding(JSON.stringify(current.orcaBinding));
  if (binding.agenthubTaskId !== taskId || binding.generation !== current.orcaGeneration) throw Error("ENROLLED_SESSION_BINDING_MISMATCH");
  const expected = { taskId, projectId: binding.projectId, generation: binding.generation, bindingDigest: digest };
  const enrollment = readOrcaLocalEnrollment(projectRoot, sessionsRoot, expected);
  const extracted = await readOrcaSessionTextBlockStreaming(sessionsRoot, relativeFile, rawSelector);
  const finalTask = await store.getTask(taskId);
  if (!isDeepStrictEqual(finalTask, current) ||
    !isDeepStrictEqual(readOrcaLocalEnrollment(projectRoot, sessionsRoot, expected), enrollment)) throw Error("ENROLLED_SESSION_SNAPSHOT_CHANGED");
  return { extracted, enrollmentDigest: enrollment.digest, taskId, revision: expectedRevision,
    sourceAuthenticated: false as const, canCompleteTask: false as const, scope: "ENROLLED_LOCAL_SESSION_BYTES_ONLY" as const };
}
