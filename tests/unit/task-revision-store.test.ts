import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRevisionStore } from "../../src/integrations/task-revision-store.js";

let root: string;
let store: TaskRevisionStore;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-revision-")); store = new TaskRevisionStore(root); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe("isolated task revision storage (real local filesystem, not provider E2E)", () => {
  it("creates, reloads and conditionally updates without mutating input", async () => {
    const input = { id: "task-1", revision: 0, status: "DOING" };
    expect(await store.read(input.id)).toBeNull();
    const saved = await store.save(input, null);
    expect(saved.revision).toBe(1); expect(input.revision).toBe(0);
    const restarted = new TaskRevisionStore(root);
    expect(await restarted.read(input.id)).toEqual(saved);
    expect((await restarted.save({ ...saved, status: "REVIEW" }, 1)).revision).toBe(2);
    await expect(store.save(saved, 1)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await store.read(input.id))?.status).toBe("REVIEW");
  });
  it("allows only one competing conditional writer", async () => {
    const saved = await store.save({ id: "task", revision: 0 }, null);
    const results = await Promise.allSettled([store.save({ ...saved, owner: "a" }, 1),
      new TaskRevisionStore(root).save({ ...saved, owner: "b" }, 1)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await store.read("task"))?.revision).toBe(2);
  });
  it("fences separate Node processes against the same revision", async () => {
    await store.save({ id: "task", revision: 0 }, null);
    const module = new URL("../../src/integrations/task-revision-store.ts", import.meta.url).href;
    const script = `import {TaskRevisionStore} from ${JSON.stringify(module)};
      const store = new TaskRevisionStore(process.argv[1]);
      try { await store.save({id:"task",revision:1,owner:process.argv[2]},1); console.log("saved"); }
      catch(error) { if(!["BUSY","CONFLICT"].includes(error.code)) throw error; console.log(error.code); }`;
    const run = promisify(execFile);
    const results = await Promise.all(["a", "b"].map(owner => run(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, root, owner], { timeout: 10000, maxBuffer: 4096 })));
    expect(results.filter(r => r.stdout.trim() === "saved")).toHaveLength(1);
    expect((await store.read("task"))?.revision).toBe(2);
  });
  it("treats legacy records as revision zero, not absent", async () => {
    await fs.mkdir(path.join(root, "data/tasks"), { recursive: true });
    await fs.writeFile(path.join(root, "data/tasks/task.json"), JSON.stringify({ id: "task", status: "DOING" }));
    const legacy = (await store.read("task"))!;
    expect(legacy.revision).toBe(0);
    await expect(store.save(legacy, null)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await store.save(legacy, 0)).revision).toBe(1);
  });
  it("fails closed on corrupt records", async () => {
    await fs.mkdir(path.join(root, "data/tasks"), { recursive: true });
    for (const raw of ["{", '{"id":"other"}', '{"id":"task","revision":-1}']) {
      await fs.writeFile(path.join(root, "data/tasks/task.json"), raw);
      await expect(store.save({ id: "task", revision: 0 }, null)).rejects.toMatchObject({ code: "CORRUPT" });
      expect(await fs.readFile(path.join(root, "data/tasks/task.json"), "utf8")).toBe(raw);
    }
  });
  it("never steals an orphan lock", async () => {
    await fs.mkdir(path.join(root, "data/task-writes"), { recursive: true });
    const lock = path.join(root, "data/task-writes/task.lock");
    await fs.writeFile(lock, "old lock");
    await expect(store.save({ id: "task", revision: 0 }, null)).rejects.toMatchObject({ code: "BUSY" });
    expect(await fs.readFile(lock, "utf8")).toBe("old lock");
  });
  it.each(["../escape", "/absolute", "--option", "", "a/b"])("rejects unsafe task ID %s", async id => {
    await expect(store.read(id)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(store.save({ id, revision: 0 }, null)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("rejects mismatched revisions and exhausted counters", async () => {
    await expect(store.save({ id: "task", revision: 2 }, 1)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(store.save({ id: "task", revision: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("snapshots nested input before asynchronous IO", async () => {
    const input = { id: "task", revision: 0, nested: { value: "original" } };
    const pending = store.save(input, null);
    input.nested.value = "changed";
    expect((await pending).nested).toEqual({ value: "original" });
    expect((await store.read("task"))?.nested).toEqual({ value: "original" });
  });
  it.each(["before-rename", "after-rename"])("requires reconciliation on %s sync failure", async stage => {
    const saved = await store.save({ id: "task", revision: 0, status: "DOING" }, null);
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      const name = String(args[0]);
      if ((stage === "before-rename" && name.endsWith(".tmp")) ||
        (stage === "after-rename" && name === path.join(root, "data/tasks"))) {
        vi.spyOn(handle, "sync").mockRejectedValueOnce(Object.assign(new Error("injected sync failure"), { code: "EIO" }));
      }
      return handle;
    });
    await expect(store.save({ ...saved, status: "REVIEW" }, 1)).rejects.toMatchObject({ code: "EIO" });
    vi.restoreAllMocks();
    const current = (await store.read("task"))!;
    expect(current.revision).toBe(stage === "before-rename" ? 1 : 2);
    expect(current.status).toBe(stage === "before-rename" ? "DOING" : "REVIEW");
    expect(await fs.readdir(path.join(root, "data/task-writes"))).toEqual([]);
    expect(await fs.readdir(path.join(root, "data/tasks"))).toEqual(["task.json"]);
    if (stage === "after-rename") await expect(store.save(saved, 1)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
