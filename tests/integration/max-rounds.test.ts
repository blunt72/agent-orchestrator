import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectEngine } from "../../src/projects/project-engine.js";
import { Agent, AgentResponse } from "../../src/agents/agent.js";
import { GitService } from "../../src/git/git-service.js";

class MockCodexAgent implements Agent {
  public readonly name = "codex";
  public initialized = false;
  public roundCount = 0;

  async start(): Promise<void> {}
  async initialize(): Promise<void> {
    this.initialized = true;
  }
  async createSession(workspace: string): Promise<string> {
    return "session-codex";
  }
  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    this.roundCount++;
    return {
      text: `Codex round ${this.roundCount} work finished.\nAGENT_STATUS: CONTINUE`,
      stopReason: "end_turn",
    };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
  isRunning(): boolean {
    return this.initialized;
  }
}

class StrictReviewerAgent implements Agent {
  public readonly name = "gemini";
  public reviewCount = 0;
  public allowApprovalAfterHumanGuidance = false;

  async start(): Promise<void> {}
  async initialize(): Promise<void> {}
  async createSession(workspace: string): Promise<string> {
    return "session-gemini";
  }
  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    this.reviewCount++;

    // If human decision was provided in prompt/description, approve
    if (this.allowApprovalAfterHumanGuidance && message.includes("User Decision:")) {
      return {
        text: "REVIEW_STATUS: PASS\nHuman decision accepted and code verified.\nAGENT_STATUS: DONE",
        stopReason: "end_turn",
      };
    }

    // Otherwise repeatedly request changes
    return {
      text: `REVIEW_STATUS: REQUEST_CHANGES\nEdge case ${this.reviewCount} not resolved.\nAGENT_STATUS: CONTINUE`,
      stopReason: "end_turn",
    };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
  isRunning(): boolean {
    return true;
  }
}

describe("Item 9: maxRounds -> NEED_USER with Human Owner", () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-maxrounds-"));
    repoDir = path.join(tempDir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });

    await GitService.exec(["init"], repoDir);
    await GitService.exec(["config", "user.name", "MaxRounds Test"], repoDir);
    await GitService.exec(["config", "user.email", "maxrounds@test.local"], repoDir);

    fs.writeFileSync(
      path.join(repoDir, "package.json"),
      JSON.stringify({ name: "maxrounds-test", scripts: { test: "echo ok" } }),
      "utf-8"
    );
    await GitService.exec(["add", "."], repoDir);
    await GitService.exec(["commit", "-m", "initial commit"], repoDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("transitions task to NEED_USER with owner=HUMAN when reviewer repeatedly requests changes up to maxRounds", async () => {
    const codex = new MockCodexAgent();
    const gemini = new StrictReviewerAgent();

    const engine = new ProjectEngine({
      baseDir: tempDir,
      codexAgent: codex,
      geminiAgent: gemini,
    });

    const project = await engine.createProject({
      id: "PROJ-MAXROUNDS",
      name: "MaxRounds Guard Project",
      workspace: repoDir,
    });

    const maxRoundsLimit = 3;
    const task = await engine.createTask({
      id: "TASK-MAXROUNDS-1",
      projectId: project.id,
      title: "Task with strict reviewer",
      description: "Implement complex calculation with multiple edge cases",
      workspace: repoDir,
      testCommand: "npm test",
      maxRounds: maxRoundsLimit,
    });

    expect(task.status).toBe("TODO");

    // Run task - Reviewer rejects rounds 1, 2, 3
    const resultTask = await engine.runTask(task.id);

    // Verify task transitioned to NEED_USER instead of looping infinitely
    expect(resultTask.status).toBe("NEED_USER");
    expect(resultTask.currentRound).toBe(maxRoundsLimit);
    expect(resultTask.ownerType).toBe("HUMAN");
    expect(resultTask.ownerId).toBe("user");
    expect(resultTask.owner).toBe("user");
    expect(resultTask.nextAction).toContain(`Max rounds (${maxRoundsLimit}) reached`);

    // Verify persisted state in store
    const stored = await engine.getTask(task.id);
    expect(stored?.status).toBe("NEED_USER");
    expect(stored?.ownerType).toBe("HUMAN");

    // Verify events recorded
    const events = await engine.getStore().getEvents(task.id);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("NEED_USER");
    expect(eventTypes.filter((t) => t === "REWORK_STARTED").length).toBe(maxRoundsLimit);

    // Now test Human Intervention: user responds with guidance
    gemini.allowApprovalAfterHumanGuidance = true;
    const resumedTask = await engine.respondToNeedUser(
      task.id,
      "User Decision: Approve default rounding strategy without throwing exception."
    );

    // Task resumes and completes to DONE!
    expect(resumedTask.status).toBe("DONE");
    expect(resumedTask.result?.status).toBe("PASS");
  });
});
