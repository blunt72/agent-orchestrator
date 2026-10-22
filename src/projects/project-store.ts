import fs from "node:fs/promises";
import { writeTaskEvent, verifyTaskEventReadOnly } from "../integrations/task-event-store.js";
import { OrcaEvidenceStore, type OrcaEvidenceRef } from "../integrations/orca-evidence.js";
import fsSync from "node:fs";
import path from "node:path";
import { Project } from "../models/project.js";
import { Epic } from "../models/epic.js";
import { Task, TaskStatus } from "../tasks/task.js";
import { Actor, DEFAULT_SYSTEM_ACTORS } from "../models/actor.js";
import { ProjectEvent } from "../models/project-event.js";
import { TaskEvent } from "../tasks/task-events.js";
import { TaskClaimError } from "../tasks/task-claim.js";
import { TaskExecutionBusyError } from "../tasks/task-execution.js";
import { TaskRevisionStore } from "../integrations/task-revision-store.js";
import { withTaskFileLock, type TaskLockNamespace } from "../integrations/task-file-lock.js";

import crypto from "node:crypto";

export class KeyedMutex {
  private queues = new Map<string, Promise<void>>();

  public async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const current = this.queues.get(key) || Promise.resolve();
    let resolveNext: () => void;
    const next = new Promise<void>((r) => {
      resolveNext = r;
    });
    this.queues.set(key, next);

    try {
      await current;
      return await fn();
    } finally {
      resolveNext!();
      if (this.queues.get(key) === next) {
        this.queues.delete(key);
      }
    }
  }
}

export interface TaskFilter {
  projectId?: string;
  epicId?: string;
  status?: TaskStatus;
}

export interface TaskTreeNode {
  task: Task;
  children: TaskTreeNode[];
}

export interface EpicTreeNode {
  epic: Epic;
  tasks: TaskTreeNode[];
}

export interface ProjectTree {
  project: Project;
  epics: EpicTreeNode[];
  standaloneTasks: TaskTreeNode[];
}

export interface TaskTraceability {
  taskId: string;
  title: string;
  rootTask: Task | null;
  parentTask: Task | null;
  originalRequirement: string;
  createdBy?: string;
  createdFrom?: string;
  ownerType: string;
  ownerId: string;
  reviewerId?: string;
  changedFiles: string[];
  gitBranch?: string;
  worktree?: string;
  statusHistory: Array<{ timestamp: string; from?: string; to: string; actor: string }>;
  testHistory: Array<{ timestamp: string; pass: boolean; command?: string }>;
  reviewHistory: Array<{ timestamp: string; status: string; feedback?: string }>;
}

export class ProjectStore {
  protected readonly rootDir: string;
  protected readonly projectsDir: string;
  protected readonly epicsDir: string;
  protected readonly tasksDir: string;
  protected readonly actorsDir: string;
  protected readonly projectLogsDir: string;
  protected readonly taskLogsDir: string;
  protected readonly mutex = new KeyedMutex();

  public getMutex(): KeyedMutex {
    return this.mutex;
  }

  public getBaseDirectory(): string { return path.resolve(this.rootDir); }

  constructor(baseDir?: string) {
    this.rootDir = path.resolve(baseDir || process.env.AGENTHUB_STORE || process.cwd());
    this.projectsDir = path.join(this.rootDir, "data/projects");
    this.epicsDir = path.join(this.rootDir, "data/epics");
    this.tasksDir = path.join(this.rootDir, "data/tasks");
    this.actorsDir = path.join(this.rootDir, "data/actors");
    this.projectLogsDir = path.join(this.rootDir, "logs/projects");
    this.taskLogsDir = path.join(this.rootDir, "logs/tasks");
    this.ensureDirs();
    this.initializeDefaultActors();
  }

  protected ensureDirs(): void {
    const dirs = [
      this.projectsDir,
      this.epicsDir,
      this.tasksDir,
      this.actorsDir,
      this.projectLogsDir,
      this.taskLogsDir,
    ];
    for (const d of dirs) {
      if (!fsSync.existsSync(d)) {
        fsSync.mkdirSync(d, { recursive: true });
      }
    }
  }

  protected initializeDefaultActors(): void {
    for (const actor of DEFAULT_SYSTEM_ACTORS) {
      const p = path.join(this.actorsDir, `${actor.id}.json`);
      if (!fsSync.existsSync(p)) {
        try {
          fsSync.writeFileSync(p, JSON.stringify(actor, null, 2), "utf-8");
        } catch {}
      }
    }
  }

