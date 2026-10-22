import { describe, it, expect } from "vitest";
import { TaskStateMachine, TaskStateMachineError } from "../../src/tasks/task-state-machine.js";

describe("TaskStateMachine Unit Tests", () => {
  it("initializes with TODO state by default", () => {
    const sm = new TaskStateMachine();
    expect(sm.getStatus()).toBe("TODO");
    expect(sm.isTerminal()).toBe(false);
  });

  it("handles standard happy path: TODO -> DOING -> TESTING -> REVIEW -> DONE", () => {
    const sm = new TaskStateMachine();

    expect(sm.transition("DOING")).toBe("DOING");
    expect(sm.transition("TESTING")).toBe("TESTING");
    expect(sm.transition("REVIEW")).toBe("REVIEW");
    expect(sm.transition("DONE")).toBe("DONE");

    expect(sm.getStatus()).toBe("DONE");
    expect(sm.isTerminal()).toBe(true);
  });

  it("handles rework loop: REVIEW -> REWORK -> DOING -> TESTING -> REVIEW -> DONE", () => {
    const sm = new TaskStateMachine("REVIEW");

    expect(sm.transition("REWORK", "Changes requested")).toBe("REWORK");
    expect(sm.transition("DOING")).toBe("DOING");
    expect(sm.transition("TESTING")).toBe("TESTING");
    expect(sm.transition("REVIEW")).toBe("REVIEW");
    expect(sm.transition("DONE")).toBe("DONE");

    expect(sm.isTerminal()).toBe(true);
  });

  it("handles test failure loop: TESTING -> REWORK -> DOING", () => {
    const sm = new TaskStateMachine("TESTING");

    expect(sm.transition("REWORK", "Tests failed with exit code 1")).toBe("REWORK");
    expect(sm.transition("DOING")).toBe("DOING");
    expect(sm.getStatus()).toBe("DOING");
  });

  it("handles NEED_USER pause and resume", () => {
    const sm = new TaskStateMachine("DOING");

    expect(sm.transition("NEED_USER", "Max rounds reached")).toBe("NEED_USER");
    expect(sm.isTerminal()).toBe(false);

    // Resume back to DOING
    expect(sm.transition("DOING")).toBe("DOING");
    expect(sm.getStatus()).toBe("DOING");
  });

  it("handles cancellation from non-terminal states", () => {
    const sm1 = new TaskStateMachine("TODO");
    expect(sm1.transition("CANCELLED")).toBe("CANCELLED");
    expect(sm1.isTerminal()).toBe(true);

    const sm2 = new TaskStateMachine("DOING");
    expect(sm2.transition("CANCELLED")).toBe("CANCELLED");

    const sm3 = new TaskStateMachine("REVIEW");
    expect(sm3.transition("CANCELLED")).toBe("CANCELLED");
  });

  it("strictly rejects illegal transitions", () => {
    const sm = new TaskStateMachine("TODO");

    // Cannot jump from TODO directly to DONE
    expect(() => sm.transition("DONE")).toThrow(TaskStateMachineError);

    // Cannot jump from TODO to REVIEW
    expect(() => sm.transition("REVIEW")).toThrow(TaskStateMachineError);

    // Cannot jump from TODO to TESTING
    expect(() => sm.transition("TESTING")).toThrow(TaskStateMachineError);
  });

  it("strictly prevents transitions out of terminal states", () => {
    const smDone = new TaskStateMachine("DONE");
    expect(() => smDone.transition("DOING")).toThrow(TaskStateMachineError);
    expect(() => smDone.transition("REWORK")).toThrow(TaskStateMachineError);

    const smFailed = new TaskStateMachine("FAILED");
    expect(() => smFailed.transition("DOING")).toThrow(TaskStateMachineError);

    const smCancelled = new TaskStateMachine("CANCELLED");
    expect(() => smCancelled.transition("REVIEW")).toThrow(TaskStateMachineError);
  });
});
