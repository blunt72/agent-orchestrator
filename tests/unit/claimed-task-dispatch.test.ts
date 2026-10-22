import { it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskRunner } from "../../src/tasks/task-runner.js";
import { TaskEngine } from "../../src/tasks/task-engine.js";
import type { Task } from "../../src/tasks/task.js";
import type { TaskStore } from "../../src/tasks/task-store.js";

let root: string;
let engine: TaskEngine;
let task: Task;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "claimed-dispatch-"));
  engine = new TaskEngine({ baseDir: root, maxConcurrentTasks: 1 });
  const now = new Date().toISOString();
  task = { id: "claimed", projectId: "project", title: "Dispatch", description: "",
    status: "TODO", owner: "gemini", ownerId: "gemini", ownerType: "AGENT",
    reviewerId: "codex", priority: "LOW", workspace: root, maxRounds: 1,
    currentRound: 0, createdAt: now, updatedAt: now,
    claim: { id: "receipt", ownerId: "gemini", previousOwnerId: "user", claimedAt: now } };
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const runner = () => new TaskRunner({ task, store: engine.getStore() as unknown as TaskStore });
const roles = (value: TaskRunner) => value as unknown as { developerId: string; reviewerId: string };

it("selects the Gemini claimant with independent Codex reviewer without starting providers", () => {
  expect(roles(runner())).toMatchObject({ developerId: "gemini", reviewerId: "codex" });
});
it("selects the Codex claimant with independent Gemini reviewer", () => {
  task.ownerId = "codex"; task.claim!.ownerId = "codex"; task.reviewerId = "gemini";
  expect(roles(runner())).toMatchObject({ developerId: "codex", reviewerId: "gemini" });
});
it.each([undefined, "gemini", "user"])("rejects missing, same or unsupported reviewer %s", reviewer => {
  task.reviewerId = reviewer;
  expect(runner).toThrow("explicit independent reviewer");
});
it("rejects ownership changed since claim", () => {
  task.ownerId = "codex";
  expect(runner).toThrow("matching its current owner");
});
it("rejects unsupported claimant", () => {
  task.ownerId = "other"; task.claim!.ownerId = "other";
  expect(runner).toThrow("supported claimant");
});
it.each(["REVIEW", "DONE"] as const)("preserves claimant routing after normal %s handoff", status => {
  task.status = status; task.ownerId = "codex";
  expect(roles(runner())).toMatchObject({ developerId: "gemini", reviewerId: "codex" });
});
it("accepts NEED_USER human ownership without replacing the claimant", () => {
  task.status = "NEED_USER"; task.ownerId = "user";
  expect(roles(runner())).toMatchObject({ developerId: "gemini", reviewerId: "codex" });
});
it("rejects an unexpected owner at reviewer handoff", () => {
  task.status = "REVIEW"; task.ownerId = "gemini";
  expect(runner).toThrow("lifecycle ownership");
});
it("preserves legacy reviewer-derived selection for unclaimed tasks", () => {
  delete task.claim; delete task.reviewerId;
  expect(roles(runner())).toMatchObject({ developerId: "codex", reviewerId: "gemini" });
});
it("invalid dispatch does not leak a concurrency slot or overwrite ownership", async () => {
  task.reviewerId = "gemini";
  await engine.getStore().saveTask(task);
  await expect(engine.runTask(task.id)).rejects.toThrow("independent reviewer");
  const state = engine as unknown as { runningTaskCount: number; activeRunners: Map<string, unknown> };
  expect(state.runningTaskCount).toBe(0);
  expect(state.activeRunners.size).toBe(0);
  expect((await engine.getTask(task.id)).ownerId).toBe("gemini");
});