  /**
   * Atomic JSON write per Section 3:
   * 1. write temporary file (.tmp.${pid}.${Date.now()}.${nonce})
   * 2. fsync (fileHandle.sync())
   * 3. atomic rename (fs.rename)
   */
  protected async writeAtomicJson(targetPath: string, data: unknown): Promise<void> {
    const dir = path.dirname(targetPath);
    if (!fsSync.existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }
    const nonce = crypto.randomBytes(6).toString("hex");
    const tempPath = path.join(dir, `.${path.basename(targetPath)}.tmp.${process.pid}.${Date.now()}.${nonce}`);
    const content = JSON.stringify(data, null, 2);

    const handle = await fs.open(tempPath, "w");
    try {
      await handle.writeFile(content, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(tempPath, targetPath);
  }

  // --- Project CRUD ---

  public async saveProject(project: Project): Promise<void> {
    return this.mutex.runExclusive(`project:${project.id}`, async () => {
      const p = path.join(this.projectsDir, `${project.id}.json`);
      await this.writeAtomicJson(p, project);
    });
  }

  public async getProject(projectId: string): Promise<Project | null> {
    const p = path.join(this.projectsDir, `${projectId}.json`);
    if (!fsSync.existsSync(p)) return null;
    try {
      const content = await fs.readFile(p, "utf-8");
      return JSON.parse(content) as Project;
    } catch {
      return null;
    }
  }

  public async listProjects(): Promise<Project[]> {
    if (!fsSync.existsSync(this.projectsDir)) return [];
    const files = await fs.readdir(this.projectsDir);
    const projects: Project[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const c = await fs.readFile(path.join(this.projectsDir, f), "utf-8");
        projects.push(JSON.parse(c) as Project);
      } catch {}
    }
    return projects.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  // --- Epic CRUD ---

  public async saveEpic(epic: Epic): Promise<void> {
    return this.mutex.runExclusive(`epic:${epic.id}`, async () => {
      const p = path.join(this.epicsDir, `${epic.id}.json`);
      await this.writeAtomicJson(p, epic);
    });
  }

  public async getEpic(epicId: string): Promise<Epic | null> {
    const p = path.join(this.epicsDir, `${epicId}.json`);
    if (!fsSync.existsSync(p)) return null;
    try {
      const content = await fs.readFile(p, "utf-8");
      return JSON.parse(content) as Epic;
    } catch {
      return null;
    }
  }

  public async listEpics(projectId?: string): Promise<Epic[]> {
    if (!fsSync.existsSync(this.epicsDir)) return [];
    const files = await fs.readdir(this.epicsDir);
    const epics: Epic[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const c = await fs.readFile(path.join(this.epicsDir, f), "utf-8");
        const epic = JSON.parse(c) as Epic;
        if (projectId && epic.projectId !== projectId) continue;
        epics.push(epic);
      } catch {}
    }
    return epics.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  // --- Task CRUD ---

  public async runTaskClaimExclusive<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    return this.runTaskFileExclusive(taskId, "task-claims", operation,
      () => new TaskClaimError("CLAIM_BUSY", "Task claim is locked; inspect current ownership before retrying"));
  }

  public async runTaskExecutionExclusive<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    return this.runTaskFileExclusive(taskId, "task-executions", operation,
      () => new TaskExecutionBusyError(taskId));
  }

  private async runTaskFileExclusive<T>(taskId: string, namespace: TaskLockNamespace,
    operation: () => Promise<T>, busyError: () => Error): Promise<T> {
    return withTaskFileLock(path.resolve(this.rootDir), taskId, namespace, busyError, operation);
  }

  public async saveTask(task: Task): Promise<void> {
    const expected = task.revision ?? null;
    const snapshot = JSON.parse(JSON.stringify({ ...task, revision: task.revision ?? 0 }));
    return this.mutex.runExclusive(`task:${snapshot.id}`, async () => {
      const saved = await new TaskRevisionStore(path.resolve(this.rootDir)).save(snapshot, expected);
      // Keep existing callers' in-memory task current after a confirmed commit only.
      if (task.id === snapshot.id && task.revision === (expected ?? undefined)) task.revision = saved.revision;
    });
  }

  public async getTask(taskId: string): Promise<Task | null> {
    return await new TaskRevisionStore(path.resolve(this.rootDir)).read(taskId) as unknown as Task | null;
  }

  public async putOrcaEvidence(bytes: Buffer): Promise<OrcaEvidenceRef> {
    return new OrcaEvidenceStore(await fs.realpath(this.rootDir)).put(bytes);
  }

