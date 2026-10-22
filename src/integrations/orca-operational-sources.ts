import fs from "node:fs/promises";
import syncFs, { constants, type Stats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import type { Task } from "../tasks/task.js";
import type { OrcaBinding } from "./orca-delivery.js";
import { validOrcaEvidenceRef, type OrcaEvidenceRef } from "./orca-evidence.js";
import { decodeOrcaJson, decodeOrcaSessionRecordJson } from "./orca-json.js";
import { OrcaReadOnlyStore } from "./orca-read-only-store.js";
import { readOrcaLocalEnrollment } from "./orca-local-enrollment.js";
import { inspectOrcaEvidenceManifest, parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";
import { inspectOrcaLifecycleChronology } from "./orca-lifecycle-chronology.js";
import { inspectOrcaLifecycleSourceBytes } from "./orca-lifecycle-source.js";
import { decodeOrcaExecEvidenceBytes } from "./orca-delivery-evidence.js";
import { ORCA_SESSION_MAX_BYTES, ORCA_SESSION_STREAM_MAX_BYTES, readOrcaSessionTextBlockStreaming } from "./orca-session-source.js";

export const ORCA_OPERATIONAL_ROLES = ["waiting", "prebinding", "execution_reply", "worker_done", "settlement", "cleanup"] as const;
export type OrcaOperationalRole = typeof ORCA_OPERATIONAL_ROLES[number];

/** Original record hash includes its terminating LF; output hash covers one raw text block. */
export interface OrcaOperationalSourcePin {
  sessionId: string;
  callId: string;
  toolName: string;
  ordinal: number;
  blockIndex: number;
  recordSha256: string;
  outputSha256: string;
  timestamp: string;
}

/** Trusted operator configuration, strict exact keys at every level, <= 32 KiB UTF-8.
 * The main transaction MUST compare SHA-256(rawPolicy UTF-8) to its external
 * expectedSourcePolicyDigest. This inspector does not establish that trust.
 * Paths are relative to the separately enrolled sessionsRoot. Coordinator bytes
 * are fixed (<= 32 MiB); mechanism bytes may append (<= 64 MiB), but its ack pin
 * remains fixed. There is deliberately no caller-supplied expected ack output.
 */
export interface OrcaOperationalSourcePolicy {
  version: 1;
  coordinator: {
    relativeFile: string;
    sourceSha256: string;
    selectors: Record<OrcaOperationalRole, OrcaOperationalSourcePin>;
  };
  mechanism: {
    relativeFile: string;
    bindingAck: OrcaOperationalSourcePin;
  };
}

export interface OrcaOperationalSourcesInspection {
  /** Deferred consistency check only. Strip this function before durable recording. */
  revalidate: () => void;
  policyDigest: string;
  /** Stable validated evidence identity; excludes the appendable mechanism full hash. */
  evidenceDigest: string;
  observedSourceDigests: { coordinator: string; mechanism: string };
  localSourcesConsistent: true;
  sourceAuthenticated: false;
  trustedClock: false;
  permissionDigestBound: false;
  canCompleteTask: false;
  scope: "LIMITED_LOCAL_OPERATIONAL_SOURCES";
}

const invalid = (): never => { throw Error("INVALID_ORCA_OPERATIONAL_SOURCES"); };
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v) && v.length === 64;
const token = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}(?![\s\S])/.test(v);
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, any> => object(v) &&
  isDeepStrictEqual(Object.keys(v).sort(), [...keys].sort());
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (object(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const relative = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096 &&
  !path.isAbsolute(v) && !/[\x00-\x1f\\]/.test(v) && v.split("/").every(p => p && p !== "." && p !== "..");
function time(v: unknown): number {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z(?![\s\S])/.test(v)) return invalid();
  const n = Date.parse(v);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== (v.length === 20 ? v.slice(0, -1) + ".000Z" : v)) return invalid();
  return n;
}
function json(bytes: Buffer, sessionRecord = false): Record<string, any> {
  try {
    const raw = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const parsed = sessionRecord ? decodeOrcaSessionRecordJson(raw) : decodeOrcaJson(raw);
    if (!parsed.ok || !object(parsed.value)) return invalid();
    return parsed.value;
  } catch { return invalid(); }
}
function pin(value: unknown): void {
  if (!exact(value, ["sessionId", "callId", "toolName", "ordinal", "blockIndex", "recordSha256", "outputSha256", "timestamp"]) ||
    typeof value.sessionId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(value.sessionId) ||
    !token(value.callId) || !token(value.toolName) || !Number.isSafeInteger(value.ordinal) || value.ordinal < 1 ||
    !Number.isSafeInteger(value.blockIndex) || value.blockIndex < 0 || !hash(value.recordSha256) || !hash(value.outputSha256)) return invalid();
  time(value.timestamp);
}
function policy(raw: string): OrcaOperationalSourcePolicy {
  if (typeof raw !== "string" || !raw.length || raw.length > 32768 || Buffer.byteLength(raw, "utf8") > 32768 ||
    Buffer.from(raw, "utf8").toString("utf8") !== raw) return invalid();
  const value = json(Buffer.from(raw, "utf8"));
  if (!exact(value, ["version", "coordinator", "mechanism"]) || value.version !== 1 ||
    !exact(value.coordinator, ["relativeFile", "sourceSha256", "selectors"]) ||
    !relative(value.coordinator.relativeFile) || !hash(value.coordinator.sourceSha256) ||
    !exact(value.coordinator.selectors, ORCA_OPERATIONAL_ROLES) ||
    !exact(value.mechanism, ["relativeFile", "bindingAck"]) || !relative(value.mechanism.relativeFile)) return invalid();
  for (const role of ORCA_OPERATIONAL_ROLES) pin(value.coordinator.selectors[role]);
  pin(value.mechanism.bindingAck);
  const first = value.coordinator.selectors.waiting;
  if (ORCA_OPERATIONAL_ROLES.some(role => value.coordinator.selectors[role].sessionId !== first.sessionId)) return invalid();
  return value as unknown as OrcaOperationalSourcePolicy;
}
function selector(pin: OrcaOperationalSourcePin, sourceSha256: string) {
  return { sessionId: pin.sessionId, callId: pin.callId, toolName: pin.toolName, ordinal: pin.ordinal,
    blockIndex: pin.blockIndex, blockSha256: pin.outputSha256, sourceSha256 };
}
const sameFile = (a: Stats, b: Stats) => b.isFile() && b.nlink === 1 && a.dev === b.dev && a.ino === b.ino &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.uid === b.uid;
const sameDirectory = (a: Stats, b: Stats) => b.isDirectory() && a.dev === b.dev && a.ino === b.ino &&
  a.mode === b.mode && a.uid === b.uid;

