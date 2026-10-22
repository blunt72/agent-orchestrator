import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface OrcaEvidenceRef { version: 1; sha256: string; bytes: number }
export const ORCA_EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
export function validOrcaEvidenceRef(value: unknown): value is OrcaEvidenceRef {
  const v = value as OrcaEvidenceRef;
  return !!v && typeof v === "object" && !Array.isArray(v) &&
    Object.keys(v).sort().join(",") === "bytes,sha256,version" && v.version === 1 &&
    typeof v.sha256 === "string" && /^[a-f0-9]{64}$/.test(v.sha256) &&
    Number.isSafeInteger(v.bytes) && v.bytes >= 0 && v.bytes <= ORCA_EVIDENCE_MAX_BYTES;
}
const invalid = () => new Error("INVALID_ORCA_EVIDENCE");

/** Local content integrity, not provider authentication. Use a trusted quiescent root. */
export class OrcaEvidenceStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw invalid();
  }

  private async directory(create: boolean): Promise<string> {
    const root = path.resolve(this.root);
    if (await fs.realpath(root) !== root) throw invalid();
    let directory = root;
    for (const name of ["data", "orca-evidence-v1"]) {
      directory = path.join(directory, name);
      if (create) await fs.mkdir(directory, {mode:0o700}).catch(e => { if (e.code !== "EEXIST") throw e; });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    }
    return directory;
  }

  public async read(input: OrcaEvidenceRef): Promise<Buffer> {
    if (!validOrcaEvidenceRef(input)) throw invalid();
    const ref = {...input};
    const directory = await this.directory(false);
    const file = path.join(directory, ref.sha256);
    const entry = await fs.lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== ref.bytes || entry.nlink !== 1) throw invalid();
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== ref.bytes || before.nlink !== 1 ||
        before.ino !== entry.ino || before.dev !== entry.dev) throw invalid();
      const bytes = Buffer.alloc(ref.bytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await handle.stat();
      const current = await fs.lstat(file);
      if (length !== ref.bytes || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev ||
        await this.directory(false) !== directory) throw invalid();
      const value = bytes.subarray(0, length);
      if (digest(value) !== ref.sha256) throw invalid();
      return value;
    } finally { await handle.close(); }
  }

  public async put(input: Buffer): Promise<OrcaEvidenceRef> {
    if (!Buffer.isBuffer(input) || input.length > ORCA_EVIDENCE_MAX_BYTES) throw invalid();
    const bytes = Buffer.from(input);
    const ref: OrcaEvidenceRef = {version:1,sha256:digest(bytes),bytes:bytes.length};
    const directory = await this.directory(true);
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally { await handle.close(); }
      // Exclusive hard-link publication never overwrites existing evidence.
      await fs.link(temporary, path.join(directory,ref.sha256)).catch(e => { if (e.code !== "EEXIST") throw e; });
    } finally { await fs.unlink(temporary); }
    const dir = await fs.open(directory,"r");
    try { await dir.sync(); } finally { await dir.close(); }
    await this.read(ref);
    return ref;
  }
}
