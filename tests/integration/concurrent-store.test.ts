import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ProjectStore } from "../../src/projects/project-store.js";
import { ProjectEngine } from "../../src/projects/project-engine.js";
import { Task } from "../../src/tasks/task.js";
import { createTaskEvent } from "../../src/tasks/task-events.js";

describe("Concurrent Store Safety & Atomic Persistence Integration Tests", () => {
  let testDirs: string[] = [];

  function getTestDir(): string {
    const d = path.resolve(process.cwd(), `logs/concurrent-test-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(d, { recursive: true });
    testDirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of testDirs) {
      if (fs.existsSync(d)) {
        try {
          fs.rmSync(d, { recursive: true, force: true });
        } catch {}
      }
    }
    testDirs = [];
  });

  it("rejects stale concurrent updates without silently losing accepted writes", async () => {
    const baseDir = getTestDir();
    const store = new ProjectStore(baseDir);

    const taskId = "TASK-CONCURRENT-50";
    const initialTask: Task = {
      id: taskId,
      projectId: "proj-1",
      title: "Concurrent Task",
      description: "Testing concurrent atomic writes",
      status: "DOING",
      owner: "codex",
      ownerType: "AGENT",
      ownerId: "codex",
      priority: "HIGH",
      workspace: baseDir,
      maxRounds: 6,
      currentRound: 0,
      progress: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await store.saveTask(initialTask);

    const snapshots = await Promise.all(Array.from({ length: 50 }, () => store.getTask(taskId)));
    const updatePromises = snapshots.map(async (task, i) => {
      // Simulate reading and updating progress
      expect(task).not.toBeNull();
      task!.currentRound = i + 1;
      task!.progress = i + 1;
      task!.description = `Update iteration ${i + 1}`;
      task!.updatedAt = new Date().toISOString();
      await store.saveTask(task!);
    });

    const results = await Promise.allSettled(updatePromises);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(result => result.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(49);
    expect(rejected.every(result => result.reason.code === "CONFLICT")).toBe(true);

    // Verify task file exists and parses as valid JSON with no truncation or corruption
    const finalTask = await store.getTask(taskId);
    expect(finalTask).not.toBeNull();
    expect(finalTask!.id).toBe(taskId);
    expect(finalTask!.revision).toBe(2);
    expect(finalTask!.currentRound).toBeGreaterThan(0);
    expect(finalTask!.currentRound).toBeLessThanOrEqual(50);

    // Verify raw file is 100% valid JSON
    const rawContent = fs.readFileSync(path.join(baseDir, `data/tasks/${taskId}.json`), "utf-8");
    const parsed = JSON.parse(rawContent);
    expect(parsed.id).toBe(taskId);
  });

  it("handles 100 concurrent event appends without any event loss or corrupt lines", async () => {
    const baseDir = getTestDir();
    const store = new ProjectStore(baseDir);

    const taskId = "TASK-EVENT-100";

    // Launch 100 concurrent appendTaskEvent calls
    const appendPromises = Array.from({ length: 100 }, async (_, i) => {
      const event = createTaskEvent(taskId, "STATUS_CHANGED", "test-actor", {
        seq: i,
        randomToken: crypto.randomBytes(8).toString("hex"),
      });
      await store.appendTaskEvent(event);
    });

    await Promise.all(appendPromises);

    // Verify exactly 100 events were recorded
    const events = await store.getTaskEvents(taskId);
    expect(events.length).toBe(100);

    // Verify each event has correct structure and seq is unique
    const seqs = new Set(events.map((e) => (e.details as any).seq));
    expect(seqs.size).toBe(100);

    // Verify raw file lines
    const rawLines = fs
      .readFileSync(path.join(baseDir, `logs/tasks/${taskId}.jsonl`), "utf-8")
      .trim()
      .split("\n");
    expect(rawLines.length).toBe(100);

    // Every line must parse cleanly
    for (const line of rawLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("prevents project progress regression / overwrite under concurrent task completion", async () => {
    const baseDir = getTestDir();
    const engine = new ProjectEngine({ baseDir });

    const projectId = "PROJ-CONCURRENT-PROGRESS";
    await engine.createProject({
      id: projectId,
      name: "Concurrent Progress Project",
      workspace: baseDir,
    });

    // Create 10 tasks under the project
    const taskIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const task = await engine.createTask({
        id: `TASK-PROG-${i}`,
        projectId,
        title: `Task ${i}`,
        description: `Task ${i}`,
        workspace: baseDir,
        ownerType: "HUMAN",
        ownerId: "user",
      });
      taskIds.push(task.id);
    }

    // Simultaneously complete all 10 tasks concurrently
    await Promise.all(
      taskIds.map(async (tid, idx) => {
        await engine.completeHumanTask(tid, "user", `Done ${idx}`);
      })
    );

    // Refresh progress and check final state
    const finalProgress = await engine.refreshProjectProgress(projectId);
    expect(finalProgress).toBe(100);

    const project = await engine.getProject(projectId);
    expect(project?.progress).toBe(100);
    expect(project?.status).toBe("DONE");
  });
});
