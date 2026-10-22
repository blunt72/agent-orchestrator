import { it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskEngine } from "../../src/tasks/task-engine.js";
import { ProjectStore } from "../../src/projects/project-store.js";
import type { Task } from "../../src/tasks/task.js";
import { createServer } from "../../src/server/server.js";

let root: string;
let engine: TaskEngine;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "execution-lock-"));
  engine = new TaskEngine({ baseDir: root });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it("blocks a second engine before task lookup or provider startup", async () => {
  await engine.getStore().runTaskExecutionExclusive("task-1", async () => {
    const other = new TaskEngine({ baseDir: root });
    await expect(other.runTask("task-1")).rejects.toMatchObject({ code: "TASK_EXECUTION_BUSY", statusCode: 409 });
  });
  await expect(engine.runTask("task-1")).rejects.toThrow("Task not found");
});
it("releases after callback failure", async () => {
  await expect(engine.getStore().runTaskExecutionExclusive("task-1", async () => { throw new Error("failure"); }))
    .rejects.toThrow("failure");
  await expect(engine.getStore().runTaskExecutionExclusive("task-1", async () => "released")).resolves.toBe("released");
});
it("keeps task and claim lock namespaces independent", async () => {
  await engine.getStore().runTaskExecutionExclusive("task-1", async () => {
    await expect(engine.getStore().runTaskExecutionExclusive("task-2", async () => "ok")).resolves.toBe("ok");
    await expect(engine.getStore().runTaskClaimExclusive("task-1", async () => "ok")).resolves.toBe("ok");
  });
});
it("maps a busy run to HTTP 409", async () => {
  const app = createServer(engine);
  try {
    await engine.getStore().runTaskExecutionExclusive("task-1", async () => {
      const response = await app.inject({ method: "POST", url: "/api/tasks/task-1/run" });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("TASK_EXECUTION_BUSY");
    });
  } finally { await app.close(); }
});
it("recovery scanner does not overwrite a live holder's task on busy", async () => {
  const now = new Date().toISOString();
  const task = { id: "task-1", projectId: "project", title: "Pending", description: "",
    status: "DOING", owner: "gemini", ownerId: "gemini", ownerType: "AGENT",
    priority: "LOW", workspace: root, maxRounds: 1, currentRound: 1,
    createdAt: now, updatedAt: now, pendingAgentTurn: { phase: "DOING", actor: "gemini" } } as Task;
  await engine.getStore().saveTask(task);
  await engine.getStore().runTaskExecutionExclusive(task.id, async () => {
    const other = new TaskEngine({ baseDir: root });
    await other.recoverPendingTasks();
    // runTask coalesces the scanner's pending dispatch, so this awaits its settlement.
    await expect(other.runTask(task.id)).rejects.toMatchObject({ code: "TASK_EXECUTION_BUSY" });
    await new Promise(resolve => setImmediate(resolve));
    expect(await engine.getTask(task.id)).toEqual(task);
  });
});

it("keeps lock throughout unresolved async callback and allows subsequent acquisition after settlement", async () => {
  const secondStore = new ProjectStore(root);
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  let firstEntered = false;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });

  const firstPromise = engine.getStore().runTaskExecutionExclusive("task-1", async () => {
    firstEntered = true;
    signalStarted();
    await gate;
    return "first-result";
  });

  let secondEntered = false;
  try {
    await started;
    expect(firstEntered).toBe(true);

    await expect(
      secondStore.runTaskExecutionExclusive("task-1", async () => {
        secondEntered = true;
        return "second-result";
      })
    ).rejects.toMatchObject({ code: "TASK_EXECUTION_BUSY" });

    expect(secondEntered).toBe(false);

    releaseGate();
    await expect(firstPromise).resolves.toBe("first-result");

    let secondAcquired = false;
    const secondResult = await secondStore.runTaskExecutionExclusive("task-1", async () => {
      secondAcquired = true;
      return "second-after-settlement";
    });

    expect(secondAcquired).toBe(true);
    expect(secondResult).toBe("second-after-settlement");
  } finally {
    releaseGate?.();
    await firstPromise.catch(() => {});
  }
});

