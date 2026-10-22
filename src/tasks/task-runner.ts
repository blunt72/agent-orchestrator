import { GeminiTaskEventBridge, type BridgeEvent } from "../integrations/gemini-task-event-bridge.js";
import { Task, TaskResult } from "./task.js";
import { TaskStateMachine } from "./task-state-machine.js";
import { TaskStore } from "./task-store.js";
import { createTaskEvent } from "./task-events.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import { GitService } from "../git/git-service.js";
import { TestDetector } from "../testing/test-detector.js";
import { TestRunner, TestRunResult } from "../testing/test-runner.js";
import { Agent, AgentResponse, AgentTurnPendingError } from "../agents/agent.js";
import { CodexAgent } from "../agents/codex-agent.js";
import { AntigravityAgent } from "../agents/antigravity-agent.js";
import { parseAgentStatus } from "../core/message.js";
import { ProgressCalculator } from "../projects/progress-calculator.js";

export interface TaskRunnerOptions {
  task: Task;
  store: TaskStore;
  codexAgent?: Agent;
  geminiAgent?: Agent;
  /** Opt-in local pending-turn bridge; use one directory per store. */
  transcriptBridge?: GeminiTaskEventBridge;
  transcriptBrainRoot?: string;
}

export interface ParsedReview {
  reviewStatus: "PASS" | "REQUEST_CHANGES";
  agentStatus: "done" | "continue" | "need_user";
  feedback: string;
}

export class TaskRunner {
  private transcriptBridge?: GeminiTaskEventBridge;
  private bridgeResumeInProgress = false;
  private task: Task;
  private store: TaskStore;
  private sm: TaskStateMachine;
  private developerId: "codex" | "gemini";
  private reviewerId: "codex" | "gemini";
  private codex: Agent;
  private gemini: Agent;
  private codexSessionId?: string;
  private geminiSessionId?: string;
  private isAborted: boolean = false;
  private turnCompleted = false;
  private abortController: AbortController = new AbortController();

  constructor(options: TaskRunnerOptions) {
    this.task = { ...options.task };
    this.transcriptBridge = options.transcriptBridge;
    this.store = options.store;
    this.sm = new TaskStateMachine(this.task.status);
    this.reviewerId = this.task.reviewerId === "codex" ? "codex" : "gemini";
    this.developerId = this.reviewerId === "codex" ? "gemini" : "codex";
    if (this.task.claim) {
      const owner = this.task.claim.ownerId;
      const reviewer = this.task.reviewerId;
      if (owner !== "codex" && owner !== "gemini") {
        throw new Error("Claimed task requires a supported claimant");
      }
      if ((reviewer !== "codex" && reviewer !== "gemini") || reviewer === owner) {
        throw new Error("Claimed task requires an explicit independent reviewer");
      }
      // Ownership follows the lifecycle; the receipt retains the original developer.
      const expectedOwner = this.task.status === "NEED_USER" ? "user"
        : this.task.status === "REVIEW" || this.task.status === "DONE" ? reviewer : owner;
      if (this.task.ownerId !== expectedOwner) {
        throw new Error("Claimed task requires lifecycle ownership matching its current owner");
      }
      this.developerId = owner;
      this.reviewerId = reviewer;
    }
    const agents = {
      codex: options.codexAgent ?? new CodexAgent(),
      gemini: options.geminiAgent ?? new AntigravityAgent({ transcriptBrainRoot: options.transcriptBrainRoot, role: this.developerId === "gemini" ? "developer" : "reviewer" }),
    };
    this.codex = agents[this.developerId];
    this.gemini = agents[this.reviewerId];
  }

  /** Human-authorized, independently verified recovery of the saved turn only. */
  public async resumeTranscriptEvent(eventId: string, authorization: {humanAuthorized: true; evidence: string},
      verify: (task: Task, event: BridgeEvent) => Promise<boolean>): Promise<Task> {
    if (!this.transcriptBridge) throw new Error("TRANSCRIPT_BRIDGE_NOT_CONFIGURED");
    await this.transcriptBridge.resume(this.store, this.task.id, eventId, authorization, verify, async task => {
      if (task.ownerId !== this.task.ownerId || task.reviewerId !== this.task.reviewerId ||
          JSON.stringify(task.claim) !== JSON.stringify(this.task.claim)) {
        throw new Error("TASK_OWNERSHIP_CHANGED_REQUIRES_REVIEW");
      }
      this.task = task;
      this.sm = new TaskStateMachine(task.status);
      this.bridgeResumeInProgress = true;
      try { await this.run(); } finally { this.bridgeResumeInProgress = false; }
    });
    return this.task;
  }

