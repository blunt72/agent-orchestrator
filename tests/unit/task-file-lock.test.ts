import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withTaskFileLock, type TaskLockNamespace } from "../../src/integrations/task-file-lock.js";
import { TaskRevisionStore } from "../../src/integrations/task-revision-store.js";
import { ProjectStore } from "../../src/projects/project-store.js";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "task-file-lock-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
const busy = () => Error("LOCK_BUSY");
const run = <T>(namespace: TaskLockNamespace, operation: () => Promise<T>, id = "task") =>
  withTaskFileLock(root, id, namespace, busy, operation);
const filename = (namespace: TaskLockNamespace) => path.join(root, "data", namespace,
  `${namespace === "task-writes" ? "task" : createHash("sha256").update("task").digest("hex")}.lock`);

it.each(["task-writes", "task-executions", "task-claims"] as const)("uses existing %s path and private lock, then releases", async namespace => {
  await run(namespace, async () => {
    const stat = await fs.stat(filename(namespace)); expect(stat.mode & 0o777).toBe(0o600);
    const value = JSON.parse(await fs.readFile(filename(namespace), "utf8"));
    expect(value[namespace === "task-writes" ? "id" : "taskId"]).toBe("task");
    await expect(run(namespace, async () => "unreachable")).rejects.toThrow("LOCK_BUSY");
  });
  await expect(fs.stat(filename(namespace))).rejects.toMatchObject({ code: "ENOENT" });
});
it("blocks a generic writer under the shared write lock", async () => {
  const store = new TaskRevisionStore(root);
  await run("task-writes", async () => {
    await expect(store.save({ id: "task", revision: 0 }, null)).rejects.toMatchObject({ code: "BUSY" });
  });
  await expect(store.save({ id: "task", revision: 0 }, null)).resolves.toMatchObject({ revision: 1 });
});
it("blocks ProjectStore execution and claims with the same existing namespaces", async () => {
  const store = new ProjectStore(root);
  await run("task-executions", async () => {
    await expect(store.runTaskExecutionExclusive("task", async () => "unreachable")).rejects.toMatchObject({ code: "TASK_EXECUTION_BUSY" });
    await run("task-writes", async () => "nested write lock");
  });
  await run("task-claims", async () => {
    await expect(store.runTaskClaimExclusive("task", async () => "unreachable")).rejects.toMatchObject({ code: "CLAIM_BUSY" });
  });
});
it("does not grant a bound completion bypass", async () => {
  const store = new TaskRevisionStore(root);
  await store.save({ id: "task", revision: 0, status: "REVIEW", orcaBinding: {} }, null);
  await expect(store.save({ id: "task", revision: 1, status: "DONE", orcaBinding: {} }, 1))
    .rejects.toMatchObject({ code: "BOUND_COMPLETION_DISABLED" });
  expect((await store.read("task"))?.status).toBe("REVIEW");
});
it("releases on callback failure", async () => {
  await expect(run("task-writes", async () => { throw Error("callback failed"); })).rejects.toThrow("callback failed");
  await expect(run("task-writes", async () => "released")).resolves.toBe("released");
});
it("never deletes a replacement lock", async () => {
  await run("task-writes", async () => {
    await fs.rename(filename("task-writes"), filename("task-writes") + ".old");
    await fs.writeFile(filename("task-writes"), "replacement", { flag: "wx" });
  });
  expect(await fs.readFile(filename("task-writes"), "utf8")).toBe("replacement");
});
it("never follows or deletes a replacement symlink", async () => {
  await run("task-writes", async () => {
    await fs.rename(filename("task-writes"), filename("task-writes") + ".old");
    await fs.symlink(filename("task-writes") + ".old", filename("task-writes"));
  });
  expect((await fs.lstat(filename("task-writes"))).isSymbolicLink()).toBe(true);
});
it("never steals an orphan", async () => {
  await fs.mkdir(path.dirname(filename("task-writes")), { recursive: true });
  await fs.writeFile(filename("task-writes"), "orphan");
  await expect(run("task-writes", async () => "unreachable")).rejects.toThrow("LOCK_BUSY");
  expect(await fs.readFile(filename("task-writes"), "utf8")).toBe("orphan");
});
it("does not yield between release inspection and removal (same-process scheduling)", async () => {
  const original = fsSync.lstatSync;
  let observed = false, existedWhenScheduled = true;
  vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
    const stat = Reflect.apply(original, fsSync, args);
    if (!observed && String(args[0]) === filename("task-writes")) {
      observed = true;
      queueMicrotask(() => {
        existedWhenScheduled = fsSync.existsSync(filename("task-writes"));
        fsSync.writeFileSync(filename("task-writes"), "subsequent lock", { flag: "wx" });
      });
    }
    return stat;
  }) as typeof fsSync.lstatSync);
  await run("task-writes", async () => "complete");
  expect(observed).toBe(true); expect(existedWhenScheduled).toBe(false);
  expect(await fs.readFile(filename("task-writes"), "utf8")).toBe("subsequent lock");
});
it.each(["task\n", "../task", "", "a".repeat(129)])("rejects unsafe IDs before creating directories %j", async id => {
  await expect(run("task-writes", async () => "unreachable", id)).rejects.toThrow("INVALID_TASK_LOCK");
  await expect(new TaskRevisionStore(root).read(id)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(await fs.readdir(root)).toEqual([]);
});
it("rejects runtime namespace injection", async () => {
  await expect(run("../tasks" as TaskLockNamespace, async () => "unreachable")).rejects.toThrow("INVALID_TASK_LOCK");
  expect(await fs.readdir(root)).toEqual([]);
});
