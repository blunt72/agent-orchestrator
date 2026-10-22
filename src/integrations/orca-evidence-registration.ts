import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ProjectStore } from "../projects/project-store.js";
import { decodeOrcaJson } from "./orca-json.js";
import { validOrcaEvidenceRef } from "./orca-evidence.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";

const fail = (code: string): never => { throw new Error(code); };
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?![\s\S])/.test(v);

/** Evidence integrity registration only: never saves a task or authenticates a source. */
export async function registerOrcaEvidence(store: Pick<ProjectStore,
  "getTask" | "runTaskExecutionExclusive" | "readOrcaEvidence" | "appendTaskEventOnce" | "verifyTaskEventReadOnly">,
  raw: string) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 32768) return fail("INVALID_EVIDENCE_REGISTRATION");
  const decoded = decodeOrcaJson(raw);
  const v = decoded.ok ? decoded.value as any : null;
  if (!v || Object.keys(v).sort().join(",") !== "bindingDigest,generation,recordedAt,refs,revision,taskId" ||
    !identifier(v.taskId) || !Number.isSafeInteger(v.revision) || v.revision < 1 ||
    !Number.isSafeInteger(v.generation) || v.generation < 1 ||
    typeof v.bindingDigest !== "string" || !/^[a-f0-9]{64}(?![\s\S])/.test(v.bindingDigest) ||
    typeof v.recordedAt !== "string" || !Number.isFinite(Date.parse(v.recordedAt)) ||
    new Date(v.recordedAt).toISOString() !== v.recordedAt || Date.parse(v.recordedAt) > Date.now() ||
    !Array.isArray(v.refs) || v.refs.length < 1 || v.refs.length > 32) return fail("INVALID_EVIDENCE_REGISTRATION");
  let previous = "";
  for (const item of v.refs) {
    if (!item || Object.keys(item).sort().join(",") !== "evidence,label" ||
      !identifier(item.label) || item.label <= previous || !validOrcaEvidenceRef(item.evidence))
      return fail("INVALID_EVIDENCE_REGISTRATION");
    previous = item.label;
  }
  const subjects = { taskId: v.taskId, revision: v.revision, generation: v.generation,
    bindingDigest: v.bindingDigest, recordedAt: v.recordedAt,
    refs: v.refs.map((r: any) => ({ label: r.label, evidence: {
      version: r.evidence.version, sha256: r.evidence.sha256, bytes: r.evidence.bytes } })) };
  const registrationDigest = hash(JSON.stringify(subjects));
  return store.runTaskExecutionExclusive(v.taskId, async () => {
    const task = await store.getTask(v.taskId);
    if (!task?.orcaBinding || task.revision !== v.revision || task.orcaGeneration !== v.generation ||
      parseOrcaCompletionBinding(JSON.stringify(task.orcaBinding)).digest !== v.bindingDigest)
      return fail("STALE_EVIDENCE_REGISTRATION");
    for (const item of subjects.refs) {
      const bytes = await store.readOrcaEvidence(item.evidence);
      if (bytes.length !== item.evidence.bytes || hash(bytes) !== item.evidence.sha256)
        return fail("INVALID_EVIDENCE_CONTENT");
    }
    if (!isDeepStrictEqual(await store.getTask(v.taskId), task)) return fail("EVIDENCE_REGISTRATION_DRIFT");
    const event = { id: `orca-evidence-${registrationDigest}`, taskId: v.taskId,
      type: "TASK_PROPOSAL" as const, actor: "system", timestamp: v.recordedAt,
      details: { scope: "EVIDENCE_REGISTRATION_ONLY", subjects, sourceAuthenticated: false, canCompleteTask: false } };
    // A post-append error is uncertain registration, never evidence that nothing was written.
    await store.appendTaskEventOnce(event);
    await store.verifyTaskEventReadOnly(event);
    if (!isDeepStrictEqual(await store.getTask(v.taskId), task)) return fail("EVIDENCE_REGISTRATION_DRIFT");
    return { taskId: v.taskId, revision: task.revision, eventId: event.id, registrationDigest,
      taskUnchanged: true as const, sourceAuthenticated: false as const, canCompleteTask: false as const };
  });
}
