import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { inspectAntigravityPrintStream } from "./antigravity-print-stream.js";
import { inspectAntigravityReadStream, snapshotAntigravityReadPaths } from "./antigravity-read-stream.js";

export type GeminiPrintModel="gemini-3.8-flash-high"|"gemini-3.8-flash-medium"|"gemini-3.8-flash-low";
export function validGeminiPrintModel(value:unknown):value is GeminiPrintModel {
  return typeof value==="string"&&["gemini-3.8-flash-high","gemini-3.8-flash-medium","gemini-3.8-flash-low"].includes(value);
}

export interface AntigravityPrintCapture {
  executable: string;
  cwd: string;
  evidenceRoot: string;
  requestId: string;
  prompt: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  readOnlyPaths?: readonly string[];
  model?: GeminiPrintModel;
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Operator-only, one-shot independent process capture. Never impersonates an
 * Orca terminal. Root/ancestors and executable must be trusted by the host.
 */
export async function captureAntigravityPrint(config: AntigravityPrintCapture) {
  const c = {...config};
  const profile=c.readOnlyPaths===undefined?undefined:{kind:"view-file-v1" as const,allowedPaths:snapshotAntigravityReadPaths(c.readOnlyPaths)};
  if(c.model!==undefined&&!validGeminiPrintModel(c.model))throw new Error("INVALID_PRINT_MODEL");
  const version=c.model?3:profile?2:1;
  const timeout = c.timeoutMs ?? 120000, limits = {stdout:c.maxStdoutBytes ?? 4194304,stderr:c.maxStderrBytes ?? 65536};
  if (process.platform === "win32" || typeof c.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(c.requestId) ||
      typeof c.prompt !== "string" || !c.prompt.length || Buffer.byteLength(c.prompt) > 65536 || c.prompt.includes("\0") ||
      Buffer.from(c.prompt).toString("utf8") !== c.prompt ||
      !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000 ||
      Object.values(limits).some(n=>!Number.isSafeInteger(n) || n < 1 || n > 4194304)) throw new Error("INVALID_PRINT_CAPTURE");
  for (const p of [c.executable,c.cwd,c.evidenceRoot]) {
    if (typeof p !== "string" || !path.isAbsolute(p) || p.includes("\0") || p.length > 4096 || fs.realpathSync(p) !== p) throw new Error("INVALID_CAPTURE_PATH");
  }
  const rootStat = fs.statSync(c.evidenceRoot);
  if (!rootStat.isDirectory() || rootStat.uid !== process.getuid!() || (rootStat.mode & 0o022) ||
      !fs.statSync(c.cwd).isDirectory() || !fs.statSync(c.executable).isFile()) throw new Error("INVALID_CAPTURE_PATH");
  const root = path.join(c.evidenceRoot,c.requestId);
  // Exclusive directory is the permanent launch marker. Even a partial failure
  // consumes this request ID; callers must inspect it, never auto-relaunch.
  fs.mkdirSync(root,{mode:0o700});
  const retain = (name: string, bytes: Buffer | string) => {
    const fd = fs.openSync(path.join(root,name),"wx",0o600);
    try { fs.writeFileSync(fd,bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const prompt = Buffer.from(c.prompt);
  const args = ["--print",c.prompt,"--output-format","stream-json","--sandbox","--disable-slash-commands","--print-timeout",`${timeout}ms`];
  if(c.model)args.push("--model",c.model);
  retain("request.bin",prompt);
  retain("intent.json",JSON.stringify({version,...(profile?{profile}:{}),...(c.model?{model:c.model}:{}),requestId:c.requestId,executable:c.executable,cwd:c.cwd,
    requestSha256:sha(prompt),requestBytes:prompt.length,createdAt:new Date().toISOString(),automaticRetry:false}));
  const buffers = {stdout:[] as Buffer[],stderr:[] as Buffer[]}, counts = {stdout:0,stderr:0};
  const fds: Partial<Record<"stdout" | "stderr",number>> = {};
  try { for (const key of ["stdout","stderr"] as const) fds[key] = fs.openSync(path.join(root,`${key}.bin`),"wx",0o600); }
  catch (error) { for (const fd of Object.values(fds)) fs.closeSync(fd); throw error; }
  return await new Promise<{
    evidenceDirectory:string; status:"CAPTURED" | "FAILED"; failure:string | null;
    protocol:ReturnType<typeof inspectAntigravityPrintStream> | ReturnType<typeof inspectAntigravityReadStream> | null; canFinalizeReview:false; canCompleteTask:false;
  }>((resolve,reject)=> {
    let failure: string | null = null;
    let retentionError: unknown, truncated = false;
    let terminationFailure: {code:string} | undefined;
    let child: ReturnType<typeof spawn>;
    const closeFiles = () => {
      const errors: unknown[] = [];
      for (const key of ["stdout","stderr"] as const) {
        const fd = fds[key]; if (fd === undefined) continue; delete fds[key];
        try { fs.fsyncSync(fd); } catch (error) { errors.push(error); }
        try { fs.closeSync(fd); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors,"CAPTURE_CLEANUP_FAILED");
    };
    const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("ORCA_")));
    try { child = spawn(c.executable,args,{cwd:c.cwd,env,shell:false,detached:true,stdio:["ignore","pipe","pipe"]}); }
    catch (error) { closeFiles(); reject(error); return; }
    const stop = (reason: string) => {
      failure ??= reason;
      if (child.pid) { try { process.kill(-child.pid,"SIGKILL"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") terminationFailure={code:(e as NodeJS.ErrnoException).code??"UNKNOWN"}; } }
    };
    const timer = setTimeout(()=>stop("TIMEOUT"),timeout);
    child.once("error",()=> { failure ??= "SPAWN_ERROR"; });
    for (const key of ["stdout","stderr"] as const) {
      child[key]!.on("error",()=>stop("STREAM_ERROR"));
      child[key]!.on("data",(chunk:Buffer)=> {
        if (retentionError) return;
        const remaining = limits[key]-counts[key], bytes = Buffer.from(chunk.subarray(0,Math.max(0,remaining)));
        if (bytes.length) {
          try { fs.writeFileSync(fds[key]!,bytes); buffers[key].push(bytes); counts[key] += bytes.length; }
          catch (error) { retentionError = error; stop("RETENTION_ERROR"); }
        }
        if (chunk.length > remaining) { truncated = true; stop(`${key.toUpperCase()}_LIMIT`); }
      });
    }
    child.once("close",(code,signal)=> {
      clearTimeout(timer);
      let protocol: ReturnType<typeof inspectAntigravityPrintStream> | ReturnType<typeof inspectAntigravityReadStream> | null = null;
      try {
        closeFiles();
        if (retentionError) throw retentionError;
        if (!failure && (code !== 0 || signal !== null)) failure = "PROCESS_FAILED";
        if (!failure) { try { protocol = profile?inspectAntigravityReadStream(Buffer.concat(buffers.stdout),code,c.cwd,profile.allowedPaths,c.model):inspectAntigravityPrintStream(Buffer.concat(buffers.stdout),code,c.cwd); } catch { failure = "PROTOCOL_FAILED"; } }
        retain("process.json",JSON.stringify({version,...(profile?{profile}:{}),...(c.model?{model:c.model}:{}),requestId:c.requestId,pid:child.pid ?? null,code,signal,
          closedAt:new Date().toISOString(),failure,stdoutBytes:counts.stdout,stderrBytes:counts.stderr,
          stdoutSha256:sha(Buffer.concat(buffers.stdout)),stderrSha256:sha(Buffer.concat(buffers.stderr)),
          truncated,automaticRetry:false,...(terminationFailure?{terminationFailure}:{}),
          sourceAuthenticated:false,terminalIdentityVerified:false,canFinalizeReview:false,canCompleteTask:false}));
        resolve({evidenceDirectory:root,status:failure ? "FAILED":"CAPTURED",failure,protocol,canFinalizeReview:false,canCompleteTask:false});
      } catch (error) { reject(error); }
    });
  });
}
