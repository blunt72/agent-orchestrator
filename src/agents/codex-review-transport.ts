import { inspectCodexReviewEvents } from "./codex-review-output.js";

/** Retained local process evidence, never provider authentication. */
export function validateCodexReviewTransport(raw: unknown, responseHash: string, session?: string) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 4194304) throw new Error("Invalid native review transport");
  const v = JSON.parse(raw);
  if (!v || Object.keys(v).sort().join(",") !== "adapterSessionId,code,finalHash,providerSessionId,stderrBase64,stdout,version" ||
      v.version !== 1 || v.code !== 0 || v.finalHash !== responseHash ||
      typeof v.adapterSessionId !== "string" || !/^[a-f0-9-]{36}$/.test(v.adapterSessionId) ||
      (session !== undefined && v.adapterSessionId !== session) ||
      typeof v.stdout !== "string" || Buffer.byteLength(v.stdout) > 1048576 ||
      typeof v.stderrBase64 !== "string" || v.stderrBase64.length > 1398104 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.stderrBase64)) throw new Error("Invalid native review transport");
  const identity = inspectCodexReviewEvents(Buffer.from(v.stdout));
  if (identity.providerSessionId !== v.providerSessionId) throw new Error("Native session mismatch");
  return { adapterSessionId: v.adapterSessionId as string, providerSessionId: identity.providerSessionId };
}