  public async readOrcaEvidence(ref: OrcaEvidenceRef): Promise<Buffer> {
    return new OrcaEvidenceStore(await fs.realpath(this.rootDir)).read(ref);
  }

  public async listTasks(filter?: TaskFilter): Promise<Task[]> {
    if (!fsSync.existsSync(this.tasksDir)) return [];
    const files = await fs.readdir(this.tasksDir);
    const tasks: Task[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const task = await this.getTask(f.slice(0, -5));
        if (!task) continue;
        if (filter?.projectId && task.projectId !== filter.projectId) continue;
        if (filter?.epicId && task.epicId !== filter.epicId) continue;
        if (filter?.status && task.status !== filter.status) continue;
        tasks.push(task);
      } catch {}
    }
    return tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  // --- Actor CRUD ---

  public async saveActor(actor: Actor): Promise<void> {
    return this.mutex.runExclusive(`actor:${actor.id}`, async () => {
      const p = path.join(this.actorsDir, `${actor.id}.json`);
      await this.writeAtomicJson(p, actor);
    });
  }

  public async getActor(actorId: string): Promise<Actor | null> {
    const p = path.join(this.actorsDir, `${actorId}.json`);
    if (!fsSync.existsSync(p)) return null;
    try {
      const content = await fs.readFile(p, "utf-8");
      return JSON.parse(content) as Actor;
    } catch {
      return null;
    }
  }

