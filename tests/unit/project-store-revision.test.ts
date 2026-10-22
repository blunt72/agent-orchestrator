import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "../../src/projects/project-store.js";
import { ProjectEngine } from "../../src/projects/project-engine.js";
import { TaskRunner } from "../../src/tasks/task-runner.js";
import type { Task } from "../../src/tasks/task.js";

let root: string;
let store: ProjectStore;
const task = (): Task => ({ id: "task", projectId: "project", title: "Revision", description: "",
  status: "TODO", owner: "user", ownerId: "user", ownerType: "HUMAN", priority: "LOW", workspace: root,
  maxRounds: 1, currentRound: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "store-revision-")); store = new ProjectStore(root); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe("ProjectStore revision integration (local filesystem, not provider E2E)", () => {
  it("fences bound DONE/result writes and binding removal across store instances", async () => {
    const input = { ...task(), status: "REVIEW" as const, orcaBinding: { dispatchId: "synthetic" } as any };
    await store.saveTask(input);
    const before = await fs.readFile(path.join(root, "data/tasks/task.json"), "utf8");
    const other = new ProjectStore(root);
    for (const update of [{ ...input, status: "DONE" as const },
      { ...input, result: {} as any }, { ...input, orcaBinding: undefined },
      { ...input, orcaBinding: undefined, status: "DONE" as const }]) {
      await expect(other.saveTask(update)).rejects.toMatchObject({code:"BOUND_COMPLETION_DISABLED"});
      expect(await fs.readFile(path.join(root, "data/tasks/task.json"), "utf8")).toBe(before);
    }
    await other.saveTask(input);
    expect(input.revision).toBe(2);
  });
  it("rejects generic manual completion of a bound task before emitting completion events", async () => {
    const input = { ...task(), orcaBinding: { dispatchId: "synthetic" } as any };
    await store.saveTask(input);
    const engine = new ProjectEngine({baseDir:root});
    const before = await fs.readFile(path.join(root,"data/tasks/task.json"),"utf8");
    await expect(engine.completeHumanTask(input.id)).rejects.toMatchObject({code:"BOUND_COMPLETION_DISABLED"});
    expect(await fs.readFile(path.join(root,"data/tasks/task.json"),"utf8")).toBe(before);
    expect(await fs.stat(path.join(root,"logs/tasks/task.jsonl")).then(()=>true,()=>false)).toBe(false);
  });
  it("advances caller revision and rejects stale or missing-version overwrites", async () => {
    const input = task(); await store.saveTask(input); expect(input.revision).toBe(1);
    const stale = (await store.getTask(input.id))!;
    input.status = "CANCELLED"; await store.saveTask(input); expect(input.revision).toBe(2);
    await expect(store.saveTask({ ...stale, status: "DONE" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(store.saveTask(task())).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await store.getTask(input.id))?.status).toBe("CANCELLED");
  });
  it("fences competing store instances and rejects queued stale snapshots", async () => {
    const input = task(); await store.saveTask(input);
    const other = new ProjectStore(root);
    const results = await Promise.allSettled([store.saveTask({ ...input, ownerId: "gemini" }),
      other.saveTask({ ...input, ownerId: "codex" })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const current = (await store.getTask(input.id))!;
    const queued = await Promise.allSettled([store.saveTask({ ...current, status: "REVIEW" }),
      store.saveTask({ ...current, status: "DONE" })]);
    expect(queued.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await store.getTask(input.id))?.revision).toBe(3);
  });
  it("normalizes legacy tasks through get and list before guarded migration", async () => {
    const input = task();
    await fs.writeFile(path.join(root, "data/tasks/task.json"), JSON.stringify(input));
    expect((await store.getTask("task"))?.revision).toBe(0);
    const [listed] = await store.listTasks(); expect(listed.revision).toBe(0);
    await store.saveTask(listed); expect(listed.revision).toBe(1);
    await expect(store.saveTask({ ...input, revision: 0 })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("fails closed on corrupt reads and saves without replacing the file", async () => {
    const file = path.join(root, "data/tasks/task.json"); await fs.writeFile(file, "{");
    await expect(store.getTask("task")).rejects.toMatchObject({ code: "CORRUPT" });
    await expect(store.saveTask(task())).rejects.toMatchObject({ code: "CORRUPT" });
    expect(await fs.readFile(file, "utf8")).toBe("{");
  });
  it("snapshots nested fields before waiting on the in-process mutex", async () => {
    const input = task(); input.dependsOn = ["original"];
    const pending = store.saveTask(input); input.dependsOn[0] = "changed";
    await pending; expect((await store.getTask("task"))?.dependsOn).toEqual(["original"]);
  });
  it("does not transfer a committed revision to a changed caller identity", async () => {
    const a = task(); await store.saveTask(a);
    const b = { ...task(), id: "other" }; await store.saveTask(b);
    b.status = "CANCELLED"; await store.saveTask(b);
    const pending = store.saveTask(a); a.id = b.id; a.status = "DONE";
    await pending;
    expect(a.revision).toBe(1);
    await expect(store.saveTask(a)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await store.getTask(b.id))?.status).toBe("CANCELLED");
  });
  it("preserves safe dotted legacy IDs through read, list and update", async () => {
    const input = { ...task(), id: "task.v1" };
    await fs.writeFile(path.join(root, "data/tasks/task.v1.json"), JSON.stringify(input));
    const loaded = (await store.getTask(input.id))!; expect(loaded.revision).toBe(0);
    expect((await store.listTasks()).map(t => t.id)).toContain(input.id);
    await store.saveTask(loaded); expect(loaded.revision).toBe(1);
    expect((await store.getTask(input.id))?.revision).toBe(1);
  });
  it.each(["CANCELLED", "TODO"] as const)("reconciles final-save race only when latest status is %s", async status => {
    const engine = new ProjectEngine({ baseDir: root });
    const project = await engine.createProject({ name: "Race", workspace: root });
    const input = await engine.createTask({ projectId: project.id, title: "Final save race", description: "" });
    const engineStore = engine.getStore(); const save = engineStore.saveTask.bind(engineStore);
    vi.spyOn(TaskRunner.prototype, "run").mockImplementation(async function () {
      return { ...this.getTask(), status: "DONE" };
    });
    vi.spyOn(engineStore, "saveTask").mockImplementation(async value => {
      if (value.status === "DONE") {
        const latest = (await engineStore.getTask(value.id))!;
        await save({ ...latest, status });
      }
      await save(value);
    });
    if (status === "CANCELLED") expect((await engine.runTask(input.id)).status).toBe("CANCELLED");
    else await expect(engine.runTask(input.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await engineStore.getTask(input.id))?.status).toBe(status);
  });
});
