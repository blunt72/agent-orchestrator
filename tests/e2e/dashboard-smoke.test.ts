import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TaskEngine } from "../../src/tasks/task-engine.js";
import { createServer } from "../../src/server/server.js";
import { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

describe("Dashboard Smoke & REST API E2E", () => {
  let app: FastifyInstance;
  let engine: TaskEngine;
  let baseDir: string;

  beforeAll(async () => {
    const nonce = crypto.randomBytes(3).toString("hex");
    baseDir = path.resolve(process.cwd(), `logs/smoke-test-${nonce}`);
    fs.mkdirSync(baseDir, { recursive: true });

    engine = new TaskEngine({ baseDir });
    app = createServer(engine, false);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (fs.existsSync(baseDir)) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("serves HTML dashboard at GET / and GET /dashboard", async () => {
    const resRoot = await app.inject({ method: "GET", url: "/" });
    expect(resRoot.statusCode).toBe(200);
    expect(resRoot.headers["content-type"]).toContain("text/html");
    const htmlRoot = resRoot.body;
    expect(htmlRoot).toContain("Codex × Gemini AgentHub");
    expect(htmlRoot).toContain("V0.3 Internal Alpha");
    expect(htmlRoot).toContain("EventSource");
    expect(htmlRoot).toContain("task-tree-container");

    const resDash = await app.inject({ method: "GET", url: "/dashboard" });
    expect(resDash.statusCode).toBe(200);
    expect(resDash.headers["content-type"]).toContain("text/html");
    const htmlDash = resDash.body;
    expect(htmlDash).toContain("Codex × Gemini AgentHub");
  });

  it("validates full REST API lifecycle: Project -> Epic -> Task -> Human Ops -> Tree & Traceability", async () => {
    // 1. Create Project
    const projRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Demo Smoke Project",
        description: "Smoke test project for REST endpoints",
        workspace: baseDir,
      },
    });
    expect(projRes.statusCode).toBe(201);
    const project = projRes.json();
    expect(project.id).toBeDefined();
    expect(project.name).toBe("Demo Smoke Project");

    // 2. List Projects
    const listProjRes = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listProjRes.statusCode).toBe(200);
    const projects = listProjRes.json();
    expect(projects.some((p: any) => p.id === project.id)).toBe(true);

    // 3. Create Epic
    const epicRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/epics`,
      payload: {
        title: "EPIC-1: Authentication Module",
        description: "Login and token verification",
        priority: "HIGH",
      },
    });
    expect(epicRes.statusCode).toBe(201);
    const epic = epicRes.json();
    expect(epic.id).toBeDefined();
    expect(epic.projectId).toBe(project.id);

    // 4. Create Task under Epic
    const taskRes = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        projectId: project.id,
        epicId: epic.id,
        title: "TASK-1: Design login schema",
        description: "Human review schema design",
        ownerType: "HUMAN",
        ownerId: "zhangsan",
        workspace: baseDir,
      },
    });
    expect(taskRes.statusCode).toBe(201);
    const task = taskRes.json();
    expect(task.id).toBeDefined();
    expect(task.ownerType).toBe("HUMAN");
    expect(task.status).toBe("TODO");

    // 5. Assign Task to another member
    const assignRes = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/assign`,
      payload: {
        ownerId: "lisi",
        ownerType: "HUMAN",
      },
    });
    expect(assignRes.statusCode).toBe(200);
    const assignedTask = assignRes.json();
    expect(assignedTask.ownerId).toBe("lisi");

    // 6. Start Human Task
    const startRes = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/start`,
      payload: { userId: "lisi" },
    });
    expect(startRes.statusCode).toBe(200);
    const startedTask = startRes.json();
    expect(startedTask.status).toBe("DOING");
    expect(startedTask.progress).toBe(30);

    // 7. Complete Human Task
    const completeRes = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/complete`,
      payload: {
        userId: "lisi",
        summary: "Schema designed and verified successfully.",
      },
    });
    expect(completeRes.statusCode).toBe(200);
    const completedTask = completeRes.json();
    expect(completedTask.status).toBe("DONE");
    expect(completedTask.progress).toBe(100);

    // 8. Verify Project Progress updated to 100%
    const progressRes = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/progress`,
    });
    expect(progressRes.statusCode).toBe(200);
    const progressData = progressRes.json();
    expect(progressData.progress).toBe(100);

    // 9. Verify Project Tree
    const treeRes = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/tree`,
    });
    expect(treeRes.statusCode).toBe(200);
    const tree = treeRes.json();
    expect(tree.project.id).toBe(project.id);
    expect(tree.epics.length).toBe(1);
    expect(tree.epics[0].tasks.length).toBe(1);
    expect(tree.epics[0].tasks[0].task.id).toBe(task.id);

    // 10. Verify Task Traceability
    const traceRes = await app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}/traceability`,
    });
    expect(traceRes.statusCode).toBe(200);
    const trace = traceRes.json();
    expect(trace.taskId).toBe(task.id);
    expect(trace.title).toBe(task.title);
    expect(trace.ownerId).toBe("lisi");
    expect(trace.statusHistory.length).toBeGreaterThanOrEqual(1);

    // 11. Verify Project Events Timeline
    const eventsRes = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/events`,
    });
    expect(eventsRes.statusCode).toBe(200);
    const events = eventsRes.json();
    expect(events.length).toBeGreaterThanOrEqual(4);
  });
});
