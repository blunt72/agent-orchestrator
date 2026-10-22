import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TaskStore } from "../../src/tasks/task-store.js";
import { Task } from "../../src/tasks/task.js";
import { createTaskEvent } from "../../src/tasks/task-events.js";

describe("TaskStore Unit Tests", () => {
  let tempDir: string;
  let store: TaskStore;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `agenthub-store-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    store = new TaskStore(tempDir);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("saves and retrieves a task", async () => {
    const task: Task = {
      id: "TASK-TEST-001",
      projectId: "proj-1",
      title: "Test Task 1",
      description: "Description for test task",
      status: "TODO",
      owner: "user",
      priority: "HIGH",
      workspace: "/test/workspace",
      maxRounds: 6,
      currentRound: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await store.saveTask(task);
    const retrieved = await store.getTask("TASK-TEST-001");

    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe("TASK-TEST-001");
    expect(retrieved?.title).toBe("Test Task 1");
    expect(retrieved?.priority).toBe("HIGH");
  });

  it("lists tasks and supports filtering by projectId and status", async () => {
    const base: Omit<Task, "id" | "projectId" | "status"> = {
      title: "Sample",
      description: "Sample",
      owner: "user",
      priority: "MEDIUM",
      workspace: "/test",
      maxRounds: 6,
      currentRound: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await store.saveTask({ ...base, id: "T1", projectId: "p1", status: "TODO" });
    await store.saveTask({ ...base, id: "T2", projectId: "p1", status: "DOING" });
    await store.saveTask({ ...base, id: "T3", projectId: "p2", status: "DONE" });

    const all = await store.listTasks();
    expect(all.length).toBe(3);

    const p1Tasks = await store.listTasks({ projectId: "p1" });
    expect(p1Tasks.length).toBe(2);

    const doingTasks = await store.listTasks({ status: "DOING" });
    expect(doingTasks.length).toBe(1);
    expect(doingTasks[0].id).toBe("T2");
  });

  it("records and streams task events in JSONL format", async () => {
    const ev1 = createTaskEvent("TASK-EV-1", "TASK_CREATED", "user", { title: "New Task" });
    const ev2 = createTaskEvent("TASK-EV-1", "TASK_STARTED", "system");
    const ev3 = createTaskEvent("TASK-EV-1", "AGENT_STARTED", "codex", { round: 1 });

    await store.appendEvent(ev1);
    await store.appendEvent(ev2);
    await store.appendEvent(ev3);

    const events = await store.getEvents("TASK-EV-1");
    expect(events.length).toBe(3);
    expect(events[0].type).toBe("TASK_CREATED");
    expect(events[1].type).toBe("TASK_STARTED");
    expect(events[2].actor).toBe("codex");
  });

  it("correctly traces task hierarchy: parent, children, root, and tree", async () => {
    const base: Omit<Task, "id" | "parentTaskId"> = {
      projectId: "proj-1",
      title: "Hierarchy Test",
      description: "Desc",
      status: "TODO",
      owner: "user",
      priority: "MEDIUM",
      workspace: "/test",
      maxRounds: 6,
      currentRound: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // EPIC-1 -> TASK-10 -> SUB-101
    await store.saveTask({ ...base, id: "EPIC-1" });
    await store.saveTask({ ...base, id: "TASK-10", parentTaskId: "EPIC-1" });
    await store.saveTask({ ...base, id: "SUB-101", parentTaskId: "TASK-10" });
    await store.saveTask({ ...base, id: "SUB-102", parentTaskId: "TASK-10" });

    const parentOfSub = await store.getParent("SUB-101");
    expect(parentOfSub?.id).toBe("TASK-10");

    const childrenOfTask = await store.getChildren("TASK-10");
    expect(childrenOfTask.length).toBe(2);
    expect(childrenOfTask.map((c) => c.id).sort()).toEqual(["SUB-101", "SUB-102"]);

    const rootOfSub = await store.getRootTask("SUB-101");
    expect(rootOfSub?.id).toBe("EPIC-1");

    const tree = await store.getTree("TASK-10");
    expect(tree.task?.id).toBe("TASK-10");
    expect(tree.parent?.id).toBe("EPIC-1");
    expect(tree.root?.id).toBe("EPIC-1");
    expect(tree.children.length).toBe(2);
  });
});
