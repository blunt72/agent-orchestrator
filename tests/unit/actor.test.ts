import { describe, it, expect } from "vitest";
import { Actor, DEFAULT_SYSTEM_ACTORS } from "../../src/models/actor.js";

describe("Actor Model Unit Tests", () => {
  it("provides valid default system actors for Codex, Gemini, and User", () => {
    expect(DEFAULT_SYSTEM_ACTORS.length).toBe(3);

    const codex = DEFAULT_SYSTEM_ACTORS.find((a) => a.id === "codex");
    expect(codex).toBeDefined();
    expect(codex?.type).toBe("AGENT");
    expect(codex?.role).toBe("Developer");

    const gemini = DEFAULT_SYSTEM_ACTORS.find((a) => a.id === "gemini");
    expect(gemini).toBeDefined();
    expect(gemini?.type).toBe("AGENT");
    expect(gemini?.role).toBe("Reviewer");

    const user = DEFAULT_SYSTEM_ACTORS.find((a) => a.id === "user");
    expect(user).toBeDefined();
    expect(user?.type).toBe("HUMAN");
  });

  it("supports creating and validating custom human and agent actors", () => {
    const humanDev: Actor = {
      id: "dev-zhangsan",
      type: "HUMAN",
      name: "张三",
      role: "Backend Lead",
      capabilities: ["backend", "review"],
      enabled: true,
    };

    expect(humanDev.id).toBe("dev-zhangsan");
    expect(humanDev.type).toBe("HUMAN");
    expect(humanDev.name).toBe("张三");
    expect(humanDev.enabled).toBe(true);
  });
});
