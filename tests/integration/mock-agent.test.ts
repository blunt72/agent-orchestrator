import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Agent, AgentResponse } from "../../src/agents/acp-agent.js";
import { AgentHubOrchestrator } from "../../src/core/orchestrator.js";

/**
 * Controllable Mock Agent implementing the unified Agent interface
 */
class MockAgent implements Agent {
  public name: "codex" | "gemini";
  public history: { sessionId: string; message: string }[] = [];
  public responses: (string | ((message: string, turn: number) => string))[] = [];
  public initialized = false;
  public sessions: string[] = [];
  private turnCount = 0;

  constructor(name: "codex" | "gemini", responses: (string | ((message: string, turn: number) => string))[] = []) {
    this.name = name;
    this.responses = responses;
  }

  async start(): Promise<void> {}

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async createSession(workspace: string): Promise<string> {
    const id = `mock-${this.name}-session-${Date.now()}`;
    this.sessions.push(id);
    return id;
  }

  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    this.history.push({ sessionId, message });
    this.turnCount++;

    const nextResp = this.responses.length > 0
      ? this.responses.shift()!
      : `Default response from ${this.name}\nAGENT_STATUS: CONTINUE`;

    const text = typeof nextResp === "function" ? nextResp(message, this.turnCount) : nextResp;

    return {
      text,
      stopReason: "end_turn",
      rawEvents: [{ event: "mock_event", name: this.name }],
    };
  }

  async cancel(sessionId: string): Promise<void> {}
  async close(): Promise<void> {}
}

