import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectEngine } from "../../src/projects/project-engine.js";
import { Agent, AgentResponse, AgentTurnPendingError } from "../../src/agents/agent.js";
import { GitService } from "../../src/git/git-service.js";

class FastMockDeveloper implements Agent {
  public readonly name = "codex";
  async start(): Promise<void> {}
  async initialize(): Promise<void> {}
  async createSession(): Promise<string> {
    return "mock-dev-sess";
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
    return "mock-rev-sess";
  }
  async prompt(): Promise<AgentResponse> {
    return { text: "REVIEW_STATUS: PASS\nAGENT_STATUS: DONE" };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

describe("ProjectEngine Integration Tests", () => {
  let tempBaseDir: string;
  let testRepoDir: string;
  let engine: ProjectEngine;

  beforeEach(async () => {
    tempBaseDir = path.join(os.tmpdir(), `agenthub-pe-base-${Date.now()}`);
    testRepoDir = path.join(os.tmpdir(), `agenthub-pe-repo-${Date.now()}`);

    fs.mkdirSync(tempBaseDir, { recursive: true });
    fs.mkdirSync(testRepoDir, { recursive: true });

    await GitService.exec(["init"], testRepoDir);
    await GitService.exec(["config", "user.name", "Test User"], testRepoDir);
    await GitService.exec(["config", "user.email", "test@example.com"], testRepoDir);

    fs.writeFileSync(path.join(testRepoDir, "README.md"), "# Project Engine Test", "utf-8");
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
      maxConcurrentTasks: 2,
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

  it("routes Gemini development and Codex review through rework with accurate actors", async () => {
    const prompts: Array<{ actor: string; text: string }> = [];
    let reviews = 0;
    const developer: Agent = {
      name: "gemini", start: async () => {}, initialize: async () => {},
      createSession: async () => "gemini-dev", cancel: async () => {}, close: async () => {},
      prompt: async (_session, text) => {
        prompts.push({ actor: "gemini", text });
        const workspace = text.match(/Workspace:\s*([^\n]+)/)?.[1].trim();
        if (!workspace) throw new Error("Missing workspace");
        fs.writeFileSync(path.join(workspace, "test.js"), "process.exit(0);");
        return { text: "AGENT_STATUS: CONTINUE" };
      },
    };
    const reviewer: Agent = {
      name: "codex", start: async () => {}, initialize: async () => {},
      createSession: async () => "codex-review", cancel: async () => {}, close: async () => {},
      prompt: async (_session, text) => {
        prompts.push({ actor: "codex", text });
        reviews++;
        return { text: reviews === 1
          ? "REVIEW_STATUS: REQUEST_CHANGES\nAdd edge case coverage.\nAGENT_STATUS: CONTINUE"
          : "REVIEW_STATUS: PASS\nAGENT_STATUS: DONE" };
      },
    };
    engine = new ProjectEngine({ baseDir: tempBaseDir, codexAgent: reviewer, geminiAgent: developer });
    const project = await engine.createProject({ name: "Reversed roles", workspace: testRepoDir });
    const task = await engine.createTask({ projectId: project.id, title: "Reversed task", description: "Synthetic routing check", ownerId: "gemini", ownerType: "AGENT" });
    expect(task.reviewerId).toBe("codex");
    const result = await engine.runTask(task.id);
    expect(result.status, result.nextAction).toBe("DONE");
    expect(prompts.map(p => p.actor)).toEqual(["gemini", "codex", "gemini", "codex"]);
    expect(prompts[1].text).toContain("Developer:\ngemini");
    const events = await engine.getStore().getTaskEvents(task.id);
    expect(events.filter(e => e.type === "AGENT_STARTED").map(e => e.actor)).toEqual(["gemini", "gemini"]);
    expect(events.filter(e => e.type === "REVIEW_STARTED").map(e => e.actor)).toEqual(["codex", "codex"]);
    const projectEvents = await engine.getStore().getProjectEvents(project.id);
    expect(projectEvents.find(e => e.type === "task.started")?.actorId).toBe("gemini");
    expect(projectEvents.find(e => e.type === "task.done")?.actorId).toBe("codex");
  });

  it("recovers a timed-out turn without redispatch and automatically tests and reviews", async () => {
    let sent = 0;
    let waited = 0;
    const checkpoint = { sessionId: "pending-session", startStepIndex: 7, requestTime: new Date().toISOString() };
    const dev = new FastMockDeveloper();
    dev.prompt = async () => { sent++; throw new AgentTurnPendingError(checkpoint); };
    Object.assign(dev, {
      waitForPendingTurn: async () => {
        waited++;
        if (waited === 1) throw new AgentTurnPendingError(checkpoint);
        return { text: "AGENT_STATUS: CONTINUE" };
      },
    });
    engine = new ProjectEngine({ baseDir: tempBaseDir, codexAgent: dev, geminiAgent: new FastMockReviewer() });
    const project = await engine.createProject({ name: "Recovery", workspace: testRepoDir });
    const task = await engine.createTask({ projectId: project.id, title: "Recover", description: "Recovery" });
    const [first, duplicate] = await Promise.all([engine.runTask(task.id), engine.runTask(task.id)]);
    expect(first.status).toBe("DONE");
    expect(duplicate.status).toBe("DONE");
    expect(sent).toBe(1);
    expect(waited).toBe(2);
    expect(first.pendingAgentTurn).toBeUndefined();
    const events = await engine.getStore().getTaskEvents(task.id);
    expect(events.some(e => e.type === "TEST_PASSED")).toBe(true);
    expect(events.some(e => e.type === "REVIEW_PASSED")).toBe(true);
    expect(events.some(e => e.type === "TASK_FAILED")).toBe(false);
  });

  it("reattaches a persisted reviewer turn without rerunning development", async () => {
    let sent = 0;
    let restored = 0;
    const reviewer = new FastMockReviewer();
    reviewer.prompt = async () => { sent++; throw new Error("Must not redispatch"); };
    Object.assign(reviewer, {
      restorePendingTurn: async () => { restored++; return "saved-review"; },
      waitForPendingTurn: async () => ({ text: "REVIEW_STATUS: PASS\nAGENT_STATUS: DONE" }),
    });
    const developer = new FastMockDeveloper();
    developer.prompt = async () => { throw new Error("Must not rerun development"); };
    engine = new ProjectEngine({ baseDir: tempBaseDir, codexAgent: developer, geminiAgent: reviewer });
    const project = await engine.createProject({ name: "Restart", workspace: testRepoDir });
    const task = await engine.createTask({ projectId: project.id, title: "Restart", description: "Resume review" });
    task.baseline = await GitService.captureBaseline(testRepoDir);
    task.status = "REVIEW";
    task.worktree = testRepoDir;
    task.branch = "test";
    task.currentRound = task.maxRounds;
    task.pendingAgentTurn = { sessionId: "saved-review", startStepIndex: 4, requestTime: new Date().toISOString(), actor: "gemini", phase: "REVIEW" };
    await engine.getStore().saveTask(task);
    const result = await engine.runTask(task.id);
    expect(result.status).toBe("DONE");
    expect(result.currentRound).toBe(task.maxRounds);
    expect(restored).toBe(1);
    expect(sent).toBe(0);
  });

  it("preserves the original checkpoint for NEED_USER after recovery expires", async () => {
    const checkpoint = { sessionId: "still-running", startStepIndex: 3, requestTime: new Date(Date.now() - 46 * 60 * 1000).toISOString() };
    let sent = 0;
    const developer = new FastMockDeveloper();
    developer.prompt = async () => { sent++; throw new AgentTurnPendingError(checkpoint); };
    Object.assign(developer, { waitForPendingTurn: async () => { throw new AgentTurnPendingError(checkpoint); } });
    engine = new ProjectEngine({ baseDir: tempBaseDir, codexAgent: developer, geminiAgent: new FastMockReviewer() });
    const project = await engine.createProject({ name: "Bounded recovery", workspace: testRepoDir });
    const task = await engine.createTask({ projectId: project.id, title: "Long wait", description: "Need human attention" });
    const result = await engine.runTask(task.id);
    expect(result.status).toBe("NEED_USER");
    expect(result.pendingAgentTurn?.sessionId).toBe("still-running");
    expect(sent).toBe(1);
    expect(result.result?.status).not.toBe("PASS");
  });

  it.each([false, true])("human continuation waits for the old turn before sending once (pending=%s)", async (stillPending) => {
    const checkpoint = { sessionId: "original-dev", startStepIndex: 10, requestTime: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
    const calls: string[] = [];
    let handler: ((checkpoint: typeof checkpoint) => Promise<void>) | undefined;
    const developer = new FastMockDeveloper();
    Object.assign(developer, {
      createSession: async () => { throw new Error("No new developer session"); },
      restorePendingTurn: async () => checkpoint.sessionId,
      setPendingTurnHandler: (fn: typeof handler) => { handler = fn; },
      waitForPendingTurn: async () => {
        calls.push("wait");
        if (stillPending) throw new AgentTurnPendingError(checkpoint);
        return { text: "Stopped. AGENT_STATUS: NEED_USER" };
      },
      prompt: async (session: string, text: string) => {
        calls.push("send");
        expect(session).toBe(checkpoint.sessionId);
        expect(text).toContain("Continue only in this worktree");
        await handler!({ ...checkpoint, startStepIndex: 42, requestTime: new Date().toISOString() });
        return { text: "AGENT_STATUS: CONTINUE" };
      },
    });
    engine = new ProjectEngine({ baseDir: tempBaseDir, codexAgent: developer, geminiAgent: new FastMockReviewer() });
    const project = await engine.createProject({ name: "Human recovery", workspace: testRepoDir });
    const task = await engine.createTask({ projectId: project.id, title: "Continue original", description: "Recovery", testCommand: "node -e \"process.exit(0)\"" });
    task.baseline = await GitService.captureBaseline(testRepoDir);
    task.status = "NEED_USER";
    task.worktree = testRepoDir;
    task.branch = "test";
    task.currentRound = 2;
    task.pendingAgentTurn = { ...checkpoint, actor: "codex", phase: "DOING" };
    await engine.getStore().saveTask(task);
    const result = await engine.respondToNeedUser(task.id, "Continue only in this worktree");
    expect(calls).toEqual(stillPending ? ["wait"] : ["wait", "send"]);
    expect(result.status, result.nextAction).toBe(stillPending ? "NEED_USER" : "DONE");
    expect(result.currentRound).toBe(2);
    expect(result.pendingHumanResponse).toBe(stillPending ? "Continue only in this worktree" : undefined);
    if (stillPending) expect(result.pendingAgentTurn?.requestTime).toBe(checkpoint.requestTime);
  });

  it("accepts a final review protocol block concatenated after commentary", async () => {
    const reviewer = new FastMockReviewer();
    reviewer.prompt = async () => ({ text: "Review complete.REVIEW_STATUS: PASS\nAGENT_STATUS: DONE" });
    engine = new ProjectEngine({ baseDir: tempBaseDir, codexAgent: new FastMockDeveloper(), geminiAgent: reviewer });
    const project = await engine.createProject({ name: "Protocol boundary", workspace: testRepoDir });
    const task = await engine.createTask({ projectId: project.id, title: "Final block", description: "No spurious rework" });
    const result = await engine.runTask(task.id);
    expect(result.status).toBe("DONE");
    expect(result.currentRound).toBe(1);
    const events = await engine.getStore().getTaskEvents(task.id);
    expect(events.some(e => e.type === "REVIEW_FAILED")).toBe(false);
  });

  it("creates a Project, Epics, Tasks, and retrieves the complete tree", async () => {
    const project = await engine.createProject({
      name: "Demo Platform",
      description: "Demo Automated Testing Platform",
      workspace: testRepoDir,
    });
    expect(project.id).toBeDefined();

    const epic = await engine.createEpic({
      projectId: project.id,
      title: "Login Testing Milestone",
      priority: "HIGH",
    });
    expect(epic.id).toBeDefined();

    const task1 = await engine.createTask({
      projectId: project.id,
      epicId: epic.id,
      title: "Task 1",
      description: "First task",
      workspace: testRepoDir,
    });

    const subtask = await engine.createTask({
      projectId: project.id,
      epicId: epic.id,
      parentTaskId: task1.id,
      title: "Task 1 Subtask",
      description: "Child task",
      workspace: testRepoDir,
    });

    const tree = await engine.getProjectTree(project.id);
    expect(tree).not.toBeNull();
    expect(tree?.project.name).toBe("Demo Platform");
    expect(tree?.epics.length).toBe(1);
    expect(tree?.epics[0].tasks.length).toBe(1);
    expect(tree?.epics[0].tasks[0].task.id).toBe(task1.id);
    expect(tree?.epics[0].tasks[0].children[0].task.id).toBe(subtask.id);
  });

  it("broadcasts live project events through subscription", async () => {
    const project = await engine.createProject({
      name: "Event Test Project",
      workspace: testRepoDir,
    });

    const capturedEvents: string[] = [];
    const unsubscribe = engine.subscribe(project.id, (ev) => {
      capturedEvents.push(ev.type);
    });

    await engine.createEpic({
      projectId: project.id,
      title: "Epic E1",
    });

    await engine.createTask({
      projectId: project.id,
      title: "Task T1",
      description: "Desc",
      workspace: testRepoDir,
    });

    expect(capturedEvents).toContain("epic.created");
    expect(capturedEvents).toContain("task.created");

    unsubscribe();
  });

  it("manages task execution through concurrency control queue", async () => {
    const project = await engine.createProject({
      name: "Concurrent Project",
      workspace: testRepoDir,
    });

    const task1 = await engine.createTask({
      projectId: project.id,
      title: "Task 1",
      description: "D1",
      workspace: testRepoDir,
    });
    const task2 = await engine.createTask({
      projectId: project.id,
      title: "Task 2",
      description: "D2",
      workspace: testRepoDir,
    });
    const task3 = await engine.createTask({
      projectId: project.id,
      title: "Task 3",
      description: "D3",
      workspace: testRepoDir,
    });

    // Run 3 tasks with maxConcurrentTasks: 2
    const [r1, r2, r3] = await Promise.all([
      engine.runTask(task1.id),
      engine.runTask(task2.id),
      engine.runTask(task3.id),
    ]);

    expect(r1.status).toBe("DONE");
    expect(r2.status).toBe("DONE");
    expect(r3.status).toBe("DONE");
  });
});
