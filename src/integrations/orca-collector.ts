import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";

export type OrcaCollection =
  | { ok: false; code: "INVALID_CONFIG" | "CLI_FAILED" | "INVALID_RECEIPT" | "IDENTITY_MISMATCH" }
  | { ok: true; receipt: unknown; stdoutSha256: string; bytes: number;
    provenance: "LOCAL_CLI_OBSERVATION" };

const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);

/** Read-only, local collection. executable must be an operator-trusted absolute CLI path.
 * This is not binary attestation, provider authentication or task acceptance.
 * The returned receipt is internal evidence: do not log it wholesale.
 */
export async function collectOrcaWorker(
  executable: string,
  runtimeId: string,
  dispatchId: string,
): Promise<OrcaCollection> {
  if (typeof executable !== "string" || executable.length > 4096 || !path.isAbsolute(executable) ||
    /[\u0000-\u001f]/.test(executable) || !identifier(runtimeId) || !identifier(dispatchId)) {
    return { ok: false, code: "INVALID_CONFIG" };
  }
  try {
    const output = await new Promise<Buffer>((resolve, reject) => {
      execFile(executable, ["orchestration", "worker-show", "--dispatch", dispatchId, "--json"], {
        encoding: "buffer", shell: false, timeout: 15000, killSignal: "SIGKILL", maxBuffer: 262144,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error || stderr.length) reject(new Error("CLI_FAILED"));
        else resolve(stdout);
      });
    });
    const decoded = decodeOrcaJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output));
    if (!decoded.ok) return { ok: false, code: "INVALID_RECEIPT" };
    const receipt = decoded.value as any;
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || receipt.ok !== true ||
      !receipt.result?.dispatch || typeof receipt.result.dispatch !== "object") {
      return { ok: false, code: "INVALID_RECEIPT" };
    }
    if (receipt._meta?.runtimeId !== runtimeId || receipt.result.dispatch.id !== dispatchId) {
      return { ok: false, code: "IDENTITY_MISMATCH" };
    }
    return { ok: true, receipt, bytes: output.length,
      stdoutSha256: createHash("sha256").update(output).digest("hex"), provenance: "LOCAL_CLI_OBSERVATION" };
  } catch { return { ok: false, code: "CLI_FAILED" }; }
}
