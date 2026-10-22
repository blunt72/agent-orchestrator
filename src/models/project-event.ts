import crypto from "node:crypto";

/**
 * Unified Project Event Model for AgentHub V0.3
 * Tracks all timeline activities, handoffs, and lifecycle events across projects, epics, and tasks.
 */

export type ProjectEventActorType = "HUMAN" | "AGENT" | "SYSTEM";

export interface ProjectEvent {
  id: string;
  projectId: string;
  epicId?: string;
  taskId?: string;
  actorId: string;
  actorType: ProjectEventActorType;
  type: string;
  timestamp: string;
  data?: unknown;
}

export function createProjectEvent(
  projectId: string,
  type: string,
  actorId: string,
  actorType: ProjectEventActorType,
  options?: {
    epicId?: string;
    taskId?: string;
    data?: unknown;
  }
): ProjectEvent {
  return {
    id: `pevt-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    projectId,
    epicId: options?.epicId,
    taskId: options?.taskId,
    actorId,
    actorType,
    type,
    timestamp: new Date().toISOString(),
    data: options?.data,
  };
}
