import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";
import { inspectAntigravityPrintStream } from "./antigravity-print-stream.js";
import { inspectAntigravityReadStream, snapshotAntigravityReadPaths } from "./antigravity-read-stream.js";
import { validGeminiPrintModel } from "./antigravity-print-capture.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const fail = (): never => { throw new Error("INVALID_PRINT_CAPTURE_SOURCE"); };
const exact = (v: any, keys: string[]) => v !== null && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === keys.sort().join(",");
const uuid = (v: unknown) => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(v);
const absolute = (v: unknown) => typeof v === "string" && v.startsWith("/") && v.length <= 4096 && !v.includes("\0");
function json(bytes: Buffer) {
  let raw: string;
  try { raw = new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes); } catch { return fail(); }
  const parsed = decodeOrcaJson(raw); if (!parsed.ok) return fail(); return parsed.value as any;
}

/** Supplied bundle consistency only. Neither disk provenance nor a trusted
 * launcher is established by caller-supplied bytes or metadata.
 */
export function inspectAntigravityPrintSource(request: Buffer, intent: Buffer, stdout: Buffer,
  stderr: Buffer, processReceipt: Buffer, rawExpectation: string) {
  for (const [bytes,max,empty] of [[request,65536,false],[intent,32768,false],[stdout,4194304,false],
    [stderr,4194304,true],[processReceipt,32768,false]] as const) {
    if (!Buffer.isBuffer(bytes) || bytes.length > max || (!empty && !bytes.length)) return fail();
  }
  if (typeof rawExpectation !== "string" || Buffer.byteLength(rawExpectation) > 32768) return fail();
  const parsed = decodeOrcaJson(rawExpectation), expected = parsed.ok ? parsed.value as any : null;
  const hasProfile=expected!==null&&typeof expected==="object"&&Object.hasOwn(expected,"profile");
  let profile: {kind:"view-file-v1";allowedPaths:string[]}|undefined;
  if(hasProfile){
    if(!exact(expected.profile,["kind","allowedPaths"])||expected.profile.kind!=="view-file-v1")return fail();
    profile={kind:"view-file-v1",allowedPaths:snapshotAntigravityReadPaths(expected.profile.allowedPaths)};
  }
  const hasModel=expected!==null&&typeof expected==="object"&&Object.hasOwn(expected,"model");
  if(hasModel&&!validGeminiPrintModel(expected.model))return fail();
  const extra=[...(profile?["profile"]:[]),...(hasModel?["model"]:[])],version=hasModel?3:profile?2:1;
  if (!exact(expected,["requestId","cwd","executable","requestSha256",...extra]) || !uuid(expected.requestId) ||
      !absolute(expected.cwd) || !absolute(expected.executable) || typeof expected.requestSha256 !== "string" ||
      !/^[a-f0-9]{64}(?![\s\S])/.test(expected.requestSha256)) return fail();
  const i = json(intent), p = json(processReceipt);
  const profileMatches=(v:any)=>!profile||(exact(v,["kind","allowedPaths"])&&v.kind===profile.kind&&JSON.stringify(v.allowedPaths)===JSON.stringify(profile.allowedPaths));
  if (!exact(i,["version","requestId","executable","cwd","requestSha256","requestBytes","createdAt","automaticRetry",...extra]) ||
      i.version !== version || (hasModel&&i.model!==expected.model) || !profileMatches(i.profile) || i.requestId !== expected.requestId || i.executable !== expected.executable || i.cwd !== expected.cwd ||
      i.requestSha256 !== expected.requestSha256 || i.requestSha256 !== sha(request) || i.requestBytes !== request.length ||
      i.automaticRetry !== false || typeof i.createdAt !== "string" || !Number.isFinite(Date.parse(i.createdAt))) return fail();
  if (!exact(p,["version","requestId","pid","code","signal","closedAt","failure","stdoutBytes","stderrBytes","stdoutSha256","stderrSha256",
    "truncated","automaticRetry","sourceAuthenticated","terminalIdentityVerified","canFinalizeReview","canCompleteTask",...extra]) ||
      p.version !== version || (hasModel&&p.model!==expected.model) || !profileMatches(p.profile) || p.requestId !== expected.requestId || !Number.isSafeInteger(p.pid) || p.pid < 1 ||
      p.code !== 0 || p.signal !== null || p.failure !== null || p.truncated !== false || p.automaticRetry !== false ||
      [p.sourceAuthenticated,p.terminalIdentityVerified,p.canFinalizeReview,p.canCompleteTask].some(v=>v !== false) ||
      typeof p.closedAt !== "string" || !Number.isFinite(Date.parse(p.closedAt)) || Date.parse(p.closedAt) < Date.parse(i.createdAt) ||
      p.stdoutBytes !== stdout.length || p.stderrBytes !== stderr.length || p.stdoutSha256 !== sha(stdout) || p.stderrSha256 !== sha(stderr)) return fail();
  let prompt: string;
  try { prompt = new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(request); } catch { return fail(); }
  if (prompt.includes("\0")) return fail();
  const stream = profile?inspectAntigravityReadStream(stdout,p.code,expected.cwd,profile.allowedPaths,expected.model):inspectAntigravityPrintStream(stdout,p.code,expected.cwd);
  return {requestId:expected.requestId as string,conversationId:stream.conversationId,response:stream.response,
    adapter:"antigravity-print" as const,scope:"SUPPLIED_INDEPENDENT_PRINT_CAPTURE" as const,
    profile:profile?.kind??"no-tool-v1",
    configuredModel:hasModel?expected.model as string:null,modelIdentityVerified:false as const,
    requestSha256:sha(request),intentSha256:sha(intent),stdoutSha256:sha(stdout),stderrSha256:sha(stderr),processSha256:sha(processReceipt),
    suppliedEvidenceConsistent:true as const,sourceAuthenticated:false as const,trustedExtractionVerified:false as const,
    terminalIdentityVerified:false as const,canFinalizeReview:false as const,canCompleteTask:false as const};
}
