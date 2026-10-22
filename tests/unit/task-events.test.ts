import { describe, it, expect } from "vitest";
import { createTaskEvent, TaskEventType, TaskActor } from "../../src/tasks/task-events.js";

describe("TaskEvent Unit Tests", () => {
  it("creates a well-formed TaskEvent with unique ID, timestamp, and payload", () => {
    const event = createTaskEvent("TASK-EV-1", "TASK_CREATED", "user", {
      projectId: "proj-1",
      title: "Add validation",
    });

    expect(event.id).toMatch(/^evt-\d+-[a-f0-9]+$/);
    expect(event.taskId).toBe("TASK-EV-1");
    expect(event.type).toBe("TASK_CREATED");
    expect(event.actor).toBe("user");
    expect(event.timestamp).toBeDefined();
    expect(new Date(event.timestamp).getTime()).not.toBeNaN();
    expect((event.details as any).title).toBe("Add validation");
  });

  it("supports all required task event types and actors", () => {
    const types: TaskEventType[] = [
      "TASK_CREATED",
      "WORKTREE_CREATED",
      "TASK_STARTED",
      "STATUS_CHANGED",
      "AGENT_STARTED",
      "AGENT_COMPLETED",
      "TEST_STARTED",
      "TEST_PASSED",
      "TEST_FAILED",
      "REVIEW_STARTED",
      "REVIEW_PASSED",
      "REVIEW_FAILED",
      "REWORK_STARTED",
      "NEED_USER",
      "TASK_COMPLETED",
      "TASK_FAILED",
    ];

    const actors: TaskActor[] = ["user", "codex", "gemini", "system"];

    for (let i = 0; i < types.length; i++) {
      const type = types[i];
      const actor = actors[i % actors.length];
      const ev = createTaskEvent("TASK-ALL", type, actor, { index: i });
      expect(ev.type).toBe(type);
      expect(ev.actor).toBe(actor);
    }
  });
});
