import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";
import { reconcileOrcaRelay, type RelayIntent, type RelayObservation } from "./orca-relay-reconciliation.js";
import { withTaskFileLock } from "./task-file-lock.js";
import { inspectOrcaMutationRecovery } from "./orca-request-lookup.js";

const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const bad = (): never => { throw Error("INVALID_RELAY_JOURNAL"); };
function parse(raw: string): any {
  const decoded = decodeOrcaJson(raw);
  if (!decoded.ok) return bad();
  return decoded.value;
}
function intent(raw: string): RelayIntent {
  const i = parse(raw) as RelayIntent;
  if (!i || i.phase !== "INTENT") return bad();
  reconcileOrcaRelay(raw, JSON.stringify({ identity: i.identity, operationId: i.operationId,
    requestDigest: i.requestDigest, status: "absent", receiptDigest: null }), JSON.stringify(i.identity));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}(?![\s\S])/.test(i.identity.taskId)) return bad();
  return i;
}
function bytes(value: Buffer): Buffer {
  if (!Buffer.isBuffer(value) || !value.length || value.length > 65536) return bad();
  return Buffer.from(value);
}
async function syncDir(dir: string) {
  const h = await fs.open(dir, "r");
  try { await h.sync(); } finally { await h.close(); }
}
// Trusted local root, participating writers only; no defense against hostile OS
// path swaps. Symlink ancestors/entries and orphan locks fail closed.
async function directory(root: string, create: boolean) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || await fs.realpath(root) !== root) return bad();
  let current = root;
  for (const name of ["data", "orca-relay-journal-v1"]) {
    const parent = current;
    current = path.join(current, name);
    if (create) {
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (e: any) { if (e.code !== "EEXIST") throw e; }
      await syncDir(parent);
    }
    const s = await fs.lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink() || await fs.realpath(current) !== current) return bad();
    if (name === "orca-relay-journal-v1" && (s.mode & 0o077) !== 0) return bad();
  }
  return current;
}
function key(i: RelayIntent) {
  return hash(Buffer.from(JSON.stringify([i.identity.taskId, i.identity.generation, i.operationId])));
}
async function read(file: string): Promise<any | null> {
  let h;
  try { h = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
  try {
    const s = await h.stat();
    if (!s.isFile() || s.nlink !== 1 || s.size > 262144 || (s.mode & 0o077) !== 0) return bad();
    const buffer = Buffer.alloc(s.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const r = await h.read(buffer, offset, buffer.length - offset, offset);
      if (!r.bytesRead) break;
      offset += r.bytesRead;
    }
    const final = await h.stat();
    if (offset !== s.size || final.size !== s.size || final.mtimeMs !== s.mtimeMs || final.ctimeMs !== s.ctimeMs) return bad();
    const value = parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)));
    if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
    return value;
  } finally { await h.close(); }
}
function unpack(value: any, expected: unknown): Buffer {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "bytes,record,version" || value.version !== 1 ||
    !isDeepStrictEqual(value.record, expected) || typeof value.bytes !== "string") return bad();
  const b = bytes(Buffer.from(value.bytes, "base64"));
  if (b.toString("base64") !== value.bytes) return bad();
  return b;
}
async function publish(dir: string, file: string, record: unknown, b: Buffer) {
  const existing = await read(file);
  if (existing !== null) {
    if (!unpack(existing, record).equals(b)) return bad();
    const h = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await h.sync(); } finally { await h.close(); }
    await syncDir(dir);
    return "duplicate" as const;
  }
  const temp = path.join(dir, `.${randomUUID()}.tmp`);
  try {
    const h = await fs.open(temp, "wx", 0o600);
    try { await h.writeFile(JSON.stringify({ version: 1, record, bytes: b.toString("base64") })); await h.sync(); }
    finally { await h.close(); }
    // Exclusive publication: never replace another operation's retained bytes.
    await fs.link(temp, file);
    await fs.unlink(temp);
    await syncDir(dir);
    return "written" as const;
  } finally { await fs.rm(temp, { force: true }); }
}

/** Persistence only, not a dispatch capability. Root must be operator-supplied.
 * A crash may leave an orphan lock/temp or two-link publication: reconcile
 * manually with writers quiesced, never treat that as permission to resend. */
export async function persistRelayIntent(root: string, raw: string, request: Buffer) {
  const i = intent(raw), b = bytes(request);
  if (hash(b) !== i.requestDigest) return bad();
  await directory(root, true);
  return withTaskFileLock(root, i.identity.taskId, "task-executions", () => Error("RELAY_BUSY"), async () => {
    const dir = await directory(root, false);
    const recovery = await read(path.join(dir, `${key(i)}.recovery.json`));
    if (recovery !== null) {
      const saved = await read(path.join(dir, `${key(i)}.intent.json`));
      if (!saved || hash(unpack(saved, i)) !== i.requestDigest) return bad();
      validateRecovery(recovery, i);
    }
    const receipt = await read(path.join(dir, `${key(i)}.receipt.json`));
    if (receipt !== null) {
      const saved = await read(path.join(dir, `${key(i)}.intent.json`));
      if (!saved || hash(unpack(saved, i)) !== i.requestDigest) return bad();
      const decision = reconcileOrcaRelay(raw, JSON.stringify(receipt.record), JSON.stringify(i.identity));
      if (decision.action !== "RETAIN_RECEIPT" || hash(unpack(receipt, receipt.record)) !== receipt.record.receiptDigest) return bad();
    }
    return publish(dir, path.join(dir, `${key(i)}.intent.json`), i, b);
  });
}

