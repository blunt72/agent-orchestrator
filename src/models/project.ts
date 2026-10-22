/**
 * Project Model for AgentHub V0.3
 * Upgraded project definition with lifecycle states, mathematical progress, and timestamps.
 */

export type ProjectStatus =
  | "PLANNING"
  | "ACTIVE"
  | "PAUSED"
  | "DONE"
  | "CANCELLED";

export interface Project {
  historicalClosureSummary?: { taskIds: string[]; normalAcceptancePassed: false };
  id: string;
  name: string;
  description?: string;
  workspace?: string;
  status: ProjectStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CreateProjectInput {
  id?: string;
  name: string;
  description?: string;
  workspace?: string;
  status?: ProjectStatus;
}
