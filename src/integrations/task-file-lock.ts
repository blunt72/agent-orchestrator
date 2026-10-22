import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export type TaskLockNamespace = "task-writes" | "task-executions" | "task-claims";

/** Shared lock paths only; possession never authorizes a task-state transition.
 * Participating writers never replace a live/orphan lock. Operator reconciliation
 * requires quiescing all writers first; arbitrary external filesystem writes are
 * not fenced by this protocol.
 */
export async function withTaskFileLock<T>(root: string, taskId: string, namespace: TaskLockNamespace,
  busyError: () => Error, operation: () => Promise<T>): Promise<T> {
  if (!path.isAbsolute(root) || typeof taskId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}(?![\s\S])/.test(taskId) ||
    !["task-writes", "task-executions", "task-claims"].includes(namespace)) throw Error("INVALID_TASK_LOCK");
  const directory = path.join(root, "data", namespace);
  await fs.mkdir(directory, { recursive: true });
  const key = namespace === "task-writes" ? taskId : createHash("sha256").update(taskId).digest("hex");
  const lockPath = path.join(directory, `${key}.lock`);
  let handle;
  try { handle = await fs.open(lockPath, "wx", 0o600); }
  catch (error: any) { if (error.code === "EEXIST") throw busyError(); throw error; }
  let identity: Awaited<ReturnType<typeof handle.stat>> | undefined;
  try {
    identity = await handle.stat();
    await handle.writeFile(JSON.stringify(namespace === "task-writes"
      ? { id: taskId, pid: process.pid, createdAt: new Date().toISOString() }
      : { taskId, pid: process.pid, createdAt: new Date().toISOString() }));
    await handle.sync();
    return await operation();
  } finally {
    await handle.close();
    // Do not yield to other same-process code between inspection and removal.
    // This is not an atomic unlink-if-inode against arbitrary external writers.
    let current;
    try { current = fsSync.lstatSync(lockPath); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    if (identity && current?.isFile() && current.ino === identity.ino && current.dev === identity.dev) fsSync.unlinkSync(lockPath);
  }
}
