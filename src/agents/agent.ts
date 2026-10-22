/**
 * Unified Agent Interface for AgentHub
 * Orchestrator interacts solely with this interface, abstracting ACP or stream-json protocols.
 */

export interface AgentProvenance {
  provider: string; // e.g., "openai" | "google"
  adapter: string;  // e.g., "codex-acp" | "antigravity-agentapi"
  model: string;    // e.g., "gpt-5.5" | "gemini-3.8-flash"
  endpoint: string; // executable path or server URI
  providerSessionId?: string;
  adapterSessionId?: string; // Local correlation ID, not provider session identity.
  requestTime?: string;
  responseTime?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface AgentResponse {
  nativeReviewTransport?: string;
  text: string;
  stopReason?: string;
  usage?: unknown;
  rawEvents?: unknown[];
  provenance?: AgentProvenance;
}

export type TextChunkCallback = (chunk: string) => void;
export type EventCallback = (event: unknown) => void;

export interface PendingAgentTurn {
  sessionId: string;
  startStepIndex: number;
  requestTime: string;
}

export class AgentTurnPendingError extends Error {
  constructor(public readonly checkpoint: PendingAgentTurn) {
    super(`Agent turn still pending: ${checkpoint.sessionId}`);
    this.name = "AgentTurnPendingError";
  }
}

export interface Agent {
  readonly name: "codex" | "gemini";
  readonly provider?: string; // "acp" | "antigravity"
  start(): Promise<void>;
  initialize(): Promise<void>;
  createSession(workspace: string): Promise<string>;
  prompt(sessionId: string, message: string): Promise<AgentResponse>;
  restorePendingTurn?(checkpoint: PendingAgentTurn): Promise<string>;
  waitForPendingTurn?(checkpoint: PendingAgentTurn, signal?: AbortSignal): Promise<AgentResponse>;
  setPendingTurnHandler?(handler: (checkpoint: PendingAgentTurn) => Promise<void>): void;
  cancel(sessionId?: string): Promise<void>;
  close(): Promise<void>;
  isRunning?(): boolean;
  onTextChunk?(cb: TextChunkCallback): () => void;
  onRawEvent?(cb: EventCallback): () => void;
}
