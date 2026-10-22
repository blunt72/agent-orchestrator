import path from "node:path";
import { GeminiTaskEventBridge } from "../integrations/gemini-task-event-bridge.js";
import { verifyTranscriptRecovery, type TranscriptRecovery } from "../integrations/gemini-transcript-recovery.js";
import crypto from "node:crypto";
import { TaskRevisionError } from "../integrations/task-revision-store.js";
import { Project, CreateProjectInput } from "../models/project.js";
import { Epic, CreateEpicInput } from "../models/epic.js";
import { Task, CreateTaskInput, TaskStatus } from "../tasks/task.js";
import { Actor } from "../models/actor.js";
import { ProjectStore, ProjectTree, TaskTraceability } from "./project-store.js";
import { ProgressCalculator } from "./progress-calculator.js";
import { DependencyResolver } from "./dependency-resolver.js";
import { createProjectEvent, ProjectEvent } from "../models/project-event.js";
import { createTaskEvent } from "../tasks/task-events.js";
import { TaskRunner } from "../tasks/task-runner.js";
import { Agent } from "../agents/agent.js";
import { TaskStore } from "../tasks/task-store.js";
import { ClaimTaskInput, TaskClaimError } from "../tasks/task-claim.js";
import { TaskExecutionBusyError } from "../tasks/task-execution.js";

export type ProjectEventSubscriber = (event: ProjectEvent) => void;

export interface ProjectEngineOptions {
  baseDir?: string;
  store?: ProjectStore;
  codexAgent?: Agent;
  geminiAgent?: Agent;
  maxConcurrentTasks?: number;
  /** Explicit opt-in; false overrides the environment. */
  transcriptBridgeEnabled?: boolean;
  transcriptBrainRoot?: string;
}

export class ProjectEngine {
  private store: ProjectStore;
  private transcriptBridge?: GeminiTaskEventBridge;
  private transcriptBrainRoot?: string;
  private codexAgent?: Agent;
  private geminiAgent?: Agent;
  private maxConcurrentTasks: number;
  private runningTaskCount: number = 0;
  private taskQueue: Array<() => Promise<void>> = [];
  private activeRunners = new Map<string, TaskRunner>();
  private dispatches = new Map<string, Promise<Task>>();
  private subscribers = new Map<string, Set<ProjectEventSubscriber>>();

  constructor(options?: ProjectEngineOptions) {
    this.store = options?.store || new ProjectStore(options?.baseDir);
    const enabled = options?.transcriptBridgeEnabled ?? process.env.AGENTHUB_TRANSCRIPT_BRIDGE === "1";
    if (enabled) {
      this.transcriptBrainRoot = options?.transcriptBrainRoot ?? process.env.AGENTHUB_GEMINI_BRAIN_ROOT;
      if (!this.transcriptBrainRoot || !path.isAbsolute(this.transcriptBrainRoot)) throw Error("EXPLICIT_GEMINI_BRAIN_ROOT_REQUIRED");
      this.transcriptBridge = new GeminiTaskEventBridge(path.join(this.store.getBaseDirectory(), "data/gemini-event-bridge"));
    }
    this.codexAgent = options?.codexAgent;
    this.geminiAgent = options?.geminiAgent;
    this.maxConcurrentTasks = options?.maxConcurrentTasks ?? 2;
  }

  public getStore(): ProjectStore {
    return this.store;
  }

  // --- Pub/Sub for Real-Time SSE ---

  public subscribe(projectId: string, subscriber: ProjectEventSubscriber): () => void {
    if (!this.subscribers.has(projectId)) {
      this.subscribers.set(projectId, new Set());
    }
    this.subscribers.get(projectId)!.add(subscriber);

    return () => {
      this.subscribers.get(projectId)?.delete(subscriber);
      if (this.subscribers.get(projectId)?.size === 0) {
        this.subscribers.delete(projectId);
      }
    };
  }

  public async emitEvent(
    projectId: string,
    type: string,
    actorId: string,
    actorType: "HUMAN" | "AGENT" | "SYSTEM",
    options?: { epicId?: string; taskId?: string; data?: unknown }
  ): Promise<ProjectEvent> {
    const event = createProjectEvent(projectId, type, actorId, actorType, options);
    await this.store.appendProjectEvent(event);

    const subs = this.subscribers.get(projectId);
    if (subs) {
      for (const cb of subs) {
        try {
          cb(event);
        } catch {}
      }
    }

    return event;
  }

