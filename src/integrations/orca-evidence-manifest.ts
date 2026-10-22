import { createHash } from "node:crypto";
import { decodeOrcaJson } from "./orca-json.js";
import { snapshotOrcaBinding, type OrcaBinding } from "./orca-delivery.js";
import { validOrcaEvidenceRef, type OrcaEvidenceRef } from "./orca-evidence.js";

export const ORCA_MANIFEST_ROLES = ["startup_wait", "binding_confirmation", "worker_done", "settlement", "test_output", "review_response", "cleanup"] as const;
type Role = typeof ORCA_MANIFEST_ROLES[number];
export interface OrcaManifestEntry {
  role: Role;
  source: "LOCAL_ORIGINAL_BYTES_UNAUTHENTICATED";
  mediaType: "application/json" | "application/x-ndjson" | "text/plain";
  schemaVersion: 1;
  taskId: string;
  dispatchId: string;
  runId: string;
  capturedAt: string;
  sourceReceipt: string;
  evidence: OrcaEvidenceRef;
}
export interface OrcaEvidenceManifest {
  version: 1;
  bindingDigest: string;
  entries: OrcaManifestEntry[];
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: object, keys: readonly string[]) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const bindingKeys = ["agenthubTaskId", "projectId", "revision", "generation", "runtimeId", "hostId", "runId", "taskId", "dispatchId", "workspaceId", "workspacePath", "terminalHandle", "developer", "reviewer", "provider", "ownerId", "claimId"];
const invalid = (): never => { throw new Error("INVALID_ORCA_MANIFEST"); };

// Only decoded JSON data reaches this encoder, never arbitrary caller objects.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function decode(raw: string, limit: number): unknown {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > limit) return invalid();
  const parsed = decodeOrcaJson(raw);
  if (!parsed.ok) return invalid();
  return parsed.value;
}

/** Strict version-1 binding encoding for future approval consumers; no state lookup. */
export function parseOrcaCompletionBinding(raw: string) {
  const value = decode(raw, 32768);
  if (!record(value) || !exact(value, bindingKeys)) return invalid();
  const binding = snapshotOrcaBinding(value);
  if (!binding || !/^[1-9][0-9]*(?![\s\S])/.test(binding.revision) ||
    !Number.isSafeInteger(Number(binding.revision))) return invalid();
  const encoded = canonical(value);
  return { binding, canonical: encoded, digest: hash(encoded) };
}

/** Structural manifest and original-byte integrity only, never source authentication.
 * No source text is executed or interpreted as instructions; no task state changes.
 */
export async function inspectOrcaEvidenceManifest(
  reader: { readOrcaEvidence(ref: OrcaEvidenceRef): Promise<Buffer> },
  raw: string, rawBinding: string, expectedDigest: string,
) {
  const { binding, digest: bindingDigest } = parseOrcaCompletionBinding(rawBinding);
  const value = decode(raw, 32768);
  if (!isHash(expectedDigest) || !record(value) || !exact(value, ["version", "bindingDigest", "entries"]) ||
    value.version !== 1 || value.bindingDigest !== bindingDigest || !Array.isArray(value.entries) ||
    value.entries.length !== ORCA_MANIFEST_ROLES.length) return invalid();
  for (let index = 0; index < value.entries.length; index++) {
    const entry = value.entries[index];
    if (!record(entry) || !exact(entry, ["role", "source", "mediaType", "schemaVersion", "taskId", "dispatchId", "runId", "capturedAt", "sourceReceipt", "evidence"]) ||
      entry.role !== ORCA_MANIFEST_ROLES[index] || entry.source !== "LOCAL_ORIGINAL_BYTES_UNAUTHENTICATED" ||
      !["application/json", "application/x-ndjson", "text/plain"].includes(entry.mediaType as string) || entry.schemaVersion !== 1 ||
      entry.taskId !== binding.agenthubTaskId || entry.dispatchId !== binding.dispatchId || entry.runId !== binding.runId ||
      typeof entry.capturedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.capturedAt) ||
      !Number.isFinite(Date.parse(entry.capturedAt)) || new Date(entry.capturedAt).toISOString() !== entry.capturedAt ||
      typeof entry.sourceReceipt !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}(?![\s\S])/.test(entry.sourceReceipt) ||
      !validOrcaEvidenceRef(entry.evidence) || !isHash(entry.evidence.sha256) || (entry.role !== "test_output" && entry.evidence.bytes < 1)) return invalid();
  }
  const encoded = canonical(value);
  const digest = hash(encoded);
  if (digest !== expectedDigest) throw new Error("STALE_ORCA_MANIFEST");
  // Snapshot metadata before the first await; never return mutable raw buffers.
  const manifest = value as unknown as OrcaEvidenceManifest;
  for (const entry of manifest.entries) {
    const ref = { ...entry.evidence };
    const bytes = await reader.readOrcaEvidence({ ...ref });
    if (!Buffer.isBuffer(bytes) || bytes.length !== ref.bytes || hash(bytes) !== ref.sha256) return invalid();
  }
  return { manifest, binding: binding as OrcaBinding, digest, canonical: encoded,
    byteIntegrityVerified: true as const, sourceAuthenticated: false as const, canCompleteTask: false as const,
    scope: "LOCAL_MANIFEST_INTEGRITY_ONLY" as const };
}
