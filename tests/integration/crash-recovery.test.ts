import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AcpAgent } from "../../src/agents/acp-agent.js";
import { AgentHubOrchestrator } from "../../src/core/orchestrator.js";

class CrashingAgent extends AcpAgent {
  public crashAttempts = 0;
  public maxCrashesBeforeSuccess: number;

  constructor(name: "codex" | "gemini", maxCrashesBeforeSuccess: number = 999) {
    super({
      name,
      command: "node",
      args: ["-e", "process.exit(1)"],
      maxRestarts: 2,
    });
    this.maxCrashesBeforeSuccess = maxCrashesBeforeSuccess;
  }

  override async start(): Promise<void> {
    this.crashAttempts++;
  }

  override async initialize(): Promise<void> {
    // throw crash error during turn
  }

  override async createSession(workspace: string): Promise<string> {
    return `sess-crash-${Date.now()}`;
  }

  override async prompt(sessionId: string, message: string) {
    if (this.crashAttempts <= this.maxCrashesBeforeSuccess) {
      if (this.restartCount < this.maxRestarts) {
        this.restartCount++;
        throw new Error(`Process killed unexpectedly (crash count: ${this.crashAttempts})`);
      } else {
        throw new Error(`Agent process crashed and exceeded maximum restart limit (${this.maxRestarts}).`);
      }
    }
    return {
      text: "Recovered and done!\nAGENT_STATUS: DONE",
      stopReason: "end_turn",
    };
  }

  override async close(): Promise<void> {}
}

describe("Test 10: Crash Recovery & Failure Handling", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-crash-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("detects agent crash, attempts up to 2 restarts, and safely transitions to ERROR state", async () => {
    const crashingCodex = new CrashingAgent("codex", 10);
    const mockGemini = new CrashingAgent("gemini", 0);

    const orchestrator = new AgentHubOrchestrator({
      workspace: tempDir,
      codexAgent: crashingCodex,
      geminiAgent: mockGemini,
      firstAgent: "codex",
      maxRounds: 6,
      baseDir: tempDir,
    });

    const result = await orchestrator.runTask("Execute crash test");
    expect(result.finalState).toBe("ERROR");
    expect(result.stopReason).toBe("AGENT_ERROR");
    expect(crashingCodex.getRestartCount()).toBeLessThanOrEqual(2);
  });
});