describe("AgentHub Integration Tests (Multi-Agent Workflows)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-integ-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Test 1: Codex 单独通信
  it("Test 1: Communicates with Codex independently and gets valid ACP response", async () => {
    const codex = new MockAgent("codex", ["Codex implementation plan ready.\nAGENT_STATUS: DONE"]);
    const gemini = new MockAgent("gemini", []);

    const orchestrator = new AgentHubOrchestrator({
      workspace: tempDir,
      codexAgent: codex,
      geminiAgent: gemini,
      firstAgent: "codex",
      maxRounds: 6,
      baseDir: tempDir,
    });

    const result = await orchestrator.runTask("Initialize calculator module");
    expect(result.finalState).toBe("DONE");
    expect(result.totalRounds).toBe(1);
    expect(codex.history.length).toBe(1);
    expect(codex.history[0].message).toContain("Initialize calculator module");
  });

  // Test 2: Gemini 单独通信
  it("Test 2: Communicates with Gemini independently and gets valid ACP response", async () => {
    const codex = new MockAgent("codex", []);
    const gemini = new MockAgent("gemini", ["Gemini architectural review completed.\nAGENT_STATUS: DONE"]);

    const orchestrator = new AgentHubOrchestrator({
      workspace: tempDir,
      codexAgent: codex,
      geminiAgent: gemini,
      firstAgent: "gemini",
      maxRounds: 6,
      baseDir: tempDir,
    });

    const result = await orchestrator.runTask("Review system architecture");
    expect(result.finalState).toBe("DONE");
    expect(result.totalRounds).toBe(1);
    expect(gemini.history.length).toBe(1);
    expect(gemini.history[0].message).toContain("Review system architecture");
  });

  // Test 3: Codex → Gemini
  it("Test 3: Forwards Codex output to Gemini as input and collects Gemini review", async () => {
    const codex = new MockAgent("codex", [
      "Here is my code implementation.\nAGENT_STATUS: CONTINUE",
    ]);
    const gemini = new MockAgent("gemini", [
      "Code looks good, please fix edge case.\nAGENT_STATUS: DONE",
    ]);

    const orchestrator = new AgentHubOrchestrator({
      workspace: tempDir,
      codexAgent: codex,
      geminiAgent: gemini,
      firstAgent: "codex",
      maxRounds: 6,
      baseDir: tempDir,
    });

    const result = await orchestrator.runTask("Implement divide feature");
    expect(result.finalState).toBe("DONE");
    expect(result.totalRounds).toBe(2);

    // Verify Gemini received Codex output
    expect(gemini.history[0].message).toContain("Here is my code implementation.");
    expect(gemini.history[0].message).toContain("上一位 Agent：\nCodex (Developer)");
  });

  // Test 4: Gemini → Codex
  it("Test 4: Forwards Gemini review feedback back to Codex for modification", async () => {
    const codex = new MockAgent("codex", [
      "Initial code drafted.\nAGENT_STATUS: CONTINUE",
      "Fixed edge cases as requested by Gemini.\nAGENT_STATUS: DONE",
    ]);
    const gemini = new MockAgent("gemini", [
      "Found bug in divide by zero.\nAGENT_STATUS: CONTINUE",
    ]);

    const orchestrator = new AgentHubOrchestrator({
      workspace: tempDir,
      codexAgent: codex,
      geminiAgent: gemini,
      firstAgent: "codex",
      maxRounds: 6,
      baseDir: tempDir,
    });

    const result = await orchestrator.runTask("Fix calculation errors");
    expect(result.finalState).toBe("DONE");
    expect(result.totalRounds).toBe(3);

    // Verify round 3: Codex received Gemini feedback
    expect(codex.history[1].message).toContain("Found bug in divide by zero.");
    expect(codex.history[1].message).toContain("上一位 Agent：\nGemini (Reviewer)");
  });

  // Test 5: 3 轮自动通信 (Codex -> Gemini -> Codex)
  it("Test 5: Executes 3 rounds of automated communication (Codex -> Gemini -> Codex)", async () => {
    const codex = new MockAgent("codex", [
      "Round 1: Implement feature.\nAGENT_STATUS: CONTINUE",
      "Round 3: Adjusted implementation.\nAGENT_STATUS: DONE",
    ]);
    const gemini = new MockAgent("gemini", [
      "Round 2: Review feedback.\nAGENT_STATUS: CONTINUE",
    ]);

    const orchestrator = new AgentHubOrchestrator({
      workspace: tempDir,
      codexAgent: codex,
      geminiAgent: gemini,
      firstAgent: "codex",
      maxRounds: 6,
      baseDir: tempDir,
    });

    const result = await orchestrator.runTask("Three rounds test");
    expect(result.totalRounds).toBe(3);
    expect(result.finalState).toBe("DONE");
    expect(result.messages.length).toBe(4); // 1 task + 3 turns
  });

  // Test 6: 5 轮自动通信 (Codex -> Gemini -> Codex -> Gemini -> Codex)
  it("Test 6: Executes 5 rounds of automated communication without losing context", async () => {
    const codex = new MockAgent("codex", [
      "Round 1 from Codex.\nAGENT_STATUS: CONTINUE",
      "Round 3 from Codex.\nAGENT_STATUS: CONTINUE",
      "Round 5 from Codex: Final fix done.\nAGENT_STATUS: DONE",
    ]);
    const gemini = new MockAgent("gemini", [
      "Round 2 from Gemini: Please refine.\nAGENT_STATUS: CONTINUE",
      "Round 4 from Gemini: Please add test case.\nAGENT_STATUS: CONTINUE",
    ]);

    const orchestrator = new AgentHubOrchestrator({
      workspace: tempDir,
      codexAgent: codex,
      geminiAgent: gemini,
      firstAgent: "codex",
      maxRounds: 6,
      baseDir: tempDir,
    });

    const result = await orchestrator.runTask("Five rounds multi-turn test");
    expect(result.totalRounds).toBe(5);
    expect(result.finalState).toBe("DONE");
    expect(codex.history.length).toBe(3);
    expect(gemini.history.length).toBe(2);

    // Verify context was preserved at turn 5
    expect(codex.history[2].message).toContain("Round 4 from Gemini: Please add test case.");
  });

  // Test 7: 最大轮次 (maxRounds = 3)
  it("Test 7: Strictly enforces max rounds (stops at round 3 without executing round 4)", async () => {
    const codex = new MockAgent("codex", [
      "Turn 1.\nAGENT_STATUS: CONTINUE",
      "Turn 3.\nAGENT_STATUS: CONTINUE",
    ]);
    const gemini = new MockAgent("gemini", [
      "Turn 2.\nAGENT_STATUS: CONTINUE",
    ]);

    const orchestrator = new AgentHubOrchestrator({
      workspace: tempDir,
      codexAgent: codex,
      geminiAgent: gemini,
      firstAgent: "codex",
      maxRounds: 3,
      baseDir: tempDir,
    });

    const result = await orchestrator.runTask("Enforce max rounds test");
    expect(result.totalRounds).toBe(3);
    expect(result.finalState).toBe("NEED_USER");
    expect(result.stopReason).toBe("MAX_ROUNDS");
    // Ensure gemini was not called for turn 4
    expect(gemini.history.length).toBe(1);
    expect(codex.history.length).toBe(2);
  });

  // Test 8: DONE 状态退出
  it("Test 8: Halts immediately when agent returns AGENT_STATUS: DONE", async () => {
    const codex = new MockAgent("codex", [
      "Everything is already in place. Nothing to do.\nAGENT_STATUS: DONE",
    ]);
    const gemini = new MockAgent("gemini", []);

    const orchestrator = new AgentHubOrchestrator({
      workspace: tempDir,
      codexAgent: codex,
      geminiAgent: gemini,
      firstAgent: "codex",
      maxRounds: 6,
      baseDir: tempDir,
    });

    const result = await orchestrator.runTask("Verify already completed work");
    expect(result.finalState).toBe("DONE");
    expect(result.totalRounds).toBe(1);
    expect(gemini.history.length).toBe(0);
  });

  // Test 9: NEED_USER 状态处理
  it("Test 9: Pauses and requests user input when agent returns AGENT_STATUS: NEED_USER", async () => {
    const codex = new MockAgent("codex", [
      "Unclear specifications: should we support floating point?\nAGENT_STATUS: NEED_USER",
    ]);
    const gemini = new MockAgent("gemini", []);

    const orchestrator = new AgentHubOrchestrator({
      workspace: tempDir,
      codexAgent: codex,
      geminiAgent: gemini,
      firstAgent: "codex",
      maxRounds: 6,
      baseDir: tempDir,
    });

    const result = await orchestrator.runTask("Implement fuzzy calculator");
    expect(result.finalState).toBe("NEED_USER");
    expect(result.stopReason).toBe("NEED_USER");
    expect(gemini.history.length).toBe(0);
  });
});
