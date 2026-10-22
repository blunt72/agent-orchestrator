import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readOrcaManagedApprovalFile } from "../../src/integrations/orca-managed-approval-file.js";
let root: string, file: string, pin: string;
const expected = { operator: { namespace: "local", subject: "synthetic" }, subjects: { taskId: "task", revision: 1 } };
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "managed-approval-")));
  fs.mkdirSync(path.join(root, "data/orca-trust-v1"), { recursive: true, mode: 0o700 });
  file = path.join(root, "data/orca-trust-v1/task.print-managed-v1-approval.json");
  const bytes = Buffer.from(JSON.stringify({ version: 1, purpose: "TASK_SCOPED_PRINT_MANAGED_COMPLETION_APPROVAL",
    approvedAt: "2020-01-01T00:00:00.000Z", sourceAuthenticated: false, ...expected }));
  pin = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(file, bytes, { mode: 0o600 });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const read = () => readOrcaManagedApprovalFile(root, "task", pin, expected);
it("reads a private synthetic approval without granting authority or changing its bytes", () => {
  const before = fs.readFileSync(file);
  expect(read()).toMatchObject({ approvalEvidenceConsistent: true, operatorAuthenticated: false, canCompleteTask: false });
  expect(fs.readFileSync(file)).toEqual(before);
});
it.each(["file-mode", "directory-mode", "hardlink", "symlink", "empty", "oversize", "pin"])("rejects %s", kind => {
  if (kind === "file-mode") fs.chmodSync(file, 0o644);
  if (kind === "directory-mode") fs.chmodSync(path.dirname(file), 0o755);
  if (kind === "hardlink") fs.linkSync(file, path.join(root, "copy"));
  if (kind === "symlink") { fs.renameSync(file, path.join(root, "target")); fs.symlinkSync(path.join(root, "target"), file); }
  if (kind === "empty") fs.writeFileSync(file, "");
  if (kind === "oversize") fs.writeFileSync(file, Buffer.alloc(32769));
  if (kind === "pin") pin = "0".repeat(64);
  expect(read).toThrow();
});
it("rejects path traversal and missing storage without creating directories", () => {
  expect(() => readOrcaManagedApprovalFile(root, "../task", pin, expected)).toThrow();
  fs.rmSync(path.join(root, "data"), { recursive: true });
  expect(read).toThrow(); expect(fs.existsSync(path.join(root, "data"))).toBe(false);
});
it.each(["replace-file", "change-mode", "replace-directory"])("rejects deterministic mid-read drift: %s", kind => {
  const originalRead = fs.readSync.bind(fs);
  const bytes = fs.readFileSync(file);
  let injected = false, observedFd: number | undefined;
  vi.spyOn(fs, "readSync").mockImplementation(((...args: any[]) => {
    const n = (originalRead as any)(...args);
    observedFd = args[0];
    if (!injected) {
      injected = true;
      if (kind === "replace-file") {
        fs.renameSync(file, path.join(root, "old-approval"));
        fs.writeFileSync(file, bytes, { mode: 0o600 });
      } else if (kind === "change-mode") fs.chmodSync(file, 0o644);
      else {
        const directory = path.dirname(file), old = path.join(root, "old-trust");
        fs.renameSync(directory, old);
        fs.mkdirSync(directory, { mode: 0o700 });
        // Preserve the file inode to exercise the directory identity check itself.
        fs.renameSync(path.join(old, path.basename(file)), file);
      }
    }
    return n;
  }) as any);
  expect(read).toThrow("UNSAFE_MANAGED_APPROVAL_FILE");
  expect(injected).toBe(true);
  expect(() => fs.fstatSync(observedFd!)).toThrow();
});
