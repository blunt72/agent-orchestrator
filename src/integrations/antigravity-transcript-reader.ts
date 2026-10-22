import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { ANTIGRAVITY_TRANSCRIPT_MAX_BYTES, extractAntigravityTranscriptPair } from "./antigravity-transcript-source.js";

/** Explicit local source read only. The caller must independently establish the
 * trusted root; confinement does not authenticate a provider or terminal.
 */
export function readAntigravityTranscriptPair(root: string, relativePath: string, selector: string) {
  const fail = (): never => { throw new Error("UNSAFE_ANTIGRAVITY_TRANSCRIPT_SOURCE"); };
  if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0") ||
      typeof relativePath !== "string" || relativePath.length > 4096 || relativePath.includes("\0") ||
      relativePath.split("/").some(p => !p || p === "." || p === "..") || isAbsolute(relativePath)) return fail();
  const canonicalRoot = resolve(root);
  if (realpathSync(canonicalRoot) !== canonicalRoot) return fail();
  const parts = relativePath.split("/");
  const directories = [canonicalRoot, ...parts.slice(0, -1).map((_, i) => join(canonicalRoot, ...parts.slice(0, i + 1)))];
  const snapshots = directories.map(path => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o022n)) return fail();
    return {path, stat};
  });
  const path = join(canonicalRoot, ...parts);
  if (!path.startsWith(canonicalRoot + sep)) return fail();
  const before = lstatSync(path, { bigint: true });
  const safeFile = (s: typeof before) => s.isFile() && s.nlink === 1n && s.uid === BigInt(process.getuid!()) &&
    !(s.mode & 0o022n) && s.size > 0n && s.size <= BigInt(ANTIGRAVITY_TRANSCRIPT_MAX_BYTES);
  const same = (a: typeof before, b: typeof before) =>
    a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode &&
    a.uid === b.uid && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  if (!safeFile(before)) return fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!safeFile(opened) || !same(before, opened)) return fail();
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0, count = 0;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, length)) > 0) length += count;
    if (length !== Number(opened.size)) return fail();
    const result = extractAntigravityTranscriptPair(bytes.subarray(0, length), selector);
    // No await occurs between final descriptor, directory and pathname checks.
    if (!same(opened, fstatSync(fd, { bigint: true })) || realpathSync(canonicalRoot) !== canonicalRoot ||
        snapshots.some(({path, stat}) => !same(stat, lstatSync(path, { bigint: true }))) ||
        !same(opened, lstatSync(path, { bigint: true })) || realpathSync(path) !== path) return fail();
    return {...result, localFileSnapshotVerified: true as const};
  } finally { closeSync(fd); }
}
