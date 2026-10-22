import { createHash } from "node:crypto";
import { decodeOrcaJson } from "./orca-json.js";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const token = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}(?![\s\S])/.test(v);

/** Only the actually observed absent lookup shape is supported. This diagnostic
 * does not authenticate caller identity, dispatch state or absence of effects. */
export function inspectOrcaRequestLookup(input: Buffer, expectedRuntime: string, expectedRequest: string) {
  if (!Buffer.isBuffer(input) || !input.length || input.length > 262144 || !token(expectedRuntime) || !token(expectedRequest))
    throw Error("INVALID_ORCA_REQUEST_LOOKUP");
  const bytes = Buffer.from(input);
  let parsed;
  try { parsed = decodeOrcaJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { throw Error("INVALID_ORCA_REQUEST_LOOKUP"); }
  if (!parsed.ok || !object(parsed.value)) throw Error("INVALID_ORCA_REQUEST_LOOKUP");
  const v = parsed.value;
  if (v.ok !== true || !token(v.id) || !object(v.result) || !object(v._meta) ||
    v._meta.runtimeId !== expectedRuntime || v.result.requestId !== expectedRequest ||
    typeof v.result.state !== "string") throw Error("ORCA_REQUEST_LOOKUP_MISMATCH");
  if (v.result.state !== "absent") throw Error("UNSUPPORTED_ORCA_REQUEST_LOOKUP_STATE");
  // Unknown fields are not interpreted as capabilities or execution authority.
  return { state: "absent" as const, nextAction: "INSPECT_REMOTE" as const,
    runtimeId: expectedRuntime, requestId: expectedRequest,
    responseSha256: createHash("sha256").update(bytes).digest("hex"),
    responseBytes: bytes, callerIdentityVerified: false as const,
    sourceAuthenticated: false as const, canReplay: false as const, canCompleteTask: false as const };
}

/** Source-informed error-envelope diagnostic, not live recovery acceptance.
 * Recovery command text/argv are untrusted data and are never returned. */
export function inspectOrcaMutationRecovery(input: Buffer, expectedRuntime: string) {
  if (!Buffer.isBuffer(input) || !input.length || input.length > 262144 || !token(expectedRuntime))
    throw Error("INVALID_ORCA_MUTATION_RECOVERY");
  const bytes = Buffer.from(input);
  let parsed;
  try { parsed = decodeOrcaJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { throw Error("INVALID_ORCA_MUTATION_RECOVERY"); }
  if (!parsed.ok || !object(parsed.value)) throw Error("INVALID_ORCA_MUTATION_RECOVERY");
  const v = parsed.value;
  if (v.ok !== false || !token(v.id) || !object(v._meta) || v._meta.runtimeId !== expectedRuntime ||
    !object(v.error) || !["runtime_unavailable", "remote_runtime_unavailable", "runtime_timeout", "invalid_runtime_response"].includes(v.error.code as string) ||
    !object(v.error.data)) throw Error("INVALID_ORCA_MUTATION_RECOVERY");
  const data = v.error.data, requestId = data.orchestrationRequestId;
  if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/i.test(requestId))
    throw Error("INVALID_ORCA_MUTATION_RECOVERY");
  if (data.recovery !== undefined && (!object(data.recovery) || data.recovery.orchestrationRequestId !== requestId ||
    data.recovery.disposition !== "outcome_unknown" || data.recovery.workerDeathInferred !== false))
    throw Error("INVALID_ORCA_MUTATION_RECOVERY");
  if (data.dispatchId !== undefined && !token(data.dispatchId)) throw Error("INVALID_ORCA_MUTATION_RECOVERY");
  if (object(data.recovery) && data.recovery.dispatchId !== undefined && data.recovery.dispatchId !== data.dispatchId)
    throw Error("INVALID_ORCA_MUTATION_RECOVERY");
  return { requestId, dispatchId: (data.dispatchId as string | undefined) ?? null,
    nextAction: data.dispatchId ? "INSPECT_DISPATCH" as const : "LOOKUP_REQUEST" as const,
    disposition: "outcome_unknown" as const,
    responseSha256: createHash("sha256").update(bytes).digest("hex"), responseBytes: bytes,
    callerIdentityVerified: false as const, sourceAuthenticated: false as const,
    canReplay: false as const, canCompleteTask: false as const };
}
