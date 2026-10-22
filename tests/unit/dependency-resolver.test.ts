import { describe, it, expect } from "vitest";
import { DependencyResolver } from "../../src/projects/dependency-resolver.js";
import { Task } from "../../src/tasks/task.js";

function makeTask(id: string, status: Task["status"], dependsOn?: string[]): Task {
  return {
    id,
    projectId: "p1",
    title: `Task ${id}`,
    description: "",
    status,
    owner: "codex",
    ownerType: "AGENT",
    ownerId: "codex",
    priority: "MEDIUM",
    workspace: "/tmp",
    maxRounds: 6,
    currentRound: 0,
    dependsOn,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("DependencyResolver Unit Tests", () => {
  it("determines active blockers when dependent tasks are not DONE", () => {
    const taskA = makeTask("TASK-A", "DOING");
    const taskB = makeTask("TASK-B", "BLOCKED", ["TASK-A"]);

    const blockers = DependencyResolver.getActiveBlockers(taskB, [taskA, taskB]);
    expect(blockers).toEqual(["TASK-A"]);
    expect(DependencyResolver.isBlocked(taskB, [taskA, taskB])).toBe(true);
  });

  it("determines that a task is not blocked if all dependencies are DONE", () => {
    const taskA = makeTask("TASK-A", "DONE");
    const taskB = makeTask("TASK-B", "TODO", ["TASK-A"]);

    const blockers = DependencyResolver.getActiveBlockers(taskB, [taskA, taskB]);
    expect(blockers).toEqual([]);
    expect(DependencyResolver.isBlocked(taskB, [taskA, taskB])).toBe(false);
  });

  it("detects circular dependency cycles", () => {
    const taskA = makeTask("TASK-A", "BLOCKED", ["TASK-B"]);
    const taskB = makeTask("TASK-B", "BLOCKED", ["TASK-A"]);

    const cycle = DependencyResolver.findCycle([taskA, taskB]);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("TASK-A");
    expect(cycle).toContain("TASK-B");
  });

  it("returns null when no cycles exist", () => {
    const taskA = makeTask("TASK-A", "DONE");
    const taskB = makeTask("TASK-B", "BLOCKED", ["TASK-A"]);
    const taskC = makeTask("TASK-C", "BLOCKED", ["TASK-B"]);

    expect(DependencyResolver.findCycle([taskA, taskB, taskC])).toBeNull();
  });

  it("finds unblockable tasks when a blocker task completes", () => {
    const taskA = makeTask("TASK-A", "DONE");
    const taskB = makeTask("TASK-B", "BLOCKED", ["TASK-A"]);
    const taskC = makeTask("TASK-C", "BLOCKED", ["TASK-A", "TASK-OTHER"]);
    const taskOther = makeTask("TASK-OTHER", "DOING");

    const allTasks = [taskA, taskB, taskC, taskOther];
    const unblockable = DependencyResolver.findUnblockableTasks("TASK-A", allTasks);

    // Task B only depended on Task A -> unblockable!
    // Task C depended on Task A AND Task Other (which is still DOING) -> still blocked!
    expect(unblockable.length).toBe(1);
    expect(unblockable[0].id).toBe("TASK-B");
  });
});
