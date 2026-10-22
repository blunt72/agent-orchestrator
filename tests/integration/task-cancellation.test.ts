import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectEngine } from "../../src/projects/project-engine.js";
import { Agent, AgentResponse } from "../../src/agents/agent.js";
import { GitService } from "../../src/git/git-service.js";

class SlowCodexAgent implements Agent {
  public readonly name = "codex";
  public initialized = false;
  public promptCalled = false;
  public cancelCalled = false;
  private cancelCallback?: () => void;

  async start(): Promise<void> {}
  async initialize(): Promise<void> {
    this.initialized = true;
  }
  async createSession(workspace: string): Promise<string> {
    return "session-slow-codex";
  }
  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    this.promptCalled = true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          text: "Finished slowly.\nAGENT_STATUS: CONTINUE",
          stopReason: "end_turn",
        });
      }, 5000);

      this.cancelCallback = () => {
        clearTimeout(timer);
        resolve({
          text: "Aborted.\nAGENT_STATUS: CONTINUE",
          stopReason: "cancelled",
        });
      };
    });
  }
  async cancel(sessionId?: string): Promise<void> {
    this.cancelCalled = true;
    if (this.cancelCallback) {
      this.cancelCallback();
    }
  }
  async close(): Promise<void> {}
  isRunning(): boolean {
    return this.initialized;
  }
}

class NeverCalledGeminiAgent implements Agent {
  public readonly name = "gemini";
  public promptCalled = false;
  public cancelCalled = false;

  async start(): Promise<void> {}
  async initialize(): Promise<void> {}
  async createSession(workspace: string): Promise<string> {
    return "session-gemini";
  }
  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    this.promptCalled = true;
    return {
      text: "REVIEW_STATUS: PASS\nAGENT_STATUS: DONE",
      stopReason: "end_turn",
    };
  }
  async cancel(sessionId?: string): Promise<void> {
    this.cancelCalled = true;
  }
  async close(): Promise<void> {}
  isRunning(): boolean {
    return true;
  }
}

describe("Item 8: Running Task Cancellation", () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-cancel-test-"));
    repoDir = path.join(tempDir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });

    // Initialize minimal git repo for worktree
    await GitService.exec(["init"], repoDir);
    await GitService.exec(["config", "user.name", "Cancel Test"], repoDir);
    await GitService.exec(["config", "user.email", "cancel@test.local"], repoDir);

    fs.writeFileSync(
      path.join(repoDir, "package.json"),
      JSON.stringify({ name: "cancel-test", scripts: { test: "echo ok" } }),
      "utf-8"
    );
    await GitService.exec(["add", "."], repoDir);
    await GitService.exec(["commit", "-m", "initial"], repoDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("cancels in-flight task execution immediately: halts agent, cancels session, and prevents reviewer launch", async () => {
    const codex = new SlowCodexAgent();
    const gemini = new NeverCalledGeminiAgent();

    const engine = new ProjectEngine({
      baseDir: tempDir,
      codexAgent: codex,
      geminiAgent: gemini,
    });

    const project = await engine.createProject({
      id: "PROJ-CANCEL-1",
      name: "Cancellation Test Project",
      workspace: repoDir,
    });

    const task = await engine.createTask({
      id: "TASK-CANCEL-TEST",
      projectId: project.id,
      title: "Long Running Task to Cancel",
      workspace: repoDir,
      testCommand: "npm test",
    });

    expect(task.status).toBe("TODO");

    // Launch task execution asynchronously in background
    const runPromise = engine.runTask(task.id);

    // Wait until Codex prompt is invoked
    let waitCount = 0;
    while (!codex.promptCalled && waitCount < 50) {
      await new Promise((r) => setTimeout(r, 50));
      waitCount++;
    }
    expect(codex.promptCalled).toBe(true);

    // Cancel the running task while Codex is in the middle of prompt
    const cancelledTask = await engine.cancelTask(task.id);
    expect(cancelledTask.status).toBe("CANCELLED");
    expect(codex.cancelCalled).toBe(true);

    // Await runTask completion
    const finalRunResult = await runPromise;
    expect(finalRunResult.status).toBe("CANCELLED");

    // Verify task state in store is strictly CANCELLED
    const storedTask = await engine.getTask(task.id);
    expect(storedTask?.status).toBe("CANCELLED");

    // CRITICAL: Reviewer was never invoked! Execution halted!
    expect(gemini.promptCalled).toBe(false);

    // Verify audit event log
    const events = await engine.getStore().getEvents(task.id);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("TASK_CREATED");
    expect(eventTypes).toContain("STATUS_CHANGED");
    expect(eventTypes).not.toContain("REVIEW_STARTED");
    expect(eventTypes).not.toContain("TASK_COMPLETED");
  });

  it("cancels queued task before it even starts", async () => {
    const codex = new SlowCodexAgent();
    const gemini = new NeverCalledGeminiAgent();

    const engine = new ProjectEngine({
      baseDir: tempDir,
      codexAgent: codex,
      geminiAgent: gemini,
      maxConcurrentTasks: 1, // Only 1 task running at a time
    });

    const project = await engine.createProject({
      id: "PROJ-QUEUE-CANCEL",
      name: "Queue Cancel Project",
      workspace: repoDir,
    });

    const task1 = await engine.createTask({
      id: "TASK-RUNNING",
      projectId: project.id,
      title: "Running Task",
      workspace: repoDir,
      testCommand: "npm test",
    });

    const task2 = await engine.createTask({
      id: "TASK-QUEUED",
      projectId: project.id,
      title: "Queued Task to Cancel",
      workspace: repoDir,
      testCommand: "npm test",
    });

    // Start task1 -> takes concurrency slot
    const p1 = engine.runTask(task1.id);

    // Cancel task2 while queued / pending
    const cancelled2 = await engine.cancelTask(task2.id);
    expect(cancelled2.status).toBe("CANCELLED");

    // Cancel task1 as well
    await engine.cancelTask(task1.id);
    await p1;

    const stored2 = await engine.getTask(task2.id);
    expect(stored2?.status).toBe("CANCELLED");
  });
});
