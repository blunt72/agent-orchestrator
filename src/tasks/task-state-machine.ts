import { TaskStatus } from "./task.js";

export class TaskStateMachineError extends Error {
  constructor(public readonly from: TaskStatus, public readonly to: TaskStatus, reason?: string) {
    super(`Illegal task state transition from ${from} to ${to}${reason ? `: ${reason}` : ""}`);
    this.name = "TaskStateMachineError";
  }
}

export class TaskStateMachine {
  private static readonly VALID_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
    TODO: ["DOING", "BLOCKED", "NEED_USER", "FAILED", "CANCELLED"],
    BLOCKED: ["TODO", "CANCELLED"],
    DOING: ["TESTING", "REWORK", "DONE", "BLOCKED", "NEED_USER", "FAILED", "CANCELLED"],
    TESTING: ["REVIEW", "REWORK", "NEED_USER", "FAILED", "CANCELLED"],
    REVIEW: ["DONE", "REWORK", "NEED_USER", "FAILED", "CANCELLED"],
    REWORK: ["DOING", "TESTING", "NEED_USER", "FAILED", "CANCELLED"],
    NEED_USER: ["DOING", "REWORK", "TESTING", "REVIEW", "CANCELLED", "FAILED"],
    DONE: [],
    FAILED: [],
    CANCELLED: [],
  };

  private currentStatus: TaskStatus;

  constructor(initialStatus: TaskStatus = "TODO") {
    this.currentStatus = initialStatus;
  }

  public getStatus(): TaskStatus {
    return this.currentStatus;
  }

  public isTerminal(): boolean {
    return this.currentStatus === "DONE" || this.currentStatus === "FAILED" || this.currentStatus === "CANCELLED";
  }

  public canTransitionTo(targetStatus: TaskStatus): boolean {
    const allowed = TaskStateMachine.VALID_TRANSITIONS[this.currentStatus] || [];
    return allowed.includes(targetStatus);
  }

  public transition(targetStatus: TaskStatus, reason?: string): TaskStatus {
    if (!this.canTransitionTo(targetStatus)) {
      throw new TaskStateMachineError(this.currentStatus, targetStatus, reason);
    }
    this.currentStatus = targetStatus;
    return this.currentStatus;
  }
}
