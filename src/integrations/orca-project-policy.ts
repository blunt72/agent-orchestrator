import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { decodeOrcaJson } from "./orca-json.js";

type CommonPolicy = {
  projectId: string; workspace: string; documentation: string[];
  readFiles: string[]; writeFiles: string[];
  limits: { timeoutMs: number; maxReworks: number; maxDispatches: number };
};
type VitestCommand = { executable: "./node_modules/.bin/vitest"; args: string[]; cwd: string };
export type OrcaProjectPolicy = CommonPolicy & (
  { version: 1; developer: "gemini"; reviewer: "codex"; command: VitestCommand } |
  { version: 2; developer: "gemini" | "codex"; reviewer: "codex" | "gemini";
    coordinator: "codex" | "antigravity";
    command: (VitestCommand & { profile: "vitest" }) |
      { profile: "node-test"; executable: string; args: string[]; cwd: string } }
);
const fail = (): never => { throw Error("INVALID_ORCA_PROJECT_POLICY"); };
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, any>, keys: string[]) => Object.keys(v).sort().join(",") === keys.sort().join(",");
function relative(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 512 && !/[\x00-\x1f\x7f\\:*?\[\]{}]/.test(v) &&
    !path.posix.isAbsolute(v) && v.split("/").every(s => s !== "" && s !== "." && s !== ".." && !s.startsWith("."));
}
function files(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.length <= 64 && v.every(relative) && new Set(v).size === v.length;
}
const testTs = /^(test|tests)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.test\.ts$/;
const testMjs = /^(test|tests)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.test\.mjs$/;
const sourceMjs = /^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.mjs$/;
function validCommand(p: Record<string, any>): boolean {
  if (!object(p.command) || !Array.isArray(p.command.args) || p.command.cwd !== p.workspace) return false;
  const c = p.command;
  if (p.version === 2 && c.profile === "node-test") {
    const tests = p.writeFiles.filter((f: string) => testMjs.test(f));
    return exact(c, ["profile", "executable", "args", "cwd"]) &&
      typeof c.executable === "string" && path.isAbsolute(c.executable) &&
      path.resolve(c.executable) === c.executable && !/[\x00-\x1f\x7f]/.test(c.executable) &&
      tests.length > 0 && p.writeFiles.every((f: string) => testMjs.test(f) || sourceMjs.test(f)) &&
      JSON.stringify(c.args) === JSON.stringify(["--test", ...tests]);
  }
  return exact(c, p.version === 1 ? ["executable", "args", "cwd"] : ["profile", "executable", "args", "cwd"]) &&
    (p.version === 1 || c.profile === "vitest") && c.executable === "./node_modules/.bin/vitest" &&
    p.writeFiles.every((f: string) => testTs.test(f)) && c.args.length === p.writeFiles.length + 3 &&
    c.args[0] === "run" && c.args[1] === "--config" && relative(c.args[2]) &&
    /^vitest\.[A-Za-z0-9_-]+\.config\.ts$/.test(c.args[2]) && p.readFiles.includes(c.args[2]) &&
    JSON.stringify(c.args.slice(3)) === JSON.stringify(p.writeFiles);
}
/** Operator-pinned input only. Parsing a digest is not operator authentication. */
export function parseOrcaProjectPolicy(raw: string, expectedDigest: string) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 32768 || typeof expectedDigest !== "string" || !/^[a-f0-9]{64}(?![\s\S])/.test(expectedDigest)) return fail();
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== expectedDigest) return fail();
  const parsed = decodeOrcaJson(raw);
  if (!parsed.ok || !object(parsed.value)) return fail();
  const p = parsed.value;
  if (![1, 2].includes(p.version) || !exact(p, ["version", "projectId", "workspace", "documentation", "readFiles", "writeFiles", "developer", "reviewer", "command", "limits", ...(p.version === 2 ? ["coordinator"] : [])]) ||
    typeof p.projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?![\s\S])/.test(p.projectId) ||
    typeof p.workspace !== "string" || !path.isAbsolute(p.workspace) || path.resolve(p.workspace) !== p.workspace || /[\x00-\x1f\x7f]/.test(p.workspace) ||
    !files(p.documentation) || !files(p.readFiles) || !files(p.writeFiles) ||
    (p.version === 1 ? p.developer !== "gemini" || p.reviewer !== "codex" :
      !["codex", "gemini"].includes(p.developer) || !["codex", "gemini"].includes(p.reviewer) || p.developer === p.reviewer ||
      p.coordinator !== (p.reviewer === "gemini" ? "antigravity" : "codex")) ||
    p.writeFiles.some((f: string) => p.readFiles.includes(f) || p.documentation.includes(f)) ||
    !validCommand(p) ||
    !object(p.limits) || !exact(p.limits, ["timeoutMs", "maxReworks", "maxDispatches"]) ||
    !Number.isSafeInteger(p.limits.timeoutMs) || p.limits.timeoutMs < 1000 || p.limits.timeoutMs > 900000 ||
    !Number.isSafeInteger(p.limits.maxReworks) || p.limits.maxReworks < 0 || p.limits.maxReworks > 2 ||
    !Number.isSafeInteger(p.limits.maxDispatches) || p.limits.maxDispatches < p.limits.maxReworks + 1 || p.limits.maxDispatches > 3) return fail();
  return { policy: p as OrcaProjectPolicy, digest, sourceAuthenticated: false as const, canDispatch: false as const };
}

/** Read-only path preflight; does not inspect test/config code or authorize execution. */
export async function inspectOrcaProjectPolicyPaths(raw: string, expectedDigest: string) {
  const result = parseOrcaProjectPolicy(raw, expectedDigest), p = result.policy;
  if (await fs.realpath(p.workspace) !== p.workspace) return fail();
  if (p.version === 2 && p.command.profile === "node-test") {
    // Pin the native runner to this operator's interpreter, not an arbitrary program named node.
    if (p.command.executable !== await fs.realpath(process.execPath)) return fail();
  }
  const check = async (name: string, mayBeMissing: boolean) => {
    const segments = name.split("/");
    let current = p.workspace;
    for (let index = 0; index < segments.length; index++) {
      current = path.join(current, segments[index]);
      let s;
      try { s = await fs.lstat(current); }
      catch (e: any) {
        if (e.code === "ENOENT" && mayBeMissing && index === segments.length - 1) return null;
        throw e;
      }
      if (s.isSymbolicLink() || (index < segments.length - 1 ? !s.isDirectory() : !s.isFile())) return fail();
      if (index === segments.length - 1) {
        if (mayBeMissing && s.nlink !== 1) return fail();
        return `${s.dev}:${s.ino}`;
      }
    }
  };
  const identities = new Set<string>();
  for (const name of [...p.documentation, ...p.readFiles]) {
    const id = await check(name, false);
    if (!id) return fail();
    identities.add(id);
  }
  for (const name of p.writeFiles) {
    const id = await check(name, true);
    if (id && identities.has(id)) return fail();
    if (id) identities.add(id);
  }
  return { ...result, localPathsChecked: true as const, canExecute: false as const };
}

/** Exact legacy shell representation; preparation only, never executes a command. */
export function formatOrcaPolicyTestCommand(policy: OrcaProjectPolicy): string {
  const quote = (s: string) => /^[A-Za-z0-9_./-]+$/.test(s) ? s : "'" + s.replaceAll("'", "'\\''") + "'";
  return [policy.command.executable, ...policy.command.args].map(quote).join(" ");
}
