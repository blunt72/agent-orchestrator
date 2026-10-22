import { describe, it, expect } from "vitest";
import { MessageRouter } from "../../src/core/router.js";
import { createAgentMessage } from "../../src/core/message.js";

describe("MessageRouter", () => {
  it("alternates next agent between codex and gemini", () => {
    const router = new MessageRouter({ maxRounds: 6 });
    expect(router.getNextAgent("codex")).toBe("gemini");
    expect(router.getNextAgent("gemini")).toBe("codex");
  });

  it("routes message to next agent when status is continue", () => {
    const router = new MessageRouter({ maxRounds: 6 });
    const msg = createAgentMessage("sess-1", 1, "codex", "gemini", "response", "Plan ready", {
      status: "continue",
    });

    const decision = router.route(msg);
    expect(decision.action).toBe("proceed");
    expect(decision.nextRecipient).toBe("gemini");
  });

  it("stops immediately when agent output status is done", () => {
    const router = new MessageRouter({ maxRounds: 6 });
    const msg = createAgentMessage("sess-1", 2, "gemini", "codex", "review", "Looks good! AGENT_STATUS: DONE", {
      status: "done",
    });

    const decision = router.route(msg);
    expect(decision.action).toBe("stop");
    expect(decision.stopReason).toBe("COMPLETE");
  });

  it("stops and requests user when agent status is need_user", () => {
    const router = new MessageRouter({ maxRounds: 6 });
    const msg = createAgentMessage("sess-1", 2, "codex", "gemini", "response", "Need user decision", {
      status: "need_user",
    });

    const decision = router.route(msg);
    expect(decision.action).toBe("stop");
    expect(decision.stopReason).toBe("NEED_USER");
  });
});
