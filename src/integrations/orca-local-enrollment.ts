import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { decodeOrcaJson } from "./orca-json.js";

export interface LocalEnrollmentScope {
  taskId: string;
  projectId: string;
  generation: number;
  bindingDigest: string;
}
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const fail = (): never => { throw new Error("INVALID_LOCAL_ENROLLMENT"); };
const canonicalDirectory = (name: string) => {
  if (!path.isAbsolute(name) || fs.realpathSync(name) !== name || !fs.lstatSync(name).isDirectory()) fail();
};

/** Read-only local policy record. Neither provider authentication nor a completion capability. */
export function readOrcaLocalEnrollment(projectRoot: string, sessionsRoot: string, expected: LocalEnrollmentScope) {
  return readEnrollment(projectRoot, sessionsRoot, expected, "enrollment.json");
}

/** Explicit task-scoped reader. Never falls back to the historical global record. */
export function readOrcaTaskEnrollment(projectRoot: string, sessionsRoot: string, expected: LocalEnrollmentScope) {
  if (!expected || typeof expected.taskId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}(?![\s\S])/.test(expected.taskId)) fail();
  return readEnrollment(projectRoot, sessionsRoot, expected, `${expected.taskId}.enrollment.json`);
}

function readEnrollment(projectRoot: string, sessionsRoot: string, expected: LocalEnrollmentScope, basename: string) {
  canonicalDirectory(projectRoot);
  canonicalDirectory(sessionsRoot);
  const data = path.join(projectRoot, "data");
  const directory = path.join(data, "orca-trust-v1");
  const evidenceRoot = path.join(data, "orca-evidence-v1");
  for (const name of [data, directory, evidenceRoot]) canonicalDirectory(name);
  const directories = [projectRoot, sessionsRoot, data, directory, evidenceRoot].map(name => ({ name, stat: fs.lstatSync(name) }));
  const privateDirectory = fs.lstatSync(directory);
  const uid = process.getuid?.();
  if ((privateDirectory.mode & 0o777) !== 0o700 || (uid !== undefined && privateDirectory.uid !== uid)) fail();
  const filename = path.join(directory, basename);
  const before = fs.lstatSync(filename);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 16384 ||
    (before.mode & 0o777) !== 0o600 || (uid !== undefined && before.uid !== uid)) fail();
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev) fail();
    const bytes = Buffer.alloc(16385);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(filename);
    for (const { name, stat } of directories) {
      canonicalDirectory(name);
      const now = fs.lstatSync(name);
      if (now.ino !== stat.ino || now.dev !== stat.dev || now.mode !== stat.mode || now.uid !== stat.uid) fail();
    }
    if (length !== before.size || length > 16384 || after.size !== before.size || after.nlink !== 1 ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink() ||
      after.mode !== before.mode || after.uid !== before.uid || current.mode !== before.mode || current.uid !== before.uid ||
      fs.realpathSync(directory) !== directory || fs.lstatSync(directory).ino !== privateDirectory.ino) fail();
    return inspectOrcaEnrollmentBytes(bytes.subarray(0,length),sessionsRoot,evidenceRoot,expected);
  } finally { fs.closeSync(fd); }
}

/** Shared bounded record validation for readers and explicit registration. */
export function inspectOrcaEnrollmentBytes(bytes:Buffer,sessionsRoot:string,evidenceRoot:string,expected:LocalEnrollmentScope){
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>16384)return fail();
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const parsed = decodeOrcaJson(raw);
    if (!parsed.ok) return fail();
    const value = parsed.value;
    if (!exact(value, ["version", "purpose", "registeredAt", "operator", "scope", "evidenceRoots", "authorizationBasis", "sourceAuthenticated", "canCompleteTask"]) ||
      value.version !== 1 || value.purpose !== "LOCAL_HUMAN_SUPERVISED_PILOT_ENROLLMENT" ||
      value.sourceAuthenticated !== false || value.canCompleteTask !== false ||
      typeof value.registeredAt !== "string" || !Number.isFinite(Date.parse(value.registeredAt)) ||
      new Date(value.registeredAt).toISOString() !== value.registeredAt ||
      typeof value.authorizationBasis !== "string" || value.authorizationBasis.length < 1 || value.authorizationBasis.length > 1024 ||
      !exact(value.operator, ["namespace", "subject"]) || value.operator.namespace !== "agenthub-local-operator-v1" ||
      typeof value.operator.subject !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/.test(value.operator.subject) ||
      !exact(value.scope, ["taskId", "projectId", "generation", "bindingDigest"]) ||
      !Number.isSafeInteger(value.scope.generation) || Number(value.scope.generation) < 1 ||
      typeof value.scope.bindingDigest !== "string" || !/^[a-f0-9]{64}(?![\s\S])/.test(value.scope.bindingDigest) ||
      typeof value.scope.taskId !== "string" || !value.scope.taskId || typeof value.scope.projectId !== "string" || !value.scope.projectId ||
      JSON.stringify(value.evidenceRoots) !== JSON.stringify([sessionsRoot, evidenceRoot])) fail();
    const scope = (value as Record<string, unknown>).scope as Record<string, unknown>;
    if (!exact(expected, ["taskId", "projectId", "generation", "bindingDigest"]) ||
      Object.entries(expected).some(([key, entry]) => scope[key] !== entry)) fail();
    return { operator: { namespace: "agenthub-local-operator-v1" as const, subject: ((value as Record<string, unknown>).operator as Record<string, string>).subject },
      digest: createHash("sha256").update(bytes).digest("hex"),
      scope: "LOCAL_ENROLLMENT_RECORD_ONLY" as const, sourceAuthenticated: false as const, canCompleteTask: false as const };
}