  public getTask(): Task {
    return this.task;
  }

  private async restoreTurn(agent: Agent): Promise<string> {
    if (!agent.restorePendingTurn || !this.task.pendingAgentTurn) throw new Error("Agent cannot restore pending turn");
    return agent.restorePendingTurn(this.task.pendingAgentTurn);
  }

  private async promptWithRecovery(agent: Agent, session: string, prompt: string, actor: "codex" | "gemini", phase: "DOING" | "REVIEW"): Promise<AgentResponse> {
    this.turnCompleted = false;
    let pending = this.task.pendingAgentTurn;
    let sendingHumanResponse = false;
    let lastPendingSignature: string | undefined;
    let lastPendingAt = 0;
    let immediatelyRepeatedPending = 0;
    agent.setPendingTurnHandler?.(async checkpoint => {
      this.task.pendingAgentTurn = { ...checkpoint, actor, phase };
      if (sendingHumanResponse) delete this.task.pendingHumanResponse;
      await this.store.saveTask(this.task);
    });
    for (;;) {
      if (this.isAborted) throw new Error("Task aborted; remote execution may continue");
      try {
        let response = pending
          ? await agent.waitForPendingTurn!(pending, this.abortController.signal)
          : await agent.prompt(session, prompt);
        if (pending && this.task.pendingHumanResponse) {
          if (!agent.setPendingTurnHandler) throw new Error("Agent cannot checkpoint a human continuation");
          // Consume the completed old turn before sending guidance to the same session.
          const guidance = this.task.pendingHumanResponse;
          pending = undefined;
          sendingHumanResponse = true;
          response = await agent.prompt(session, `${prompt}\n\nHuman continuation after completed pending turn:\n${guidance}`);
        }
        this.turnCompleted = true;
        return response;
      } catch (err) {
        if (!(err instanceof AgentTurnPendingError) || !agent.waitForPendingTurn) throw err;
        pending = { ...err.checkpoint, actor, phase };
        // A broken adapter can reject instantly forever; fail closed instead
        // of spinning through unbounded retries, events and task writes.
        const signature = JSON.stringify([pending.sessionId, pending.startStepIndex, pending.requestTime, actor, phase]);
        if (signature === lastPendingSignature && Date.now() - lastPendingAt < 1000) immediatelyRepeatedPending++;
        else immediatelyRepeatedPending = 0;
        lastPendingSignature = signature;
        lastPendingAt = Date.now();
        if (immediatelyRepeatedPending >= 3) {
          throw new Error("PENDING_TURN_REPEATED_WITHOUT_PROGRESS; inspect original session; do not redispatch");
        }
        this.task.pendingAgentTurn = pending;
        this.task.nextAction = `Waiting for existing ${actor} turn; no duplicate dispatch`;
        this.task.updatedAt = new Date().toISOString();
        await this.store.saveTask(this.task);
        if (this.transcriptBridge && actor === "gemini") {
          await this.bindTranscriptCheckpoint();
          throw new TranscriptTurnDeferred();
        }
        await this.recordEvent("AGENT_STARTED", actor, { recovery: true, sessionId: pending.sessionId, phase });
        if (Date.now() - Date.parse(pending.requestTime) >= 45 * 60 * 1000) {
          throw new Error("Pending turn exceeded recovery deadline; inspect original session before resuming");
        }
      }
    }
  }

  public abort(): void {
    this.isAborted = true;
    this.task.status = "CANCELLED";
    this.abortController.abort();
    if (this.codexSessionId) {
      this.codex.cancel(this.codexSessionId).catch(() => {});
    } else {
      this.codex.cancel().catch(() => {});
    }
    if (this.geminiSessionId) {
      this.gemini.cancel(this.geminiSessionId).catch(() => {});
    } else {
      this.gemini.cancel().catch(() => {});
    }
  }

