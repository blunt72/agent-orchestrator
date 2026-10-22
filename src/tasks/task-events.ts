import crypto from "node:crypto";

export const TASK_EVENT_TYPES = [
  "TASK_CREATED", "WORKTREE_CREATED", "TASK_STARTED", "STATUS_CHANGED",
  "AGENT_STARTED", "AGENT_COMPLETED", "TEST_STARTED", "TEST_PASSED", "TEST_FAILED",
  "REVIEW_STARTED", "REVIEW_PASSED", "REVIEW_FAILED", "REWORK_STARTED", "TASK_BLOCKED",
  "TASK_UNBLOCKED", "TASK_ASSIGNED", "TASK_CLAIMED", "TASK_PROPOSAL", "NEED_USER",
  "TASK_COMPLETED", "TASK_HISTORICALLY_CLOSED", "TASK_FAILED",
] as const;

export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export type TaskActor = "user" | "codex" | "gemini" | "system" | string;

export interface TaskEvent {
  id: string;
  taskId: string;
  timestamp: string;
  type: TaskEventType;
  actor: TaskActor;
  details?: unknown;
}

export function createTaskEvent(
  taskId: string,
  type: TaskEventType,
  actor: TaskActor,
  details?: unknown
): TaskEvent {
  return {
    id: `evt-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    taskId,
    timestamp: new Date().toISOString(),
    type,
    actor,
    details,
  };
}