function retainedEvidenceGuard(projectRoot: string, ref: OrcaEvidenceRef) {
  if (!validOrcaEvidenceRef(ref)) return invalid();
  const directory = path.join(projectRoot, "data", "orca-evidence-v1"), file = path.join(directory, ref.sha256);
  const directories = [projectRoot, path.join(projectRoot, "data"), directory].map(name => {
    const stat = syncFs.lstatSync(name);
    if (!stat.isDirectory() || syncFs.realpathSync(name) !== name) return invalid();
    return { name, stat };
  });
  const before = syncFs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size !== ref.bytes || syncFs.realpathSync(file) !== file) return invalid();
  return () => {
    try {
      if (syncFs.realpathSync(file) !== file || !sameFile(before, syncFs.lstatSync(file))) return invalid();
      for (const { name, stat } of directories) if (syncFs.realpathSync(name) !== name ||
        !sameDirectory(stat, syncFs.lstatSync(name))) return invalid();
    } catch { return invalid(); }
  };
}

// Existing extraction does not export full confined bytes needed by chronology.
async function readSource(root: string, relativeFile: string, limit: number) {
  if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) !== root || !relative(relativeFile)) return invalid();
  const file = path.join(root, relativeFile), directories: { name: string; stat: Stats }[] = [];
  let directory = root;
  for (const part of ["", ...relativeFile.split("/").slice(0, -1)]) {
    directory = path.join(directory, part);
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || await fs.realpath(directory) !== directory) return invalid();
    directories.push({ name: directory, stat });
  }
  if (await fs.realpath(file) !== file) return invalid();
  const entry = await fs.lstat(file);
  if (!entry.isFile() || entry.nlink !== 1 || entry.size < 1 || entry.size > limit) return invalid();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!sameFile(entry, before)) return invalid();
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== before.size || !sameFile(before, await handle.stat())) return invalid();
    const revalidate = () => {
      if (syncFs.realpathSync(file) !== file || !sameFile(before, syncFs.lstatSync(file))) return invalid();
      for (const { name, stat } of directories) {
        if (syncFs.realpathSync(name) !== name || !sameDirectory(stat, syncFs.lstatSync(name))) return invalid();
      }
    };
    revalidate();
    const value = bytes.subarray(0, length);
    return { bytes: value, digest: sha(value), revalidate };
  } finally { await handle.close(); }
}
function taskIdentity(task: Task, binding: OrcaBinding) {
  if (!task || task.id !== binding.agenthubTaskId || task.projectId !== binding.projectId ||
    task.orcaGeneration !== binding.generation || (task.worktree ?? task.workspace) !== binding.workspacePath ||
    task.ownerId !== binding.ownerId || (task.reviewerId ?? task.reviewer) !== binding.reviewer ||
    (task.claim?.id ?? null) !== binding.claimId || !Number.isSafeInteger(task.revision) || Number(task.revision) < Number(binding.revision) ||
    parseOrcaCompletionBinding(JSON.stringify(task.orcaBinding)).digest !== parseOrcaCompletionBinding(JSON.stringify(binding)).digest ||
    !exact(task.orcaBaseline, ["version", "evidence", "workspaceHash"]) || task.orcaBaseline.version !== 1 ||
    !validOrcaEvidenceRef(task.orcaBaseline.evidence) || !hash(task.orcaBaseline.workspaceHash)) return invalid();
}
function baselineIdentity(bytes: Buffer, task: Task, binding: OrcaBinding) {
  if (!bytes.length || bytes.length > 262144) return invalid();
  const b = json(bytes);
  if (!exact(b, ["version", "taskId", "generation", "bindingRevision", "workspacePath", "capturedAt", "head", "files", "allowedFiles", "provenance"]) ||
    b.version !== 1 || b.taskId !== task.id || b.generation !== binding.generation || b.bindingRevision !== binding.revision ||
    b.workspacePath !== binding.workspacePath || b.provenance !== "LOCAL_PRE_BINDING_SNAPSHOT" ||
    typeof b.head !== "string" || !/^[a-f0-9]{40,64}(?![\s\S])/.test(b.head) || !object(b.files) || Object.keys(b.files).length > 5000 ||
    !Array.isArray(b.allowedFiles) || !b.allowedFiles.length || b.allowedFiles.length > 256 ||
    b.allowedFiles.some((v: unknown, i: number) => !relative(v) || (v as string).split("/").includes(".git") ||
      (i > 0 && b.allowedFiles[i - 1] >= (v as string)))) return invalid();
  for (const [name, entry] of Object.entries(b.files)) {
    if (!relative(name) || name.split("/").includes(".git") || !exact(entry, ["type", "hash", "mode"]) ||
      !["file", "symlink"].includes(entry.type) || !hash(entry.hash) || !Number.isSafeInteger(entry.mode) || entry.mode < 0) return invalid();
  }
  if (sha(JSON.stringify({ head: b.head, files: Object.keys(b.files).sort().map(name => [name, b.files[name]]) })) !==
    task.orcaBaseline!.workspaceHash) return invalid();
  time(b.capturedAt);
  return b;
}

