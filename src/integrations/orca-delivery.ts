import { createHash } from "node:crypto";
import { types } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";

export interface OrcaBinding {
  agenthubTaskId: string;
  projectId: string;
  revision: string;
  generation: number;
  runtimeId: string;
  hostId: string;
  runId: string;
  taskId: string;
  dispatchId: string;
  workspaceId: string;
  workspacePath: string;
  terminalHandle: string;
  developer: "codex" | "gemini";
  reviewer: "codex" | "gemini";
  provider: "codex" | "antigravity";
  ownerId: string;
  claimId: string | null;
}

export interface ImportContext {
  taskId: string;
  projectId: string;
  revision: string;
  generation: number;
  status: string;
  ownerId: string;
  claimId: string | null;
  reviewerId: string;
}

export type DeliveryPlan =
  | { kind: "rejected"; code: "INVALID_INPUT" | "STALE_BINDING" | "IDENTITY_MISMATCH" | "UNSETTLED" | "DUPLICATE_CONFLICT" }
  | { kind: "duplicate"; messageId: string; digest: string }
  | {
    kind: "candidate";
    taskId: string;
    dispatchId: string;
    generation: number;
    messageId: string;
    digest: string;
    proposedStatus: "REVIEW" | "NEED_USER";
    testStatus: "NOT_RUN";
    reviewStatus: "NOT_RUN";
    provenance: "UNVERIFIED_INPUT";
  };

type RecordValue = Record<string, any>;
const record = (x: any): x is RecordValue => x !== null && typeof x === "object" && !Array.isArray(x);
const text = (x: any): x is string => typeof x === "string" && x.length > 0 && x.length <= 4096 && !/[\u0000-\u001f]/.test(x);
const hash = (x: string) => createHash("sha256").update(x).digest("hex");

// Accept parsed data only: no JSON text, getters, custom prototypes or toJSON execution.
function canonicalData(input: unknown): string {
  let nodes = 0;
  const seen = new Set<object>();
  function visit(x: any, depth: number): any {
    if (++nodes > 20000 || depth > 24) throw Error();
    if (x === null || typeof x === "boolean") return x;
    if (typeof x === "number" && Number.isFinite(x)) return x;
    if (typeof x === "string" && x.length <= 262144) return x;
    if (!x || typeof x !== "object" || types.isProxy(x) || seen.has(x)) throw Error();
    const proto = Object.getPrototypeOf(x);
    if (Array.isArray(x) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw Error();
    seen.add(x);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(x);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some(k => typeof k !== "string")) throw Error();
      for (const key of keys as string[]) if (!("value" in descriptors[key])) throw Error();
      if (Array.isArray(x)) {
        if (x.length > 20000 || keys.length !== x.length + 1) throw Error();
        return Array.from({ length: x.length }, (_, i) => {
          if (!descriptors[String(i)]) throw Error();
          return visit(descriptors[String(i)].value, depth + 1);
        });
      }
      const copy = Object.create(null);
      for (const key of (keys as string[]).sort()) {
        if (!descriptors[key].enumerable) throw Error();
        copy[key] = visit(descriptors[key].value, depth + 1);
      }
      return copy;
    } finally { seen.delete(x); }
  }
  const encoded = JSON.stringify(visit(input, 0));
  if (Buffer.byteLength(encoded, "utf8") > 262144) throw Error();
  return encoded;
}

export function snapshotOrcaBinding(input: unknown): OrcaBinding | null {
  try {
    const b = JSON.parse(canonicalData(input));
    const strings = ["agenthubTaskId", "projectId", "revision", "runtimeId", "hostId", "runId", "taskId", "dispatchId", "workspaceId", "workspacePath", "terminalHandle", "ownerId"];
    if (!record(b) || !strings.every(k => text(b[k])) || !Number.isSafeInteger(b.generation) || b.generation < 1 ||
      !(b.claimId === null || text(b.claimId)) || !["codex", "gemini"].includes(b.developer) ||
      !["codex", "gemini"].includes(b.reviewer) || b.developer === b.reviewer || b.ownerId !== b.developer ||
      b.provider !== (b.developer === "gemini" ? "antigravity" : "codex") || !b.workspacePath.startsWith("/")) return null;
    return b as unknown as OrcaBinding;
  } catch { return null; }
}

export function snapshotOrcaMessage(input: unknown): unknown | null {
  try {
    const message = JSON.parse(canonicalData(input));
    if (record(message) && typeof message.payload === "string") {
      const decoded = decodeOrcaJson(message.payload);
      if (!decoded.ok) return null;
      message.payload = decoded.value;
    }
    return record(message) && text(message.id) && message.type === "worker_done" && record(message.payload) &&
      ["succeeded", "failed"].includes(message.payload.outcome) ? message : null;
  } catch { return null; }
}

