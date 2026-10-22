import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectEngine } from "../../src/projects/project-engine.js";

describe("Project & Epic Progress Flow Integration Tests", () => {
  let tempBaseDir: string;
  let engine: ProjectEngine;

  beforeEach(() => {
    tempBaseDir = path.join(os.tmpdir(), `agenthub-prog-base-${Date.now()}`);
    fs.mkdirSync(tempBaseDir, { recursive: true });
    engine = new ProjectEngine({ baseDir: tempBaseDir });
  });

  afterEach(() => {
    if (fs.existsSync(tempBaseDir)) {
      try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("dynamically recalculates Epic and Project progress based on task states and weights", async () => {
    // 1. Create project
    const project = await engine.createProject({
      name: "Progress Project",
      workspace: "/tmp",
    });
    expect(project.progress).toBe(0);

    // 2. Create Epic
    const epic = await engine.createEpic({
      projectId: project.id,
      title: "Epic 1",
    });
    expect(epic.progress).toBe(0);

    // 3. Create 3 Human tasks under this Epic
    const task1 = await engine.createTask({
      projectId: project.id,
      epicId: epic.id,
      title: "Task 1",
      description: "D1",
      ownerType: "HUMAN",
      estimatedWeight: 1,
    });

    const task2 = await engine.createTask({
      projectId: project.id,
      epicId: epic.id,
      title: "Task 2",
      description: "D2",
      ownerType: "HUMAN",
      estimatedWeight: 1,
    });

    const task3 = await engine.createTask({
      projectId: project.id,
      epicId: epic.id,
      title: "Task 3",
      description: "D3",
      ownerType: "HUMAN",
      estimatedWeight: 1,
    });

    // Initial: 3 tasks in TODO (0, 0, 0) -> 0%
    let updatedProj = await engine.getProject(project.id);
    let updatedEpic = await engine.getEpic(epic.id);
    expect(updatedProj?.progress).toBe(0);
    expect(updatedEpic?.progress).toBe(0);

    // Human starts Task 1: TODO -> DOING (30%)
    // (30 + 0 + 0) / 3 = 10%
    await engine.startHumanTask(task1.id);
    updatedProj = await engine.getProject(project.id);
    updatedEpic = await engine.getEpic(epic.id);
    expect(updatedEpic?.progress).toBe(10);
    expect(updatedProj?.progress).toBe(10);

    // Human completes Task 1: DOING -> DONE (100%)
    // (100 + 0 + 0) / 3 = 33%
    await engine.completeHumanTask(task1.id);
    updatedProj = await engine.getProject(project.id);
    updatedEpic = await engine.getEpic(epic.id);
    expect(updatedEpic?.progress).toBe(33);
    expect(updatedProj?.progress).toBe(33);

    // Human starts and completes Task 2: (100 + 100 + 0) / 3 = 67%
    await engine.startHumanTask(task2.id);
    await engine.completeHumanTask(task2.id);
    updatedProj = await engine.getProject(project.id);
    expect(updatedProj?.progress).toBe(67);

    // Human completes Task 3: (100 + 100 + 100) / 3 = 100%
    await engine.startHumanTask(task3.id);
    await engine.completeHumanTask(task3.id);
    updatedProj = await engine.getProject(project.id);
    updatedEpic = await engine.getEpic(epic.id);
    expect(updatedEpic?.progress).toBe(100);
    expect(updatedEpic?.status).toBe("DONE");
    expect(updatedProj?.progress).toBe(100);
    expect(updatedProj?.status).toBe("DONE");
  });
});
