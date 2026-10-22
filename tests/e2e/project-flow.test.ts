import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TaskEngine } from "../../src/tasks/task-engine.js";
import { Agent, AgentResponse } from "../../src/agents/agent.js";
import { GitService } from "../../src/git/git-service.js";

class MockCodexAgent implements Agent {
  public readonly name = "codex";
  public initialized = false;
  private sessionWorkspaces = new Map<string, string>();

  async start(): Promise<void> {}
  async initialize(): Promise<void> {
    this.initialized = true;
  }
  async createSession(workspace: string): Promise<string> {
    const sid = `sess-${crypto.randomBytes(4).toString("hex")}`;
    this.sessionWorkspaces.set(sid, workspace);
    return sid;
  }
  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    const ws = this.sessionWorkspaces.get(sessionId);
    if (ws) {
      fs.mkdirSync(path.join(ws, "src"), { recursive: true });
      fs.mkdirSync(path.join(ws, "tests"), { recursive: true });

      if (message.includes("TASK_A")) {
        fs.writeFileSync(
          path.join(ws, "src", "featureA.js"),
          `export function featureA() { return "A_DONE"; }\n`
        );
        fs.writeFileSync(
          path.join(ws, "tests", "featureA.test.js"),
          `import test from "node:test";
import assert from "node:assert/strict";
import { featureA } from "../src/featureA.js";

test("featureA succeeds", () => {
  assert.equal(featureA(), "A_DONE");
});
`
        );
      } else if (message.includes("TASK_B")) {
        fs.writeFileSync(
          path.join(ws, "src", "featureB.js"),
          `export function featureB() { return "B_DONE"; }\n`
        );
        fs.writeFileSync(
          path.join(ws, "tests", "featureB.test.js"),
          `import test from "node:test";
import assert from "node:assert/strict";
import { featureB } from "../src/featureB.js";

test("featureB succeeds", () => {
  assert.equal(featureB(), "B_DONE");
});
`
        );
      }
    }

    return {
      text: "Implementation finished.\nAGENT_STATUS: CONTINUE",
      stopReason: "end_turn",
    };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
  isRunning(): boolean {
    return this.initialized;
  }
}

class MockGeminiAgent implements Agent {
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
      text: "REVIEW_STATUS: PASS\nAll requirements and tests pass.\nAGENT_STATUS: DONE",
      stopReason: "end_turn",
    };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
  isRunning(): boolean {
    return this.initialized;
  }
}

