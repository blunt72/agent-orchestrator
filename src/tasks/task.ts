/**
 * Task Data Models for AgentHub V0.3
 * Expanded with Epic association, dependency graph, actor ownership, weight & progress.
 */

import type { FileBaselineEntry } from "../git/git-service.js";

export type TaskStatus =
  | "TODO"
  | "BLOCKED"
  | "DOING"
  | "TESTING"
  | "REVIEW"
  | "REWORK"
  | "NEED_USER"
  | "DONE"
  | "FAILED"
  | "CANCELLED";

export type TaskOwner = "user" | "codex" | "gemini" | "system";

export type TaskOwnerType = "HUMAN" | "AGENT";

export type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface TaskSource {
  type: "USER" | "AGENT" | "TASK" | "SYSTEM";
  id?: string;
}

export interface TaskResult {
  status: "PASS" | "FAIL" | "NEED_USER";
  summary: string;
  changedFiles: string[];
  testStatus: "PASS" | "FAIL" | "NOT_RUN";
  testCommand?: string;
  reviewStatus: "PASS" | "REQUEST_CHANGES" | "NOT_RUN";
  rounds: number;
  branch?: string;
  worktree?: string;
}

export interface Task {
  orcaHistoricalCompletion?: import("../integrations/orca-historical-completion.js").OrcaHistoricalCompletion;
  orcaPrintTaskCompletion?: import("../integrations/orca-print-task-completion.js").OrcaPrintTaskCompletionRecord;
  orcaPrintReviewFinalization?: import("../integrations/orca-print-review-finalization.js").OrcaPrintReviewFinalization;
  orcaPrintCaptureIntent?: import("../integrations/orca-print-review-capture.js").OrcaPrintCaptureIntent;
  orcaPrintCaptureResult?: import("../integrations/orca-print-review-capture.js").OrcaPrintCaptureResult;
  orcaPrintReviewPreparation?: import("../integrations/orca-print-review-preparation.js").OrcaPrintReviewPreparation;
  orcaPrintRecoveryPreparation?: import("../integrations/orca-print-review-preparation.js").OrcaPrintRecoveryPreparation;
  orcaPrintRecoveryCaptureIntent?: import("../integrations/orca-print-review-capture.js").OrcaPrintCaptureIntent;
  orcaPrintRecoveryCaptureResult?: import("../integrations/orca-print-review-capture.js").OrcaPrintCaptureResult;
  orcaPrintRecoveryFinalization?: import("../integrations/orca-print-review-finalization.js").OrcaPrintReviewFinalization;
  orcaTaskCompletion?: import("../integrations/orca-task-completion.js").OrcaTaskCompletionRecord;
  orcaCompletion?: import("../integrations/orca-limited-completion.js").OrcaLimitedCompletionRecord;
  revision?: number;
  orcaBinding?: import("../integrations/orca-delivery.js").OrcaBinding;
  orcaBaseline?: import("../integrations/orca-baseline.js").OrcaBaselineReceipt;
  orcaGeneration?: number;
  orcaDelivery?: import("../integrations/orca-import.js").OrcaDeliveryCommit;
  orcaTestRun?: import("../integrations/orca-tests.js").OrcaTestRun;
  orcaRevalidationHistory?: { priorTaskEvidence: import("../integrations/orca-evidence.js").OrcaEvidenceRef;
    authorizationEvidence: import("../integrations/orca-evidence.js").OrcaEvidenceRef; workspaceHash: string; recordedAt: string }[];
  orcaReviewRun?: import("../integrations/orca-review.js").OrcaReviewRun;
  orcaReviewHistory?: import("../integrations/orca-review.js").OrcaReviewHistoryEntry[];
  orcaReviewContext?: { requirements: import("../integrations/orca-evidence.js").OrcaEvidenceRef;
    reconciliation: import("../integrations/orca-evidence.js").OrcaEvidenceRef;
    priorTask: import("../integrations/orca-evidence.js").OrcaEvidenceRef };
  claim?: { id: string; ownerId: string; previousOwnerId: string; claimedAt: string };
  pendingAgentTurn?: import("../agents/agent.js").PendingAgentTurn & { actor: "codex" | "gemini"; phase: "DOING" | "REVIEW" };
  pendingHumanResponse?: string;
  id: string;
  projectId: string;
  epicId?: string;
  parentTaskId?: string;
  rootTaskId?: string;
  title: string;
  description: string;
  status: TaskStatus;
  owner: TaskOwner;
  ownerType: TaskOwnerType;
  ownerId: string;
  reviewer?: "gemini" | "codex";
  reviewerId?: string;
  baseline?: Record<string, FileBaselineEntry>;
  priority: TaskPriority;
  workspace: string;
  branch?: string;
  worktree?: string;
  dependsOn?: string[];
  blockedBy?: string[];
  nextAction?: string;
  estimatedWeight?: number;
  progress?: number;
  source?: TaskSource;
  maxRounds: number;
  currentRound: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: TaskResult;
  testCommand?: string;
}

export interface CreateTaskInput {
  id?: string;
  projectId: string;
  epicId?: string;
  parentTaskId?: string;
  rootTaskId?: string;
  title: string;
  description: string;
  workspace?: string;
  priority?: TaskPriority;
  ownerType?: TaskOwnerType;
  ownerId?: string;
  reviewer?: "gemini" | "codex";
  reviewerId?: string;
  dependsOn?: string[];
  estimatedWeight?: number;
  maxRounds?: number;
  testCommand?: string;
  source?: TaskSource;
}
