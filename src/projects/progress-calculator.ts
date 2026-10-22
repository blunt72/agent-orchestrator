import { Task, TaskStatus } from "../tasks/task.js";

/**
 * Status contribution percentages per Section 十八:
 * TODO        0%
 * BLOCKED     0%
 * DOING       30%
 * TESTING     60%
 * REVIEW      80%
 * REWORK      50%
 * NEED_USER   50%
 * DONE        100%
 * FAILED      0%
 * CANCELLED   excluded
 */
export const STATUS_PROGRESS_MAP: Record<TaskStatus, number> = {
  TODO: 0,
  BLOCKED: 0,
  DOING: 30,
  TESTING: 60,
  REVIEW: 80,
  REWORK: 50,
  NEED_USER: 50,
  DONE: 100,
  FAILED: 0,
  CANCELLED: 0,
};

export class ProgressCalculator {
  /**
   * Returns true if a task has at least one child task in the collection.
   */
  public static isParentTask(task: Task, allTasks: Task[]): boolean {
    return allTasks.some((t) => t.parentTaskId === task.id);
  }

  /**
   * Returns only leaf tasks (tasks that have no children in the collection).
   */
  public static getLeafTasks(tasks: Task[]): Task[] {
    const parentIds = new Set(tasks.map((t) => t.parentTaskId).filter((id): id is string => Boolean(id)));
    return tasks.filter((t) => !parentIds.has(t.id));
  }

  /**
   * Finds all recursive leaf descendants of a given task within allTasks.
   */
  public static getLeafDescendants(task: Task, allTasks: Task[]): Task[] {
    const parentIds = new Set(allTasks.map((t) => t.parentTaskId).filter((id): id is string => Boolean(id)));
    const leaves: Task[] = [];
    const queue = [task.id];

    while (queue.length > 0) {
      const currentParentId = queue.shift()!;
      const children = allTasks.filter((t) => t.parentTaskId === currentParentId);
      for (const child of children) {
        if (parentIds.has(child.id)) {
          queue.push(child.id);
        } else {
          leaves.push(child);
        }
      }
    }

    return leaves;
  }

  /**
   * Calculates progress for a single task based on its status or explicit override,
   * or recursively from its leaf descendants if it has children in allTasks.
   */
  public static calculateTaskProgress(task: Task, allTasks: Task[] = []): number {
    if (task.status === "CANCELLED") return 0;

    // If this task has children in allTasks, its progress is computed from its leaf descendants
    const hasChildren = allTasks.some((t) => t.parentTaskId === task.id);
    if (hasChildren) {
      const leafDescendants = this.getLeafDescendants(task, allTasks);
      return this.calculateLeavesProgress(leafDescendants);
    }

    if (task.status === "DONE") return 100;
    const statusProg = STATUS_PROGRESS_MAP[task.status] ?? 0;
    if (task.progress !== undefined && task.progress > statusProg) {
      return task.progress;
    }
    return statusProg;
  }

  /**
   * Calculates weighted progress for a collection of tasks (e.g. within an Epic or Project).
   * Double Counting Prevention: Only LEAF tasks directly participate in the weighted sum.
   * CANCELLED tasks are excluded from both numerator and denominator.
   */
  public static calculateWeightedProgress(tasks: Task[]): number {
    const leafTasks = this.getLeafTasks(tasks);
    return this.calculateLeavesProgress(leafTasks);
  }

  /**
   * Helper to calculate weighted progress over a set of leaf tasks.
   */
  private static calculateLeavesProgress(leafTasks: Task[]): number {
    const activeLeaves = leafTasks.filter((t) => t.status !== "CANCELLED");
    if (activeLeaves.length === 0) {
      return 0;
    }

    let totalWeightedProgress = 0;
    let totalWeight = 0;

    for (const leaf of activeLeaves) {
      const weight = leaf.estimatedWeight !== undefined && leaf.estimatedWeight > 0 ? leaf.estimatedWeight : 1;
      const progress = leaf.status === "DONE"
        ? 100
        : (leaf.progress !== undefined && leaf.progress > (STATUS_PROGRESS_MAP[leaf.status] ?? 0)
          ? leaf.progress
          : (STATUS_PROGRESS_MAP[leaf.status] ?? 0));

      totalWeightedProgress += progress * weight;
      totalWeight += weight;
    }

    if (totalWeight <= 0) {
      return 0;
    }

    const calculated = totalWeightedProgress / totalWeight;
    return Math.round(calculated);
  }
}
