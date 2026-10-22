import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";

/** Recognize only the observed single-response, no-tool print protocol. Supplied
 * exit status and bytes are claims until connected to a trusted launcher.
 */
export function inspectAntigravityPrintStream(bytes: Buffer, exitCode: unknown, expectedCwd: string) {
  const fail = (): never => { throw new Error("INVALID_ANTIGRAVITY_PRINT_STREAM"); };
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 4 * 1024 * 1024 ||
      bytes[bytes.length - 1] !== 10 || exitCode !== 0 || typeof expectedCwd !== "string" ||
      !expectedCwd.startsWith("/") || expectedCwd.includes("\0") || Buffer.byteLength(expectedCwd) > 4096) return fail();
  const object = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
  const keys = (v: any, required: string[], optional: string[] = []) => object(v) &&
    required.every(k => Object.hasOwn(v,k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
  const text = (v: unknown): v is string => typeof v === "string" && Buffer.from(v,"utf8").toString("utf8") === v;
  let id = "", phase = 0, response = "", resultSeen = false, lines = 0, activeSeen = false;
  for (let offset = 0, end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, offset)) {
    const line = bytes.subarray(offset,end); offset = end + 1;
    if (!line.length || line.length > 262144 || ++lines > 10000 || resultSeen) return fail();
    let raw: string;
    try { raw = new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(line); } catch { return fail(); }
    const decoded = decodeOrcaJson(raw), row = decoded.ok ? decoded.value as any : null;
    if (!object(row)) return fail();
    if (phase === 0) {
      if (!keys(row,["event","conversation_id","init"]) || row.event !== "init" ||
          typeof row.conversation_id !== "string" || !/^[a-f0-9-]{36}(?![\s\S])/.test(row.conversation_id) ||
          !keys(row.init,["cwd","tools","permission_mode"]) || row.init.cwd !== expectedCwd ||
          row.init.permission_mode !== "request-review" || !Array.isArray(row.init.tools) ||
          !row.init.tools.every(text)) return fail();
      id = row.conversation_id; phase = 1; continue;
    }
    if (row.event === "step_update") {
      const s = row.step_update;
      if (!keys(row,["event","step_update"]) || !keys(s,["conversation_id","step_index","state","step_type"],["text_delta","duration_seconds","usage"]) || s.conversation_id !== id) return fail();
      if ((Object.hasOwn(s,"duration_seconds") && (typeof s.duration_seconds !== "number" || !Number.isFinite(s.duration_seconds) || s.duration_seconds < 0)) ||
          (Object.hasOwn(s,"usage") && !object(s.usage))) return fail();
      if (phase === 1) {
        if (s.step_index !== 0 || s.state !== "DONE" || s.step_type !== "user_input" || Object.hasOwn(s,"text_delta")) return fail();
        phase = 2; continue;
      }
      if (phase !== 2 || s.step_index !== 1 || s.step_type !== "agent_response" ||
          !["ACTIVE","DONE"].includes(s.state) || !text(s.text_delta)) return fail();
      response += s.text_delta;
      if (s.state === "ACTIVE") activeSeen = true;
      if (s.state === "DONE") { if (!activeSeen) return fail(); phase = 3; }
      continue;
    }
    const r = row.result;
    if (phase !== 3 || !keys(row,["event","result"]) || row.event !== "result" ||
        !keys(r,["conversation_id","status","response","duration_seconds","num_turns","usage"]) ||
        r.conversation_id !== id || r.status !== "SUCCESS" || r.num_turns !== 1 ||
        !text(r.response) || !response.length || r.response !== response ||
        typeof r.duration_seconds !== "number" || !Number.isFinite(r.duration_seconds) || r.duration_seconds < 0 || !object(r.usage)) return fail();
    resultSeen = true;
  }
  if (!resultSeen) return fail();
  return {conversationId:id,response,sourceSha256:createHash("sha256").update(bytes).digest("hex"),
    observedProtocolComplete:true as const, sourceAuthenticated:false as const,
    terminalIdentityVerified:false as const, canFinalizeReview:false as const, canCompleteTask:false as const};
}
