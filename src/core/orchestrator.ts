import path from "node:path";
import { Agent, AgentResponse } from "../agents/agent.js";
import { CodexAgent } from "../agents/codex-agent.js";
import { AntigravityAgent } from "../agents/antigravity-agent.js";
import { SessionManager } from "./session.js";
import { MessageRouter, RouteDecision } from "./router.js";
import {
  AgentMessage,
  AgentRoleName,
  formatAgentPrompt,
  parseAgentStatus,
  MessageSender,
  MessageRecipient,
  MessageType,
} from "./message.js";
import { StateSnapshot, StopReason } from "./state-machine.js";

export interface OrchestratorOptions {
  workspace: string;
  maxRounds?: number;
  firstAgent?: AgentRoleName;
  codexAgent?: Agent;
  geminiAgent?: Agent;
  baseDir?: string;
}

export interface OrchestratorHooks {
  onRoundStart?: (round: number, agent: AgentRoleName, role: string) => void;
  onAgentChunk?: (agent: AgentRoleName, chunk: string) => void;
  onRoundEnd?: (round: number, agent: AgentRoleName, message: AgentMessage) => void;
  onStateChange?: (snapshot: StateSnapshot) => void;
  onWarning?: (warning: string) => void;
  onError?: (error: Error) => void;
}

export interface OrchestrationResult {
  sessionId: string;
  totalRounds: number;
  finalState: string;
  stopReason?: StopReason;
  messages: readonly AgentMessage[];
  logPath: string;
}

export class AgentHubOrchestrator {
  private readonly workspace: string;
  private readonly maxRounds: number;
  private readonly firstAgent: AgentRoleName;
  private readonly codex: Agent;
  private readonly gemini: Agent;
  private readonly router: MessageRouter;
  private readonly hooks: OrchestratorHooks;
  private readonly baseDir?: string;

  private sessionManager?: SessionManager;
  private codexSessionId?: string;
  private geminiSessionId?: string;
  private isInitialized: boolean = false;
  private isAborted: boolean = false;

  constructor(options: OrchestratorOptions, hooks: OrchestratorHooks = {}) {
    this.workspace = path.resolve(options.workspace);
    this.maxRounds = options.maxRounds ?? 6;
    this.firstAgent = options.firstAgent ?? "codex";
    this.codex = options.codexAgent ?? new CodexAgent();
    this.gemini = options.geminiAgent ?? new AntigravityAgent();
    this.router = new MessageRouter({ maxRounds: this.maxRounds });
    this.hooks = hooks;
    this.baseDir = options.baseDir;

    // Attach stream chunk listeners if agents are AcpAgent instances
    if ("onTextChunk" in this.codex && typeof (this.codex as any).onTextChunk === "function") {
      (this.codex as any).onTextChunk((chunk: string) => {
        this.hooks.onAgentChunk?.("codex", chunk);
      });
    }
    if ("onTextChunk" in this.gemini && typeof (this.gemini as any).onTextChunk === "function") {
      (this.gemini as any).onTextChunk((chunk: string) => {
        this.hooks.onAgentChunk?.("gemini", chunk);
      });
    }
  }

  public getSessionManager(): SessionManager | undefined {
    return this.sessionManager;
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Initialize both agents in parallel
    await Promise.all([
      this.codex.initialize(),
      this.gemini.initialize(),
    ]);

    // Create session in shared workspace
    const [cSession, gSession] = await Promise.all([
      this.codex.createSession(this.workspace),
      this.gemini.createSession(this.workspace),
    ]);

    this.codexSessionId = cSession;
    this.geminiSessionId = gSession;
    this.isInitialized = true;
  }

