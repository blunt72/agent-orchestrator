export class TaskExecutionBusyError extends Error {
  public readonly code = "TASK_EXECUTION_BUSY";
  public readonly statusCode = 409;

  constructor(taskId: string) {
    super(`Task execution is locked: ${taskId}; inspect the holder and provider session before retrying`);
    this.name = "TaskExecutionBusyError";
  }
}
