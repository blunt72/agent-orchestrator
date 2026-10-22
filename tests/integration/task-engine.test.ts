import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TaskEngine } from "../../src/tasks/task-engine.js";
import { Agent, AgentResponse } from "../../src/agents/agent.js";
import { GitService } from "../../src/git/git-service.js";
import { createServer } from "../../src/server/server.js";
import { FastifyInstance } from "fastify";

class MockDeveloperAgent implements Agent {
  public readonly name = "codex";
  public initialized = false;

  async start(): Promise<void> {}
  async initialize(): Promise<void> {
    this.initialized = true;
  }
  async createSession(workspace: string): Promise<string> {
    return "dev-sess-1";
  }
  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    return {
      text: "Implementation completed.\nAGENT_STATUS: CONTINUE",
      stopReason: "end_turn",
    };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
  isRunning(): boolean {
    return this.initialized;
  }
}

class MockReviewerAgent implements Agent {
  public readonly name = "gemini";
  public initialized = false;

  async start(): Promise<void> {}
  async initialize(): Promise<void> {
    this.initialized = true;
  }
  async createSession(workspace: string): Promise<string> {
    return "rev-sess-1";
  }
  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    return {
      text: "REVIEW_STATUS: PASS\nAll requirements satisfied.\nAGENT_STATUS: DONE",
      stopReason: "end_turn",
    };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
  isRunning(): boolean {
    return this.initialized;
  }
}

describe("TaskEngine Integration Tests", () => {
  let tempBaseDir: string;
  let testRepoDir: string;
  let engine: TaskEngine;

  beforeEach(async () => {
    tempBaseDir = path.join(os.tmpdir(), `agenthub-engine-base-${Date.now()}`);
    testRepoDir = path.join(os.tmpdir(), `agenthub-engine-repo-${Date.now()}`);

    fs.mkdirSync(tempBaseDir, { recursive: true });
    fs.mkdirSync(testRepoDir, { recursive: true });

    // Initialize Git repo
    await GitService.exec(["init"], testRepoDir);
    await GitService.exec(["config", "user.name", "Test User"], testRepoDir);
    await GitService.exec(["config", "user.email", "test@example.com"], testRepoDir);

    fs.writeFileSync(path.join(testRepoDir, "README.md"), "# Task Engine Test Repo", "utf-8");
    fs.writeFileSync(
      path.join(testRepoDir, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "node -e 'process.exit(0)'" } }),
      "utf-8"
    );

    await GitService.exec(["add", "."], testRepoDir);
    await GitService.exec(["commit", "-m", "Initial commit"], testRepoDir);

    engine = new TaskEngine({
      baseDir: tempBaseDir,
      codexAgent: new MockDeveloperAgent(),
      geminiAgent: new MockReviewerAgent(),
    });
  });

  afterEach(() => {
    if (fs.existsSync(tempBaseDir)) {
      try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {}
    }
    if (fs.existsSync(testRepoDir)) {
      try {
        fs.rmSync(testRepoDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("creates, retrieves, and lists tasks", async () => {
    const task = await engine.createTask({
      projectId: "proj-alpha",
      title: "Add user profile validation",
      description: "Ensure names and emails are validated",
      workspace: testRepoDir,
      priority: "HIGH",
    });

    expect(task.id).toBeDefined();
    expect(task.status).toBe("TODO");
    expect(task.priority).toBe("HIGH");

    const fetched = await engine.getTask(task.id);
    expect(fetched.id).toBe(task.id);

    const list = await engine.listTasks("proj-alpha");
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(task.id);
  });

  it("runs a task through worktree, test gate, and review to completion", async () => {
    const task = await engine.createTask({
      projectId: "proj-alpha",
      title: "Implement feature A",
      description: "Implement feature A cleanly",
      workspace: testRepoDir,
    });

    const completed = await engine.runTask(task.id);

    expect(completed.status).toBe("DONE");
    expect(completed.worktree).toBeDefined();
    expect(completed.branch).toContain("agent/");
    expect(completed.result?.status).toBe("PASS");
    expect(completed.result?.testStatus).toBe("PASS");
    expect(completed.result?.reviewStatus).toBe("PASS");

    // Events were recorded
    const events = await engine.getStore().getEvents(task.id);
    expect(events.some((e) => e.type === "TASK_CREATED")).toBe(true);
    expect(events.some((e) => e.type === "TASK_STARTED")).toBe(true);
    expect(events.some((e) => e.type === "TEST_PASSED")).toBe(true);
    expect(events.some((e) => e.type === "REVIEW_PASSED")).toBe(true);
    expect(events.some((e) => e.type === "TASK_COMPLETED")).toBe(true);
  });

  it("allows cancelling an active or pending task", async () => {
    const task = await engine.createTask({
      projectId: "proj-alpha",
      title: "Task to cancel",
      description: "Will be cancelled",
      workspace: testRepoDir,
    });

    await engine.cancelTask(task.id);
    const updated = await engine.getTask(task.id);
    expect(updated.status).toBe("CANCELLED");
  });

  it("operates seamlessly through the Fastify REST API", async () => {
    const app: FastifyInstance = createServer(engine);

    // 1. POST /api/tasks
    const createRes = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        projectId: "proj-api",
        title: "API Created Task",
        description: "Task via HTTP",
        workspace: testRepoDir,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    expect(created.id).toBeDefined();
    expect(created.status).toBe("TODO");

    // 2. GET /api/tasks/:id
    const getRes = await app.inject({
      method: "GET",
      url: `/api/tasks/${created.id}`,
    });
    expect(getRes.statusCode).toBe(200);

    // 3. POST /api/tasks/:id/run
    const runRes = await app.inject({
      method: "POST",
      url: `/api/tasks/${created.id}/run`,
    });
    expect(runRes.statusCode).toBe(200);
    const finished = JSON.parse(runRes.body);
    expect(finished.status).toBe("DONE");

    // 4. GET /api/tasks/:id/events
    const evRes = await app.inject({
      method: "GET",
      url: `/api/tasks/${created.id}/events`,
    });
    expect(evRes.statusCode).toBe(200);
    const events = JSON.parse(evRes.body);
    expect(events.length).toBeGreaterThan(0);

    // 5. GET /api/tasks/:id/tree
    const treeRes = await app.inject({
      method: "GET",
      url: `/api/tasks/${created.id}/tree`,
    });
    expect(treeRes.statusCode).toBe(200);
    const tree = JSON.parse(treeRes.body);
    expect(tree.task.id).toBe(created.id);
  });
});
