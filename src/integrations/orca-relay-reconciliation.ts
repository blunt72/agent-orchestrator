import { decodeOrcaJson } from "./orca-json.js";

export type RelayIdentity = {
  runtimeId: string;
  callerId: string;
  taskId: string;
  generation: number;
  bindingDigest: string;
  policyDigest: string;
};
export type RelayIntent = {
  version: 1;
  identity: RelayIdentity;
  operationId: string;
  requestDigest: string;
  kind: "create" | "release_development" | "reply" | "ack" | "cleanup";
  phase: "INTENT" | "OBSERVED";
  receiptDigest: string | null;
};
export type RelayObservation = {
  identity: RelayIdentity;
  operationId: string;
  requestDigest: string;
  status: "completed" | "pending" | "absent" | "unreachable";
  receiptDigest: string | null;
};
type Action = "RETAINED" | "RETAIN_RECEIPT" | "WAIT_ORIGINAL" | "INSPECT_REMOTE" | "CONFLICT";
const fail = (): never => { throw Error("INVALID_RELAY_RECONCILIATION"); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const token = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(v) && !/[\r\n]/.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v) && v.length === 64;
const fields = ["runtimeId", "callerId", "taskId", "generation", "bindingDigest", "policyDigest"];
function identity(v: unknown): asserts v is RelayIdentity {
  if (!object(v) || !exact(v, fields) || !token(v.runtimeId) || !token(v.callerId) || !token(v.taskId) ||
    !Number.isSafeInteger(v.generation) || (v.generation as number) < 1 || !digest(v.bindingDigest) || !digest(v.policyDigest)) fail();
}
function parse(raw: string): Record<string, unknown> {
  const value = decodeOrcaJson(raw);
  if (!value.ok || !object(value.value)) return fail();
  return value.value;
}
function same(a: RelayIdentity, b: RelayIdentity): boolean {
  return fields.every(k => a[k as keyof RelayIdentity] === b[k as keyof RelayIdentity]);
}

/** Internal normalized records only, NOT a parser for Orca CLI response schemas.
 * A decision never authorizes replay, development, task completion or remote I/O. */
export function reconcileOrcaRelay(rawIntent: string, rawObservation: string, rawCurrentIdentity: string) {
  const i = parse(rawIntent), o = parse(rawObservation), current = parse(rawCurrentIdentity);
  identity(i.identity); identity(o.identity); identity(current);
  if (!exact(i, ["version", "identity", "operationId", "requestDigest", "kind", "phase", "receiptDigest"]) ||
    i.version !== 1 || !token(i.operationId) || !digest(i.requestDigest) ||
    !["create", "release_development", "reply", "ack", "cleanup"].includes(i.kind as string) ||
    !["INTENT", "OBSERVED"].includes(i.phase as string) ||
    (i.phase === "INTENT" ? i.receiptDigest !== null : !digest(i.receiptDigest)) ||
    !exact(o, ["identity", "operationId", "requestDigest", "status", "receiptDigest"]) ||
    !token(o.operationId) || !digest(o.requestDigest) ||
    !["completed", "pending", "absent", "unreachable"].includes(o.status as string) ||
    (o.status === "completed" ? !digest(o.receiptDigest) : o.receiptDigest !== null)) return fail();
  let action: Action;
  if (!same(i.identity, current) || !same(i.identity, o.identity) || i.operationId !== o.operationId ||
    i.requestDigest !== o.requestDigest || (i.phase === "OBSERVED" && o.status === "completed" && i.receiptDigest !== o.receiptDigest)) {
    action = "CONFLICT";
  } else if (i.phase === "OBSERVED") {
    action = "RETAINED";
  } else if (o.status === "completed") {
    action = "RETAIN_RECEIPT";
  } else {
    action = o.status === "pending" ? "WAIT_ORIGINAL" : "INSPECT_REMOTE";
  }
  return { action, canReplay: false as const, canReleaseDevelopment: false as const,
    canCompleteTask: false as const, sourceAuthenticated: false as const };
}
