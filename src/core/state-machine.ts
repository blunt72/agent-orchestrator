export type OrchestratorState =
  | "IDLE"
  | "RUNNING"
  | "WAITING_AGENT"
  | "NEED_USER"
  | "DONE"
  | "ERROR";

export type StopReason =
  | "COMPLETE"
  | "MAX_ROUNDS"
  | "REPETITION"
  | "NEED_USER"
  | "AGENT_ERROR"
  | "AGENT_CRASH"
  | "ABORTED";

export interface StateSnapshot {
  state: OrchestratorState;
  currentRound: number;
  maxRounds: number;
  activeAgent?: "codex" | "gemini";
  stopReason?: StopReason;
  error?: string;
  updatedAt: string;
}

export class AgentStateMachine {
  private currentState: OrchestratorState = "IDLE";
  private currentRound: number = 0;
  private readonly maxRounds: number;
  private activeAgent?: "codex" | "gemini";
  private stopReason?: StopReason;
  private lastError?: string;
  private readonly history: StateSnapshot[] = [];

  constructor(maxRounds: number = 6) {
    this.maxRounds = maxRounds;
    this.recordSnapshot();
  }

  public getState(): OrchestratorState {
    return this.currentState;
  }

  public getRound(): number {
    return this.currentRound;
  }

  public getMaxRounds(): number {
    return this.maxRounds;
  }

  public getActiveAgent(): ("codex" | "gemini") | undefined {
    return this.activeAgent;
  }

  public getStopReason(): StopReason | undefined {
    return this.stopReason;
  }

  public getLastError(): string | undefined {
    return this.lastError;
  }

  public getSnapshot(): StateSnapshot {
    return {
      state: this.currentState,
      currentRound: this.currentRound,
      maxRounds: this.maxRounds,
      activeAgent: this.activeAgent,
      stopReason: this.stopReason,
      error: this.lastError,
      updatedAt: new Date().toISOString(),
    };
  }

  public start(firstAgent: "codex" | "gemini" = "codex"): void {
    if (this.currentState !== "IDLE") {
      throw new Error(`Cannot start from state ${this.currentState}. Must be IDLE.`);
    }
    this.currentRound = 1;
    this.activeAgent = firstAgent;
    this.transition("RUNNING");
  }

  public agentStartTurn(agent: "codex" | "gemini"): void {
    this.activeAgent = agent;
    this.transition("RUNNING");
  }

  public agentWaiting(nextAgent: "codex" | "gemini"): void {
    this.activeAgent = nextAgent;
    this.transition("WAITING_AGENT");
  }

  public incrementRound(): number {
    this.currentRound++;
    if (this.currentRound > this.maxRounds) {
      this.needUser("MAX_ROUNDS", `Reached maximum rounds limit (${this.maxRounds})`);
    }
    return this.currentRound;
  }

  public done(reason: StopReason = "COMPLETE"): void {
    this.stopReason = reason;
    this.transition("DONE");
  }

  public needUser(reason: StopReason = "NEED_USER", detail?: string): void {
    this.stopReason = reason;
    if (detail) {
      this.lastError = detail;
    }
    this.transition("NEED_USER");
  }

  public error(errorMessage: string, reason: StopReason = "AGENT_ERROR"): void {
    this.lastError = errorMessage;
    this.stopReason = reason;
    this.transition("ERROR");
  }

  public isTerminal(): boolean {
    return this.currentState === "DONE" || this.currentState === "ERROR" || this.currentState === "NEED_USER";
  }

  private transition(newState: OrchestratorState): void {
    this.currentState = newState;
    this.recordSnapshot();
  }

  private recordSnapshot(): void {
    this.history.push(this.getSnapshot());
  }

  public getHistory(): readonly StateSnapshot[] {
    return this.history;
  }
}
