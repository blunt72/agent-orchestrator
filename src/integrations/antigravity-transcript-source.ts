import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";

export const ANTIGRAVITY_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;
const sha = (v: Buffer) => createHash("sha256").update(v).digest("hex");
const invalid = (): never => { throw new Error("INVALID_ANTIGRAVITY_TRANSCRIPT"); };
const record = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(v);
const user = (v: any) => ["USER_EXPLICIT", "USER"].includes(v.source) && ["USER_INPUT", "REQUEST"].includes(v.type);
const model = (v: any) => v.source === "MODEL" && v.type === "PLANNER_RESPONSE";

/** Select original local transcript rows. Caller pins and role labels are not
 * provider authorship, terminal ownership, a completed turn or review authority.
 */
export function extractAntigravityTranscriptPair(bytes: Buffer, rawSelector: string) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > ANTIGRAVITY_TRANSCRIPT_MAX_BYTES ||
    bytes[bytes.length - 1] !== 10 || typeof rawSelector !== "string" || Buffer.byteLength(rawSelector) > 4096) return invalid();
  const decoded = decodeOrcaJson(rawSelector), s = decoded.ok ? decoded.value as any : null;
  if (!record(s) || Object.keys(s).sort().join(",") !== "requestLine,requestSha256,responseLine,responseSha256,sourceSha256" ||
    ![s.sourceSha256, s.requestSha256, s.responseSha256].every(hash) ||
    !Number.isSafeInteger(s.requestLine) || !Number.isSafeInteger(s.responseLine) ||
    s.requestLine < 1 || s.responseLine <= s.requestLine || s.responseLine > 100000) return invalid();
  if (sha(bytes) !== s.sourceSha256) throw new Error("ANTIGRAVITY_TRANSCRIPT_HASH_MISMATCH");
  let offset = 0, ordinal = 0;
  let requestRow: Buffer | undefined, responseRow: Buffer | undefined;
  let request: Buffer | undefined, response: Buffer | undefined, requestTime = 0;
  for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, offset)) {
    const original = bytes.subarray(offset, end + 1), line = original.subarray(0, original.length - 1);
    offset = end + 1;
    if (!line.length || line.length > 262144 || ++ordinal > 100000) return invalid();
    let text: string;
    try { text = new TextDecoder("utf-8", {fatal:true, ignoreBOM:true}).decode(line); }
    catch { return invalid(); }
    const decoded = decodeOrcaJson(text), row = decoded.ok ? decoded.value as any : null;
    if (!record(row) || typeof row.source !== "string" || typeof row.type !== "string" ||
      typeof row.content !== "string" || typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at))) return invalid();
    if (ordinal > s.requestLine && ordinal < s.responseLine && (user(row) || model(row)))
      throw new Error("AMBIGUOUS_ANTIGRAVITY_TRANSCRIPT_PAIR");
    if (ordinal !== s.requestLine && ordinal !== s.responseLine) continue;
    if (ordinal === s.requestLine ? !user(row) : !model(row)) return invalid();
    let content = row.content;
    if (ordinal === s.requestLine && content.startsWith("<USER_REQUEST>")) {
      if (!content.endsWith("</USER_REQUEST>")) return invalid();
      content = content.slice("<USER_REQUEST>".length, -"</USER_REQUEST>".length);
      if (content.includes("<USER_REQUEST>") || content.includes("</USER_REQUEST>")) return invalid();
    }
    // Decoding escapes must never silently replace an unpaired UTF-16 surrogate.
    const extracted = Buffer.from(content, "utf8");
    if (!extracted.length || extracted.toString("utf8") !== content || extracted.length > 262144) return invalid();
    if (ordinal === s.requestLine) {
      request = extracted; requestRow = Buffer.from(original); requestTime = Date.parse(row.created_at);
    } else {
      if (Date.parse(row.created_at) < requestTime) return invalid();
      response = extracted; responseRow = Buffer.from(original);
    }
  }
  if (!request || !response || !requestRow || !responseRow) throw new Error("ANTIGRAVITY_TRANSCRIPT_RECORD_NOT_FOUND");
  if (sha(request) !== s.requestSha256 || sha(response) !== s.responseSha256)
    throw new Error("ANTIGRAVITY_TRANSCRIPT_CONTENT_MISMATCH");
  return { sourceSha256: s.sourceSha256 as string, requestLine: s.requestLine as number, responseLine: s.responseLine as number,
    requestBytes: request, responseBytes: response, requestRecordBytes: requestRow, responseRecordBytes: responseRow,
    requestRecordSha256: sha(requestRow), responseRecordSha256: sha(responseRow),
    scope: "PINNED_LOCAL_ANTIGRAVITY_TRANSCRIPT_PAIR" as const, sourceAuthenticated: false as const,
    terminalIdentityVerified: false as const, turnCompletionVerified: false as const,
    canFinalizeReview: false as const, canCompleteTask: false as const };
}
