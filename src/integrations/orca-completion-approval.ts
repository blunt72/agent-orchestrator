import { createHash } from "node:crypto";
import { decodeOrcaJson } from "./orca-json.js";

export interface OrcaOperatorIdentity {
  namespace: "agenthub-local-operator-v1";
  subject: string;
}
export interface OrcaCompletionApproval {
  version: 1;
  purpose: "SCOPED_ORCA_PILOT_COMPLETION";
  approvalId: string;
  approvedAt: string;
  operator: OrcaOperatorIdentity;
  taskId: string;
  projectId: string;
  dispatchId: string;
  runId: string;
  runtimeId: string;
  orcaTaskId: string;
  ownerId: "codex" | "gemini";
  reviewerId: "codex" | "gemini";
  claimId: string | null;
  expectedRevision: number;
  generation: number;
  bindingDigest: string;
  deliveryDigest: string;
  testReceiptDigest: string;
  reviewReceiptDigest: string;
  workspaceDigest: string;
  baselineDigest: string;
  manifestDigest: string;
  allowedFiles: string[];
}

export class OrcaCompletionApprovalError extends Error {
  constructor(public readonly code: "INVALID_COMPLETION_APPROVAL" | "UNREGISTERED_OPERATOR") { super(code); }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;
const hash = /^[a-f0-9]{64}(?![\s\S])/;
const id = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}(?![\s\S])/;
const exact = (value: Record<string, unknown>, keys: string[]) =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const invalid = (): never => { throw new OrcaCompletionApprovalError("INVALID_COMPLETION_APPROVAL"); };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const digestKeys = ["bindingDigest", "deliveryDigest", "testReceiptDigest", "reviewReceiptDigest", "workspaceDigest", "baselineDigest", "manifestDigest"] as const;
const idKeys = ["taskId", "projectId", "dispatchId", "runId", "runtimeId", "orcaTaskId"] as const;
const keys = ["version", "purpose", "approvalId", "approvedAt", "operator", ...idKeys, "ownerId", "reviewerId", "claimId",
  "expectedRevision", "generation", ...digestKeys, "allowedFiles"];

/** JSON-only canonical encoding: no normalization, object keys sorted recursively. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Pure validation only. Registry entries must come from trusted human enrollment.
 * This neither reads a registry nor grants completion authority or writes a task.
 */
export function parseOrcaCompletionApproval(raw: string, enrolled: readonly OrcaOperatorIdentity[]) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 32768) invalid();
  const decoded = decodeOrcaJson(raw);
  if (!decoded.ok) return invalid();
  if (!record(decoded.value)) return invalid();
  const value = decoded.value as Record<string, unknown>;
  if (!exact(value, keys) || value.version !== 1 || value.purpose !== "SCOPED_ORCA_PILOT_COMPLETION" ||
    typeof value.approvalId !== "string" || !uuid.test(value.approvalId) ||
    typeof value.approvedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.approvedAt) ||
    !Number.isFinite(Date.parse(value.approvedAt)) || new Date(value.approvedAt).toISOString() !== value.approvedAt ||
    !record(value.operator) || !exact(value.operator, ["namespace", "subject"]) ||
    value.operator.namespace !== "agenthub-local-operator-v1" || typeof value.operator.subject !== "string" || !uuid.test(value.operator.subject) ||
    idKeys.some(key => typeof value[key] !== "string" || !id.test(value[key] as string)) ||
    digestKeys.some(key => typeof value[key] !== "string" || !hash.test(value[key] as string)) ||
    !["codex", "gemini"].includes(value.ownerId as string) || !["codex", "gemini"].includes(value.reviewerId as string) || value.ownerId === value.reviewerId ||
    !(value.claimId === null || (typeof value.claimId === "string" && id.test(value.claimId))) ||
    !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1 || Number(value.expectedRevision) >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 ||
    !Array.isArray(value.allowedFiles) || value.allowedFiles.length < 1 || value.allowedFiles.length > 256) invalid();
  const files = value.allowedFiles as unknown[];
  if (files.some((name, index) => typeof name !== "string" || name.length < 1 || name.length > 4096 ||
    /[\x00-\x1f\\]/.test(name) || name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === ".." || part === ".git") ||
    (index > 0 && (files[index - 1] as string) >= name))) invalid();
  const operator = value.operator as unknown as OrcaOperatorIdentity;
  if (!Array.isArray(enrolled) || !enrolled.some(entry => record(entry) && exact(entry, ["namespace", "subject"]) &&
    entry.namespace === operator.namespace && entry.subject === operator.subject))
    throw new OrcaCompletionApprovalError("UNREGISTERED_OPERATOR");
  const encoded = canonical(value);
  return { approval: value as unknown as OrcaCompletionApproval, canonical: encoded,
    digest: createHash("sha256").update(encoded, "utf8").digest("hex"), canCompleteTask: false as const };
}
