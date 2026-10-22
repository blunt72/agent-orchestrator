import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TaskEngine } from "../../src/tasks/task-engine.js";
import { startServer } from "../../src/server/server.js";
import { FastifyInstance } from "fastify";

describe("SSE Real Event Stream Acceptance Test", () => {
  let app: FastifyInstance;
  let serverPort: number;
  let engine: TaskEngine;
  let baseDir: string;

  beforeAll(async () => {
    const nonce = crypto.randomBytes(3).toString("hex");
    baseDir = path.resolve(process.cwd(), `logs/sse-test-${nonce}`);
    fs.mkdirSync(baseDir, { recursive: true });

    engine = new TaskEngine({ baseDir });
    const srv = await startServer({ engine, port: 0, host: "127.0.0.1" });
    app = srv.app;
    serverPort = srv.port;
  });

  afterAll(async () => {
    await app.close();
    if (fs.existsSync(baseDir)) {
      try {
        fs.rmSync(baseDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("client opens SSE stream and receives task.created, task.started, task.status_changed, project.progress_changed, and task.done in real-time", async () => {
    // 1. Create project
    const project = await engine.createProject({
      name: "SSE Test Project",
      workspace: baseDir,
    });
    const projectId = project.id;

    // 2. Open HTTP connection to GET /api/projects/:id/events/stream
    const receivedEvents: Array<{ type: string; data: any }> = [];
    let streamConnected = false;

    const req = http.request({
      hostname: "127.0.0.1",
      port: serverPort,
      path: `/api/projects/${projectId}/events/stream`,
      method: "GET",
      headers: {
        Accept: "text/event-stream",
      },
    });

    let buffer = "";

    req.on("response", (res) => {
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");

      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");

        if (buffer.includes(": connected")) {
          streamConnected = true;
        }

        // Parse SSE messages (delimited by \n\n)
        const parts = buffer.split("\n\n");
        // Keep the last partial chunk in buffer
        buffer = parts.pop() || "";

        for (const part of parts) {
          const lines = part.trim().split("\n");
          let evType = "message";
          let evDataStr = "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              evType = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              evDataStr = line.slice(6).trim();
            }
          }

          if (evDataStr) {
            try {
              const parsed = JSON.parse(evDataStr);
              receivedEvents.push({ type: evType, data: parsed });
            } catch {}
          }
        }
      });
    });

    req.end();

    // Wait until SSE stream connected
    const startWait = Date.now();
    while (!streamConnected && Date.now() - startWait < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(streamConnected).toBe(true);

    // 3. Trigger: create task
    const task = await engine.createTask({
      projectId,
      title: "SSE Task 1",
      description: "Test task for real-time SSE stream",
      ownerType: "HUMAN",
      ownerId: "zhangsan",
      workspace: baseDir,
    });

    // 4. Trigger: start task (emits task.started & task.status_changed)
    await engine.startHumanTask(task.id, "zhangsan");

    // 5. Trigger: complete task (emits task.done & project.progress_changed)
    await engine.completeHumanTask(task.id, "zhangsan", "Completed successfully");

    // Wait for client to receive all events
    const waitEventsStart = Date.now();
    while (receivedEvents.length < 5 && Date.now() - waitEventsStart < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Close the HTTP request
    req.destroy();

    // 6. Verify client received required events
    const eventTypes = receivedEvents.map((e) => e.type);
    expect(eventTypes).toContain("task.created");
    expect(eventTypes).toContain("task.started");
    expect(eventTypes).toContain("task.status_changed");
    expect(eventTypes).toContain("project.progress_changed");
    expect(eventTypes).toContain("task.done");

    // 7. Verify event payload schema for each event:
    // event type, projectId, taskId, timestamp
    const createdEv = receivedEvents.find((e) => e.type === "task.created")?.data;
    expect(createdEv).toBeDefined();
    expect(createdEv.type).toBe("task.created");
    expect(createdEv.projectId).toBe(projectId);
    expect(createdEv.taskId).toBe(task.id);
    expect(createdEv.timestamp).toBeDefined();
    expect(new Date(createdEv.timestamp).getTime()).not.toBeNaN();

    const startedEv = receivedEvents.find((e) => e.type === "task.started")?.data;
    expect(startedEv).toBeDefined();
    expect(startedEv.type).toBe("task.started");
    expect(startedEv.projectId).toBe(projectId);
    expect(startedEv.taskId).toBe(task.id);
    expect(startedEv.timestamp).toBeDefined();

    const statusChangedEv = receivedEvents.find((e) => e.type === "task.status_changed")?.data;
    expect(statusChangedEv).toBeDefined();
    expect(statusChangedEv.type).toBe("task.status_changed");
    expect(statusChangedEv.projectId).toBe(projectId);
    expect(statusChangedEv.taskId).toBe(task.id);
    expect(statusChangedEv.timestamp).toBeDefined();

    const doneEv = receivedEvents.find((e) => e.type === "task.done")?.data;
    expect(doneEv).toBeDefined();
    expect(doneEv.type).toBe("task.done");
    expect(doneEv.projectId).toBe(projectId);
    expect(doneEv.taskId).toBe(task.id);
    expect(doneEv.timestamp).toBeDefined();

    const progressEv = receivedEvents.find((e) => e.type === "project.progress_changed")?.data;
    expect(progressEv).toBeDefined();
    expect(progressEv.type).toBe("project.progress_changed");
    expect(progressEv.projectId).toBe(projectId);
    expect(progressEv.timestamp).toBeDefined();
  });
});