  // --- Projects ---

  public async createProject(input: CreateProjectInput): Promise<Project> {
    const id = input.id || `PROJ-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const now = new Date().toISOString();

    const project: Project = {
      id,
      name: input.name,
      description: input.description,
      workspace: input.workspace,
      status: input.status || "PLANNING",
      progress: 0,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.saveProject(project);
    await this.emitEvent(id, "project.created", "system", "SYSTEM", {
      data: { name: project.name },
    });

    return project;
  }

  public async getProject(projectId: string): Promise<Project | null> {
    return this.store.getProject(projectId);
  }

  public async listProjects(): Promise<Project[]> {
    return this.store.listProjects();
  }

  public async getProjectTree(projectId: string): Promise<ProjectTree | null> {
    return this.store.getProjectTree(projectId);
  }

  public async refreshProjectProgress(projectId: string): Promise<number> {
    return this.store.getMutex().runExclusive(`engine:progress:${projectId}`, async () => {
      const project = await this.store.getProject(projectId);
      if (!project) return 0;

      const tasks = await this.store.listTasks({ projectId });

      // Update progress for all parent tasks in store
      for (const t of tasks) {
        if (ProgressCalculator.isParentTask(t, tasks) && t.orcaHistoricalCompletion === undefined) {
          t.progress = ProgressCalculator.calculateTaskProgress(t, tasks);
          await this.store.saveTask(t);
        }
      }

      const progress = ProgressCalculator.calculateWeightedProgress(tasks);
      const oldProgress = project.progress;
      project.progress = progress;
      project.updatedAt = new Date().toISOString();

      const historicalTaskIds = tasks.filter(t => t.orcaHistoricalCompletion !== undefined).map(t => t.id).sort();
      if (historicalTaskIds.length) {
        project.historicalClosureSummary = { taskIds: historicalTaskIds, normalAcceptancePassed: false };
        if (project.status === "DONE") project.status = "ACTIVE";
        delete project.completedAt;
      } else delete project.historicalClosureSummary;

      if (historicalTaskIds.length === 0 && progress === 100 && tasks.length > 0 && tasks.every((t) => t.status === "DONE" || t.status === "CANCELLED")) {
        project.status = "DONE";
        project.completedAt = new Date().toISOString();
      } else if (project.status === "PLANNING" && tasks.length > 0) {
        project.status = "ACTIVE";
        project.startedAt = project.startedAt || new Date().toISOString();
      }

      await this.store.saveProject(project);

      if (oldProgress !== progress) {
        await this.emitEvent(projectId, "project.progress_changed", "system", "SYSTEM", {
          data: { oldProgress, newProgress: progress },
        });
      }

      return progress;
    });
  }

  // --- Epics ---

  public async createEpic(input: CreateEpicInput): Promise<Epic> {
    const id = input.id || `EPIC-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const now = new Date().toISOString();

    const epic: Epic = {
      id,
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      status: "TODO",
      progress: 0,
      priority: input.priority || "MEDIUM",
      createdAt: now,
      updatedAt: now,
    };

    await this.store.saveEpic(epic);
    await this.emitEvent(input.projectId, "epic.created", "system", "SYSTEM", {
      epicId: id,
      data: { title: epic.title },
    });

    return epic;
  }

  public async getEpic(epicId: string): Promise<Epic | null> {
    return this.store.getEpic(epicId);
  }

  public async listEpics(projectId?: string): Promise<Epic[]> {
    return this.store.listEpics(projectId);
  }

