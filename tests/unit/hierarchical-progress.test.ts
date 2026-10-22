import { describe, it, expect } from "vitest";
import { ProgressCalculator } from "../../src/projects/progress-calculator.js";
import { Task } from "../../src/tasks/task.js";

function makeTask(
  id: string,
  status: Task["status"],
  options?: { parentTaskId?: string; estimatedWeight?: number; progress?: number }
): Task {
  return {
    id,
    projectId: "proj-1",
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
    parentTaskId: options?.parentTaskId,
    estimatedWeight: options?.estimatedWeight ?? 1,
    progress: options?.progress,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("Hierarchical Progress Unit Tests (Double Counting Prevention)", () => {
  it("Scenario 1: 2-tier hierarchy (Parent with 2 leaf children)", () => {
    // TASK-A
    // ├── A1 DONE (100%)
    // └── A2 TODO (0%)
    const parentA = makeTask("TASK-A", "DOING");
    const childA1 = makeTask("A1", "DONE", { parentTaskId: "TASK-A" });
    const childA2 = makeTask("A2", "TODO", { parentTaskId: "TASK-A" });

    const allTasks = [parentA, childA1, childA2];

    // Parent progress should be 50%
    const parentProgress = ProgressCalculator.calculateTaskProgress(parentA, allTasks);
    expect(parentProgress).toBe(50);

    // Project progress must only calculate leaves (A1 + A2) = (100 + 0) / 2 = 50%
    // NOT (50 + 100 + 0) / 3 = 50% with double counting
    const projectProgress = ProgressCalculator.calculateWeightedProgress(allTasks);
    expect(projectProgress).toBe(50);
  });

  it("Scenario 2: 3-tier hierarchy (Root -> Sub -> Leaf)", () => {
    // ROOT
    // └── SUB (Parent of L1, L2)
    //     ├── L1 DONE (100%, weight 1)
    //     └── L2 TODO (0%, weight 1)
    const root = makeTask("ROOT", "DOING");
    const sub = makeTask("SUB", "DOING", { parentTaskId: "ROOT" });
    const l1 = makeTask("L1", "DONE", { parentTaskId: "SUB", estimatedWeight: 1 });
    const l2 = makeTask("L2", "TODO", { parentTaskId: "SUB", estimatedWeight: 1 });

    const allTasks = [root, sub, l1, l2];

    expect(ProgressCalculator.calculateTaskProgress(l1, allTasks)).toBe(100);
    expect(ProgressCalculator.calculateTaskProgress(l2, allTasks)).toBe(0);
    expect(ProgressCalculator.calculateTaskProgress(sub, allTasks)).toBe(50);
    expect(ProgressCalculator.calculateTaskProgress(root, allTasks)).toBe(50);

    // Project progress must strictly only count leaves L1 and L2
    const projectProgress = ProgressCalculator.calculateWeightedProgress(allTasks);
    expect(projectProgress).toBe(50);
  });

  it("Scenario 3: Mixed parent/leaf tasks under the same project", () => {
    // TASK-P (Parent)
    // ├── P1 DONE (100%, weight 1)
    // └── P2 TODO (0%, weight 1)
    // TASK-STANDALONE (Leaf, DONE 100%, weight 2)
    const p = makeTask("TASK-P", "DOING");
    const p1 = makeTask("P1", "DONE", { parentTaskId: "TASK-P", estimatedWeight: 1 });
    const p2 = makeTask("P2", "TODO", { parentTaskId: "TASK-P", estimatedWeight: 1 });
    const standalone = makeTask("TASK-STANDALONE", "DONE", { estimatedWeight: 2 });

    const allTasks = [p, p1, p2, standalone];

    // Leaves: P1 (wt 1, 100), P2 (wt 1, 0), STANDALONE (wt 2, 100)
    // Total weight = 1 + 1 + 2 = 4
    // Weighted sum = (100*1) + (0*1) + (100*2) = 300
    // Expected progress = 300 / 4 = 75%
    const projectProgress = ProgressCalculator.calculateWeightedProgress(allTasks);
    expect(projectProgress).toBe(75);
    expect(ProgressCalculator.calculateTaskProgress(p, allTasks)).toBe(50);
  });

  it("Scenario 4: Cancelled child task is excluded from calculation", () => {
    // TASK-A
    // ├── A1 DONE (100%, weight 1)
    // └── A2 CANCELLED (excluded)
    const parent = makeTask("TASK-A", "DOING");
    const a1 = makeTask("A1", "DONE", { parentTaskId: "TASK-A", estimatedWeight: 1 });
    const a2 = makeTask("A2", "CANCELLED", { parentTaskId: "TASK-A", estimatedWeight: 5 });

    const allTasks = [parent, a1, a2];

    // A2 cancelled, so only A1 counts. 100 / 1 = 100%
    expect(ProgressCalculator.calculateTaskProgress(parent, allTasks)).toBe(100);
    expect(ProgressCalculator.calculateWeightedProgress(allTasks)).toBe(100);
  });

  it("Scenario 5: Different weights on leaf tasks", () => {
    // TASK-A
    // ├── A1 DONE (100%, weight 3)
    // └── A2 TODO (0%, weight 1)
    const parent = makeTask("TASK-A", "DOING");
    const a1 = makeTask("A1", "DONE", { parentTaskId: "TASK-A", estimatedWeight: 3 });
    const a2 = makeTask("A2", "TODO", { parentTaskId: "TASK-A", estimatedWeight: 1 });

    const allTasks = [parent, a1, a2];

    // Weighted sum = (100*3) + (0*1) = 300
    // Total weight = 4
    // Expected = 300 / 4 = 75%
    expect(ProgressCalculator.calculateTaskProgress(parent, allTasks)).toBe(75);
    expect(ProgressCalculator.calculateWeightedProgress(allTasks)).toBe(75);
  });
});