  private async bindTranscriptCheckpoint(): Promise<void> {
    try { this.transcriptBridge!.bind(this.task); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "REBIND_REQUIRES_HUMAN_RECONCILIATION") throw error;
      this.task.nextAction = "REBIND_REQUIRES_HUMAN_RECONCILIATION: stop writers; retain prior state and reconcile the previous turn before a new binding";
      await this.store.saveTask(this.task);
    }
  }

  public async run(): Promise<Task> {
    if (this.transcriptBridge && this.task.pendingAgentTurn?.actor === "gemini" && !this.bridgeResumeInProgress) {
      await this.bindTranscriptCheckpoint();
      return this.task;
    }
    this.isAborted = false;
    this.abortController = new AbortController();

    // Check if task is already in terminal state
    if (this.sm.isTerminal()) {
      return this.task;
    }

    // Step 1: Ensure Worktree and Branch exist
    if (!this.task.worktree || !this.task.branch) {
      try {
        const wtInfo = await WorktreeManager.createWorktree(
          this.task.id,
          this.task.title,
          this.task.workspace
        );
        this.task.branch = wtInfo.branch;
        this.task.worktree = wtInfo.worktreePath;
        await this.store.saveTask(this.task);
        await this.recordEvent("WORKTREE_CREATED", "system", {
          branch: wtInfo.branch,
          worktree: wtInfo.worktreePath,
        });
      } catch (err: any) {
        await this.recordStatusChange("FAILED", "system", { error: err.message });
        throw err;
      }
    }

    const worktreePath = this.task.worktree!;

    // Step 2: Initialize Agents in worktree
    await Promise.all([
      this.codex.initialize(),
      this.gemini.initialize(),
    ]);

    const [cSession, gSession] = await Promise.all([
      this.task.pendingAgentTurn?.actor === this.developerId ? this.restoreTurn(this.codex) : this.codex.createSession(worktreePath),
      this.task.pendingAgentTurn?.actor === this.reviewerId ? this.restoreTurn(this.gemini) : this.gemini.createSession(worktreePath),
    ]);

    this.codexSessionId = cSession;
    this.geminiSessionId = gSession;

    // Capture baseline before first developer turn if not already present
    if (!this.task.baseline) {
      const isBeforeFirstDevTurn =
        this.task.currentRound === 0 &&
        this.task.status === "TODO" &&
        !this.task.pendingAgentTurn;

      if (isBeforeFirstDevTurn) {
        this.task.baseline = await GitService.captureBaseline(worktreePath);
        await this.store.saveTask(this.task);
      }
    }

    if (!this.task.startedAt) {
      this.task.startedAt = new Date().toISOString();
      await this.recordEvent("TASK_STARTED", "system", { startedAt: this.task.startedAt });
    }

    // Resolve test command
    const testCommand = TestDetector.detect(worktreePath, this.task.testCommand);
    if (!testCommand) {
      await this.recordStatusChange("NEED_USER", "system", {
        reason: "Unable to auto-detect test command in worktree. User must configure testCommand.",
      });
      return this.task;
    }
    this.task.testCommand = testCommand;

    // Initial transition TODO -> DOING if starting fresh
    if (this.task.status === "TODO") {
      await this.recordStatusChange("DOING", this.developerId);
    }

    let lastFeedback: string | undefined;
    let lastTestFailure: TestRunResult | null = null;

    // Execution loop
    while (!this.sm.isTerminal() && !this.isAborted) {
      // Loop Guard Check
      if (!this.task.pendingAgentTurn && this.task.currentRound >= this.task.maxRounds) {
        await this.recordStatusChange("NEED_USER", "system", {
          reason: `Max rounds (${this.task.maxRounds}) reached without full completion.`,
          currentRound: this.task.currentRound,
        });
        break;
      }

      if (!this.task.pendingAgentTurn) this.task.currentRound++;

      // Phase 1: CODEX DEVELOPMENT / REWORK (DOING)
      if (this.task.status === "DOING" || this.task.status === "REWORK") {
        if (this.task.status === "REWORK") {
          await this.recordStatusChange("DOING", this.developerId);
        }

        await this.recordEvent("AGENT_STARTED", this.developerId, {
          round: this.task.currentRound,
          worktree: worktreePath,
        });

        const devPrompt = this.buildDeveloperPrompt(lastFeedback, lastTestFailure);
        let codexOutput = "";

        try {
          const resp = await this.promptWithRecovery(this.codex, this.codexSessionId!, devPrompt, this.developerId, "DOING");
          codexOutput = resp.text;
        } catch (err: any) {
          if (this.isAborted) break;
          if (err instanceof TranscriptTurnDeferred) break;
          if (this.task.pendingAgentTurn) {
            await this.recordStatusChange("NEED_USER", this.developerId, { error: err.message, remoteExecutionMayContinue: true });
            break;
          }
          await this.recordStatusChange("FAILED", this.developerId, {
            error: `Developer ${this.developerId} failed during turn: ${err.message}`,
          });
          break;
        }

        await this.recordEvent("AGENT_COMPLETED", this.developerId, {
          round: this.task.currentRound,
          outputSummary: codexOutput.slice(0, 300),
        });

        const parsedDev = parseAgentStatus(codexOutput);
        if (parsedDev.status === "need_user") {
          await this.recordStatusChange("NEED_USER", this.developerId, {
            detail: codexOutput,
          });
          break;
        }

        if (this.isAborted) break;

        // Developer turn complete -> Transition to TESTING
        await this.recordStatusChange("TESTING", "system");
      }

      if (this.isAborted) break;

      // Phase 2: INDEPENDENT TEST GATE (TESTING)
      if (this.task.status === "TESTING") {
        await this.recordEvent("TEST_STARTED", "system", {
          command: testCommand,
          worktree: worktreePath,
        });

        const testResult = await TestRunner.run(testCommand, worktreePath, 180000, this.abortController.signal);

        if (this.isAborted) break;

        if (!testResult.pass) {
          // Tests failed!
          await this.recordEvent("TEST_FAILED", "system", {
            command: testCommand,
            exitCode: testResult.exitCode,
            output: testResult.output.slice(0, 1000),
          });

          lastTestFailure = testResult;
          lastFeedback = undefined; // clear reviewer feedback, focus on test fix

          await this.recordStatusChange("REWORK", "system", {
            reason: `Test gate failed with exit code ${testResult.exitCode}`,
          });
          continue; // Loop back to DOING to rework
        }

        // Tests passed!
        await this.recordEvent("TEST_PASSED", "system", {
          command: testCommand,
          durationMs: testResult.durationMs,
        });

        lastTestFailure = null;

        if (this.isAborted) break;

        // Transition TESTING -> REVIEW
        await this.recordStatusChange("REVIEW", this.reviewerId);
      }

      if (this.isAborted) break;

      // Phase 3: GEMINI REVIEW (REVIEW)
      if (this.task.status === "REVIEW") {
        await this.recordEvent("REVIEW_STARTED", this.reviewerId, {
          round: this.task.currentRound,
          worktree: worktreePath,
        });

        const diffContent = await GitService.getDiff(worktreePath);
        const reviewPrompt = this.buildReviewerPrompt(diffContent);
        let geminiOutput = "";

        try {
          const resp = await this.promptWithRecovery(this.gemini, this.geminiSessionId!, reviewPrompt, this.reviewerId, "REVIEW");
          geminiOutput = resp.text;
        } catch (err: any) {
          if (this.isAborted) break;
          if (err instanceof TranscriptTurnDeferred) break;
          if (this.task.pendingAgentTurn) {
            await this.recordStatusChange("NEED_USER", this.reviewerId, { error: err.message, remoteExecutionMayContinue: true });
            break;
          }
          await this.recordStatusChange("FAILED", this.reviewerId, {
            error: `Reviewer ${this.reviewerId} failed during turn: ${err.message}`,
          });
          break;
        }

        if (this.isAborted) break;

        const parsedReview = this.parseReviewerOutput(geminiOutput);

        // Section 十七: Check for subtask proposal from Agent
        const proposalMatch = geminiOutput.match(/TASK_PROPOSAL:\s*(\{[\s\S]*?\})/i);
        if (proposalMatch) {
          try {
            const proposal = JSON.parse(proposalMatch[1]);
            const subtaskId = `TASK-PROP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
            const subtask: Task = {
              id: subtaskId,
              projectId: this.task.projectId,
              epicId: this.task.epicId,
              parentTaskId: this.task.id,
              rootTaskId: this.task.rootTaskId || this.task.id,
              title: proposal.title || "Proposed Subtask",
              description: proposal.description || "",
              status: "TODO",
              owner: proposal.suggestedOwner || this.developerId,
              ownerType: proposal.suggestedOwner === "user" ? "HUMAN" : "AGENT",
              ownerId: proposal.suggestedOwner || this.developerId,
              priority: "MEDIUM",
              workspace: this.task.workspace,
              maxRounds: 6,
              currentRound: 0,
              source: { type: "AGENT", id: this.reviewerId },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              nextAction: "等待排期执行",
              progress: 0,
            };
            await this.store.saveTask(subtask);
            await this.recordEvent("TASK_PROPOSAL", this.reviewerId, {
              proposedTaskId: subtaskId,
              title: subtask.title,
            });
          } catch {}
        }

        if (parsedReview.agentStatus === "need_user") {
          await this.recordStatusChange("NEED_USER", this.reviewerId, {
            detail: geminiOutput,
          });
          break;
        } else if (parsedReview.reviewStatus === "PASS") {
          // Review approved!
          if (!this.task.baseline) {
            await this.recordStatusChange("NEED_USER", this.reviewerId, {
              reason: "Legacy pending task lacks original pre-task baseline; manual attribution review required.",
            });
            break;
          }

          await this.recordEvent("REVIEW_PASSED", this.reviewerId, {
            summary: parsedReview.feedback.slice(0, 500),
          });

          const changedFiles = await GitService.deriveChangedFiles(worktreePath, this.task.baseline);

          const result: TaskResult = {
            status: "PASS",
            summary: "Task successfully developed, tested, reviewed, and approved.",
            changedFiles,
            testStatus: "PASS",
            testCommand,
            reviewStatus: "PASS",
            rounds: this.task.currentRound,
            branch: this.task.branch,
            worktree: this.task.worktree,
          };

          this.task.result = result;
          this.task.completedAt = new Date().toISOString();

          await this.recordStatusChange("DONE", this.reviewerId, { result });
          await this.recordEvent("TASK_COMPLETED", "system", { result });
          break;
        } else {
          // Review rejected or requires further changes -> REWORK
          await this.recordEvent("REVIEW_FAILED", this.reviewerId, {
            feedback: parsedReview.feedback.slice(0, 500),
          });

          lastFeedback = parsedReview.feedback;

          await this.recordStatusChange("REWORK", this.reviewerId, {
            feedback: parsedReview.feedback,
          });
          continue; // Loop back to DOING
        }
      }
    }

    if (this.isAborted) {
      this.task.status = "CANCELLED";
    }

    return this.task;
  }

  // --- Prompts ---

  private buildDeveloperPrompt(reviewerFeedback?: string, testFailure?: TestRunResult | null): string {
    let extraContext = "";

    if (testFailure) {
      extraContext = `\n\n[CRITICAL: TESTS FAILED]\nCommand:\n${testFailure.command}\n\nExit Code: ${testFailure.exitCode}\n\nOutput:\n${testFailure.output}\n\nPlease fix the implementation or test defects until tests pass cleanly.`;
    } else if (reviewerFeedback) {
      extraContext = `\n\n[REVIEWER FEEDBACK / REQUEST_CHANGES]:\n${reviewerFeedback}\n\nPlease address the reviewer's feedback and refine the implementation and tests.`;
    }

    return `Task ID:
${this.task.id}

Title:
${this.task.title}

Description:
${this.task.description}

Workspace:
${this.task.worktree}

Current Status:
${this.task.status}
${extraContext}

You are the Developer.

Requirements:
1. Inspect existing implementation in the workspace.
2. Only modify files required by this task.
3. Do not modify unrelated files.
4. Run relevant tests to verify your changes.
5. Summarize:
   - changed files
   - test results
   - remaining risks

If implementation is complete:
AGENT_STATUS: CONTINUE

If user decision is required:
AGENT_STATUS: NEED_USER`;
  }

  private buildReviewerPrompt(diffContent: string): string {
    const isFirstReview = this.task.currentRound <= 1;
    const reviewGuidance = isFirstReview
      ? `Review Guidance for Round 1:
Please review rigorously. Inspect edge cases (e.g. negative numbers, non-numbers, negative zero -0, or boundary conditions).
If any edge cases or tests can be improved, output:
REVIEW_STATUS: REQUEST_CHANGES
AGENT_STATUS: CONTINUE
with your actionable recommendations.`
      : `Review Guidance:
If the Developer has addressed previous feedback and tests pass, approve with:
REVIEW_STATUS: PASS
AGENT_STATUS: DONE`;

    return `You are the Reviewer for:

Task:
${this.task.title} - ${this.task.description}

Developer:
${this.developerId}

Workspace:
${this.task.worktree}

Git Diff:
${diffContent || "(no current uncommitted diff)"}

Please independently inspect:
1. Current code in workspace
2. Git diff
3. Existing tests
4. Test results
5. Task requirements

Do not trust Developer's textual summary alone. You must inspect the workspace.

${reviewGuidance}

Format your response as follows:
REVIEW_STATUS: PASS
or
REVIEW_STATUS: REQUEST_CHANGES

If REQUEST_CHANGES:
Provide concrete actionable issues. End with AGENT_STATUS: CONTINUE.

If PASS:
Conclude with AGENT_STATUS: DONE.`;
  }

  public parseReviewerOutput(text: string): ParsedReview {
    // ACP may concatenate commentary with the final protocol block without a newline.
    const lines = text.replace(/([^\n])(?=REVIEW_STATUS:\s*(?:PASS|REQUEST_CHANGES)\b)/gi, "$1\n").split("\n");
    let reviewStatus: "PASS" | "REQUEST_CHANGES" = "REQUEST_CHANGES";
    let agentStatus: "done" | "continue" | "need_user" = "continue";

    for (const line of lines) {
      const match = line.match(/^REVIEW_STATUS:\s*(PASS|REQUEST_CHANGES)/i);
      if (match) {
        reviewStatus = match[1].toUpperCase() as "PASS" | "REQUEST_CHANGES";
      }
      const sm = line.match(/^AGENT_STATUS:\s*(DONE|CONTINUE|NEED_USER)/i);
      if (sm) {
        agentStatus = sm[1].toLowerCase() as "done" | "continue" | "need_user";
      }
    }

    // Heuristics fallback
    if (!text.includes("REVIEW_STATUS:")) {
      if (agentStatus === "done" || text.toLowerCase().includes("approved") || text.toLowerCase().includes("lgtm")) {
        reviewStatus = "PASS";
      } else {
        reviewStatus = "REQUEST_CHANGES";
      }
    }

    if (reviewStatus === "PASS" && agentStatus !== "need_user") {
      agentStatus = "done";
    }

    return {
      reviewStatus,
      agentStatus,
      feedback: text.trim(),
    };
  }

  // --- State & Event Recording ---

  private async recordStatusChange(newStatus: Task["status"], actor: Task["owner"], details?: unknown): Promise<void> {
    const oldStatus = this.task.status;
    this.sm.transition(newStatus);
    this.task.status = newStatus;
    if (this.turnCompleted) {
      delete this.task.pendingAgentTurn;
      this.turnCompleted = false;
    }
    this.task.owner = actor;
    this.task.updatedAt = new Date().toISOString();

    // V0.3 Auto-handoff & Next Action
    if (newStatus === "DOING" || newStatus === "REWORK") {
      this.task.ownerType = "AGENT";
      this.task.ownerId = this.developerId;
      this.task.owner = this.developerId;
      this.task.nextAction = `等待 ${this.developerId} 完成开发实现`;
    } else if (newStatus === "TESTING") {
      this.task.nextAction = "等待自动化测试门禁执行";
    } else if (newStatus === "REVIEW") {
      this.task.ownerType = "AGENT";
      this.task.ownerId = this.reviewerId;
      this.task.owner = this.reviewerId;
      this.task.nextAction = `等待 ${this.reviewerId} 完成代码审查`;
    } else if (newStatus === "NEED_USER") {
      this.task.ownerType = "HUMAN";
      this.task.ownerId = "user";
      this.task.owner = "user";
      const reason = typeof details === "object" && details !== null && "reason" in details
        ? (details as any).reason
        : (typeof details === "object" && details !== null && "detail" in details
          ? (details as any).detail
          : "等待用户输入决策");
      this.task.nextAction = String(reason).slice(0, 100);
    } else if (newStatus === "DONE") {
      this.task.nextAction = undefined;
    } else if (newStatus === "BLOCKED") {
      this.task.nextAction = "等待前置依赖任务完成";
    }

    this.task.progress = ProgressCalculator.calculateTaskProgress(this.task);

    await this.store.saveTask(this.task);

    await this.recordEvent("STATUS_CHANGED", actor, {
      from: oldStatus,
      to: newStatus,
      details,
    });

    if (newStatus === "REWORK") {
      await this.recordEvent("REWORK_STARTED", actor, details);
    } else if (newStatus === "NEED_USER") {
      await this.recordEvent("NEED_USER", actor, details);
    } else if (newStatus === "FAILED") {
      await this.recordEvent("TASK_FAILED", actor, details);
    }
  }

  private async recordEvent(type: any, actor: any, details?: unknown): Promise<void> {
    const event = createTaskEvent(this.task.id, type, actor, details);
    await this.store.appendEvent(event);
  }
}

/** Internal yield; preserves DOING/REVIEW and the saved remote checkpoint. */
class TranscriptTurnDeferred extends Error {}
