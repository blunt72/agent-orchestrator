import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectStore } from "../../src/projects/project-store.js";
import { Project } from "../../src/models/project.js";
import { Task } from "../../src/tasks/task.js";
import { Epic } from "../../src/models/epic.js";

describe("ProjectStore Unit Tests", () => {
  let tempDir: string;
  let store: ProjectStore;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `agenthub-proj-store-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    store = new ProjectStore(tempDir);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("saves and retrieves projects with updated progress and status", async () => {
    const project: Project = {
      id: "PROJ-101",
      name: "Demo Platform",
      description: "Automated demo testing platform",
      workspace: "/test/demo",
      status: "ACTIVE",
      progress: 35,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await store.saveProject(project);
    const retrieved = await store.getProject("PROJ-101");

    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe("PROJ-101");
    expect(retrieved?.name).toBe("Demo Platform");
    expect(retrieved?.status).toBe("ACTIVE");
    expect(retrieved?.progress).toBe(35);
  });

  it("extracts complete ancestor chain and root task", async () => {
    // TASK-ROOT -> TASK-CHILD -> TASK-SUBCHILD
    const rootTask: Task = {
      id: "TASK-ROOT",
      projectId: "PROJ-101",
      title: "Root Task",
      description: "Root",
      status: "DOING",
      owner: "codex",
      ownerType: "AGENT",
      ownerId: "codex",
      priority: "HIGH",
      workspace: "/tmp",
      maxRounds: 6,
      currentRound: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const childTask: Task = {
      ...rootTask,
      id: "TASK-CHILD",
      parentTaskId: "TASK-ROOT",
      title: "Child Task",
    };

    const subchildTask: Task = {
      ...rootTask,
      id: "TASK-SUBCHILD",
      parentTaskId: "TASK-CHILD",
      title: "Subchild Task",
    };

    await store.saveTask(rootTask);
    await store.saveTask(childTask);
    await store.saveTask(subchildTask);

    const ancestors = await store.getAncestors("TASK-SUBCHILD");
    expect(ancestors.map((a) => a.id)).toEqual(["TASK-CHILD", "TASK-ROOT"]);

    const root = await store.getRootTask("TASK-SUBCHILD");
    expect(root?.id).toBe("TASK-ROOT");

    const descendants = await store.getDescendants("TASK-ROOT");
    expect(descendants.map((d) => d.id)).toContain("TASK-CHILD");
    expect(descendants.map((d) => d.id)).toContain("TASK-SUBCHILD");
  });

  it("builds a hierarchical project tree with Epics and Tasks", async () => {
    const project: Project = {
      id: "P1",
      name: "Demo Project",
      status: "ACTIVE",
      progress: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.saveProject(project);

    const epic: Epic = {
      id: "EPIC-LOGIN",
      projectId: "P1",
      title: "Login Module",
      status: "DOING",
      progress: 50,
      priority: "HIGH",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.saveEpic(epic);

    const task1: Task = {
      id: "T1",
      projectId: "P1",
      epicId: "EPIC-LOGIN",
      title: "T1",
      description: "Desc",
      status: "DOING",
      owner: "codex",
      ownerType: "AGENT",
      ownerId: "codex",
      priority: "MEDIUM",
      workspace: "/tmp",
      maxRounds: 6,
      currentRound: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const subtask: Task = {
      ...task1,
      id: "T1-SUB",
      parentTaskId: "T1",
      title: "Subtask",
    };

    await store.saveTask(task1);
    await store.saveTask(subtask);

    const tree = await store.getProjectTree("P1");
    expect(tree).not.toBeNull();
    expect(tree?.project.id).toBe("P1");
    expect(tree?.epics.length).toBe(1);
    expect(tree?.epics[0].epic.id).toBe("EPIC-LOGIN");
    expect(tree?.epics[0].tasks.length).toBe(1);
    expect(tree?.epics[0].tasks[0].task.id).toBe("T1");
    expect(tree?.epics[0].tasks[0].children.length).toBe(1);
    expect(tree?.epics[0].tasks[0].children[0].task.id).toBe("T1-SUB");
  });

  it("retrieves full task traceability per Section 二十二", async () => {
    const task: Task = {
      id: "TASK-TRACE",
      projectId: "P1",
      title: "Traceable Task",
      description: "Must trace properly",
      status: "DONE",
      owner: "gemini",
      ownerType: "AGENT",
      ownerId: "gemini",
      priority: "MEDIUM",
      workspace: "/tmp",
      maxRounds: 6,
      currentRound: 2,
      result: {
        status: "PASS",
        summary: "Done cleanly",
        changedFiles: ["src/auth.ts"],
        testStatus: "PASS",
        reviewStatus: "PASS",
        rounds: 2,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.saveTask(task);

    const trace = await store.getTraceability("TASK-TRACE");
    expect(trace).not.toBeNull();
    expect(trace?.taskId).toBe("TASK-TRACE");
    expect(trace?.originalRequirement).toBe("Must trace properly");
    expect(trace?.changedFiles).toEqual(["src/auth.ts"]);
  });
});
