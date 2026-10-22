import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectEngine } from "../../src/projects/project-engine.js";
import { Agent, AgentResponse } from "../../src/agents/agent.js";
import { GitService } from "../../src/git/git-service.js";

class ResumableCodexAgent implements Agent {
  public readonly name = "codex";
  public initialized = false;

  async start(): Promise<void> {}
  async initialize(): Promise<void> {
    this.initialized = true;
  }
  async createSession(workspace: string): Promise<string> {
    return "session-codex";
  }
  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    return {
      text: "Codex resumed and finished implementation.\nAGENT_STATUS: CONTINUE",
      stopReason: "end_turn",
    };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
  isRunning(): boolean {
    return this.initialized;
  }
}

class ApprovingGeminiAgent implements Agent {
  public readonly name = "gemini";

  async start(): Promise<void> {}
  async initialize(): Promise<void> {}
  async createSession(workspace: string): Promise<string> {
    return "session-gemini";
  }
  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    return {
      text: "REVIEW_STATUS: PASS\nAll changes verified after engine restart.\nAGENT_STATUS: DONE",
      stopReason: "end_turn",
    };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
  isRunning(): boolean {
    return true;
  }
}

describe("Item 7: Engine Restart Recovery & State Persistence", () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-restart-test-"));
    repoDir = path.join(tempDir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });

    await GitService.exec(["init"], repoDir);
    await GitService.exec(["config", "user.name", "Restart Test"], repoDir);
    await GitService.exec(["config", "user.email", "restart@test.local"], repoDir);

    fs.writeFileSync(
      path.join(repoDir, "package.json"),
      JSON.stringify({ name: "restart-recovery-test", scripts: { test: "echo ok" } }),
      "utf-8"
    );
    await GitService.exec(["add", "."], repoDir);
    await GitService.exec(["commit", "-m", "initial baseline"], repoDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("recovers full project hierarchy, intermediate task statuses, dependencies, and resumes cleanly after server/engine restart", async () => {
    const codex = new ResumableCodexAgent();
    const gemini = new ApprovingGeminiAgent();

    // 1. Initial engine session
    let engine = new ProjectEngine({
      baseDir: tempDir,
      codexAgent: codex,
      geminiAgent: gemini,
    });

    const projectId = "PROJ-RESTART-001";
    const project = await engine.createProject({
      id: projectId,
      name: "Mission Critical Enterprise App",
      description: "Testing state persistence across abrupt process restarts",
      workspace: repoDir,
    });

    const epic = await engine.createEpic({
      id: "EPIC-RESTART-10",
      projectId,
      title: "Core Infrastructure Migration",
      priority: "CRITICAL",
    });

    // Task A: In NEED_USER state (simulating paused for human input)
    const taskA = await engine.createTask({
      id: "TASK-RESTART-A",
      projectId,
      epicId: epic.id,
      title: "Task A: Database Migration Script",
      workspace: repoDir,
      testCommand: "npm test",
    });

    // Manually pause Task A into NEED_USER
    taskA.baseline = await GitService.captureBaseline(repoDir);
    taskA.status = "NEED_USER";
    taskA.ownerType = "HUMAN";
    taskA.ownerId = "user";
    taskA.owner = "user";
    taskA.nextAction = "等待用户确认数据库连接字符串与迁移策略";
    await engine.getStore().saveTask(taskA);

    // Task B: BLOCKED by Task A
    const taskB = await engine.createTask({
      id: "TASK-RESTART-B",
      projectId,
      epicId: epic.id,
      title: "Task B: Data Validation Service",
      workspace: repoDir,
      testCommand: "npm test",
      dependsOn: [taskA.id],
    });
    expect(taskB.status).toBe("BLOCKED");
    expect(taskB.blockedBy).toContain(taskA.id);

    // Task C: Human task in DOING
    const taskC = await engine.createTask({
      id: "TASK-RESTART-C",
      projectId,
      epicId: epic.id,
      title: "Task C: Manual Security Audit",
      ownerType: "HUMAN",
      ownerId: "auditor-alice",
      workspace: repoDir,
    });
    await engine.startHumanTask(taskC.id, "auditor-alice");
    const startedC = await engine.getTask(taskC.id);
    expect(startedC?.status).toBe("DOING");

    await engine.refreshProjectProgress(projectId);

    // ==========================================
    // 2. SIMULATE ENGINE RESTART / SERVER SHUTDOWN
    // ==========================================
    // Clear in-memory references and instantiate new ProjectEngine pointing to the same disk
    engine = new ProjectEngine({
      baseDir: tempDir,
      codexAgent: codex,
      geminiAgent: gemini,
    });

    // 3. Verify complete recovered state from disk
    const reloadedProject = await engine.getProject(projectId);
    expect(reloadedProject).toBeDefined();
    expect(reloadedProject?.id).toBe(projectId);
    expect(reloadedProject?.name).toBe("Mission Critical Enterprise App");
    expect(reloadedProject?.status).toBe("ACTIVE");

    const reloadedEpic = await engine.getEpic(epic.id);
    expect(reloadedEpic).toBeDefined();
    expect(reloadedEpic?.id).toBe(epic.id);
    expect(reloadedEpic?.priority).toBe("CRITICAL");

    const reloadedTasks = await engine.listTasks({ projectId });
    expect(reloadedTasks.length).toBe(3);

    const reloadedA = reloadedTasks.find((t) => t.id === taskA.id);
    expect(reloadedA?.status).toBe("NEED_USER");
    expect(reloadedA?.ownerType).toBe("HUMAN");
    expect(reloadedA?.nextAction).toBe("等待用户确认数据库连接字符串与迁移策略");

    const reloadedB = reloadedTasks.find((t) => t.id === taskB.id);
    expect(reloadedB?.status).toBe("BLOCKED");
    expect(reloadedB?.blockedBy).toContain(taskA.id);

    const reloadedC = reloadedTasks.find((t) => t.id === taskC.id);
    expect(reloadedC?.status).toBe("DOING");
    expect(reloadedC?.ownerId).toBe("auditor-alice");

    // Check project tree
    const tree = await engine.getProjectTree(projectId);
    expect(tree).toBeDefined();
    expect(tree?.epics.length).toBe(1);
    expect(tree?.epics[0].tasks.length).toBe(3);

    // 4. Resume execution on the newly booted engine!
    // Respond to Task A -> resumes AI execution, finishes, and unblocks Task B!
    const resumedA = await engine.respondToNeedUser(taskA.id, "User confirmation: Use staging DB connection");
    expect(resumedA.status).toBe("DONE");

    // Task B must automatically unblock!
    const unblockedB = await engine.getTask(taskB.id);
    expect(unblockedB?.status).toBe("TODO");
    expect(unblockedB?.blockedBy).toEqual([]);

    // Complete Task B
    const completedB = await engine.completeHumanTask(taskB.id, "user", "Auto-verified Task B");
    expect(completedB.status).toBe("DONE");

    // Complete Task C
    const completedC = await engine.completeHumanTask(taskC.id, "auditor-alice", "Audit passed cleanly");
    expect(completedC.status).toBe("DONE");

    // Verify 100% progress
    const finalProgress = await engine.refreshProjectProgress(projectId);
    expect(finalProgress).toBe(100);

    const finishedProject = await engine.getProject(projectId);
    expect(finishedProject?.status).toBe("DONE");
    expect(finishedProject?.progress).toBe(100);

    // 5. Simulate SECOND RESTART to ensure completed state stays 100% persisted
    const secondReloadEngine = new ProjectEngine({
      baseDir: tempDir,
    });
    const permanentProject = await secondReloadEngine.getProject(projectId);
    expect(permanentProject?.status).toBe("DONE");
    expect(permanentProject?.progress).toBe(100);
  });
});
