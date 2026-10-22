import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeOrcaJson, decodeOrcaSessionRecordJson, ORCA_SESSION_JSON_MAX_BYTES } from "./orca-json.js";

export const ORCA_SESSION_MAX_BYTES = 32 * 1024 * 1024;
export const ORCA_SESSION_LINE_MAX_BYTES = ORCA_SESSION_JSON_MAX_BYTES;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const invalid = (): never => { throw new Error("INVALID_ORCA_SESSION_SOURCE"); };
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const token = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}(?![\s\S])/.test(value);

/** A locally pinned journal selection, not proof of authorship or provider origin. */
export function extractOrcaSessionToolOutput(bytes: Buffer, rawSelector: string) {
  return extractSessionOutput(bytes, rawSelector, false);
}

/** Select one exact custom-tool text block; never concatenate or unwrap blocks. */
export function extractOrcaSessionTextBlock(bytes: Buffer, rawSelector: string) {
  return extractSessionOutput(bytes, rawSelector, true);
}

function extractSessionOutput(bytes: Buffer, rawSelector: string, custom: boolean) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > ORCA_SESSION_MAX_BYTES ||
    typeof rawSelector !== "string" || Buffer.byteLength(rawSelector, "utf8") > 4096) return invalid();
  const scanner = sessionScanner(rawSelector, custom);
  if (bytes[bytes.length - 1] !== 10) return invalid();
  let start = 0;
  for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
    scanner.consume(bytes.subarray(start, end + 1));
    start = end + 1;
  }
  return scanner.finish(sha(bytes));
}

