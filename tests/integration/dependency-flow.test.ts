import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectEngine } from "../../src/projects/project-engine.js";
import { Agent, AgentResponse } from "../../src/agents/agent.js";
import { GitService } from "../../src/git/git-service.js";

class FastMockDeveloper implements Agent {
  public readonly name = "codex";
  async start(): Promise<void> {}
  async initialize(): Promise<void> {}
  async createSession(): Promise<string> {
    return "dev-sess";
  }
  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    const wtMatch = message.match(/Workspace:\s*([^\n]+)/);
    if (wtMatch) {
      fs.writeFileSync(path.join(wtMatch[1].trim(), "test.js"), "process.exit(0);", "utf-8");
    }
    return { text: "Done.\nAGENT_STATUS: CONTINUE" };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

class FastMockReviewer implements Agent {
  public readonly name = "gemini";
  async start(): Promise<void> {}
  async initialize(): Promise<void> {}
  async createSession(): Promise<string> {
    return "rev-sess";
  }
  async prompt(): Promise<AgentResponse> {
    return { text: "REVIEW_STATUS: PASS\nAGENT_STATUS: DONE" };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

describe("Task Dependency Flow Integration Tests", () => {
  let tempBaseDir: string;
  let testRepoDir: string;
  let engine: ProjectEngine;

  beforeEach(async () => {
    tempBaseDir = path.join(os.tmpdir(), `agenthub-dep-base-${Date.now()}`);
    testRepoDir = path.join(os.tmpdir(), `agenthub-dep-repo-${Date.now()}`);

    fs.mkdirSync(tempBaseDir, { recursive: true });
    fs.mkdirSync(testRepoDir, { recursive: true });

    await GitService.exec(["init"], testRepoDir);
    await GitService.exec(["config", "user.name", "Test User"], testRepoDir);
    await GitService.exec(["config", "user.email", "test@example.com"], testRepoDir);

    fs.writeFileSync(path.join(testRepoDir, "README.md"), "# Dep Test", "utf-8");
    fs.writeFileSync(
      path.join(testRepoDir, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "node test.js" } }),
      "utf-8"
    );
    fs.writeFileSync(path.join(testRepoDir, "test.js"), "process.exit(0);", "utf-8");

    await GitService.exec(["add", "."], testRepoDir);
    await GitService.exec(["commit", "-m", "Initial commit"], testRepoDir);

    engine = new ProjectEngine({
      baseDir: tempBaseDir,
      codexAgent: new FastMockDeveloper(),
      geminiAgent: new FastMockReviewer(),
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

  it("handles dependency blocking, automatic unblocking on completion, and execution", async () => {
    const project = await engine.createProject({
      name: "Dependency Flow Project",
      workspace: testRepoDir,
    });

    // 1. Create Task A
    const taskA = await engine.createTask({
      projectId: project.id,
      title: "Task A (Base Feature)",
      description: "Must finish first",
      workspace: testRepoDir,
    });
    expect(taskA.status).toBe("TODO");

    // 2. Create Task B which depends on Task A
    const taskB = await engine.createTask({
      projectId: project.id,
      title: "Task B (Dependent Feature)",
      description: "Depends on Task A",
      workspace: testRepoDir,
      dependsOn: [taskA.id],
    });
    expect(taskB.status).toBe("BLOCKED");
    expect(taskB.blockedBy).toEqual([taskA.id]);
    expect(taskB.nextAction).toContain("等待前置依赖任务完成");

    // 3. Attempting to run Task B while blocked must fail
    await expect(engine.runTask(taskB.id)).rejects.toThrow(/Cannot run BLOCKED task/);

    // 4. Run Task A to completion
    const completedA = await engine.runTask(taskA.id);
    expect(completedA.status).toBe("DONE");

    // 5. Verify Task B was automatically unblocked!
    const updatedB = await engine.getTask(taskB.id);
    expect(updatedB).not.toBeNull();
    expect(updatedB?.status).toBe("TODO");
    expect(updatedB?.nextAction).not.toContain("等待前置依赖任务完成");

    // Verify TASK_UNBLOCKED event in Task B logs
    const bEvents = await engine.getStore().getTaskEvents(taskB.id);
    expect(bEvents.some((e) => e.type === "TASK_UNBLOCKED")).toBe(true);

    // 6. Now Task B can run cleanly to DONE
    const completedB = await engine.runTask(taskB.id);
    expect(completedB.status).toBe("DONE");
  });
});