describe("Complete Project Flow E2E", () => {
  it("orchestrates Project -> Epic -> Task A (AI) -> Task B (Blocked -> Auto-unblock -> AI) -> Task C (Human) -> 100% -> Timeline & Persistence Recovery", async () => {
    const nonce = crypto.randomBytes(3).toString("hex");
    const repoDir = path.resolve(process.cwd(), `logs/proj-flow-repo-${nonce}`);
    const dataDir = path.resolve(process.cwd(), `logs/proj-flow-data-${nonce}`);

    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "tests"), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    // 1. Setup real Git repository with initial commit
    await GitService.exec(["init"], repoDir);
    await GitService.exec(["config", "user.name", "ProjectFlow E2E"], repoDir);
    await GitService.exec(["config", "user.email", "projflow@agenthub.local"], repoDir);

    const packageJson = {
      name: `project-flow-${nonce}`,
      version: "1.0.0",
      type: "module",
      scripts: {
        test: "node --test tests/*.test.js",
      },
    };
    fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify(packageJson, null, 2), "utf-8");
    fs.writeFileSync(path.join(repoDir, ".gitignore"), ".agenthub\nnode_modules\n", "utf-8");

    fs.writeFileSync(
      path.join(repoDir, "tests", "baseline.test.js"),
      `import test from "node:test";
import assert from "node:assert/strict";

test("sanity", () => { assert.equal(1, 1); });
`,
      "utf-8"
    );

    await GitService.exec(["add", "."], repoDir);
    await GitService.exec(["commit", "-m", "Initial commit"], repoDir);

    // 2. Initialize Engine
    const codexAgent = new MockCodexAgent();
    const geminiAgent = new MockGeminiAgent();

    let engine = new TaskEngine({
      baseDir: dataDir,
      codexAgent,
      geminiAgent,
    });

    // 3. Create Project & Epic
    const projectId = `PROJ-FLOW-${nonce.toUpperCase()}`;
    const project = await engine.createProject({
      id: projectId,
      name: "Demo Enterprise Project",
      description: "Complete flow test with AI & Human collaboration",
      workspace: repoDir,
    });
    expect(project.id).toBe(projectId);
    expect(project.status).toBe("PLANNING");

    const epic = await engine.createEpic({
      projectId,
      title: "EPIC-101: Order Processing Module",
      description: "Order lifecycle and auditing",
      priority: "HIGH",
    });
    expect(epic.id).toBeDefined();

    // 4. Create Task A (AI - Codex + Gemini)
    const taskAId = `TASK-A-${nonce.toUpperCase()}`;
    const taskA = await engine.createTask({
      id: taskAId,
      projectId,
      epicId: epic.id,
      title: "Develop Order Core Engine [TASK_A]",
      description: "Implement Order Core in src/featureA.js",
      workspace: repoDir,
      testCommand: "node --test tests/featureA.test.js",
      estimatedWeight: 1,
    });
    expect(taskA.status).toBe("TODO");

    // 5. Create Task B (AI - dependsOn Task A) -> Must be BLOCKED immediately
    const taskBId = `TASK-B-${nonce.toUpperCase()}`;
    const taskB = await engine.createTask({
      id: taskBId,
      projectId,
      epicId: epic.id,
      title: "Develop Order Audit Log [TASK_B]",
      description: "Implement Audit Log in src/featureB.js",
      workspace: repoDir,
      testCommand: "node --test tests/featureB.test.js",
      dependsOn: [taskAId],
      estimatedWeight: 1,
    });
    expect(taskB.status).toBe("BLOCKED");
    expect(taskB.blockedBy).toContain(taskAId);
    expect(taskB.nextAction).toContain(taskAId);

    // 6. Create Task C (Human - User signoff)
    const taskCId = `TASK-C-${nonce.toUpperCase()}`;
    const taskC = await engine.createTask({
      id: taskCId,
      projectId,
      epicId: epic.id,
      title: "Human Signoff & Acceptance [TASK_C]",
      description: "Manual acceptance by product owner",
      ownerType: "HUMAN",
      ownerId: "zhangsan",
      workspace: repoDir,
      estimatedWeight: 1,
    });
    expect(taskC.status).toBe("TODO");
    expect(taskC.ownerType).toBe("HUMAN");

    // Check intermediate progress (0% since none started)
    let pProgress = await engine.refreshProjectProgress(projectId);
    expect(pProgress).toBe(0);

    // 7. Run Task A -> Should complete and automatically unblock Task B!
    const completedA = await engine.runTask(taskAId);
    expect(completedA.status).toBe("DONE");
    expect(completedA.result?.status).toBe("PASS");

    // Verify Task B was automatically unblocked!
    const unblockedB = await engine.getTask(taskBId);
    expect(unblockedB.status).toBe("TODO");
    expect(unblockedB.blockedBy).toEqual([]);

    // 8. Run Task B -> Should complete
    const completedB = await engine.runTask(taskBId);
    expect(completedB.status).toBe("DONE");
    expect(completedB.result?.status).toBe("PASS");

    // 9. Run Human Task C: TODO -> DOING -> DONE
    const startedC = await engine.startHumanTask(taskCId, "zhangsan");
    expect(startedC.status).toBe("DOING");
    expect(startedC.progress).toBe(30);

    const completedC = await engine.completeHumanTask(taskCId, "zhangsan", "Acceptance signoff passed.");
    expect(completedC.status).toBe("DONE");
    expect(completedC.progress).toBe(100);

    // 10. Verify 100% Project Progress
    pProgress = await engine.refreshProjectProgress(projectId);
    expect(pProgress).toBe(100);

    const finalProject = await engine.getProject(projectId);
    expect(finalProject.status).toBe("DONE");

    const finalEpic = await engine.getEpic(epic.id);
    expect(finalEpic?.status).toBe("DONE");
    expect(finalEpic?.progress).toBe(100);

    // 11. Timeline Reconstruction Verification
    const events = await engine.getStore().getProjectEvents(projectId);
    expect(events.length).toBeGreaterThanOrEqual(8);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("project.created");
    expect(eventTypes).toContain("task.created");
    expect(eventTypes).toContain("task.blocked");
    expect(eventTypes).toContain("task.unblocked");
    expect(eventTypes).toContain("task.done");

    // 12. Server Restart & Persistence Recovery
    // Create new TaskEngine instance pointing to same baseDir
    const reloadedEngine = new TaskEngine({
      baseDir: dataDir,
      codexAgent,
      geminiAgent,
    });

    const reloadedProject = await reloadedEngine.getProject(projectId);
    expect(reloadedProject.id).toBe(projectId);
    expect(reloadedProject.status).toBe("DONE");
    expect(reloadedProject.progress).toBe(100);

    const reloadedEpic = await reloadedEngine.getEpic(epic.id);
    expect(reloadedEpic?.id).toBe(epic.id);
    expect(reloadedEpic?.status).toBe("DONE");
    expect(reloadedEpic?.progress).toBe(100);

    const reloadedTasks = await reloadedEngine.listTasks({ projectId });
    expect(reloadedTasks.length).toBe(3);
    expect(reloadedTasks.every((t) => t.status === "DONE")).toBe(true);

    const reloadedTree = await reloadedEngine.getProjectTree(projectId);
    expect(reloadedTree?.epics[0].tasks.length).toBe(3);

    // Clean up
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