  public async refreshEpicProgress(epicId: string): Promise<number> {
    const epic = await this.store.getEpic(epicId);
    if (!epic) return 0;

    const tasks = await this.store.listTasks({ epicId });
    const progress = ProgressCalculator.calculateWeightedProgress(tasks);

    epic.progress = progress;
    epic.updatedAt = new Date().toISOString();

    const historicalTaskIds = tasks.filter(t => t.orcaHistoricalCompletion !== undefined).map(t => t.id).sort();
    if (historicalTaskIds.length) {
      epic.historicalClosureSummary = { taskIds: historicalTaskIds, normalAcceptancePassed: false };
      if (epic.status === "DONE" || tasks.every(t => t.status === "DONE" || t.status === "CANCELLED")) epic.status = "BLOCKED";
    } else delete epic.historicalClosureSummary;

    if (historicalTaskIds.length === 0 && progress === 100 && tasks.length > 0 && tasks.every((t) => t.status === "DONE" || t.status === "CANCELLED")) {
      epic.status = "DONE";
    } else if (tasks.some((t) => t.status === "DOING" || t.status === "TESTING" || t.status === "REVIEW" || t.status === "REWORK")) {
      epic.status = "DOING";
    }

    await this.store.saveEpic(epic);
    return progress;
  }

  // --- Tasks ---

