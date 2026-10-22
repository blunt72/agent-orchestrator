import crypto from "node:crypto";
import { AgentMessage, createAgentMessage, MessageSender, MessageRecipient, MessageType, AgentControlStatus } from "./message.js";
import { AgentStateMachine, StateSnapshot } from "./state-machine.js";
import { SessionStore, SessionData } from "../storage/store.js";

export class SessionManager {
  private readonly sessionId: string;
  private readonly workspace: string;
  private readonly stateMachine: AgentStateMachine;
  private readonly store: SessionStore;
  private readonly messages: AgentMessage[] = [];
  private readonly initialTask: string;
  private codexSessionId?: string;
  private geminiSessionId?: string;
  private codexRestarts: number = 0;
  private geminiRestarts: number = 0;
  private readonly createdAt: string;

  constructor(workspace: string, task: string, maxRounds: number = 6, baseDir?: string) {
    this.sessionId = `session-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    this.workspace = workspace;
    this.initialTask = task;
    this.createdAt = new Date().toISOString();
    this.stateMachine = new AgentStateMachine(maxRounds);
    this.store = new SessionStore(baseDir);
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getWorkspace(): string {
    return this.workspace;
  }

  public getInitialTask(): string {
    return this.initialTask;
  }

  public getStateMachine(): AgentStateMachine {
    return this.stateMachine;
  }

  public getStore(): SessionStore {
    return this.store;
  }

  public getMessages(): readonly AgentMessage[] {
    return this.messages;
  }

  public setAgentSessionId(agent: "codex" | "gemini", agentSessionId: string): void {
    if (agent === "codex") {
      this.codexSessionId = agentSessionId;
    } else {
      this.geminiSessionId = agentSessionId;
    }
  }

  public incrementRestart(agent: "codex" | "gemini"): number {
    if (agent === "codex") {
      this.codexRestarts++;
      return this.codexRestarts;
    } else {
      this.geminiRestarts++;
      return this.geminiRestarts;
    }
  }

  public async recordMessage(
    round: number,
    from: MessageSender,
    to: MessageRecipient,
    type: MessageType,
    content: string,
    options?: {
      status?: AgentControlStatus;
      stopReason?: string;
      rawEvents?: unknown[];
      provenance?: any;
      metadata?: Record<string, unknown>;
    }
  ): Promise<AgentMessage> {
    const msg = createAgentMessage(this.sessionId, round, from, to, type, content, options);
    this.messages.push(msg);

    // Append to JSONL log
    await this.store.appendMessage(this.sessionId, msg);

    // Update session snapshot in data/sessions.json
    await this.syncSessionData();

    return msg;
  }

  public async syncSessionData(): Promise<void> {
    const lastMsg = this.messages[this.messages.length - 1];
    const snapshot = this.stateMachine.getSnapshot();

    const data: SessionData = {
      id: this.sessionId,
      workspace: this.workspace,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      status: snapshot.state,
      round: snapshot.currentRound,
      maxRounds: snapshot.maxRounds,
      agents: {
        codex: {
          status: this.stateMachine.getActiveAgent() === "codex" ? "running" : "ready",
          sessionId: this.codexSessionId,
          restarts: this.codexRestarts,
        },
        gemini: {
          status: this.stateMachine.getActiveAgent() === "gemini" ? "running" : "ready",
          sessionId: this.geminiSessionId,
          restarts: this.geminiRestarts,
        },
      },
      lastMessage: lastMsg
        ? {
            from: lastMsg.from,
            to: lastMsg.to,
            round: lastMsg.round,
            contentSummary: lastMsg.content.slice(0, 120),
            timestamp: lastMsg.timestamp,
          }
        : undefined,
    };

    await this.store.saveSession(data);
  }
}
