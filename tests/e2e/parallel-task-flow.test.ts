import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TaskEngine } from "../../src/tasks/task-engine.js";
import { Agent, AgentResponse } from "../../src/agents/agent.js";
import { GitService } from "../../src/git/git-service.js";

/**
 * Isolated Developer Agent for concurrency tests.
 * Performs genuine filesystem writes in the assigned worktree.
 */
class ParallelDevAgent implements Agent {
  public readonly name = "codex";
  public initialized = false;
  private sessionWorkspaces = new Map<string, string>();

  async start(): Promise<void> {}
  async initialize(): Promise<void> {
    this.initialized = true;
  }
  async createSession(workspace: string): Promise<string> {
    const sessId = `sess-${crypto.randomBytes(4).toString("hex")}`;
    this.sessionWorkspaces.set(sessId, workspace);
    return sessId;
  }
  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    const ws = this.sessionWorkspaces.get(sessionId);
    if (!ws) throw new Error(`Unknown session: ${sessionId}`);

    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.mkdirSync(path.join(ws, "tests"), { recursive: true });

    // Determine which module to create based on prompt context
    if (message.includes("moduleA") || message.includes("TASK_A")) {
      fs.writeFileSync(
        path.join(ws, "src", "moduleA.js"),
        `export function funcA() { return "MODULE_A_OK"; }\n`,
        "utf-8"
      );
      fs.writeFileSync(
        path.join(ws, "tests", "moduleA.test.js"),
        `import test from "node:test";
import assert from "node:assert/strict";
import { funcA } from "../src/moduleA.js";

test("funcA returns MODULE_A_OK", () => {
  assert.equal(funcA(), "MODULE_A_OK");
});
`,
        "utf-8"
      );
    } else if (message.includes("moduleB") || message.includes("TASK_B")) {
      fs.writeFileSync(
        path.join(ws, "src", "moduleB.js"),
        `export function funcB() { return "MODULE_B_OK"; }\n`,
        "utf-8"
      );
      fs.writeFileSync(
        path.join(ws, "tests", "moduleB.test.js"),
        `import test from "node:test";
import assert from "node:assert/strict";
import { funcB } from "../src/moduleB.js";

test("funcB returns MODULE_B_OK", () => {
  assert.equal(funcB(), "MODULE_B_OK");
});
`,
        "utf-8"
      );
    }

    // Small delay to simulate concurrent runtime execution
    await new Promise((r) => setTimeout(r, 100));

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

class ParallelReviewerAgent implements Agent {
  public readonly name = "gemini";
  public initialized = false;

  async start(): Promise<void> {}
  async initialize(): Promise<void> {
    this.initialized = true;
  }
  async createSession(workspace: string): Promise<string> {
    return `rev-${crypto.randomBytes(4).toString("hex")}`;
  }
  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    return {
      text: "REVIEW_STATUS: PASS\nAll requirements satisfied and tests pass.\nAGENT_STATUS: DONE",
      stopReason: "end_turn",
    };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
  isRunning(): boolean {
    return this.initialized;
  }
}

describe("Parallel Task Flow E2E - Concurrency & Worktree Isolation", () => {
  it("executes 2 concurrent tasks in the same project with isolated worktrees and clean main repo", async () => {
    const nonce = crypto.randomBytes(3).toString("hex");
    const repoDir = path.resolve(process.cwd(), `logs/parallel-e2e-repo-${nonce}`);
    const dataDir = path.resolve(process.cwd(), `logs/parallel-e2e-data-${nonce}`);

    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "tests"), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    // 1. Initialize real Git repository
    await GitService.exec(["init"], repoDir);
    await GitService.exec(["config", "user.name", "AgentHub Parallel E2E"], repoDir);
    await GitService.exec(["config", "user.email", "parallel@agenthub.local"], repoDir);

    const packageJson = {
      name: `parallel-e2e-${nonce}`,
      version: "1.0.0",
      type: "module",
      scripts: {
        test: "node --test tests/*.test.js",
      },
    };
    fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify(packageJson, null, 2), "utf-8");

    fs.writeFileSync(path.join(repoDir, ".gitignore"), ".agenthub\nnode_modules\n", "utf-8");

    // Baseline test so initial master/main is valid
    fs.writeFileSync(
      path.join(repoDir, "tests", "baseline.test.js"),
      `import test from "node:test";
import assert from "node:assert/strict";

test("baseline sanity check", () => {
  assert.equal(1 + 1, 2);
});
`,
      "utf-8"
    );

    await GitService.exec(["add", "."], repoDir);
    await GitService.exec(["commit", "-m", "Initial baseline commit"], repoDir);

    // 2. Initialize Engine with maxConcurrentTasks = 2
    const codexAgent = new ParallelDevAgent();
    const geminiAgent = new ParallelReviewerAgent();

    const engine = new TaskEngine({
      baseDir: dataDir,
      codexAgent,
      geminiAgent,
      maxConcurrentTasks: 2,
    });

    const projectId = `PROJ-PARALLEL-${nonce.toUpperCase()}`;
    await engine.createProject({
      id: projectId,
      name: "Parallel Microservices Project",
      workspace: repoDir,
    });

    const taskAId = `TASK-A-${nonce.toUpperCase()}`;
    const taskBId = `TASK-B-${nonce.toUpperCase()}`;

    const taskA = await engine.createTask({
      id: taskAId,
      projectId,
      title: "Develop moduleA service [TASK_A]",
      description: "Implement moduleA with isolated test in src/moduleA.js",
      workspace: repoDir,
      testCommand: "node --test tests/moduleA.test.js",
      maxRounds: 3,
    });

    const taskB = await engine.createTask({
      id: taskBId,
      projectId,
      title: "Develop moduleB service [TASK_B]",
      description: "Implement moduleB with isolated test in src/moduleB.js",
      workspace: repoDir,
      testCommand: "node --test tests/moduleB.test.js",
      maxRounds: 3,
    });

    expect(taskA.status).toBe("TODO");
    expect(taskB.status).toBe("TODO");

    // 3. Trigger both tasks concurrently
    console.log(`[E2E Parallel] Triggering ${taskAId} and ${taskBId} concurrently...`);
    const [resultA, resultB] = await Promise.all([
      engine.runTask(taskAId),
      engine.runTask(taskBId),
    ]);

    // 4. Verify both tasks completed successfully
    expect(resultA.status).toBe("DONE");
    expect(resultB.status).toBe("DONE");
    expect(resultA.result?.status).toBe("PASS");
    expect(resultB.result?.status).toBe("PASS");

    // 5. Verify Git Worktree isolation & Clean Main Repository
    // Main repository must NOT have moduleA.js or moduleB.js (isolation preserved!)
    expect(fs.existsSync(path.join(repoDir, "src", "moduleA.js"))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, "src", "moduleB.js"))).toBe(false);

    // Main repository git status must be completely clean
    const statusOutput = await GitService.exec(["status", "--porcelain"], repoDir);
    expect(statusOutput.stdout.trim()).toBe("");

    // 6. Verify Git branches were created for both tasks
    const branchOutput = await GitService.exec(["branch", "--list"], repoDir);
    expect(branchOutput.stdout).toContain(taskAId);
    expect(branchOutput.stdout).toContain(taskBId);

    // 7. Verify overall Project Progress reached 100%
    const progress = await engine.refreshProjectProgress(projectId);
    expect(progress).toBe(100);

    const project = await engine.getProject(projectId);
    expect(project.status).toBe("DONE");

    // Cleanup test directories
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
