import { Task } from "../tasks/task.js";

export class DependencyResolver {
  /**
   * Checks for circular dependencies in a task list.
   * Returns an array of task IDs involved in a cycle, or null if acyclic.
   */
  public static findCycle(tasks: Task[]): string[] | null {
    const taskMap = new Map<string, Task>(tasks.map((t) => [t.id, t]));
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const path: string[] = [];

    const dfs = (taskId: string): boolean => {
      visited.add(taskId);
      recStack.add(taskId);
      path.push(taskId);

      const task = taskMap.get(taskId);
      if (task?.dependsOn) {
        for (const depId of task.dependsOn) {
          if (!visited.has(depId)) {
            if (dfs(depId)) return true;
          } else if (recStack.has(depId)) {
            path.push(depId);
            return true;
          }
        }
      }

      recStack.delete(taskId);
      path.pop();
      return false;
    };

    for (const task of tasks) {
      if (!visited.has(task.id)) {
        if (dfs(task.id)) {
          return path;
        }
      }
    }

    return null;
  }

  /**
   * Computes the list of unfinished task IDs that currently block a given task.
   */
  public static getActiveBlockers(task: Task, allTasks: Task[]): string[] {
    if (!task.dependsOn || task.dependsOn.length === 0) {
      return [];
    }

    const taskMap = new Map<string, Task>(allTasks.map((t) => [t.id, t]));
    const blockers: string[] = [];

    for (const depId of task.dependsOn) {
      const depTask = taskMap.get(depId);
      // If dependency doesn't exist yet or is not in DONE status, it is a blocker
      if (!depTask || depTask.status !== "DONE" || depTask.orcaHistoricalCompletion !== undefined) {
        blockers.push(depId);
      }
    }

    return blockers;
  }

  /**
   * Checks if a task should be in BLOCKED state.
   */
  public static isBlocked(task: Task, allTasks: Task[]): boolean {
    return this.getActiveBlockers(task, allTasks).length > 0;
  }

  /**
   * When a task finishes (becomes DONE), find all tasks that were blocked by it
   * and have NO OTHER unfinished dependencies, meaning they can now unblock (BLOCKED -> TODO).
   */
  public static findUnblockableTasks(completedTaskId: string, allTasks: Task[]): Task[] {
    const taskMap = new Map<string, Task>(allTasks.map((t) => [t.id, t]));
    const unblockable: Task[] = [];

    for (const task of allTasks) {
      if (task.status === "BLOCKED" && task.dependsOn?.includes(completedTaskId)) {
        // Check if all other dependencies are now DONE
        const remainingBlockers = this.getActiveBlockers(task, allTasks);
        if (remainingBlockers.length === 0) {
          unblockable.push(task);
        }
      }
    }

    return unblockable;
  }
}
