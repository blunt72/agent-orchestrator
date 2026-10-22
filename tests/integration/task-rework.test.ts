import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TaskEngine } from "../../src/tasks/task-engine.js";
import { Agent, AgentResponse } from "../../src/agents/agent.js";
import { GitService } from "../../src/git/git-service.js";

describe("Task Rework & Error Handling Integration Tests", () => {
  let tempBaseDir: string;
  let testRepoDir: string;

  beforeEach(async () => {
    tempBaseDir = path.join(os.tmpdir(), `agenthub-rework-base-${Date.now()}`);
    testRepoDir = path.join(os.tmpdir(), `agenthub-rework-repo-${Date.now()}`);

    fs.mkdirSync(tempBaseDir, { recursive: true });
    fs.mkdirSync(testRepoDir, { recursive: true });

    // Initialize Git repo
    await GitService.exec(["init"], testRepoDir);
    await GitService.exec(["config", "user.name", "Test User"], testRepoDir);
    await GitService.exec(["config", "user.email", "test@example.com"], testRepoDir);

    fs.writeFileSync(path.join(testRepoDir, "README.md"), "# Rework Repo", "utf-8");
    fs.writeFileSync(
      path.join(testRepoDir, "package.json"),
      JSON.stringify({ name: "rework-demo", scripts: { test: "node test.js" } }),
      "utf-8"
    );

    // Initial failing test
    fs.writeFileSync(path.join(testRepoDir, "test.js"), "process.exit(1);", "utf-8");

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

  it("Case A: Test failure transitions TESTING -> REWORK -> DOING and does NOT enter REVIEW", async () => {
    let devCallCount = 0;
    let reviewerCalled = false;

    class TestFixingDeveloper implements Agent {
      public readonly name = "codex";
      async start(): Promise<void> {}
      async initialize(): Promise<void> {}
      async createSession(workspace: string): Promise<string> {
        return "sess-fix";
      }
      async prompt(sessionId: string, message: string): Promise<AgentResponse> {
        devCallCount++;
        if (devCallCount === 1) {
          // Round 1: leaves test failing
          return { text: "Tried fix, but still testing.\nAGENT_STATUS: CONTINUE" };
        } else {
          // Round 2: receives failure notice and fixes test.js in worktree
          // We can find the worktree from prompt or fix it
          const wtMatch = message.match(/Workspace:\s*([^\n]+)/);
          if (wtMatch) {
            fs.writeFileSync(path.join(wtMatch[1].trim(), "test.js"), "process.exit(0);", "utf-8");
          }
          return { text: "Fixed test.js properly now.\nAGENT_STATUS: CONTINUE" };
        }
      }
      async cancel(): Promise<void> {}
      async close(): Promise<void> {}
    }

    class SpyReviewer implements Agent {
      public readonly name = "gemini";
      async start(): Promise<void> {}
      async initialize(): Promise<void> {}
      async createSession(workspace: string): Promise<string> {
        return "sess-rev";
      }
      async prompt(sessionId: string, message: string): Promise<AgentResponse> {
        reviewerCalled = true;
        return { text: "REVIEW_STATUS: PASS\nAll good.\nAGENT_STATUS: DONE" };
      }
      async cancel(): Promise<void> {}
      async close(): Promise<void> {}
    }

    const engine = new TaskEngine({
      baseDir: tempBaseDir,
      codexAgent: new TestFixingDeveloper(),
      geminiAgent: new SpyReviewer(),
    });

    const task = await engine.createTask({
      projectId: "rework-p",
      title: "Fix broken test",
      description: "Make test pass",
      workspace: testRepoDir,
      maxRounds: 6,
    });

    const completed = await engine.runTask(task.id);
    expect(completed.status).toBe("DONE");
    expect(devCallCount).toBe(2);
    expect(reviewerCalled).toBe(true);

    const events = await engine.getStore().getEvents(task.id);
    const hasTestFailed = events.some((e) => e.type === "TEST_FAILED");
    const hasReworkStarted = events.some((e) => e.type === "REWORK_STARTED");
    const hasTestPassed = events.some((e) => e.type === "TEST_PASSED");

    expect(hasTestFailed).toBe(true);
    expect(hasReworkStarted).toBe(true);
    expect(hasTestPassed).toBe(true);
  });

  it("Case B: Gemini REQUEST_CHANGES transitions REVIEW -> REWORK -> DOING", async () => {
    let reviewCount = 0;
    let devCount = 0;

    class MultiTurnDev implements Agent {
      public readonly name = "codex";
      async start(): Promise<void> {}
      async initialize(): Promise<void> {}
      async createSession(workspace: string): Promise<string> {
        return "sess-dev";
      }
      async prompt(sessionId: string, message: string): Promise<AgentResponse> {
        devCount++;
        const wtMatch = message.match(/Workspace:\s*([^\n]+)/);
        if (wtMatch) {
          fs.writeFileSync(path.join(wtMatch[1].trim(), "test.js"), "process.exit(0);", "utf-8");
        }
        return { text: `Dev turn ${devCount} complete.\nAGENT_STATUS: CONTINUE` };
      }
      async cancel(): Promise<void> {}
      async close(): Promise<void> {}
    }

    class MultiTurnReviewer implements Agent {
      public readonly name = "gemini";
      async start(): Promise<void> {}
      async initialize(): Promise<void> {}
      async createSession(workspace: string): Promise<string> {
        return "sess-rev";
      }
      async prompt(sessionId: string, message: string): Promise<AgentResponse> {
        reviewCount++;
        if (reviewCount === 1) {
          return {
            text: "REVIEW_STATUS: REQUEST_CHANGES\nPlease add edge case validation for null inputs.\nAGENT_STATUS: CONTINUE",
          };
        }
        return {
          text: "REVIEW_STATUS: PASS\nEdge cases addressed.\nAGENT_STATUS: DONE",
        };
      }
      async cancel(): Promise<void> {}
      async close(): Promise<void> {}
    }

    const engine = new TaskEngine({
      baseDir: tempBaseDir,
      codexAgent: new MultiTurnDev(),
      geminiAgent: new MultiTurnReviewer(),
    });

    const task = await engine.createTask({
      projectId: "rework-p",
      title: "Refactor API",
      description: "Refactor with review feedback",
      workspace: testRepoDir,
      maxRounds: 6,
    });

    const completed = await engine.runTask(task.id);
    expect(completed.status).toBe("DONE");
    expect(reviewCount).toBe(2);
    expect(devCount).toBe(2);

    const events = await engine.getStore().getEvents(task.id);
    expect(events.some((e) => e.type === "REVIEW_FAILED")).toBe(true);
    expect(events.some((e) => e.type === "REVIEW_PASSED")).toBe(true);
  });

  it("Case C: Exceeding maxRounds safely transitions to NEED_USER", async () => {
    class InfiniteRejectingReviewer implements Agent {
      public readonly name = "gemini";
      async start(): Promise<void> {}
      async initialize(): Promise<void> {}
      async createSession(workspace: string): Promise<string> {
        return "sess-inf-rev";
      }
      async prompt(): Promise<AgentResponse> {
        return {
          text: "REVIEW_STATUS: REQUEST_CHANGES\nStill not satisfied.\nAGENT_STATUS: CONTINUE",
        };
      }
      async cancel(): Promise<void> {}
      async close(): Promise<void> {}
    }

    class AlwaysPassingDev implements Agent {
      public readonly name = "codex";
      async start(): Promise<void> {}
      async initialize(): Promise<void> {}
      async createSession(workspace: string): Promise<string> {
        return "sess-inf-dev";
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

    const engine = new TaskEngine({
      baseDir: tempBaseDir,
      codexAgent: new AlwaysPassingDev(),
      geminiAgent: new InfiniteRejectingReviewer(),
    });

    const task = await engine.createTask({
      projectId: "rework-p",
      title: "Infinite loop task",
      description: "Should hit max rounds",
      workspace: testRepoDir,
      maxRounds: 2,
    });

    const pausedTask = await engine.runTask(task.id);
    expect(pausedTask.status).toBe("NEED_USER");
    expect(pausedTask.currentRound).toBeGreaterThanOrEqual(2);
  });
});