/** Pure dry-run only. Inputs, including the binding and duplicate ledger, are not authenticated. */
export function planOrcaDelivery(
  binding: OrcaBinding,
  current: ImportContext,
  message: unknown,
  receipt: unknown,
  previous: { messageId: string; digest: string } | null = null,
): DeliveryPlan {
  const reject = (code: Extract<DeliveryPlan, { kind: "rejected" }>["code"]): DeliveryPlan => ({ kind: "rejected", code });
  try {
    // Snapshot before use, so ordinary accessors cannot run during validation.
    const all = JSON.parse(canonicalData({ binding, current, message, receipt, previous }));
    const b = all.binding, c = all.current, m = snapshotOrcaMessage(all.message), r = all.receipt;
    if (!record(b) || !record(c) || !record(m) || !record(r)) return reject("INVALID_INPUT");
    if (!snapshotOrcaBinding(b)) return reject("INVALID_INPUT");
    if (c.taskId !== b.agenthubTaskId || c.projectId !== b.projectId || c.revision !== b.revision ||
      c.generation !== b.generation || c.ownerId !== b.ownerId || c.claimId !== b.claimId ||
      c.reviewerId !== b.reviewer || c.status !== "DOING") return reject("STALE_BINDING");
    if (!text(m.id) || m.type !== "worker_done" || !record(m.payload) ||
      !["succeeded", "failed"].includes(m.payload.outcome)) return reject("INVALID_INPUT");
    const d = r.result?.dispatch, w = r.result?.worker, p = r.result?.projection;
    if (r.ok !== true || !record(d) || !record(w) || !record(p)) return reject("INVALID_INPUT");
    // Released terminals lose their live provider projection; require durable launch and resource ownership instead.
    const resource = r.result?.terminalResource;
    const releasedProvider = p.provider === null && p.resource?.state === "released" &&
      p.resource?.releaseState === "released" && p.resource?.terminalState === "released" &&
      record(resource) && text(resource.id) && p.resource.id === resource.id &&
      resource.ownerDispatchId === b.dispatchId && resource.originDispatchId === b.dispatchId &&
      p.resource.ownerDispatchId === b.dispatchId && resource.terminalHandle === b.terminalHandle &&
      resource.worktreeId === b.workspaceId && resource.endpointId === b.runtimeId &&
      ["originDispatchId", "terminalHandle", "worktreeId", "endpointId", "endpointIncarnation"].every(key =>
        p.resource[key] === undefined || p.resource[key] === resource[key]) &&
      resource.ownershipState === "released" && resource.releaseState === "released" &&
      w.startOptions?.launch?.effective?.agent === b.provider;
    if (m.run_id !== b.runId || m.from_handle !== b.terminalHandle || m.to_handle !== `run:${b.runId}` ||
      m.payload.taskId !== b.taskId || m.payload.dispatchId !== b.dispatchId ||
      r._meta?.runtimeId !== b.runtimeId || d.id !== b.dispatchId || d.runId !== b.runId || d.taskId !== b.taskId ||
      (d.task_id !== undefined && d.task_id !== b.taskId) || d.assigneeHandle !== b.terminalHandle ||
      d.hostScope?.kind !== "local" || d.hostScope?.hostId !== b.hostId ||
      w.dispatchId !== b.dispatchId || w.runtimeEpoch !== b.runtimeId || w.worktreeId !== b.workspaceId ||
      w.agentTerminalHandle !== b.terminalHandle || w.startOptions?.agent !== b.provider ||
      (w.startOptions?.resolvedWorktreeId !== undefined && w.startOptions.resolvedWorktreeId !== b.workspaceId) ||
      p.dispatchId !== b.dispatchId || p.id !== b.dispatchId || p.taskId !== b.taskId || p.runId !== b.runId ||
      p.role !== "worker" || p.host?.kind !== "local" || p.host?.id !== b.hostId ||
      p.workspace?.id !== b.workspaceId || (p.provider?.id !== b.provider && !releasedProvider) ||
      r.result.terminal?.worktreePath !== b.workspacePath || r.result.terminal?.worktreeId !== b.workspaceId ||
      r.result.terminal?.handle !== b.terminalHandle ||
      (r.result.terminal?.executionHostId !== undefined && r.result.terminal.executionHostId !== b.hostId) ||
      (r.result.terminal?.agentIdentity !== undefined && r.result.terminal.agentIdentity !== b.provider) ||
      (d.contractVersion !== undefined && d.contractVersion !== 1)) return reject("IDENTITY_MISMATCH");
    if (d.status !== "completed" || !text(d.completedAt) || !Number.isFinite(Date.parse(d.completedAt)) ||
      w.state !== m.payload.outcome || w.stage !== "settled" || p.outcome !== m.payload.outcome ||
      p.stage?.dispatch !== "completed" || p.stage?.worker !== m.payload.outcome ||
      p.evidence?.durable !== true) return reject("UNSETTLED");
    // Liveness is deliberately not used to infer settlement or authorize process actions.
    const digest = hash(canonicalData({ binding: b, message: m, settlement: {
      dispatchId: d.id, completedAt: d.completedAt, outcome: w.state,
    } }));
    if (all.previous !== null) {
      if (!record(all.previous) || !text(all.previous.messageId) || !/^[a-f0-9]{64}$/.test(all.previous.digest)) return reject("INVALID_INPUT");
      if (all.previous.messageId === m.id) return all.previous.digest === digest
        ? { kind: "duplicate", messageId: m.id, digest } : reject("DUPLICATE_CONFLICT");
    }
    return { kind: "candidate", taskId: b.agenthubTaskId, dispatchId: b.dispatchId, generation: b.generation,
      messageId: m.id, digest, proposedStatus: w.state === "succeeded" ? "REVIEW" : "NEED_USER",
      testStatus: "NOT_RUN", reviewStatus: "NOT_RUN", provenance: "UNVERIFIED_INPUT" };
  } catch { return reject("INVALID_INPUT"); }
}
