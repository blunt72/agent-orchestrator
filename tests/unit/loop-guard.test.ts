import { describe, it, expect } from "vitest";
import { MessageRouter } from "../../src/core/router.js";
import { createAgentMessage } from "../../src/core/message.js";

describe("Loop Guard", () => {
  it("triggers MAX_ROUNDS when reaching max rounds limit", () => {
    const router = new MessageRouter({ maxRounds: 3 });

    const msg1 = createAgentMessage("s1", 1, "codex", "gemini", "response", "First step", { status: "continue" });
    const d1 = router.route(msg1);
    expect(d1.action).toBe("proceed");

    const msg2 = createAgentMessage("s1", 2, "gemini", "codex", "review", "Review step", { status: "continue" });
    const d2 = router.route(msg2);
    expect(d2.action).toBe("proceed");

    const msg3 = createAgentMessage("s1", 3, "codex", "gemini", "response", "Third step", { status: "continue" });
    const d3 = router.route(msg3);
    expect(d3.action).toBe("stop");
    expect(d3.stopReason).toBe("MAX_ROUNDS");
  });

  it("detects repeating identical messages and halts with REPETITION", () => {
    const router = new MessageRouter({ maxRounds: 6, maxSameMessage: 2 });

    const repeatedText = "我认为方案正确，测试已通过。";

    const msg1 = createAgentMessage("s1", 1, "codex", "gemini", "response", repeatedText, { status: "continue" });
    const d1 = router.route(msg1);
    expect(d1.action).toBe("proceed");

    const msg2 = createAgentMessage("s1", 2, "gemini", "codex", "review", repeatedText, { status: "continue" });
    const d2 = router.route(msg2);
    expect(d2.action).toBe("proceed");

    const msg3 = createAgentMessage("s1", 3, "codex", "gemini", "response", repeatedText, { status: "continue" });
    const d3 = router.route(msg3);
    expect(d3.action).toBe("stop");
    expect(d3.stopReason).toBe("REPETITION");
    expect(d3.detail).toContain("Loop detected");
  });
});
