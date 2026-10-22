import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TaskEngine } from "../../src/tasks/task-engine.js";
import { createServer } from "../../src/server/server.js";
import { GitService } from "../../src/git/git-service.js";
import { Agent, AgentResponse } from "../../src/agents/agent.js";
import { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

class DummyDeveloper implements Agent {
  public readonly name = "codex";
  async start(): Promise<void> {}
  async initialize(): Promise<void> {}
  async createSession(): Promise<string> {
    return "dev-sess";
  }
  async prompt(): Promise<AgentResponse> {
    return { text: "Done.\nAGENT_STATUS: CONTINUE", stopReason: "end_turn" };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

class DummyReviewer implements Agent {
  public readonly name = "gemini";
  async start(): Promise<void> {}
  async initialize(): Promise<void> {}
  async createSession(): Promise<string> {
    return "rev-sess";
  }
  async prompt(): Promise<AgentResponse> {
    return { text: "REVIEW_STATUS: PASS\nAGENT_STATUS: DONE", stopReason: "end_turn" };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

describe("REST API Acceptance Test Suite", () => {
  let app: FastifyInstance;
  let engine: TaskEngine;
  let baseDir: string;

  beforeAll(async () => {
    const nonce = crypto.randomBytes(3).toString("hex");
    baseDir = path.resolve(process.cwd(), `logs/rest-api-test-${nonce}`);
    fs.mkdirSync(baseDir, { recursive: true });

    // Initialize Git repo in baseDir
    await GitService.exec(["init"], baseDir);
    await GitService.exec(["config", "user.name", "REST Acceptance"], baseDir);
    await GitService.exec(["config", "user.email", "rest@agenthub.local"], baseDir);

    fs.writeFileSync(path.join(baseDir, ".gitignore"), ".agenthub\n", "utf-8");
    fs.writeFileSync(
      path.join(baseDir, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "node -e 'process.exit(0)'" } }),
      "utf-8"
    );
    await GitService.exec(["add", "."], baseDir);
    await GitService.exec(["commit", "-m", "Initial commit"], baseDir);

    engine = new TaskEngine({
      baseDir,
      codexAgent: new DummyDeveloper(),
      geminiAgent: new DummyReviewer(),
    });
    app = createServer(engine, false);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (fs.existsSync(baseDir)) {
      try {
        fs.rmSync(baseDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("verifies HTTP status, response schemas, and disk persistence across all REST endpoints", async () => {
    // 1. POST /api/projects
    const projRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Enterprise Demo API Project",
        description: "Full HTTP endpoints validation",
        workspace: baseDir,
      },
    });
    expect(projRes.statusCode).toBe(201);
    const project = projRes.json();
    expect(project.id).toMatch(/^PROJ-/);
    expect(project.name).toBe("Enterprise Demo API Project");
    expect(project.status).toBe("PLANNING");
    expect(project.progress).toBe(0);
    expect(project.createdAt).toBeDefined();
    expect(project.updatedAt).toBeDefined();

    // Verify disk persistence
    const projectDiskPath = path.join(baseDir, `data/projects/${project.id}.json`);
    expect(fs.existsSync(projectDiskPath)).toBe(true);
    const projectOnDisk = JSON.parse(fs.readFileSync(projectDiskPath, "utf-8"));
    expect(projectOnDisk.id).toBe(project.id);
    expect(projectOnDisk.name).toBe(project.name);

    // 2. POST /api/projects/:id/epics
    const epicRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/epics`,
      payload: {
        title: "EPIC-AUTH: Authentication & Access Control",
        description: "Login, session, and role checking",
        priority: "CRITICAL",
      },
    });
    expect(epicRes.statusCode).toBe(201);
    const epic = epicRes.json();
    expect(epic.id).toMatch(/^EPIC-/);
    expect(epic.projectId).toBe(project.id);
    expect(epic.title).toBe("EPIC-AUTH: Authentication & Access Control");
    expect(epic.status).toBe("TODO");
    expect(epic.progress).toBe(0);

    // Verify disk persistence
    const epicDiskPath = path.join(baseDir, `data/epics/${epic.id}.json`);
    expect(fs.existsSync(epicDiskPath)).toBe(true);
    const epicOnDisk = JSON.parse(fs.readFileSync(epicDiskPath, "utf-8"));
    expect(epicOnDisk.id).toBe(epic.id);
    expect(epicOnDisk.projectId).toBe(project.id);

    // 3. POST /api/tasks
    const taskRes = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        projectId: project.id,
        epicId: epic.id,
        title: "TASK-LOGIN: Implement token generator",
        description: "JWT token with 15min expiry",
        workspace: baseDir,
        ownerType: "HUMAN",
        ownerId: "zhangsan",
        estimatedWeight: 1,
      },
    });
    expect(taskRes.statusCode).toBe(201);
    const task = taskRes.json();
    expect(task.id).toMatch(/^TASK-/);
    expect(task.projectId).toBe(project.id);
    expect(task.epicId).toBe(epic.id);
    expect(task.title).toBe("TASK-LOGIN: Implement token generator");
    expect(task.status).toBe("TODO");
    expect(task.ownerType).toBe("HUMAN");
    expect(task.ownerId).toBe("zhangsan");

    // Verify disk persistence
    const taskDiskPath = path.join(baseDir, `data/tasks/${task.id}.json`);
    expect(fs.existsSync(taskDiskPath)).toBe(true);
    const taskOnDisk = JSON.parse(fs.readFileSync(taskDiskPath, "utf-8"));
    expect(taskOnDisk.id).toBe(task.id);
    expect(taskOnDisk.status).toBe("TODO");

    // 4. GET /api/projects/:id
    const getProjRes = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(getProjRes.statusCode).toBe(200);
    const fetchedProj = getProjRes.json();
    expect(fetchedProj.id).toBe(project.id);
    expect(fetchedProj.name).toBe(project.name);

    // 5. GET /api/projects/:id/tree
    const treeRes = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/tree`,
    });
    expect(treeRes.statusCode).toBe(200);
    const tree = treeRes.json();
    expect(tree.project.id).toBe(project.id);
    expect(tree.epics.length).toBe(1);
    expect(tree.epics[0].epic.id).toBe(epic.id);
    expect(tree.epics[0].tasks.length).toBe(1);
    expect(tree.epics[0].tasks[0].task.id).toBe(task.id);

    // 6. GET /api/projects/:id/progress
    const progRes = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/progress`,
    });
    expect(progRes.statusCode).toBe(200);
    const prog = progRes.json();
    expect(prog.projectId).toBe(project.id);
    expect(prog.progress).toBe(0);

    // 7. GET /api/projects/:id/events
    const evRes = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/events`,
    });
    expect(evRes.statusCode).toBe(200);
    const events = evRes.json();
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(1);

    // 8. POST /api/tasks/:id/start
    const startRes = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/start`,
      payload: { userId: "zhangsan" },
    });
    expect(startRes.statusCode).toBe(200);
    const startedTask = startRes.json();
    expect(startedTask.status).toBe("DOING");
    expect(startedTask.progress).toBe(30);

    // Verify disk update
    const taskStartedOnDisk = JSON.parse(fs.readFileSync(taskDiskPath, "utf-8"));
    expect(taskStartedOnDisk.status).toBe("DOING");
    expect(taskStartedOnDisk.progress).toBe(30);

    // 9. POST /api/tasks/:id/block
    const blockRes = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/block`,
      payload: { reason: "Waiting for external oauth client credentials" },
    });
    expect(blockRes.statusCode).toBe(200);
    const blockedTask = blockRes.json();
    expect(blockedTask.status).toBe("BLOCKED");
    expect(blockedTask.nextAction).toContain("Waiting for external oauth client credentials");

    // Verify disk update
    const taskBlockedOnDisk = JSON.parse(fs.readFileSync(taskDiskPath, "utf-8"));
    expect(taskBlockedOnDisk.status).toBe("BLOCKED");

    // 10. POST /api/tasks/:id/unblock
    const unblockRes = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/unblock`,
    });
    expect(unblockRes.statusCode).toBe(200);
    const unblockedTask = unblockRes.json();
    expect(unblockedTask.status).toBe("TODO");

    // Verify disk update
    const taskUnblockedOnDisk = JSON.parse(fs.readFileSync(taskDiskPath, "utf-8"));
    expect(taskUnblockedOnDisk.status).toBe("TODO");

    // 11. POST /api/tasks/:id/respond (simulate human responding to NEED_USER)
    const currentTask = await engine.getTask(task.id);
    currentTask.status = "NEED_USER";
    currentTask.nextAction = "Waiting for human guidance";
    await engine.getStore().saveTask(currentTask);

    const respondRes = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/respond`,
      payload: {
        userId: "zhangsan",
        message: "Use RS256 algorithm with 2048-bit RSA key pair.",
      },
    });
    expect(respondRes.statusCode).toBe(200);
    const respondedTask = respondRes.json();
    expect(respondedTask.description).toContain("Use RS256 algorithm with 2048-bit RSA key pair.");

    // 12. POST /api/tasks/:id/complete
    const completeRes = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/complete`,
      payload: {
        userId: "zhangsan",
        summary: "Token generator fully tested and signed off.",
      },
    });
    expect(completeRes.statusCode).toBe(200);
    const completedTask = completeRes.json();
    expect(completedTask.status).toBe("DONE");
    expect(completedTask.progress).toBe(100);

    // Verify disk update
    const taskCompletedOnDisk = JSON.parse(fs.readFileSync(taskDiskPath, "utf-8"));
    expect(taskCompletedOnDisk.status).toBe("DONE");
    expect(taskCompletedOnDisk.progress).toBe(100);

    // 13. POST /api/tasks/:id/cancel
    const taskToCancelRes = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        projectId: project.id,
        title: "Temporary Task To Cancel",
        workspace: baseDir,
      },
    });
    expect(taskToCancelRes.statusCode).toBe(201);
    const taskToCancel = taskToCancelRes.json();

    const cancelRes = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskToCancel.id}/cancel`,
    });
    expect(cancelRes.statusCode).toBe(200);
    const cancelledTask = cancelRes.json();
    expect(cancelledTask.status).toBe("CANCELLED");

    // Verify disk update
    const cancelDiskPath = path.join(baseDir, `data/tasks/${taskToCancel.id}.json`);
    const cancelledOnDisk = JSON.parse(fs.readFileSync(cancelDiskPath, "utf-8"));
    expect(cancelledOnDisk.status).toBe("CANCELLED");
  });
});