  public async runTask(task: string): Promise<OrchestrationResult> {
    this.isAborted = false;
    this.sessionManager = new SessionManager(this.workspace, task, this.maxRounds, this.baseDir);
    const sm = this.sessionManager.getStateMachine();

    if (!this.isInitialized) {
      await this.initialize();
    }

    this.sessionManager.setAgentSessionId("codex", this.codexSessionId!);
    this.sessionManager.setAgentSessionId("gemini", this.geminiSessionId!);

    // Start state machine
    sm.start(this.firstAgent);
    this.hooks.onStateChange?.(sm.getSnapshot());

    // Record initial user task message
    await this.sessionManager.recordMessage(
      1,
      "user",
      this.firstAgent,
      "task",
      task
    );

    let currentAgent: AgentRoleName = this.firstAgent;
    let previousOutput: string = task;
    let previousSender: MessageSender = "user";
    let currentRound = 1;

    try {
      while (!sm.isTerminal() && !this.isAborted) {
        const role = currentAgent === "codex" ? CodexAgent.ROLE : AntigravityAgent.ROLE;
        const agentInstance = currentAgent === "codex" ? this.codex : this.gemini;
        const agentSessionId = currentAgent === "codex" ? this.codexSessionId! : this.geminiSessionId!;

        sm.agentStartTurn(currentAgent);
        this.hooks.onStateChange?.(sm.getSnapshot());
        this.hooks.onRoundStart?.(currentRound, currentAgent, role);

        // Build formatted prompt
        const promptText = formatAgentPrompt({
          role,
          task,
          round: currentRound,
          from: previousSender === "user" ? "用户" : previousSender === "codex" ? "Codex (Developer)" : "Gemini (Reviewer)",
          message: previousOutput,
        });

        // Prompt agent via ACP
        let agentResponse: AgentResponse;
        try {
          agentResponse = await agentInstance.prompt(agentSessionId, promptText);
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          sm.error(errorMsg, "AGENT_ERROR");
          this.hooks.onStateChange?.(sm.getSnapshot());
          if (err instanceof Error) this.hooks.onError?.(err);

          await this.sessionManager.recordMessage(
            currentRound,
            currentAgent,
            "system",
            "error",
            `Agent ${currentAgent} encountered an error: ${errorMsg}`,
            { stopReason: "error" }
          );

          break;
        }

        // Parse AGENT_STATUS
        const parsed = parseAgentStatus(agentResponse.text);
        if (parsed.warning) {
          this.hooks.onWarning?.(parsed.warning);
        }

        const msgType: MessageType = currentAgent === "codex" ? "response" : "review";
        const nextTarget: MessageRecipient = this.router.getNextAgent(currentAgent);

        // Record agent message
        const recordedMessage = await this.sessionManager.recordMessage(
          currentRound,
          currentAgent,
          nextTarget,
          msgType,
          agentResponse.text,
          {
            status: parsed.status,
            stopReason: agentResponse.stopReason,
            rawEvents: agentResponse.rawEvents,
            provenance: agentResponse.provenance,
            metadata: { usage: agentResponse.usage },
          }
        );

        this.hooks.onRoundEnd?.(currentRound, currentAgent, recordedMessage);

        // Route evaluation & loop guard
        const decision: RouteDecision = this.router.route(recordedMessage);

        if (decision.action === "stop") {
          if (decision.stopReason === "COMPLETE") {
            sm.done("COMPLETE");
          } else if (decision.stopReason === "NEED_USER") {
            sm.needUser("NEED_USER", decision.detail);
          } else if (decision.stopReason === "MAX_ROUNDS") {
            sm.needUser("MAX_ROUNDS", decision.detail);
          } else if (decision.stopReason === "REPETITION") {
            sm.needUser("REPETITION", decision.detail);
          } else {
            sm.done("COMPLETE");
          }

          this.hooks.onStateChange?.(sm.getSnapshot());
          break;
        }

        // Proceed to next round
        previousSender = currentAgent;
        previousOutput = agentResponse.text;
        currentAgent = decision.nextRecipient || this.router.getNextAgent(currentAgent);

        sm.agentWaiting(currentAgent);
        this.hooks.onStateChange?.(sm.getSnapshot());

        currentRound = sm.incrementRound();
      }
    } finally {
      await this.sessionManager.syncSessionData();
    }

    const snapshot = sm.getSnapshot();
    const logPath = this.sessionManager.getStore().getSessionLogPath(this.sessionManager.getSessionId());

    return {
      sessionId: this.sessionManager.getSessionId(),
      totalRounds: snapshot.currentRound,
      finalState: snapshot.state,
      stopReason: snapshot.stopReason,
      messages: this.sessionManager.getMessages(),
      logPath,
    };
  }

  public async stop(): Promise<void> {
    this.isAborted = true;
    if (this.sessionManager && !this.sessionManager.getStateMachine().isTerminal()) {
      this.sessionManager.getStateMachine().needUser("ABORTED", "Session stopped by user.");
      await this.sessionManager.syncSessionData();
    }
    await Promise.allSettled([
      this.codex.close(),
      this.gemini.close(),
    ]);
  }
}