  public async createTask(input: CreateTaskInput): Promise<Task> {
    const id = input.id || `TASK-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const now = new Date().toISOString();

    // Check project exists
    const project = await this.store.getProject(input.projectId);
    const workspace = input.workspace || project?.workspace || process.cwd();

    // Determine ownership
    const ownerId = input.ownerId || (input.ownerType === "HUMAN" ? "user" : "codex");
    const ownerType = input.ownerType || (ownerId === "codex" || ownerId === "gemini" ? "AGENT" : "HUMAN");
    const reviewerId = input.reviewerId || (input.reviewer === "codex" || input.reviewer === "gemini" ? input.reviewer : (ownerId === "gemini" ? "codex" : "gemini"));
    const reviewer: "codex" | "gemini" = reviewerId === "codex" ? "codex" : "gemini";

    // Check dependencies
    const allProjectTasks = await this.store.listTasks({ projectId: input.projectId });
    const tempTask: Task = {
      id,
      projectId: input.projectId,
      epicId: input.epicId,
      parentTaskId: input.parentTaskId,
      rootTaskId: input.rootTaskId,
      title: input.title,
      description: input.description,
      status: "TODO",
      owner: (ownerId as any) || "codex",
      ownerType,
      ownerId,
      reviewer,
      reviewerId,
      priority: input.priority || "MEDIUM",
      workspace,
      dependsOn: input.dependsOn || [],
      estimatedWeight: input.estimatedWeight ?? 1,
      maxRounds: input.maxRounds || 6,
      currentRound: 0,
      createdAt: now,
      updatedAt: now,
      testCommand: input.testCommand,
      source: input.source || { type: "USER" },
    };

    const isBlocked = DependencyResolver.isBlocked(tempTask, allProjectTasks);
    const initialStatus: TaskStatus = isBlocked ? "BLOCKED" : "TODO";

    tempTask.status = initialStatus;
    tempTask.blockedBy = DependencyResolver.getActiveBlockers(tempTask, allProjectTasks);
    tempTask.progress = ProgressCalculator.calculateTaskProgress(tempTask);

    if (initialStatus === "BLOCKED") {
      tempTask.nextAction = `等待前置依赖任务完成: ${tempTask.blockedBy.join(", ")}`;
    } else if (ownerType === "HUMAN") {
      tempTask.nextAction = "等待人类成员开始任务";
    } else {
      tempTask.nextAction = "等待任务排期调度执行";
    }

    // Resolve rootTaskId if not explicitly given
    if (!tempTask.rootTaskId) {
      if (tempTask.parentTaskId) {
        const root = await this.store.getRootTask(tempTask.parentTaskId);
        tempTask.rootTaskId = root?.id || tempTask.parentTaskId;
      } else {
        tempTask.rootTaskId = id;
      }
    }

    await this.store.saveTask(tempTask);

    // Save event
    const taskEv = createTaskEvent(id, "TASK_CREATED", ownerId, {
      projectId: input.projectId,
      title: input.title,
      status: initialStatus,
    });
    await this.store.appendTaskEvent(taskEv);

    await this.emitEvent(input.projectId, "task.created", ownerId, ownerType, {
      epicId: input.epicId,
      taskId: id,
      data: { title: tempTask.title, status: initialStatus },
    });

    if (initialStatus === "BLOCKED") {
      const blockEv = createTaskEvent(id, "TASK_BLOCKED", "system", {
        blockedBy: tempTask.blockedBy,
      });
      await this.store.appendTaskEvent(blockEv);

      await this.emitEvent(input.projectId, "task.blocked", "system", "SYSTEM", {
        epicId: input.epicId,
        taskId: id,
        data: { blockedBy: tempTask.blockedBy },
      });
    }

    // Refresh progress
    if (input.epicId) {
      await this.refreshEpicProgress(input.epicId);
    }
    await this.refreshProjectProgress(input.projectId);

    return tempTask;
  }

  public async getTask(taskId: string): Promise<Task | null> {
    return this.store.getTask(taskId);
  }

  public async listTasks(filter?: { projectId?: string; epicId?: string; status?: TaskStatus }): Promise<Task[]> {
    return this.store.listTasks(filter);
  }

  public async getTaskTraceability(taskId: string): Promise<TaskTraceability | null> {
    return this.store.getTraceability(taskId);
  }

  // --- Task Assignment & Human Task Operations ---

  public async claimTask(taskId: string, input: ClaimTaskInput): Promise<Task> {
    const validId = (value: unknown): value is string =>
      typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
    if (!validId(taskId) || !validId(input?.ownerId) || !validId(input?.expectedOwnerId) ||
        input.ownerId === input.expectedOwnerId) {
      throw new TaskClaimError("INVALID_CLAIM", "Provide safe task/owner IDs and a different expected owner", 400);
    }
    return this.store.runTaskClaimExclusive(taskId, async () => {
      const task = await this.store.getTask(taskId);
      if (!task) throw new TaskClaimError("TASK_NOT_FOUND", `Task not found: ${taskId}`, 404);
      if (task.status !== "TODO" || task.ownerId !== input.expectedOwnerId) {
        throw new TaskClaimError("CLAIM_CONFLICT", "Task is not TODO or its owner no longer matches");
      }
      const claimedAt = new Date().toISOString();
      task.claim = { id: crypto.randomUUID(), ownerId: input.ownerId,
        previousOwnerId: task.ownerId, claimedAt };
      task.ownerId = input.ownerId;
      task.owner = input.ownerId as Task["owner"];
      task.ownerType = "AGENT";
      task.updatedAt = claimedAt;
      task.nextAction = `Claimed by ${input.ownerId}; waiting for explicit dispatch`;
      await this.store.saveTask(task);
      await this.store.appendTaskEvent(createTaskEvent(taskId, "TASK_CLAIMED", input.ownerId, task.claim));
      await this.emitEvent(task.projectId, "task.claimed", input.ownerId, "AGENT", {
        epicId: task.epicId, taskId, data: task.claim,
      });
      return task;
    });
  }

  public async assignTask(taskId: string, assignment: { ownerId: string; ownerType?: "HUMAN" | "AGENT"; role?: string }): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const oldOwner = task.ownerId;
    task.ownerId = assignment.ownerId;
    task.ownerType = assignment.ownerType || (assignment.ownerId === "codex" || assignment.ownerId === "gemini" ? "AGENT" : "HUMAN");
    task.owner = (assignment.ownerId as any) || "codex";
    task.updatedAt = new Date().toISOString();

    if (task.status === "TODO") {
      task.nextAction = task.ownerType === "HUMAN" ? "等待人类成员开始任务" : "等待排期执行";
    }

    await this.store.saveTask(task);

    const ev = createTaskEvent(taskId, "TASK_ASSIGNED", assignment.ownerId, {
      from: oldOwner,
      to: assignment.ownerId,
      ownerType: task.ownerType,
    });
    await this.store.appendTaskEvent(ev);

    await this.emitEvent(task.projectId, "task.assigned", assignment.ownerId, task.ownerType, {
      epicId: task.epicId,
      taskId,
      data: { from: oldOwner, to: assignment.ownerId },
    });

    return task;
  }

  public async startHumanTask(taskId: string, userId: string = "user"): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status === "BLOCKED") {
      throw new Error(`Cannot start BLOCKED task: ${taskId}. Dependencies not met: ${task.blockedBy?.join(", ")}`);
    }

    task.status = "DOING";
    task.startedAt = task.startedAt || new Date().toISOString();
    task.updatedAt = new Date().toISOString();
    task.nextAction = "等待人类成员处理并标记完成";
    task.progress = ProgressCalculator.calculateTaskProgress(task);

    await this.store.saveTask(task);

    const ev = createTaskEvent(taskId, "STATUS_CHANGED", userId, { from: "TODO", to: "DOING" });
    await this.store.appendTaskEvent(ev);

    await this.emitEvent(task.projectId, "task.started", userId, "HUMAN", {
      epicId: task.epicId,
      taskId,
      data: { status: "DOING" },
    });

    await this.emitEvent(task.projectId, "task.status_changed", userId, "HUMAN", {
      epicId: task.epicId,
      taskId,
      data: { from: "TODO", to: "DOING" },
    });

    if (task.epicId) await this.refreshEpicProgress(task.epicId);
    await this.refreshProjectProgress(task.projectId);

    return task;
  }

  public async completeHumanTask(taskId: string, userId: string = "user", summary?: string): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const oldStatus = task.status;
    task.status = "DONE";
    task.completedAt = new Date().toISOString();
    task.updatedAt = new Date().toISOString();
    task.nextAction = undefined;
    task.progress = 100;
    task.result = {
      status: "PASS",
      summary: summary || "Task completed manually by human team member.",
      changedFiles: [],
      testStatus: "PASS",
      reviewStatus: "PASS",
      rounds: 1,
    };

    await this.store.saveTask(task);

    const ev = createTaskEvent(taskId, "TASK_COMPLETED", userId, { summary: task.result.summary });
    await this.store.appendTaskEvent(ev);

    await this.emitEvent(task.projectId, "task.done", userId, "HUMAN", {
      epicId: task.epicId,
      taskId,
      data: { status: "DONE" },
    });

    // Check dependency unblocking for other tasks
    await this.unblockDependentTasks(task.id, task.projectId);

    if (task.epicId) await this.refreshEpicProgress(task.epicId);
    await this.refreshProjectProgress(task.projectId);

    return task;
  }

  public async blockTask(taskId: string, reason?: string): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const oldStatus = task.status;
    task.status = "BLOCKED";
    task.nextAction = reason ? `任务被阻塞: ${reason}` : "任务处于阻塞状态";
    task.progress = ProgressCalculator.calculateTaskProgress(task);
    task.updatedAt = new Date().toISOString();

    await this.store.saveTask(task);

    const ev = createTaskEvent(taskId, "TASK_BLOCKED", "system", { reason, from: oldStatus });
    await this.store.appendTaskEvent(ev);

    await this.emitEvent(task.projectId, "task.blocked", "system", "SYSTEM", {
      epicId: task.epicId,
      taskId,
      data: { reason },
    });

    if (task.epicId) await this.refreshEpicProgress(task.epicId);
    await this.refreshProjectProgress(task.projectId);

    return task;
  }

  public async unblockTask(taskId: string): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    task.status = "TODO";
    task.blockedBy = [];
    task.nextAction = task.ownerType === "HUMAN" ? "等待人类成员开始任务" : "等待排期执行";
    task.progress = ProgressCalculator.calculateTaskProgress(task);
    task.updatedAt = new Date().toISOString();

    await this.store.saveTask(task);

    const ev = createTaskEvent(taskId, "TASK_UNBLOCKED", "system", {});
    await this.store.appendTaskEvent(ev);

    await this.emitEvent(task.projectId, "task.unblocked", "system", "SYSTEM", {
      epicId: task.epicId,
      taskId,
    });

    if (task.epicId) await this.refreshEpicProgress(task.epicId);
    await this.refreshProjectProgress(task.projectId);

    return task;
  }

  public async respondToNeedUser(taskId: string, message: string, userId: string = "user"): Promise<Task> {
    if (this.dispatches.has(taskId)) throw new Error("Task dispatch is still active");
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.orcaBinding) throw new Error("Orca-bound task cannot use internal dispatch");
    if (task.status !== "NEED_USER") {
      throw new Error(`Task is not in NEED_USER state (current: ${task.status})`);
    }

    // Append human guidance to description
    task.description = `${task.description}\n\n[Human Decision / Response by ${userId}]:\n${message}`;
    task.ownerType = "AGENT";
    task.ownerId = task.reviewerId === "codex" ? "gemini" : "codex";
    task.owner = task.reviewerId === "codex" ? "gemini" : "codex";
    if (task.pendingAgentTurn) task.pendingHumanResponse = message;
    task.status = task.pendingAgentTurn?.phase ?? "DOING";
    task.nextAction = `等待 ${task.ownerId} 按照用户决策继续实现`;
    if (task.currentRound >= task.maxRounds) {
      task.maxRounds = task.currentRound + 6;
    }
    task.updatedAt = new Date().toISOString();

    await this.store.saveTask(task);

    const ev = createTaskEvent(taskId, "STATUS_CHANGED", userId, {
      from: "NEED_USER",
      to: task.status,
      responseMessage: message,
    });
    await this.store.appendTaskEvent(ev);

    await this.emitEvent(task.projectId, "task.status_changed", userId, "HUMAN", {
      epicId: task.epicId,
      taskId,
      data: { from: "NEED_USER", to: task.status, message },
    });

    // Run task to resume AI execution
    return this.runTask(taskId);
  }

  // --- Auto-unblocking helper ---

  private async unblockDependentTasks(completedTaskId: string, projectId: string): Promise<void> {
    const allTasks = await this.store.listTasks({ projectId });
    const unblockable = DependencyResolver.findUnblockableTasks(completedTaskId, allTasks);

    for (const task of unblockable) {
      await this.unblockTask(task.id);
    }
  }

  // --- Autonomous Task Execution with Concurrency Queue ---

  public runTask(taskId: string): Promise<Task> {
    return this.runTaskWithPreparation(taskId);
  }

  /** Human-authorized continuation may execute subsequent pipeline/model steps. */
  public resumeTranscriptEvent(taskId: string, recovery: TranscriptRecovery): Promise<Task> {
    if (!this.transcriptBridge) return Promise.reject(Error("TRANSCRIPT_BRIDGE_NOT_CONFIGURED"));
    if (recovery?.humanAuthorized !== true) return Promise.reject(Error("EXPLICIT_HUMAN_AUTHORIZATION_REQUIRED"));
    return this.runTaskWithPreparation(taskId, undefined, recovery);
  }

  protected runTaskWithPreparation(taskId: string, prepare?: () => Promise<void>, recovery?: TranscriptRecovery): Promise<Task> {
    const existing = this.dispatches.get(taskId);
    if (existing) return (prepare || recovery) ? Promise.reject(new TaskExecutionBusyError(taskId)) : existing;
    const dispatch = this.store.runTaskExecutionExclusive(taskId, async () => {
      const current = await this.store.getTask(taskId);
      if (current?.orcaBinding) throw new Error("Orca-bound task cannot use internal dispatch");
      if (prepare) await prepare();
      return this.runTaskOnce(taskId, recovery);
    })
      .finally(() => this.dispatches.delete(taskId));
    this.dispatches.set(taskId, dispatch);
    return dispatch;
  }

  public async recoverPendingTasks(): Promise<void> {
    const tasks = await this.store.listTasks();
    for (const task of tasks) {
      if (!task.orcaBinding && task.pendingAgentTurn && (task.status === "DOING" || task.status === "REVIEW")) {
        void this.runTask(task.id).catch(async err => {
          if (err instanceof TaskExecutionBusyError) return;
          task.status = "NEED_USER";
          task.nextAction = `Pending recovery failed; original session may remain active: ${err.message}`;
          await this.store.saveTask(task);
        });
      }
    }
  }

  private async runTaskOnce(taskId: string, recovery?: TranscriptRecovery): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.orcaBinding) throw new Error("Orca-bound task cannot use internal dispatch");

    if (task.status === "BLOCKED") {
      throw new Error(`Cannot run BLOCKED task: ${taskId}. Blocked by: ${task.blockedBy?.join(", ")}`);
    }

    if (task.status === "DONE" || task.status === "CANCELLED") {
      if (recovery) throw Error("TERMINAL_TASK_CANNOT_RECOVER");
      return task;
    }

    // Concurrency control: maxConcurrentTasks
    if (this.runningTaskCount >= this.maxConcurrentTasks) {
      return new Promise<Task>((resolve, reject) => {
        this.taskQueue.push(async () => {
          try {
            const res = await this.executeTaskDirectly(taskId, recovery);
            resolve(res);
          } catch (e) {
            reject(e);
          }
        });
      });
    }

    return this.executeTaskDirectly(taskId, recovery);
  }

  private async executeTaskDirectly(taskId: string, recovery?: TranscriptRecovery): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.orcaBinding) throw new Error("Orca-bound task cannot use internal dispatch");

    const runner = new TaskRunner({
      task,
      store: this.store as unknown as TaskStore,
      codexAgent: this.codexAgent,
      geminiAgent: this.geminiAgent,
      transcriptBridge: this.transcriptBridge,
      transcriptBrainRoot: this.transcriptBrainRoot,
    });

    this.runningTaskCount++;
    this.activeRunners.set(taskId, runner);

    try {
      await this.emitEvent(task.projectId, "task.started", task.reviewerId === "codex" ? "gemini" : "codex", "AGENT", {
        epicId: task.epicId,
        taskId,
      });

      let completed: Task;
      try {
        completed = recovery
          ? await runner.resumeTranscriptEvent(recovery.eventId,
              {humanAuthorized: true, evidence: recovery.approvalSha256},
              async (saved, event) => verifyTranscriptRecovery(saved, event, recovery))
          : await runner.run();
      } catch (error) {
        if (error instanceof TaskRevisionError && ["CONFLICT", "BUSY"].includes(error.code)) {
          const latest = await this.store.getTask(taskId);
          if (latest?.status === "CANCELLED") return latest;
        }
        throw error;
      }
      const currentInStore = await this.store.getTask(taskId);
      if (completed.status === "CANCELLED" || currentInStore?.status === "CANCELLED") {
        return {
          ...(currentInStore || completed),
          status: "CANCELLED",
        };
      }
      try {
        await this.store.saveTask(completed);
      } catch (error) {
        if (error instanceof TaskRevisionError && ["CONFLICT", "BUSY"].includes(error.code)) {
          const latest = await this.store.getTask(taskId);
          if (latest?.status === "CANCELLED") return latest;
        }
        throw error;
      }

      // Check if finished and unblock dependents
      if (completed.status === "DONE") {
        await this.emitEvent(task.projectId, "task.done", completed.reviewerId || "gemini", "AGENT", {
          epicId: task.epicId,
          taskId,
          data: { result: completed.result },
        });
        await this.unblockDependentTasks(completed.id, completed.projectId);
      } else if (completed.status === "NEED_USER") {
        await this.emitEvent(task.projectId, "task.need_user", "system", "SYSTEM", {
          epicId: task.epicId,
          taskId,
          data: { nextAction: completed.nextAction },
        });
      }

      if (completed.epicId) {
        await this.refreshEpicProgress(completed.epicId);
      }
      await this.refreshProjectProgress(completed.projectId);

      return completed;
    } finally {
      this.activeRunners.delete(taskId);
      this.runningTaskCount--;

      // Process next in queue
      if (this.taskQueue.length > 0 && this.runningTaskCount < this.maxConcurrentTasks) {
        const next = this.taskQueue.shift();
        if (next) {
          next().catch(() => {});
        }
      }
    }
  }

  public async cancelTask(taskId: string): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const runner = this.activeRunners.get(taskId);
    if (runner) {
      runner.abort();
    }

    task.status = "CANCELLED";
    task.nextAction = undefined;
    task.updatedAt = new Date().toISOString();

    await this.store.saveTask(task);

    const ev = createTaskEvent(taskId, "STATUS_CHANGED", "user", { to: "CANCELLED" });
    await this.store.appendTaskEvent(ev);

    await this.emitEvent(task.projectId, "task.cancelled", "user", "HUMAN", {
      epicId: task.epicId,
      taskId,
    });

    if (task.epicId) await this.refreshEpicProgress(task.epicId);
    await this.refreshProjectProgress(task.projectId);

    return task;
  }
}
