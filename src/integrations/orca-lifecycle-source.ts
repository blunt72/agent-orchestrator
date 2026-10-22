import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";
import { decodeOrcaExecEvidenceBytes } from "./orca-delivery-evidence.js";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const invalid = (): never => { throw Error("INVALID_ORCA_LIFECYCLE_SOURCE"); };
const obj = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
function json(bytes: Buffer): any {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 262144) return invalid();
  try {
    const p = decodeOrcaJson(new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!p.ok || !obj(p.value)) return invalid();
    return p.value;
  } catch { return invalid(); }
}

/** Partial local identity/state matching only; not lifecycle chronology or authentication. */
export function inspectOrcaLifecycleSourceBytes(rawBinding: string, startup: Buffer, confirmation: Buffer,
  cleanup: Buffer, rawExpectation: string) {
  if (![startup, confirmation, cleanup].every(b => Buffer.isBuffer(b) && b.length > 0 && b.length <= 262144) ||
    typeof rawExpectation !== "string" || !rawExpectation.length || Buffer.byteLength(rawExpectation, "utf8") > 4096) return invalid();
  const e = json(Buffer.from(rawExpectation)), { binding, digest } = parseOrcaCompletionBinding(rawBinding);
  if (JSON.stringify(Object.keys(e).sort()) !== '["cleanupSha256","confirmationSha256","questionId","startupSha256"]' ||
    typeof e.questionId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}(?![\s\S])/.test(e.questionId) ||
    e.startupSha256 !== sha(startup) || e.confirmationSha256 !== sha(confirmation) || e.cleanupSha256 !== sha(cleanup)) return invalid();
  const startDecoded = decodeOrcaExecEvidenceBytes(startup), cleanupDecoded = decodeOrcaExecEvidenceBytes(cleanup);
  const start = json(startDecoded), done = json(cleanupDecoded), c = json(confirmation), r = start.result;
  if (start.ok !== true || start._meta?.runtimeId !== binding.runtimeId || !obj(r) || r.runId !== binding.runId ||
    r.count !== 1 || !Array.isArray(r.messages) || r.messages.length !== 1 || r.replayed !== false ||
    r.acknowledged !== null || r.timedOut !== false || r.cancelled !== false || r.connectionLost !== false) return invalid();
  const q = r.messages[0];
  if (!obj(q) || q.id !== e.questionId || q.type !== "question" || q.delivery_contract !== "current_delivery" ||
    q.run_id !== binding.runId || q.from_handle !== `dispatch:${binding.dispatchId}` || q.to_handle !== `run:${binding.runId}` ||
    typeof q.payload !== "string" || Buffer.byteLength(q.payload, "utf8") > 32768) return invalid();
  const payload = json(Buffer.from(q.payload));
  if (payload.taskId !== binding.taskId || payload.dispatchId !== binding.dispatchId ||
    c.taskId !== binding.agenthubTaskId || c.status !== "DOING" || c.revision !== Number(binding.revision) ||
    parseOrcaCompletionBinding(JSON.stringify(c.binding)).digest !== digest || c.authorizationQuestion !== q.id ||
    c.developmentReleased !== false || c.canCompleteTask !== false || c.sourceAuthenticated !== false) return invalid();
  if (done.ok !== true || done._meta?.runtimeId !== binding.runtimeId || !obj(done.result) ||
    done.result.dispatchId !== binding.dispatchId || done.result.state !== "released" ||
    done.result.processAction !== "closed_agent_terminal" || done.result.archive?.source !== "terminal" ||
    done.result.archive?.status !== "captured" || done.result.mutation?.replayed !== false) return invalid();
  return { bindingDigest: digest, questionId: q.id as string, dispatchId: binding.dispatchId,
    lineage: { startupSha256: sha(startup), confirmationSha256: sha(confirmation), cleanupSha256: sha(cleanup),
      decodedStartupSha256: sha(startDecoded), decodedCleanupSha256: sha(cleanupDecoded) },
    identityStateMatch: true as const, chronologyVerified: false as const, sourceAuthenticated: false as const,
    canCompleteTask: false as const, scope: "PARTIAL_LOCAL_LIFECYCLE_MATCH" as const,
    blockers: ["STARTUP_BINDING_CLEANUP_CHRONOLOGY_NOT_VERIFIED", "SOURCE_AUTHENTICATION_NOT_VERIFIED"] as const };
}
