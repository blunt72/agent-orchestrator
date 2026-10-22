import { describe, it, expect } from "vitest";
import { AgentStateMachine } from "../../src/core/state-machine.js";

describe("AgentStateMachine", () => {
  it("initializes in IDLE state", () => {
    const sm = new AgentStateMachine(6);
    expect(sm.getState()).toBe("IDLE");
    expect(sm.getRound()).toBe(0);
    expect(sm.getMaxRounds()).toBe(6);
    expect(sm.isTerminal()).toBe(false);
  });

  it("transitions through running and waiting states", () => {
    const sm = new AgentStateMachine(6);
    sm.start("codex");
    expect(sm.getState()).toBe("RUNNING");
    expect(sm.getRound()).toBe(1);
    expect(sm.getActiveAgent()).toBe("codex");

    sm.agentWaiting("gemini");
    expect(sm.getState()).toBe("WAITING_AGENT");
    expect(sm.getActiveAgent()).toBe("gemini");

    const round2 = sm.incrementRound();
    expect(round2).toBe(2);

    sm.agentStartTurn("gemini");
    expect(sm.getState()).toBe("RUNNING");
    expect(sm.getActiveAgent()).toBe("gemini");

    sm.done("COMPLETE");
    expect(sm.getState()).toBe("DONE");
    expect(sm.getStopReason()).toBe("COMPLETE");
    expect(sm.isTerminal()).toBe(true);
  });

  it("handles error state", () => {
    const sm = new AgentStateMachine(6);
    sm.start("codex");
    sm.error("Process crashed unexpectedly", "AGENT_CRASH");

    expect(sm.getState()).toBe("ERROR");
    expect(sm.getStopReason()).toBe("AGENT_CRASH");
    expect(sm.getLastError()).toBe("Process crashed unexpectedly");
    expect(sm.isTerminal()).toBe(true);
  });

  it("handles need_user state when max rounds exceeded", () => {
    const sm = new AgentStateMachine(2);
    sm.start("codex");
    expect(sm.getRound()).toBe(1);

    sm.incrementRound(); // round 2
    expect(sm.getRound()).toBe(2);
    expect(sm.getState()).toBe("RUNNING");

    sm.incrementRound(); // round 3 > maxRounds 2
    expect(sm.getState()).toBe("NEED_USER");
    expect(sm.getStopReason()).toBe("MAX_ROUNDS");
    expect(sm.isTerminal()).toBe(true);
  });

  it("throws when starting from non-IDLE state", () => {
    const sm = new AgentStateMachine(6);
    sm.start("codex");
    expect(() => sm.start("gemini")).toThrow("Cannot start from state RUNNING");
  });
});
