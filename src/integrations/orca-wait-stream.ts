import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";

const invalid = (): never => { throw new Error("INVALID_ORCA_WAIT_STREAM"); };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const sha = (v: Buffer) => createHash("sha256").update(v).digest("hex");

/** Explicit heartbeat framing only; receipt semantics and provenance are checked elsewhere. */
export function extractOrcaWaitReceipt(input: Buffer) {
  if (!Buffer.isBuffer(input) || input.length < 1 || input.length > 262144) return invalid();
  const bytes = Buffer.from(input);
  const decode = (value: Buffer) => {
    try {
      const parsed = decodeOrcaJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value));
      if (!parsed.ok || !object(parsed.value)) return invalid();
      return parsed.value;
    } catch { return invalid(); }
  };
  let offset = 0, count = 0, previous = -1, deadline: number | undefined;
  while (true) {
    const end = bytes.indexOf(10, offset);
    if (end < 0) break;
    const line = bytes.subarray(offset, end);
    // Receipt may be pretty-printed, so only a complete heartbeat line is consumed.
    let row: Record<string, unknown> | undefined;
    try { row = decode(line); } catch { break; }
    if (!Object.hasOwn(row, "_keepalive") && !Object.hasOwn(row, "_heartbeat")) break;
    if (++count > 128 || JSON.stringify(Object.keys(row).sort()) !== '["_heartbeat","_keepalive","deadlineMs","elapsedMs"]' ||
      row._keepalive !== true || row._heartbeat !== true ||
      !Number.isSafeInteger(row.elapsedMs) || !Number.isSafeInteger(row.deadlineMs)) return invalid();
    const elapsed = row.elapsedMs as number, limit = row.deadlineMs as number;
    if (elapsed < 0 || limit < 1 || elapsed > limit || elapsed <= previous || (deadline !== undefined && deadline !== limit)) return invalid();
    previous = elapsed; deadline = limit; offset = end + 1;
  }
  if (!count) return invalid();
  const receiptBytes = Buffer.from(bytes.subarray(offset));
  const receipt = decode(receiptBytes);
  if (Object.hasOwn(receipt, "_keepalive") || Object.hasOwn(receipt, "_heartbeat") || receipt.ok !== true ||
    typeof receipt.id !== "string" || !receipt.id.length || !object(receipt.result) || !object(receipt._meta)) return invalid();
  return { streamBytes: bytes, receiptBytes, streamSha256: sha(bytes), receiptSha256: sha(receiptBytes),
    heartbeatCount: count, receiptOffset: offset, sourceAuthenticated: false as const, canCompleteTask: false as const };
}
