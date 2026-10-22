import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectEngine } from "../../src/projects/project-engine.js";
import { TaskClaimError } from "../../src/tasks/task-claim.js";
import type { Task } from "../../src/tasks/task.js";

describe("Claim identifier validation boundary regression", () => {
  let root: string;
  let engine: ProjectEngine;
  let baseTask: Task;

  const fixture = (overrides: Partial<Task> = {}): Task => {
    const now = new Date().toISOString();
    return {
      id: "task-1",
      projectId: "project-1",
      title: "Claim validation test",
      description: "Validation boundary test",
      status: "TODO",
      owner: "user",
      ownerId: "user",
      ownerType: "HUMAN",
      priority: "LOW",
      workspace: root,
      maxRounds: 1,
      currentRound: 0,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "claim-val-tests-"));
    engine = new ProjectEngine({ baseDir: root });
    baseTask = fixture();
    await engine.getStore().saveTask(baseTask);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  describe("accepted 128-character identifiers", () => {
    it("accepts 128-character taskId, new ownerId, and expectedOwnerId simultaneously", async () => {
      const taskId128 = "T" + "k".repeat(127);
      const expectedOwner128 = "E" + "o".repeat(127);
      const newOwner128 = "N" + "o".repeat(127);

      expect(taskId128).toHaveLength(128);
      expect(expectedOwner128).toHaveLength(128);
      expect(newOwner128).toHaveLength(128);

      const task128 = fixture({
        id: taskId128,
        ownerId: expectedOwner128,
        owner: expectedOwner128 as any,
      });
      await engine.getStore().saveTask(task128);

      const claimed = await engine.claimTask(taskId128, {
        ownerId: newOwner128,
        expectedOwnerId: expectedOwner128,
      });

      // claimTask returns Task contract
      expect(claimed.id).toBe(taskId128);
      expect(claimed.ownerId).toBe(newOwner128);
      expect(claimed.owner).toBe(newOwner128);
      expect(claimed.ownerType).toBe("AGENT");
      expect(claimed.status).toBe("TODO");
      expect(claimed.nextAction).toBe(`Claimed by ${newOwner128}; waiting for explicit dispatch`);

      // Persisted receipt contract: receipt is task.claim, dates are ISO strings
      expect(claimed.claim).toBeDefined();
      expect(claimed.claim?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(claimed.claim?.ownerId).toBe(newOwner128);
      expect(claimed.claim?.previousOwnerId).toBe(expectedOwner128);
      expect(Number.isNaN(Date.parse(claimed.claim!.claimedAt))).toBe(false);
      expect(new Date(claimed.claim!.claimedAt).toISOString()).toBe(claimed.claim!.claimedAt);
      expect(claimed.updatedAt).toBe(claimed.claim!.claimedAt);

      // Verify persisted state from fresh engine/store instance
      const persisted = await new ProjectEngine({ baseDir: root }).getTask(taskId128);
      expect(persisted).toEqual(claimed);
      expect(persisted?.ownerId).toBe(newOwner128);
      expect(persisted?.claim).toEqual(claimed.claim);
    });

    it("accepts 128-character taskId with standard owner IDs", async () => {
      const taskId128 = "A" + "b".repeat(127);
      expect(taskId128).toHaveLength(128);

      const customTask = fixture({ id: taskId128, ownerId: "user" });
      await engine.getStore().saveTask(customTask);

      const claimed = await engine.claimTask(taskId128, {
        ownerId: "gemini",
        expectedOwnerId: "user",
      });

      expect(claimed.id).toBe(taskId128);
      expect(claimed.ownerId).toBe("gemini");
      expect(claimed.claim).toMatchObject({
        ownerId: "gemini",
        previousOwnerId: "user",
      });

      const persisted = await new ProjectEngine({ baseDir: root }).getTask(taskId128);
      expect(persisted).toEqual(claimed);
      expect(persisted?.ownerId).toBe("gemini");
      expect(persisted?.claim).toEqual(claimed.claim);
    });

    it("accepts 128-character new ownerId", async () => {
      const newOwner128 = "G" + "m".repeat(127);
      expect(newOwner128).toHaveLength(128);

      const claimed = await engine.claimTask("task-1", {
        ownerId: newOwner128,
        expectedOwnerId: "user",
      });

      expect(claimed.id).toBe("task-1");
      expect(claimed.ownerId).toBe(newOwner128);
      expect(claimed.claim).toMatchObject({
        ownerId: newOwner128,
        previousOwnerId: "user",
      });

      const persisted = await new ProjectEngine({ baseDir: root }).getTask("task-1");
      expect(persisted).toEqual(claimed);
      expect(persisted?.ownerId).toBe(newOwner128);
      expect(persisted?.claim).toEqual(claimed.claim);
    });

    it("accepts 128-character expectedOwnerId", async () => {
      const expectedOwner128 = "U" + "s".repeat(127);
      expect(expectedOwner128).toHaveLength(128);

      const taskWithExpected = fixture({
        id: "task-1",
        revision: baseTask.revision,
        ownerId: expectedOwner128,
        owner: expectedOwner128 as any,
      });
      await engine.getStore().saveTask(taskWithExpected);

      const claimed = await engine.claimTask("task-1", {
        ownerId: "gemini",
        expectedOwnerId: expectedOwner128,
      });

      expect(claimed.id).toBe("task-1");
      expect(claimed.ownerId).toBe("gemini");
      expect(claimed.claim).toMatchObject({
        ownerId: "gemini",
        previousOwnerId: expectedOwner128,
      });

      const persisted = await new ProjectEngine({ baseDir: root }).getTask("task-1");
      expect(persisted).toEqual(claimed);
      expect(persisted?.ownerId).toBe("gemini");
      expect(persisted?.claim).toEqual(claimed.claim);
    });
  });

  describe("rejected 129-character values for each identifier", () => {
    it("rejects 129-character taskId and leaves durable task unchanged", async () => {
      const taskId129 = "T" + "k".repeat(128);
      expect(taskId129).toHaveLength(129);

      const task129 = fixture({ id: taskId129, ownerId: "user" });
      await expect(engine.getStore().saveTask(task129)).rejects.toMatchObject({ code: "INVALID_INPUT" });

      await expect(
        engine.claimTask(taskId129, { ownerId: "gemini", expectedOwnerId: "user" })
      ).rejects.toMatchObject({
        name: "TaskClaimError",
        code: "INVALID_CLAIM",
        statusCode: 400,
      });

      await expect(fs.access(path.join(root, "data/tasks", `${taskId129}.json`))).rejects.toMatchObject({ code: "ENOENT" });

      const persistedBase = await engine.getTask("task-1");
      expect(persistedBase).toEqual(baseTask);
      expect(persistedBase?.claim).toBeUndefined();
      expect(persistedBase?.ownerId).toBe("user");
    });

    it("rejects 129-character new ownerId and leaves durable task unchanged", async () => {
      const newOwner129 = "N" + "o".repeat(128);
      expect(newOwner129).toHaveLength(129);

      await expect(
        engine.claimTask("task-1", { ownerId: newOwner129, expectedOwnerId: "user" })
      ).rejects.toMatchObject({
        name: "TaskClaimError",
        code: "INVALID_CLAIM",
        statusCode: 400,
      });

      const persisted = await engine.getTask("task-1");
      expect(persisted).toEqual(baseTask);
      expect(persisted?.claim).toBeUndefined();
      expect(persisted?.ownerId).toBe("user");
    });

    it("rejects 129-character expectedOwnerId and leaves durable task unchanged", async () => {
      const expectedOwner129 = "E" + "o".repeat(128);
      expect(expectedOwner129).toHaveLength(129);

      await expect(
        engine.claimTask("task-1", { ownerId: "gemini", expectedOwnerId: expectedOwner129 })
      ).rejects.toMatchObject({
        name: "TaskClaimError",
        code: "INVALID_CLAIM",
        statusCode: 400,
      });

      const persisted = await engine.getTask("task-1");
      expect(persisted).toEqual(baseTask);
      expect(persisted?.claim).toBeUndefined();
      expect(persisted?.ownerId).toBe("user");
    });
  });

  describe("empty expectedOwnerId", () => {
    it("rejects empty string expectedOwnerId and leaves durable task unchanged", async () => {
      await expect(
        engine.claimTask("task-1", { ownerId: "gemini", expectedOwnerId: "" })
      ).rejects.toMatchObject({
        name: "TaskClaimError",
        code: "INVALID_CLAIM",
        statusCode: 400,
      });

      const persisted = await engine.getTask("task-1");
      expect(persisted).toEqual(baseTask);
      expect(persisted?.claim).toBeUndefined();
      expect(persisted?.ownerId).toBe("user");
    });
  });

  describe("identical new and expected owner", () => {
    it("rejects when new owner matches expected owner identical to current task owner", async () => {
      await expect(
        engine.claimTask("task-1", { ownerId: "user", expectedOwnerId: "user" })
      ).rejects.toMatchObject({
        name: "TaskClaimError",
        code: "INVALID_CLAIM",
        statusCode: 400,
      });

      const persisted = await engine.getTask("task-1");
      expect(persisted).toEqual(baseTask);
      expect(persisted?.claim).toBeUndefined();
      expect(persisted?.ownerId).toBe("user");
    });

    it("rejects when new owner matches expected owner for non-current actor", async () => {
      await expect(
        engine.claimTask("task-1", { ownerId: "gemini", expectedOwnerId: "gemini" })
      ).rejects.toMatchObject({
        name: "TaskClaimError",
        code: "INVALID_CLAIM",
        statusCode: 400,
      });

      const persisted = await engine.getTask("task-1");
      expect(persisted).toEqual(baseTask);
      expect(persisted?.claim).toBeUndefined();
      expect(persisted?.ownerId).toBe("user");
    });
  });

  describe("malformed taskId", () => {
    const malformedTaskIds: Array<{ label: string; id: any }> = [
      { label: "empty string", id: "" },
      { label: "leading hyphen", id: "-task-1" },
      { label: "leading dot", id: ".task-1" },
      { label: "leading underscore", id: "_task-1" },
      { label: "spaces", id: "task 1" },
      { label: "slash", id: "task/1" },
      { label: "path traversal", id: "../task-1" },
      { label: "special symbol @", id: "task@1" },
      { label: "special symbol #", id: "task#1" },
      { label: "special symbol $", id: "task$1" },
      { label: "colon", id: "task:1" },
      { label: "null value", id: null },
      { label: "undefined value", id: undefined },
    ];

    for (const { label, id } of malformedTaskIds) {
      it(`rejects malformed taskId (${label}) and leaves durable task unchanged`, async () => {
        await expect(
          engine.claimTask(id, { ownerId: "gemini", expectedOwnerId: "user" })
        ).rejects.toMatchObject({
          name: "TaskClaimError",
          code: "INVALID_CLAIM",
          statusCode: 400,
        });

        const persisted = await engine.getTask("task-1");
        expect(persisted).toEqual(baseTask);
        expect(persisted?.claim).toBeUndefined();
        expect(persisted?.ownerId).toBe("user");
      });
    }
  });
});
