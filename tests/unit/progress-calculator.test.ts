import { describe, it, expect } from "vitest";
import { ProgressCalculator, STATUS_PROGRESS_MAP } from "../../src/projects/progress-calculator.js";
import { Task } from "../../src/tasks/task.js";

function makeTask(id: string, status: Task["status"], weight: number = 1, progress?: number): Task {
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
    estimatedWeight: weight,
    progress,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("ProgressCalculator Unit Tests", () => {
  it("computes exact status contributions according to Section 十八", () => {
    expect(STATUS_PROGRESS_MAP.TODO).toBe(0);
    expect(STATUS_PROGRESS_MAP.BLOCKED).toBe(0);
    expect(STATUS_PROGRESS_MAP.DOING).toBe(30);
    expect(STATUS_PROGRESS_MAP.TESTING).toBe(60);
    expect(STATUS_PROGRESS_MAP.REVIEW).toBe(80);
    expect(STATUS_PROGRESS_MAP.REWORK).toBe(50);
    expect(STATUS_PROGRESS_MAP.NEED_USER).toBe(50);
    expect(STATUS_PROGRESS_MAP.DONE).toBe(100);
    expect(STATUS_PROGRESS_MAP.FAILED).toBe(0);
    expect(STATUS_PROGRESS_MAP.CANCELLED).toBe(0);
  });

  it("calculates progress for individual tasks", () => {
    expect(ProgressCalculator.calculateTaskProgress(makeTask("t1", "TODO"))).toBe(0);
    expect(ProgressCalculator.calculateTaskProgress(makeTask("t2", "DOING"))).toBe(30);
    expect(ProgressCalculator.calculateTaskProgress(makeTask("t3", "TESTING"))).toBe(60);
    expect(ProgressCalculator.calculateTaskProgress(makeTask("t4", "REVIEW"))).toBe(80);
    expect(ProgressCalculator.calculateTaskProgress(makeTask("t5", "DONE"))).toBe(100);
  });

  it("calculates weighted progress across multiple active tasks and excludes CANCELLED tasks", () => {
    // 3 tasks with default weight 1:
    // Task 1: DONE (100)
    // Task 2: REVIEW (80)
    // Task 3: TODO (0)
    // Task 4: CANCELLED (excluded)
    // Average: (100 + 80 + 0) / 3 = 180 / 3 = 60%
    const tasks = [
      makeTask("t1", "DONE"),
      makeTask("t2", "REVIEW"),
      makeTask("t3", "TODO"),
      makeTask("t4", "CANCELLED"),
    ];

    expect(ProgressCalculator.calculateWeightedProgress(tasks)).toBe(60);
  });

  it("calculates realistic project progress with custom weights", () => {
    // Task 1 (weight 2): DONE (100 * 2 = 200)
    // Task 2 (weight 1): DOING (30 * 1 = 30)
    // Task 3 (weight 1): BLOCKED (0 * 1 = 0)
    // Total weight = 4. Total = 230 / 4 = 57.5% -> round 58%
    const tasks = [
      makeTask("t1", "DONE", 2),
      makeTask("t2", "DOING", 1),
      makeTask("t3", "BLOCKED", 1),
    ];

    expect(ProgressCalculator.calculateWeightedProgress(tasks)).toBe(58);
  });

  it("returns 0 if no active tasks exist", () => {
    expect(ProgressCalculator.calculateWeightedProgress([])).toBe(0);
    expect(ProgressCalculator.calculateWeightedProgress([makeTask("c1", "CANCELLED")])).toBe(0);
  });
});
