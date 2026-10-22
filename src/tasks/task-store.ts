import { ProjectStore, type TaskFilter } from "../projects/project-store.js";
import { Task } from "./task.js";

export type { TaskFilter };

export interface TaskTree {
  root: Task | null;
  parent: Task | null;
  task: Task | null;
  children: Task[];
}

export class TaskStore extends ProjectStore {
  constructor(baseDir?: string) {
    super(baseDir);
  }

  // Backward-compatible V0.2 aliases
  public async appendEvent(event: any): Promise<void> {
    return this.appendTaskEvent(event);
  }

  public async getEvents(taskId: string): Promise<any[]> {
    return this.getTaskEvents(taskId);
  }

  public async getParent(taskId: string): Promise<Task | null> {
    const ancestors = await this.getAncestors(taskId);
    return ancestors.length > 0 ? ancestors[0] : null;
  }

  public async getChildren(taskId: string): Promise<Task[]> {
    const all = await this.listTasks();
    return all.filter((t) => t.parentTaskId === taskId);
  }

  public async getTree(taskId: string): Promise<TaskTree> {
    const task = await this.getTask(taskId);
    const parent = task?.parentTaskId ? await this.getTask(task.parentTaskId) : null;
    const root = task ? await this.getRootTask(taskId) : null;
    const children = task ? await this.getChildren(taskId) : [];

    return {
      root,
      parent,
      task,
      children,
    };
  }
}
