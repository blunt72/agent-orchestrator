import { it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskEngine } from "../../src/tasks/task-engine.js";
import { createServer } from "../../src/server/server.js";
import type { Task } from "../../src/tasks/task.js";

let root: string;
let engine: TaskEngine;
let task: Task;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "resume-lock-"));
  engine = new TaskEngine({ baseDir: root });
  const now = new Date().toISOString();
  task = { id: "resume", projectId: "project", title: "Resume", description: "",
    status: "NEED_USER", owner: "user", ownerId: "user", ownerType: "HUMAN",
    reviewerId: "codex", priority: "LOW", workspace: root, maxRounds: 1,
    currentRound: 0, createdAt: now, updatedAt: now,
    claim: { id: "receipt", ownerId: "gemini", previousOwnerId: "user", claimedAt: now } };
  await engine.getStore().saveTask(task);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it("busy resume leaves persisted task and events unchanged", async () => {
  await engine.getStore().runTaskExecutionExclusive(task.id, async () => {
    const other = new TaskEngine({ baseDir: root });
    await expect(other.resumeTask(task.id)).rejects.toMatchObject({ code: "TASK_EXECUTION_BUSY" });
    expect(await engine.getTask(task.id)).toEqual(task);
    expect(await fs.readdir(path.join(root, "logs/tasks"))).toEqual([]);
  });
});
it("HTTP resume conflict returns 409 without rewriting task", async () => {
  const app = createServer(engine);
  try {
    await engine.getStore().runTaskExecutionExclusive(task.id, async () => {
      const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/resume` });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("TASK_EXECUTION_BUSY");
      expect(await engine.getTask(task.id)).toEqual(task);
    });
  } finally { await app.close(); }
});
it("invalid independent reviewer rejects without changing state and releases lock", async () => {
  task.reviewerId = "gemini";
  await engine.getStore().saveTask(task);
  await expect(engine.resumeTask(task.id)).rejects.toThrow("independent reviewer");
  expect(await engine.getTask(task.id)).toEqual(task);
  await expect(engine.getStore().runTaskExecutionExclusive(task.id, async () => "released")).resolves.toBe("released");
});
it("invalid source state rejects before mutation", async () => {
  task.status = "DONE";
  await engine.getStore().saveTask(task);
  await expect(engine.resumeTask(task.id)).rejects.toThrow("Cannot resume");
  expect(await engine.getTask(task.id)).toEqual(task);
});
it("review resume preparation retains reviewer ownership and original checkpoint", async () => {
  task.pendingAgentTurn = { phase: "REVIEW", actor: "codex", sessionId: "original-review-session" } as Task["pendingAgentTurn"];
  await engine.getStore().saveTask(task);
  // Exercise actual preparation only; no provider session is started by this unit check.
  const preparation = engine as unknown as { prepareTaskResume(id: string): Promise<void> };
  await engine.getStore().runTaskExecutionExclusive(task.id, () => preparation.prepareTaskResume(task.id));
  const resumed = await engine.getTask(task.id);
  expect(resumed.status).toBe("REVIEW");
  expect(resumed.ownerId).toBe("codex");
  expect(resumed.claim?.ownerId).toBe("gemini");
  expect(resumed.pendingAgentTurn).toEqual(task.pendingAgentTurn);
  const events = (await fs.readFile(path.join(root, "logs/tasks/resume.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(events).toHaveLength(1);
  expect(events[0].details.to).toBe("REVIEW");
});
