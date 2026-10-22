import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { inspectOrcaExecutionPermission, type OrcaExecutionPermissionExpectation } from "./orca-execution-permission.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";

const fail = (): never => { throw Error("PERMISSION_EVIDENCE_STORE_CONFLICT"); };
/** Immutable evidence archive, not a permission registry or an authorization installer. */
export function persistOrcaPermissionEvidence(directory: string, rawBinding: string, bytes: Buffer,
  expected: OrcaExecutionPermissionExpectation) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 32768) return fail();
  const raw = Buffer.from(bytes), e = structuredClone(expected);
  const checked = inspectOrcaExecutionPermission(rawBinding, raw, e);
  const { binding } = parseOrcaCompletionBinding(rawBinding);
  if (typeof directory !== "string" || !path.isAbsolute(directory) || path.resolve(directory) !== directory || !process.getuid) return fail();
  const before = fs.lstatSync(directory, { bigint: true });
  const directoryStable = () => {
    const s = fs.lstatSync(directory, { bigint: true });
    if (!s.isDirectory() || s.dev !== before.dev || s.ino !== before.ino || s.mode !== before.mode ||
        s.uid !== before.uid || s.uid !== BigInt(process.getuid!()) || (s.mode & 0o777n) !== 0o700n ||
        fs.realpathSync(directory) !== directory) return fail();
  };
  directoryStable();
  const file = path.join(directory, `${binding.agenthubTaskId}.permission-evidence-v1.json`);
  const temp = path.join(directory, `.${randomUUID()}.tmp`);
  let replay = false;
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try {
    try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    directoryStable();
    try { fs.linkSync(temp, file); }
    catch (error: any) { if (error.code !== "EEXIST") throw error; replay = true; }
  } finally { fs.unlinkSync(temp); }
  directoryStable();
  const stat = fs.lstatSync(file, { bigint: true });
  const same = (s: typeof stat) => s.isFile() && ["dev", "ino", "size", "mode", "uid", "nlink", "mtimeNs", "ctimeNs"]
    .every(key => (s as any)[key] === (stat as any)[key]);
  if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!()) ||
      (stat.mode & 0o777n) !== 0o600n || stat.size !== BigInt(raw.length)) return fail();
  const readFd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!same(fs.fstatSync(readFd, { bigint: true }))) return fail();
    const stored = Buffer.alloc(raw.length + 1);
    let count = 0;
    while (count < stored.length) { const n = fs.readSync(readFd, stored, count, stored.length - count, count); if (!n) break; count += n; }
    if (count !== raw.length || !stored.subarray(0, count).equals(raw) || !same(fs.fstatSync(readFd, { bigint: true })) ||
        !same(fs.lstatSync(file, { bigint: true }))) return fail();
    directoryStable();
    const dirFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { const s = fs.fstatSync(dirFd, { bigint: true }); if (s.dev !== before.dev || s.ino !== before.ino) return fail(); fs.fsyncSync(dirFd); }
    finally { fs.closeSync(dirFd); }
    directoryStable();
    return { ...checked, evidenceStored: true, replay, file, scope: "IMMUTABLE_PERMISSION_EVIDENCE_ONLY" };
  } finally { fs.closeSync(readFd); }
}
