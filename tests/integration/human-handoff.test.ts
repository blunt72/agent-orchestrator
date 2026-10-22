import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectEngine } from "../../src/projects/project-engine.js";
import { Agent, AgentResponse } from "../../src/agents/agent.js";
import { GitService } from "../../src/git/git-service.js";

describe("Human Task & Human Handoff Integration Tests", () => {
  let tempBaseDir: string;
  let testRepoDir: string;

  beforeEach(async () => {
    tempBaseDir = path.join(os.tmpdir(), `agenthub-hh-base-${Date.now()}`);
    testRepoDir = path.join(os.tmpdir(), `agenthub-hh-repo-${Date.now()}`);

    fs.mkdirSync(tempBaseDir, { recursive: true });
    fs.mkdirSync(testRepoDir, { recursive: true });

    await GitService.exec(["init"], testRepoDir);
    await GitService.exec(["config", "user.name", "Test User"], testRepoDir);
    await GitService.exec(["config", "user.email", "test@example.com"], testRepoDir);

    fs.writeFileSync(path.join(testRepoDir, "README.md"), "# HH Test", "utf-8");
    fs.writeFileSync(
      path.join(testRepoDir, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "node test.js" } }),
      "utf-8"
    );
    fs.writeFileSync(path.join(testRepoDir, "test.js"), "process.exit(0);", "utf-8");

    await GitService.exec(["add", "."], testRepoDir);
    await GitService.exec(["commit", "-m", "Initial commit"], testRepoDir);
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

  it("handles Human Task manual lifecycle (start -> complete -> unblock dependent AI task)", async () => {
    const engine = new ProjectEngine({
      baseDir: tempBaseDir,
    });

    const project = await engine.createProject({
      name: "Human Task Project",
      workspace: testRepoDir,
    });

    // 1. Create Human Task
    const humanTask = await engine.createTask({
      projectId: project.id,
      title: "Architecture Review by Human Tech Lead",
      description: "Human lead approves schema",
      workspace: testRepoDir,
      ownerType: "HUMAN",
      ownerId: "zhangsan",
    });

    expect(humanTask.ownerType).toBe("HUMAN");
    expect(humanTask.ownerId).toBe("zhangsan");
    expect(humanTask.status).toBe("TODO");
    expect(humanTask.nextAction).toBe("等待人类成员开始任务");

    // 2. Human starts task
    const started = await engine.startHumanTask(humanTask.id, "zhangsan");
    expect(started.status).toBe("DOING");
    expect(started.nextAction).toBe("等待人类成员处理并标记完成");

    // 3. Human completes task
    const completed = await engine.completeHumanTask(
      humanTask.id,
      "zhangsan",
      "Schema verified and approved by Tech Lead."
    );
    expect(completed.status).toBe("DONE");
    expect(completed.progress).toBe(100);
    expect(completed.result?.summary).toContain("Tech Lead");
  });

  it("handles AI NEED_USER handoff to human, and user respond resuming AI to completion", async () => {
    let callCount = 0;

    class PausingDeveloper implements Agent {
      public readonly name = "codex";
      async start(): Promise<void> {}
      async initialize(): Promise<void> {}
      async createSession(): Promise<string> {
        return "sess-dev";
      }
      async prompt(sessionId: string, message: string): Promise<AgentResponse> {
        callCount++;
        if (callCount === 1) {
          // AI needs human decision
          return {
            text: "Need clarification on API schema.\nAGENT_STATUS: NEED_USER",
          };
        } else {
          // Resumed after human input: fixes code
          const wtMatch = message.match(/Workspace:\s*([^\n]+)/);
          if (wtMatch) {
            fs.writeFileSync(path.join(wtMatch[1].trim(), "test.js"), "process.exit(0);", "utf-8");
          }
          return {
            text: "Adopted user strategy. Implementation complete.\nAGENT_STATUS: CONTINUE",
          };
        }
      }
      async cancel(): Promise<void> {}
      async close(): Promise<void> {}
    }

    class SimpleReviewer implements Agent {
      public readonly name = "gemini";
      async start(): Promise<void> {}
      async initialize(): Promise<void> {}
      async createSession(): Promise<string> {
        return "sess-rev";
      }
      async prompt(): Promise<AgentResponse> {
        return { text: "REVIEW_STATUS: PASS\nAGENT_STATUS: DONE" };
      }
      async cancel(): Promise<void> {}
      async close(): Promise<void> {}
    }

    const engine = new ProjectEngine({
      baseDir: tempBaseDir,
      codexAgent: new PausingDeveloper(),
      geminiAgent: new SimpleReviewer(),
    });

    const project = await engine.createProject({
      name: "Handoff Project",
      workspace: testRepoDir,
    });

    const task = await engine.createTask({
      projectId: project.id,
      title: "API Migration",
      description: "Migrate legacy API",
      workspace: testRepoDir,
    });

    // 1. Initial run: hits NEED_USER
    const pausedTask = await engine.runTask(task.id);
    expect(pausedTask.status).toBe("NEED_USER");
    expect(pausedTask.ownerType).toBe("HUMAN");
    expect(pausedTask.nextAction).toBeDefined();

    // 2. User provides decision via respondToNeedUser
    const resumedTask = await engine.respondToNeedUser(
      task.id,
      "采用方案 B，保持旧 API 兼容。",
      "user-001"
    );

    // 3. Execution resumes with Codex and completes to DONE!
    expect(resumedTask.status).toBe("DONE");
    expect(callCount).toBe(2);
    expect(resumedTask.description).toContain("采用方案 B，保持旧 API 兼容。");
  });
});
