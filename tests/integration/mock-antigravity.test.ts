import { describe, it, expect } from "vitest";
import path from "node:path";
import { Agent, AgentResponse } from "../../src/agents/agent.js";

class MockReviewerAgent implements Agent {
  public readonly name = "gemini";
  public memory: Map<string, string> = new Map();
  public initialized = false;

  async start(): Promise<void> {}
  async initialize(): Promise<void> {
    this.initialized = true;
  }
  async createSession(workspace: string): Promise<string> {
    return "mock-gemini-session-1";
  }
  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    if (message.includes("Remember the code word")) {
      const match = message.match(/Remember the code word\s+([A-Za-z0-9_-]+)/i);
      if (match) this.memory.set("code_word", match[1]);
      return {
        text: `Understood. Code word recorded.\nAGENT_STATUS: CONTINUE`,
      };
    }
    if (message.includes("What code word")) {
      const word = this.memory.get("code_word") || "UNKNOWN";
      return {
        text: `The code word is ${word}.\nAGENT_STATUS: DONE`,
      };
    }
    return {
      text: `Review completed.\nAGENT_STATUS: DONE`,
    };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
  isRunning(): boolean {
    return this.initialized;
  }
}

describe("Mock Reviewer Multi-Turn Context Persistence (Integration)", () => {
  const demoWorkspace = path.resolve(process.cwd(), "examples/demo-workspace");

  it("retains conversational context across turns within mock agent", async () => {
    const agent = new MockReviewerAgent();
    await agent.initialize();
    const sessionId = await agent.createSession(demoWorkspace);
    expect(sessionId).toBeDefined();

    // Turn 1: instruct agent to remember code word APPLE
    const turn1Response = await agent.prompt(sessionId, "Remember the code word APPLE.");
    expect(turn1Response.text).toContain("Understood");

    // Turn 2: ask agent what code word was told
    const turn2Response = await agent.prompt(sessionId, "What code word did I tell you?");
    expect(turn2Response.text).toContain("APPLE");
  });
});
