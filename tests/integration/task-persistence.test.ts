import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TaskEngine } from "../../src/tasks/task-engine.js";

describe("Task Persistence Integration Tests", () => {
  let tempBaseDir: string;

  beforeEach(() => {
    tempBaseDir = path.join(os.tmpdir(), `agenthub-persistence-${Date.now()}`);
    fs.mkdirSync(tempBaseDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempBaseDir)) {
      try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("persists tasks and projects across TaskEngine restarts", async () => {
    // Session 1: Create tasks and project
    const engine1 = new TaskEngine({ baseDir: tempBaseDir });

    const project = await engine1.createProject({
      id: "PROJ-PERSIST-1",
      name: "Persistence Project",
      workspace: "/dummy/workspace",
    });

    const task1 = await engine1.createTask({
      id: "TASK-PERSIST-101",
      projectId: project.id,
      title: "Task 1",
      description: "First persistent task",
      workspace: "/dummy/workspace",
    });

    const task2 = await engine1.createTask({
      id: "TASK-PERSIST-102",
      projectId: project.id,
      parentTaskId: task1.id,
      title: "Task 2 (Child)",
      description: "Child persistent task",
      workspace: "/dummy/workspace",
    });

    // Session 2: Fresh instance pointing to same storage baseDir
    const engine2 = new TaskEngine({ baseDir: tempBaseDir });

    const reloadedProject = await engine2.getProject("PROJ-PERSIST-1");
    expect(reloadedProject).not.toBeNull();
    expect(reloadedProject.name).toBe("Persistence Project");

    const reloadedTask1 = await engine2.getTask("TASK-PERSIST-101");
    expect(reloadedTask1.title).toBe("Task 1");

    const reloadedTask2 = await engine2.getTask("TASK-PERSIST-102");
    expect(reloadedTask2.parentTaskId).toBe("TASK-PERSIST-101");

    const tree = await engine2.getStore().getTree("TASK-PERSIST-102");
    expect(tree.parent?.id).toBe("TASK-PERSIST-101");
    expect(tree.root?.id).toBe("TASK-PERSIST-101");

    // Events persisted
    const events = await engine2.getStore().getEvents("TASK-PERSIST-101");
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe("TASK_CREATED");
  });
});