  public async listActors(): Promise<Actor[]> {
    if (!fsSync.existsSync(this.actorsDir)) return [];
    const files = await fs.readdir(this.actorsDir);
    const actors: Actor[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const c = await fs.readFile(path.join(this.actorsDir, f), "utf-8");
        actors.push(JSON.parse(c) as Actor);
      } catch {}
    }
    return actors;
  }

  // --- Event Logs ---

  public async appendProjectEvent(event: ProjectEvent): Promise<void> {
    return this.mutex.runExclusive(`event:project:${event.projectId}`, async () => {
      const p = path.join(this.projectLogsDir, `${event.projectId}.jsonl`);
      const line = JSON.stringify(event) + "\n";
      await fs.appendFile(p, line, "utf-8");
    });
  }

  public async getProjectEvents(projectId: string): Promise<ProjectEvent[]> {
    const p = path.join(this.projectLogsDir, `${projectId}.jsonl`);
    if (!fsSync.existsSync(p)) return [];
    try {
      const content = await fs.readFile(p, "utf-8");
      return content
        .trim()
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as ProjectEvent);
    } catch {
      return [];
    }
  }

  public async appendTaskEvent(event: TaskEvent): Promise<void> {
    return this.mutex.runExclusive(`event:task:${event.taskId}`, async () => {
      await writeTaskEvent(this.rootDir, event, false);
    });
  }

  public async appendTaskEventOnce(event: TaskEvent): Promise<"written" | "duplicate"> {
    return this.mutex.runExclusive(`event:task:${event.taskId}`, () => writeTaskEvent(this.rootDir, event, true));
  }

  public async verifyTaskEventReadOnly(event: TaskEvent): Promise<void> {
    return verifyTaskEventReadOnly(this.rootDir, event);
  }

  public async getTaskEvents(taskId: string): Promise<TaskEvent[]> {
    const p = path.join(this.taskLogsDir, `${taskId}.jsonl`);
    if (!fsSync.existsSync(p)) return [];
    try {
      const content = await fs.readFile(p, "utf-8");
      return content
        .trim()
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as TaskEvent);
    } catch {
      return [];
    }
  }

  // Backward-compatible V0.2 aliases
  public async appendEvent(event: TaskEvent): Promise<void> {
    return this.appendTaskEvent(event);
  }

  public async getEvents(taskId: string): Promise<TaskEvent[]> {
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

  public async getTree(taskId: string): Promise<{
    root: Task | null;
    parent: Task | null;
    task: Task | null;
    children: Task[];
  }> {
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

  // --- Task Tree & Hierarchy per Section 九 ---

  public async getAncestors(taskId: string): Promise<Task[]> {
    const ancestors: Task[] = [];
    let current = await this.getTask(taskId);
    const visited = new Set<string>();

    while (current?.parentTaskId && !visited.has(current.parentTaskId)) {
      visited.add(current.parentTaskId);
      const parent = await this.getTask(current.parentTaskId);
      if (!parent) break;
      ancestors.push(parent);
      current = parent;
    }

    return ancestors;
  }

  public async getDescendants(taskId: string): Promise<Task[]> {
    const all = await this.listTasks();
    const descendants: Task[] = [];

    const collect = (parentId: string) => {
      const children = all.filter((t) => t.parentTaskId === parentId);
      for (const child of children) {
        descendants.push(child);
        collect(child.id);
      }
    };

    collect(taskId);
    return descendants;
  }

  public async getRootTask(taskId: string): Promise<Task | null> {
    const ancestors = await this.getAncestors(taskId);
    if (ancestors.length > 0) {
      return ancestors[ancestors.length - 1];
    }
    return this.getTask(taskId);
  }

  public async getTaskTree(taskId: string): Promise<TaskTreeNode | null> {
    const task = await this.getTask(taskId);
    if (!task) return null;

    const all = await this.listTasks({ projectId: task.projectId });

    const buildNode = (currTask: Task): TaskTreeNode => {
      const children = all.filter((t) => t.parentTaskId === currTask.id);
      return {
        task: currTask,
        children: children.map(buildNode),
      };
    };

    return buildNode(task);
  }

  public async getProjectTree(projectId: string): Promise<ProjectTree | null> {
    const project = await this.getProject(projectId);
    if (!project) return null;

    const [epics, tasks] = await Promise.all([
      this.listEpics(projectId),
      this.listTasks({ projectId }),
    ]);

    // Build hierarchical task tree nodes
    const buildTaskNode = (task: Task): TaskTreeNode => {
      const children = tasks.filter((t) => t.parentTaskId === task.id);
      return {
        task,
        children: children.map(buildTaskNode),
      };
    };

    const epicNodes: EpicTreeNode[] = [];

    for (const epic of epics) {
      // Find top-level tasks under this epic (parentTaskId is undefined or null)
      const epicTopLevelTasks = tasks.filter(
        (t) => t.epicId === epic.id && (!t.parentTaskId || !tasks.some((p) => p.id === t.parentTaskId))
      );

      epicNodes.push({
        epic,
        tasks: epicTopLevelTasks.map(buildTaskNode),
      });
    }

    // Standalone tasks without epic
    const standaloneTopTasks = tasks.filter(
      (t) => !t.epicId && (!t.parentTaskId || !tasks.some((p) => p.id === t.parentTaskId))
    );

    return {
      project,
      epics: epicNodes,
      standaloneTasks: standaloneTopTasks.map(buildTaskNode),
    };
  }

  // --- Traceability per Section 二十二 ---

  public async getTraceability(taskId: string): Promise<TaskTraceability | null> {
    const task = await this.getTask(taskId);
    if (!task) return null;

    const [rootTask, parentTask, events] = await Promise.all([
      this.getRootTask(taskId),
      task.parentTaskId ? this.getTask(task.parentTaskId) : Promise.resolve(null),
      this.getTaskEvents(taskId),
    ]);

    const statusHistory: TaskTraceability["statusHistory"] = [];
    const testHistory: TaskTraceability["testHistory"] = [];
    const reviewHistory: TaskTraceability["reviewHistory"] = [];

    for (const ev of events) {
      if (ev.type === "STATUS_CHANGED") {
        const details = ev.details as any;
        statusHistory.push({
          timestamp: ev.timestamp,
          from: details?.from,
          to: details?.to,
          actor: ev.actor,
        });
      } else if (ev.type === "TEST_PASSED" || ev.type === "TEST_FAILED") {
        const details = ev.details as any;
        testHistory.push({
          timestamp: ev.timestamp,
          pass: ev.type === "TEST_PASSED",
          command: details?.command,
        });
      } else if (ev.type === "REVIEW_PASSED" || ev.type === "REVIEW_FAILED") {
        const details = ev.details as any;
        reviewHistory.push({
          timestamp: ev.timestamp,
          status: ev.type === "REVIEW_PASSED" ? "PASS" : "REQUEST_CHANGES",
          feedback: details?.feedback || details?.summary,
        });
      }
    }

    return {
      taskId: task.id,
      title: task.title,
      rootTask,
      parentTask,
      originalRequirement: task.description,
      createdBy: task.source?.id || task.ownerId,
      createdFrom: task.source?.type || "USER",
      ownerType: task.ownerType,
      ownerId: task.ownerId,
      reviewerId: task.reviewerId,
      changedFiles: task.result?.changedFiles || [],
      gitBranch: task.branch,
      worktree: task.worktree,
      statusHistory,
      testHistory,
      reviewHistory,
    };
  }
}