export async function persistRelayReceipt(root: string, rawIntent: string, rawObservation: string, receipt: Buffer) {
  const i = intent(rawIntent), o = parse(rawObservation) as RelayObservation, b = bytes(receipt);
  if (reconcileOrcaRelay(rawIntent, rawObservation, JSON.stringify(i.identity)).action !== "RETAIN_RECEIPT" || hash(b) !== o.receiptDigest) return bad();
  await directory(root, false);
  return withTaskFileLock(root, i.identity.taskId, "task-executions", () => Error("RELAY_BUSY"), async () => {
    const dir = await directory(root, false), prefix = path.join(dir, key(i));
    const saved = await read(`${prefix}.intent.json`);
    if (!saved || hash(unpack(saved, i)) !== i.requestDigest) return bad();
    return publish(dir, `${prefix}.receipt.json`, o, b);
  });
}

/** Read-only restart check: missing receipt remains unknown, never replayable.
 * RETAINED means verified readable bytes, not renewed directory durability. */
export async function inspectRelayJournal(root: string, rawIntent: string, rawCurrentIdentity: string) {
  const i = intent(rawIntent), dir = await directory(root, false), prefix = path.join(dir, key(i));
  const saved = await read(`${prefix}.intent.json`);
  if (!saved || hash(unpack(saved, i)) !== i.requestDigest) return bad();
  const retained = await read(`${prefix}.receipt.json`);
  const observation = retained ? retained.record : { identity: i.identity, operationId: i.operationId,
    requestDigest: i.requestDigest, status: "absent", receiptDigest: null };
  const local = retained ? { ...i, phase: "OBSERVED", receiptDigest: observation.receiptDigest } : i;
  const decision = reconcileOrcaRelay(JSON.stringify(local), JSON.stringify(observation), rawCurrentIdentity);
  if (retained && (observation.status !== "completed" || hash(unpack(retained, observation)) !== observation.receiptDigest)) return bad();
  return { ...decision, receiptRetained: retained !== null };
}

function recoveryRecord(i: RelayIntent, b: Buffer) {
  const proof = inspectOrcaMutationRecovery(b, i.identity.runtimeId);
  return { intent: i, requestId: proof.requestId, dispatchId: proof.dispatchId, responseSha256: proof.responseSha256 };
}
function validateRecovery(value: any, i: RelayIntent) {
  const b = unpack(value, value.record);
  const expected = recoveryRecord(i, b);
  if (!isDeepStrictEqual(value.record, expected)) return bad();
  return expected;
}
function currentIdentity(i: RelayIntent, rawCurrent: string) {
  const check = reconcileOrcaRelay(JSON.stringify(i), JSON.stringify({ identity: i.identity,
    operationId: i.operationId, requestDigest: i.requestDigest, status: "absent", receiptDigest: null }), rawCurrent);
  if (check.action === "CONFLICT") return bad();
}

/** Retains a caller-supplied association, NOT proof that the error belongs to this
 * intent or that the caller is authenticated. Never authorizes retry. */
export async function persistRelayRecovery(root: string, rawIntent: string, rawCurrent: string, response: Buffer) {
  const i = intent(rawIntent), b = bytes(response);
  currentIdentity(i, rawCurrent);
  const record = recoveryRecord(i, b);
  await directory(root, false);
  return withTaskFileLock(root, i.identity.taskId, "task-executions", () => Error("RELAY_BUSY"), async () => {
    const dir = await directory(root, false), prefix = path.join(dir, key(i));
    const saved = await read(`${prefix}.intent.json`);
    if (!saved || hash(unpack(saved, i)) !== i.requestDigest) return bad();
    return publish(dir, `${prefix}.recovery.json`, record, b);
  });
}

/** Missing UUID preserves the first-send uncertainty window, not a fresh send. */
export async function inspectRelayRecovery(root: string, rawIntent: string, rawCurrent: string) {
  const i = intent(rawIntent);
  currentIdentity(i, rawCurrent);
  const dir = await directory(root, false), prefix = path.join(dir, key(i));
  const saved = await read(`${prefix}.intent.json`);
  if (!saved || hash(unpack(saved, i)) !== i.requestDigest) return bad();
  const stored = await read(`${prefix}.recovery.json`);
  const record = stored ? validateRecovery(stored, i) : null;
  return { requestId: record?.requestId ?? null, dispatchId: record?.dispatchId ?? null,
    nextAction: record ? (record.dispatchId ? "INSPECT_DISPATCH" : "LOOKUP_REQUEST") : "INSPECT_REMOTE",
    associationAuthenticated: false as const, canReplay: false as const, canCompleteTask: false as const };
}
