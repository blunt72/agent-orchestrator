import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectEngine } from "../../src/projects/project-engine.js";
import type { Task } from "../../src/tasks/task.js";

// Gemini-generated scenarios; Codex corrected return types and fixture contracts.
describe("Task claim with real filesystem storage", () => {
  let root: string;
  let engine: ProjectEngine;
  const fixture = (overrides: Partial<Task> = {}): Task => {
    const now = new Date().toISOString();
    return { id: "task-1", projectId: "project-1", title: "Claim test",
      description: "", status: "TODO", owner: "user", ownerId: "user",
      ownerType: "HUMAN", priority: "LOW", workspace: root,
      maxRounds: 1, currentRound: 0, createdAt: now, updatedAt: now, ...overrides };
  };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "claim-tests-"));
    engine = new ProjectEngine({ baseDir: root });
    await engine.getStore().saveTask(fixture());
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("persists a UUID receipt and leaves status TODO", async () => {
    const task = await engine.claimTask("task-1", { ownerId: "gemini", expectedOwnerId: "user" });
    expect(task.claim?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(task.claim).toMatchObject({ ownerId: "gemini", previousOwnerId: "user" });
    expect(Number.isNaN(Date.parse(task.claim!.claimedAt))).toBe(false);
    expect(task.status).toBe("TODO");
    expect(await new ProjectEngine({ baseDir: root }).getTask("task-1")).toEqual(task);
  });
  it("rejects wrong owner and non-TODO without changing ownership", async () => {
    await expect(engine.claimTask("task-1", { ownerId: "gemini", expectedOwnerId: "codex" }))
      .rejects.toMatchObject({ code: "CLAIM_CONFLICT", statusCode: 409 });
    await engine.getStore().saveTask({ ...(await engine.getTask("task-1"))!, status: "DOING" });
    await expect(engine.claimTask("task-1", { ownerId: "gemini", expectedOwnerId: "user" }))
      .rejects.toMatchObject({ code: "CLAIM_CONFLICT", statusCode: 409 });
    expect((await engine.getTask("task-1"))?.ownerId).toBe("user");
  });
  it("returns missing-task 404", async () => {
    await expect(engine.claimTask("missing", { ownerId: "gemini", expectedOwnerId: "user" }))
      .rejects.toMatchObject({ code: "TASK_NOT_FOUND", statusCode: 404 });
  });
  it("rejects unsafe identifiers", async () => {
    await expect(engine.claimTask("task-1", { ownerId: "../bad", expectedOwnerId: "user" }))
      .rejects.toMatchObject({ code: "INVALID_CLAIM", statusCode: 400 });
  });
  it("allows exactly one competing engine to claim", async () => {
    const other = new ProjectEngine({ baseDir: root });
    const results = await Promise.allSettled([
      engine.claimTask("task-1", { ownerId: "gemini", expectedOwnerId: "user" }),
      other.claimTask("task-1", { ownerId: "codex", expectedOwnerId: "user" }),
    ]);
    const winners = results.filter(result => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    const loser = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(["CLAIM_BUSY", "CLAIM_CONFLICT"]).toContain(loser.reason.code);
    expect((await engine.getTask("task-1"))?.ownerId).toBe(winners[0].value.ownerId);
  });
  it("releases the lock after a failed callback", async () => {
    await expect(engine.getStore().runTaskClaimExclusive("task-1", async () => { throw new Error("callback failed"); }))
      .rejects.toThrow("callback failed");
    await expect(engine.claimTask("task-1", { ownerId: "gemini", expectedOwnerId: "user" }))
      .resolves.toMatchObject({ ownerId: "gemini" });
  });
  it("preserves administrative reassignment", async () => {
    await engine.assignTask("task-1", { ownerId: "gemini" });
    await engine.assignTask("task-1", { ownerId: "codex" });
    expect((await engine.getTask("task-1"))?.ownerId).toBe("codex");
  });
  it("does not steal a held lock and allows independent task locks", async () => {
    await engine.getStore().runTaskClaimExclusive("task-1", async () => {
      const other = new ProjectEngine({ baseDir: root });
      await expect(other.claimTask("task-1", { ownerId: "gemini", expectedOwnerId: "user" }))
        .rejects.toMatchObject({ code: "CLAIM_BUSY" });
      await expect(other.getStore().runTaskClaimExclusive("other-task", async () => "ok")).resolves.toBe("ok");
      await expect(other.claimTask("task-1", { ownerId: "codex", expectedOwnerId: "user" }))
        .rejects.toMatchObject({ code: "CLAIM_BUSY" });
    });
  });
});
