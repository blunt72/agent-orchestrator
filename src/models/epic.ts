/**
 * Epic Model for AgentHub V0.3
 * Organizes tasks into high-level milestones and tracks progress.
 */

export type EpicStatus = "TODO" | "DOING" | "DONE" | "BLOCKED";
export type EpicPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface Epic {
  historicalClosureSummary?: { taskIds: string[]; normalAcceptancePassed: false };
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: EpicStatus;
  progress: number;
  priority: EpicPriority;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEpicInput {
  id?: string;
  projectId: string;
  title: string;
  description?: string;
  priority?: EpicPriority;
}
