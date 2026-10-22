import { ProjectEngine, ProjectEngineOptions } from "../projects/project-engine.js";
import { Task, CreateTaskInput, TaskStatus } from "./task.js";
import { TaskStore } from "./task-store.js";
import { Project, CreateProjectInput } from "./project.js";
import { createTaskEvent } from "./task-events.js";

export type TaskEngineOptions = ProjectEngineOptions;

export class TaskEngine extends ProjectEngine {
  constructor(options?: TaskEngineOptions) {
    super(options);
  }

  // --- Task Methods with backwards-compatible signatures ---

  public async getTask(taskId: string): Promise<Task> {
    const task = await super.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  public async listTasks(
    filterOrProjectId?: string | { projectId?: string; epicId?: string; status?: TaskStatus },
    status?: TaskStatus
  ): Promise<Task[]> {
    if (typeof filterOrProjectId === "object" && filterOrProjectId !== null) {
      return super.listTasks(filterOrProjectId);
    }
    const filter: { projectId?: string; status?: TaskStatus } = {};
    if (filterOrProjectId) filter.projectId = filterOrProjectId;
    if (status) filter.status = status;
    return super.listTasks(filter);
  }

  public async pauseTask(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (task.status !== "DONE" && task.status !== "CANCELLED" && task.status !== "FAILED") {
      task.status = "NEED_USER";
      task.owner = "system";
      task.nextAction = "任务被用户暂停，等待用户输入恢复";
      task.updatedAt = new Date().toISOString();
      await this.getStore().saveTask(task);
      await this.getStore().appendTaskEvent(
        createTaskEvent(taskId, "NEED_USER", "system", { reason: "Task paused by user" })
      );
    }
  }

  public async resumeTask(taskId: string): Promise<Task> {
    return this.runTaskWithPreparation(taskId, async () => {
      await this.prepareTaskResume(taskId);
    });
  }

  private async prepareTaskResume(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (task.status !== "NEED_USER" && task.status !== "REWORK" && task.status !== "FAILED") {
      throw new Error(
        `Cannot resume task ${taskId} from status ${task.status}. Can only resume from NEED_USER, REWORK, or FAILED.`
      );
    }

    const developer = task.claim?.ownerId ?? (task.reviewerId === "codex" ? "gemini" : "codex");
    if (task.claim && ((developer !== "codex" && developer !== "gemini") ||
        (task.reviewerId !== "codex" && task.reviewerId !== "gemini") || task.reviewerId === developer)) {
      throw new Error("Claimed task requires a supported claimant and explicit independent reviewer");
    }
    task.status = task.pendingAgentTurn?.phase ?? "DOING";
    task.owner = (task.status === "REVIEW" ? task.reviewerId : developer) as Task["owner"];
    task.ownerId = task.owner;
    task.ownerType = "AGENT";
    task.nextAction = `等待 ${task.ownerId} 继续${task.status === "REVIEW" ? "审查" : "开发实现"}`;
    task.updatedAt = new Date().toISOString();
    await this.getStore().saveTask(task);
    await this.getStore().appendTaskEvent(
      createTaskEvent(taskId, "STATUS_CHANGED", "user", { to: task.status, reason: "Resumed by user" })
    );
  }

  // --- Project Management with backwards-compatible signatures ---

  public async getProject(projectId: string): Promise<Project> {
    const p = await super.getProject(projectId);
    if (!p) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return p;
  }
}
