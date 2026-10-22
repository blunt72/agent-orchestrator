import { describe, it, expect } from "vitest";
import {
  formatAgentPrompt,
  parseAgentStatus,
  createAgentMessage,
  sanitizeLog,
} from "../../src/core/message.js";

describe("Message Protocol", () => {
  it("formats prompt strictly matching the protocol specification", () => {
    const formatted = formatAgentPrompt({
      role: "Developer / Implementer",
      task: "Fix calculator bug",
      round: 2,
      from: "Gemini (Reviewer)",
      message: "Please add validation for negative numbers.",
    });

    expect(formatted).toContain("你是 AgentHub 中的 Developer / Implementer。");
    expect(formatted).toContain("当前任务：\nFix calculator bug");
    expect(formatted).toContain("当前轮次：\n2");
    expect(formatted).toContain("上一位 Agent：\nGemini (Reviewer)");
    expect(formatted).toContain("--- BEGIN MESSAGE ---\nPlease add validation for negative numbers.\n--- END MESSAGE ---");
    expect(formatted).toContain("AGENT_STATUS: DONE");
    expect(formatted).toContain("AGENT_STATUS: CONTINUE");
    expect(formatted).toContain("AGENT_STATUS: NEED_USER");
  });

  it("parses AGENT_STATUS: DONE correctly", () => {
    const text = "I have finished all tasks.\n\nAGENT_STATUS: DONE";
    const result = parseAgentStatus(text);
    expect(result.status).toBe("done");
    expect(result.warning).toBeUndefined();
  });

  it("parses AGENT_STATUS: CONTINUE correctly", () => {
    const text = "Here is my code review. Please update tests.\nAGENT_STATUS: CONTINUE";
    const result = parseAgentStatus(text);
    expect(result.status).toBe("continue");
    expect(result.warning).toBeUndefined();
  });

  it("parses AGENT_STATUS: NEED_USER correctly", () => {
    const text = "Ambiguous requirement. Need clarification.\nAGENT_STATUS: NEED_USER";
    const result = parseAgentStatus(text);
    expect(result.status).toBe("need_user");
    expect(result.warning).toBeUndefined();
  });

  it("defaults to CONTINUE and provides warning if status tag is missing", () => {
    const text = "I wrote some code but forgot the status line.";
    const result = parseAgentStatus(text);
    expect(result.status).toBe("continue");
    expect(result.warning).toBeDefined();
  });

  it("creates valid agent message with metadata", () => {
    const msg = createAgentMessage(
      "sess-123",
      1,
      "codex",
      "gemini",
      "response",
      "Code is ready",
      { status: "continue", stopReason: "end_turn" }
    );
    expect(msg.sessionId).toBe("sess-123");
    expect(msg.round).toBe(1);
    expect(msg.from).toBe("codex");
    expect(msg.to).toBe("gemini");
    expect(msg.content).toBe("Code is ready");
    expect(msg.status).toBe("continue");
    expect(msg.stopReason).toBe("end_turn");
    expect(msg.timestamp).toBeDefined();
  });

  it("sanitizes API keys and bearer tokens", () => {
    const raw = "My key is sk-1234567890abcdef12345678 and token is Bearer eyJhbGciOiJIUzI1NiJ9.test and GEMINI_API_KEY=AIzaSyA123456789012345678901234567890";
    const sanitized = sanitizeLog(raw);
    expect(sanitized).not.toContain("sk-1234567890abcdef12345678");
    expect(sanitized).not.toContain("AIzaSyA123456789012345678901234567890");
    expect(sanitized).toContain("***REDACTED***");
  });
});