/** Read-only local corroboration. Caller owns locks, policy trust and replay comparison. */
export async function inspectOrcaOperationalSources(projectRoot: string, sessionsRoot: string, task: Task,
  rawManifest: string, manifestDigest: string, rawPolicy: string): Promise<OrcaOperationalSourcesInspection> {
  const p = policy(rawPolicy), policyDigest = sha(rawPolicy);
  const snapshot = structuredClone(task);
  if (!snapshot || snapshot.status !== "REVIEW" || snapshot.result !== undefined || snapshot.pendingAgentTurn ||
    typeof snapshot.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}(?![\s\S])/.test(snapshot.id)) return invalid();
  const rawBinding = JSON.stringify(snapshot.orcaBinding), bound = parseOrcaCompletionBinding(rawBinding), binding = bound.binding;
  taskIdentity(snapshot, binding);
  const delivery = snapshot.orcaDelivery;
  if (!delivery || !hash(delivery.digest) || !token(delivery.messageId) || delivery.dispatchId !== binding.dispatchId ||
    delivery.generation !== binding.generation || delivery.bindingRevision !== binding.revision) return invalid();
  const store = new OrcaReadOnlyStore(projectRoot);
  const expected = { taskId: snapshot.id, projectId: binding.projectId, generation: binding.generation, bindingDigest: bound.digest };
  const enrollment = readOrcaLocalEnrollment(projectRoot, sessionsRoot, expected);
  const evidenceGuards: (() => void)[] = [];
  const reader = { readOrcaEvidence: async (ref: OrcaEvidenceRef) => {
    const guard = retainedEvidenceGuard(projectRoot, ref);
    const bytes = await store.readOrcaEvidence(ref);
    guard(); evidenceGuards.push(guard); return bytes;
  } };
  const manifest = await inspectOrcaEvidenceManifest(reader, rawManifest, rawBinding, manifestDigest);
  const evidence = new Map<string, Buffer>();
  for (const entry of manifest.manifest.entries) evidence.set(entry.role, await reader.readOrcaEvidence(entry.evidence));
  const baselineBytes = await reader.readOrcaEvidence(snapshot.orcaBaseline!.evidence);
  const baseline = baselineIdentity(baselineBytes, snapshot, binding);
  const confirmationBytes = evidence.get("binding_confirmation")!, confirmation = json(confirmationBytes);
  if (!isDeepStrictEqual(confirmation.baseline, snapshot.orcaBaseline)) return invalid();

  const coordinator = await readSource(sessionsRoot, p.coordinator.relativeFile, ORCA_SESSION_MAX_BYTES);
  if (coordinator.digest !== p.coordinator.sourceSha256) return invalid();
  const blocks = new Map<OrcaOperationalRole, Awaited<ReturnType<typeof readOrcaSessionTextBlockStreaming>>>();
  const selectors = {} as Record<OrcaOperationalRole, ReturnType<typeof selector>>;
  for (const role of ORCA_OPERATIONAL_ROLES) {
    const expectedPin = p.coordinator.selectors[role];
    selectors[role] = selector(expectedPin, coordinator.digest);
    const block = await readOrcaSessionTextBlockStreaming(sessionsRoot, p.coordinator.relativeFile, JSON.stringify(selectors[role]));
    if (block.recordSha256 !== expectedPin.recordSha256 || block.outputSha256 !== expectedPin.outputSha256 ||
      json(block.recordBytes, true).timestamp !== expectedPin.timestamp) return invalid();
    blocks.set(role, block);
  }
  for (const [role, retained] of [["waiting", "startup_wait"], ["worker_done", "worker_done"],
    ["settlement", "settlement"], ["cleanup", "cleanup"]] as const) {
    if (!blocks.get(role)!.outputBytes.equals(evidence.get(retained)!)) return invalid();
  }
  const chronology = inspectOrcaLifecycleChronology(coordinator.bytes, rawBinding, baselineBytes, JSON.stringify({
    selectors, baselineSha256: sha(baselineBytes), deliveryDigest: delivery.digest, messageId: delivery.messageId,
  }));
  inspectOrcaLifecycleSourceBytes(rawBinding, evidence.get("startup_wait")!, confirmationBytes, evidence.get("cleanup")!,
    JSON.stringify({ startupSha256: sha(evidence.get("startup_wait")!), confirmationSha256: sha(confirmationBytes),
      cleanupSha256: sha(evidence.get("cleanup")!), questionId: chronology.questionId }));

  const mechanism = await readSource(sessionsRoot, p.mechanism.relativeFile, ORCA_SESSION_STREAM_MAX_BYTES);
  const ackPin = p.mechanism.bindingAck;
  const ack = await readOrcaSessionTextBlockStreaming(sessionsRoot, p.mechanism.relativeFile, JSON.stringify(selector(ackPin, mechanism.digest)));
  if (ack.recordSha256 !== ackPin.recordSha256 || ack.outputSha256 !== ackPin.outputSha256 ||
    json(ack.recordBytes, true).timestamp !== ackPin.timestamp) return invalid();
  const receipt = json(decodeOrcaExecEvidenceBytes(ack.outputBytes));
  if (!isDeepStrictEqual(receipt, { taskId: snapshot.id, revision: Number(binding.revision), bound: true,
    baselineVerified: true, developmentReleased: false })) return invalid();
  const answer = json(decodeOrcaExecEvidenceBytes(blocks.get("execution_reply")!.outputBytes)).result.message;
  if (time(ackPin.timestamp) <= time(baseline.capturedAt) || time(ackPin.timestamp) >= time(answer.created_at)) return invalid();

  await inspectOrcaEvidenceManifest(reader, rawManifest, rawBinding, manifestDigest);
  if (!(await reader.readOrcaEvidence(snapshot.orcaBaseline!.evidence)).equals(baselineBytes)) return invalid();
  // No await after these final snapshot comparisons.
  const revalidate = () => {
    coordinator.revalidate(); mechanism.revalidate();
    for (const guard of evidenceGuards) guard();
    if (!isDeepStrictEqual(task, snapshot) ||
      !isDeepStrictEqual(readOrcaLocalEnrollment(projectRoot, sessionsRoot, expected), enrollment)) return invalid();
  };
  revalidate();
  const evidenceDigest = sha(canonical({ version: 1, bindingDigest: bound.digest, baselineSha256: sha(baselineBytes),
    manifestDigest: manifest.digest, bindingConfirmationSha256: sha(confirmationBytes),
    coordinator: p.coordinator, mechanism: p.mechanism }));
  return { revalidate, policyDigest, evidenceDigest, observedSourceDigests: { coordinator: coordinator.digest, mechanism: mechanism.digest },
    localSourcesConsistent: true, sourceAuthenticated: false, trustedClock: false, permissionDigestBound: false,
    canCompleteTask: false, scope: "LIMITED_LOCAL_OPERATIONAL_SOURCES" };
}
