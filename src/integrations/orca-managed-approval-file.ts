import fs from "node:fs";
import path from "node:path";
import { inspectOrcaManagedApproval } from "./orca-managed-approval.js";

const fail = (): never => { throw Error("UNSAFE_MANAGED_APPROVAL_FILE"); };
/** Reads an already-installed local file only. Private ownership is not operator authentication. */
export function readOrcaManagedApprovalFile(root: string, taskId: string, pin: string,
  expected: Parameters<typeof inspectOrcaManagedApproval>[2]) {
  if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) !== root ||
      typeof taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?![\s\S])/.test(taskId) ||
      typeof pin !== "string" || !/^[a-f0-9]{64}(?![\s\S])/.test(pin) || !process.getuid) return fail();
  const uid = BigInt(process.getuid());
  const names = [root, path.join(root, "data"), path.join(root, "data/orca-trust-v1")];
  const directories = names.map((name, index) => {
    const s = fs.lstatSync(name, { bigint: true });
    if (!s.isDirectory() || s.uid !== uid || fs.realpathSync(name) !== name ||
        (s.mode & 0o022n) || (index === 2 && (s.mode & 0o777n) !== 0o700n)) return fail();
    return { name, stat: s };
  });
  const file = path.join(names[2], `${taskId}.print-managed-v1-approval.json`);
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.uid !== uid ||
      (before.mode & 0o777n) !== 0o600n || before.size < 1n || before.size > 32768n) return fail();
  const same = (s: typeof before) => s.isFile() && ["dev", "ino", "size", "mode", "uid", "nlink", "mtimeNs", "ctimeNs"]
    .every(key => (s as any)[key] === (before as any)[key]);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!same(fs.fstatSync(fd, { bigint: true }))) return fail();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (!n) break;
      count += n;
    }
    if (count !== Number(before.size) || !same(fs.fstatSync(fd, { bigint: true })) ||
        !same(fs.lstatSync(file, { bigint: true }))) return fail();
    const result = inspectOrcaManagedApproval(bytes.subarray(0, count), pin, expected);
    for (const { name, stat } of directories) {
      const s = fs.lstatSync(name, { bigint: true });
      if (!s.isDirectory() || s.dev !== stat.dev || s.ino !== stat.ino || s.mode !== stat.mode ||
          s.uid !== stat.uid || fs.realpathSync(name) !== name) return fail();
    }
    if (!same(fs.fstatSync(fd, { bigint: true })) || !same(fs.lstatSync(file, { bigint: true }))) return fail();
    return result;
  } finally { fs.closeSync(fd); }
}
