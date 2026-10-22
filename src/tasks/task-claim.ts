export interface ClaimTaskInput {
  ownerId: string;
  expectedOwnerId: string;
}

export class TaskClaimError extends Error {
  constructor(
    public readonly code: "INVALID_CLAIM" | "CLAIM_BUSY" | "CLAIM_CONFLICT" | "TASK_NOT_FOUND",
    message: string,
    public readonly statusCode: number = 409,
  ) {
    super(message);
    this.name = "TaskClaimError";
  }
}