// Shared record validation keeps buffered and streaming extraction semantics identical.
function sessionScanner(rawSelector: string, custom: boolean, forkAware = false) {
  if (typeof rawSelector !== "string" || rawSelector.length > 4096 || Buffer.byteLength(rawSelector) > 4096) return invalid();
  const decoded = decodeOrcaJson(rawSelector);
  if (!decoded.ok || !record(decoded.value)) return invalid();
  const selector = decoded.value;
  const fields = custom ? ["blockIndex", "blockSha256", "callId", "ordinal", "sessionId", "sourceSha256", "toolName"] :
    ["callId", "ordinal", "sessionId", "sourceSha256", "toolName"];
  if (JSON.stringify(Object.keys(selector).sort()) !== JSON.stringify(fields) ||
    !token(selector.callId) || !token(selector.toolName) || typeof selector.sessionId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(selector.sessionId) ||
    !Number.isSafeInteger(selector.ordinal) || selector.ordinal < 1 || typeof selector.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}(?![\s\S])/.test(selector.sourceSha256)) return invalid();
  if (custom && (!Number.isSafeInteger(selector.blockIndex) || selector.blockIndex < 0 ||
    typeof selector.blockSha256 !== "string" || !/^[a-f0-9]{64}(?![\s\S])/.test(selector.blockSha256))) return invalid();
  let previous = -1, count = 0, callOrdinal: number | undefined;
  let selected: { ordinal: number; record: Buffer; output: Buffer } | undefined;
  let forkHeader: { sessionHeaderOrdinal: number; forkedFromId: string; forkedFromOrdinalExclusive: number } | undefined;
  const consume = (original: Buffer) => {
    if (!original.length || original[original.length - 1] !== 10) return invalid();
    const line = original.subarray(0, original.length - 1);
    if (!line.length || line.length > ORCA_SESSION_LINE_MAX_BYTES || ++count > 100000) return invalid();
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line); } catch { return invalid(); }
    const parsed = decodeOrcaSessionRecordJson(text);
    if (!parsed.ok || !record(parsed.value)) return invalid();
    const row = parsed.value;
    if (!Number.isSafeInteger(row.ordinal) || row.ordinal <= previous || typeof row.type !== "string" || !record(row.payload)) return invalid();
    previous = row.ordinal;
    if (count === 1) {
      if (row.type !== "session_meta" || row.payload.id !== selector.sessionId ||
        (row.payload.session_id !== undefined && row.payload.session_id !== selector.sessionId)) return invalid();
      if (row.ordinal !== 0) {
        if (!forkAware || row.ordinal < 1 || typeof row.payload.forked_from_id !== "string" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(row.payload.forked_from_id) ||
          row.payload.forked_from_id === selector.sessionId || row.payload.forked_from_ordinal_exclusive !== row.ordinal) return invalid();
        forkHeader = { sessionHeaderOrdinal: row.ordinal, forkedFromId: row.payload.forked_from_id,
          forkedFromOrdinalExclusive: row.payload.forked_from_ordinal_exclusive };
      }
    } else if (row.type === "session_meta") return invalid();
    if (row.type !== "response_item" || row.payload.call_id !== selector.callId) return;
    if (row.payload.type === (custom ? "custom_tool_call" : "function_call")) {
      if (callOrdinal !== undefined || selected || row.payload.name !== selector.toolName) return invalid();
      callOrdinal = row.ordinal;
    } else if (row.payload.type === (custom ? "custom_tool_call_output" : "function_call_output")) {
      if (selected || callOrdinal === undefined || row.ordinal !== selector.ordinal) return invalid();
      let text = row.payload.output;
      if (custom) {
        if (!Array.isArray(text) || selector.blockIndex >= text.length) return invalid();
        for (const block of text) {
          if (!record(block) || JSON.stringify(Object.keys(block).sort()) !== '["text","type"]' ||
            block.type !== "input_text" || typeof block.text !== "string" || Buffer.from(block.text, "utf8").toString("utf8") !== block.text) return invalid();
        }
        text = text[selector.blockIndex].text;
      }
      if (typeof text !== "string") return invalid();
      const output = Buffer.from(text, "utf8");
      // Reject unpaired UTF-16 surrogate replacement rather than changing original output text.
      if (output.toString("utf8") !== text || output.length > ORCA_SESSION_LINE_MAX_BYTES) return invalid();
      if (custom && sha(output) !== selector.blockSha256) throw new Error("ORCA_SESSION_BLOCK_HASH_MISMATCH");
      selected = { ordinal: row.ordinal, record: Buffer.from(original), output };
    } else return invalid();
  };
  const finish = (sourceSha256: string) => {
  if (sourceSha256 !== selector.sourceSha256) throw new Error("ORCA_SESSION_HASH_MISMATCH");
  if (!selected || callOrdinal === undefined) throw new Error("ORCA_SESSION_RECORD_NOT_FOUND");
  return { sessionId: selector.sessionId as string, callId: selector.callId as string, toolName: selector.toolName as string,
    ordinal: selected.ordinal, callOrdinal, sourceSha256: selector.sourceSha256 as string,
    recordSha256: sha(selected.record), outputSha256: sha(selected.output), recordBytes: selected.record, outputBytes: selected.output,
    ...(custom ? { blockIndex: selector.blockIndex as number, blockSha256: selector.blockSha256 as string } : {}),
    ...(forkHeader ?? {}),
    sourceAuthenticated: false as const, canCompleteTask: false as const, scope: "PINNED_LOCAL_SESSION_EXTRACTION" as const };
  };
  return { consume, finish };
}

export const ORCA_SESSION_STREAM_MAX_BYTES = 64 * 1024 * 1024;

/** Separate bounded streaming adapter; does not raise the buffered-reader limit.
 * Reads and validates the entire pinned journal, not just a matching prefix.
 */
