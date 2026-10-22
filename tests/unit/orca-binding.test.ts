import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../../src/projects/project-store.js";
import { ProjectEngine } from "../../src/projects/project-engine.js";
import { TaskEngine } from "../../src/tasks/task-engine.js";
import { persistOrcaBinding } from "../../src/integrations/orca-binding.js";
import type { OrcaBinding } from "../../src/integrations/orca-delivery.js";
import type { Task } from "../../src/tasks/task.js";

let root: string; let store: ProjectStore; let binding: OrcaBinding;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "orca-binding-")); store = new ProjectStore(root);
  const task: Task = { id: "task", projectId: "project", title: "Binding", description: "", status: "DOING",
    owner: "gemini", ownerId: "gemini", ownerType: "AGENT", reviewerId: "codex", priority: "LOW", workspace: root,
    maxRounds: 1, currentRound: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await store.saveTask(task);
  binding = { agenthubTaskId: "task", projectId: "project", revision: "2", generation: 1,
    runtimeId: "runtime", hostId: "local", runId: "run", taskId: "orca-task", dispatchId: "dispatch",
    workspaceId: "workspace", workspacePath: root, terminalHandle: "terminal", developer: "gemini", reviewer: "codex",
    provider: "antigravity", ownerId: "gemini", claimId: null };
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("Orca binding persistence (synthetic mapping, actual local storage, not provider E2E)", () => {
  it("persists mapping and generation with the exact resulting task revision", async () => {
    const saved = await persistOrcaBinding(store, binding);
    expect(saved.revision).toBe(2); expect(saved.orcaBinding).toEqual(binding); expect(saved.orcaGeneration).toBe(1);
    binding.dispatchId = "mutated";
    expect((await new ProjectStore(root).getTask("task"))?.orcaBinding?.dispatchId).toBe("dispatch");
  });
  it.each(["revision", "generation", "ownerId", "claimId", "reviewer", "workspacePath", "projectId"])
    ("rejects conflicting mapping %s without task writes", async key => {
      const before = await store.getTask("task");
      (binding as any)[key] = key === "generation" ? 2 : "wrong";
      await expect(persistOrcaBinding(store, binding)).rejects.toThrow();
      expect(await store.getTask("task")).toEqual(before);
    });
  it.each(["CANCELLED", "TODO", "REVIEW"] as const)("rejects task state %s", async status => {
    const task = (await store.getTask("task"))!; task.status = status; await store.saveTask(task);
    binding.revision = "3";
    await expect(persistOrcaBinding(store, binding)).rejects.toMatchObject({ code: "BINDING_CONFLICT" });
  });
  it("never replaces existing bindings", async () => {
    await persistOrcaBinding(store, binding);
    const before = await store.getTask("task");
    binding.revision = "3"; binding.generation = 2;
    await expect(persistOrcaBinding(store, binding)).rejects.toMatchObject({ code: "BINDING_CONFLICT" });
    expect(await store.getTask("task")).toEqual(before);
  });
  it("refuses a pending internal turn without changing it", async () => {
    const task = (await store.getTask("task"))!;
    task.pendingAgentTurn = { sessionId: "session", startStepIndex: 0, requestTime: new Date().toISOString(), actor: "gemini", phase: "DOING" };
    await store.saveTask(task); binding.revision = "3";
    await expect(persistOrcaBinding(store, binding)).rejects.toMatchObject({ code: "BINDING_CONFLICT" });
    expect(await store.getTask("task")).toEqual(task);
  });
  it("allows one competing binder and refuses binding while execution lock is held", async () => {
    await store.runTaskExecutionExclusive("task", async () => {
      await expect(persistOrcaBinding(store, binding)).rejects.toMatchObject({ name: "TaskExecutionBusyError" });
    });
    const outcomes = await Promise.allSettled([persistOrcaBinding(store, binding), persistOrcaBinding(new ProjectStore(root), binding)]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
  it("refuses internal dispatch after restart and preserves later administrative cancellation", async () => {
    await persistOrcaBinding(store, binding);
    await expect(new ProjectEngine({ baseDir: root }).runTask("task")).rejects.toThrow("Orca-bound");
    const task = (await store.getTask("task"))!; task.status = "CANCELLED"; await store.saveTask(task);
    expect(task.revision).toBe(3); expect(task.orcaBinding?.revision).toBe("2");
    expect((await store.getTask("task"))?.status).toBe("CANCELLED");
  });
  it("rejects resume/human continuation before their preparation writes", async () => {
    await persistOrcaBinding(store, binding);
    const task = (await store.getTask("task"))!; task.status = "NEED_USER"; await store.saveTask(task);
    const before = await store.getTask("task");
    await expect(new TaskEngine({ baseDir: root }).resumeTask("task")).rejects.toThrow("Orca-bound");
    await expect(new ProjectEngine({ baseDir: root }).respondToNeedUser("task", "continue")).rejects.toThrow("Orca-bound");
    expect(await store.getTask("task")).toEqual(before);
  });
});