export async function readOrcaSessionTextBlockStreaming(root: string, relativeFile: string, rawSelector: string) {
  const scanner = sessionScanner(rawSelector, true, true);
  if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) !== root ||
    typeof relativeFile !== "string" || !relativeFile.length || relativeFile.length > 4096 ||
    /[\x00-\x1f\\]/.test(relativeFile) || path.isAbsolute(relativeFile) ||
    relativeFile.split("/").some(part => !part || part === "." || part === "..")) return invalid();
  const file = path.join(root, relativeFile);
  if (await fs.realpath(root) !== root || await fs.realpath(file) !== file) return invalid();
  const rootBefore = await fs.lstat(root), entry = await fs.lstat(file);
  if (!rootBefore.isDirectory() || !entry.isFile() || entry.nlink !== 1 || entry.size < 1 ||
    entry.size > ORCA_SESSION_STREAM_MAX_BYTES) return invalid();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.ino !== entry.ino || before.dev !== entry.dev || before.size !== entry.size || before.nlink !== 1) return invalid();
    const hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
    let carry = Buffer.alloc(0), total = 0;
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, ORCA_SESSION_STREAM_MAX_BYTES + 1 - total), total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > before.size || total > ORCA_SESSION_STREAM_MAX_BYTES) return invalid();
      const part = chunk.subarray(0, bytesRead);
      hash.update(part);
      const joined = Buffer.concat([carry, part]);
      let start = 0;
      for (let end = joined.indexOf(10); end >= 0; end = joined.indexOf(10, start)) {
        scanner.consume(joined.subarray(start, end + 1));
        start = end + 1;
      }
      carry = Buffer.from(joined.subarray(start));
      if (carry.length > ORCA_SESSION_LINE_MAX_BYTES) return invalid();
    }
    if (carry.length || total !== before.size) return invalid();
    const after = await handle.stat(), current = await fs.lstat(file), rootAfter = await fs.lstat(root);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      after.nlink !== 1 || current.nlink !== 1 || current.ino !== before.ino || current.dev !== before.dev ||
      rootAfter.ino !== rootBefore.ino || rootAfter.dev !== rootBefore.dev ||
      await fs.realpath(root) !== root || await fs.realpath(file) !== file) return invalid();
    return scanner.finish(hash.digest("hex"));
  } finally { await handle.close(); }
}

/** Confined read-only file adapter. Use an operator-trusted quiescent canonical root.
 * File hash pinning is supplied by the caller; this does not authenticate that pin.
 */
export async function readOrcaSessionToolOutput(root: string, relativeFile: string, rawSelector: string) {
  return readSessionOutput(root, relativeFile, rawSelector, extractOrcaSessionToolOutput);
}

export async function readOrcaSessionTextBlock(root: string, relativeFile: string, rawSelector: string) {
  return readSessionOutput(root, relativeFile, rawSelector, extractOrcaSessionTextBlock);
}

async function readSessionOutput(root: string, relativeFile: string, rawSelector: string,
  extract: typeof extractOrcaSessionToolOutput) {
  if (typeof root !== "string" || !path.isAbsolute(root) || typeof relativeFile !== "string" || !relativeFile.length ||
    relativeFile.length > 4096 || /[\x00-\x1f\\]/.test(relativeFile) || path.isAbsolute(relativeFile) ||
    relativeFile.split("/").some(part => !part || part === "." || part === "..")) return invalid();
  const canonicalRoot = path.resolve(root);
  if (await fs.realpath(canonicalRoot) !== canonicalRoot) return invalid();
  const file = path.join(canonicalRoot, relativeFile);
  if (await fs.realpath(file) !== file) return invalid();
  const entry = await fs.lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size < 1 || entry.size > ORCA_SESSION_MAX_BYTES) return invalid();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.ino !== entry.ino || before.dev !== entry.dev || before.nlink !== 1 || before.size !== entry.size) return invalid();
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat(), current = await fs.lstat(file);
    if (length !== before.size || after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.dev !== before.dev ||
      current.isSymbolicLink() || await fs.realpath(file) !== file || await fs.realpath(canonicalRoot) !== canonicalRoot) return invalid();
    return extract(bytes.subarray(0, length), rawSelector);
  } finally { await handle.close(); }
}
