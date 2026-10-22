import { AgentMessage, AgentRoleName } from "./message.js";

export interface LoopGuardConfig {
  maxRounds: number;
  maxSameMessage: number;
  similarityThreshold: number;
}

export const DEFAULT_LOOP_GUARD_CONFIG: LoopGuardConfig = {
  maxRounds: 6,
  maxSameMessage: 2,
  similarityThreshold: 0.95,
};

export interface RouteDecision {
  action: "proceed" | "stop";
  nextRecipient?: AgentRoleName;
  stopReason?: "MAX_ROUNDS" | "REPETITION" | "COMPLETE" | "NEED_USER";
  detail?: string;
}

export class MessageRouter {
  private readonly config: LoopGuardConfig;
  private readonly messageHistory: AgentMessage[] = [];

  constructor(config: Partial<LoopGuardConfig> = {}) {
    this.config = {
      ...DEFAULT_LOOP_GUARD_CONFIG,
      ...config,
    };
  }

  public getConfig(): LoopGuardConfig {
    return this.config;
  }

  /**
   * Determine the next agent recipient based on the sender
   */
  public getNextAgent(current: AgentRoleName): AgentRoleName {
    return current === "codex" ? "gemini" : "codex";
  }

  /**
   * Record a message and evaluate routing / loop guard rules
   */
  public route(message: AgentMessage): RouteDecision {
    this.messageHistory.push(message);

    // 1. Explicit status checks
    if (message.status === "done") {
      return {
        action: "stop",
        stopReason: "COMPLETE",
        detail: `Agent ${message.from} indicated task is DONE.`,
      };
    }

    if (message.status === "need_user") {
      return {
        action: "stop",
        stopReason: "NEED_USER",
        detail: `Agent ${message.from} requested user intervention.`,
      };
    }

    // 2. Max rounds check
    if (message.round >= this.config.maxRounds) {
      return {
        action: "stop",
        stopReason: "MAX_ROUNDS",
        detail: `Exceeded max rounds limit of ${this.config.maxRounds}. Halting to prevent infinite loop.`,
      };
    }

    // 3. Message repetition check (Loop Guard)
    const repetitionCheck = this.checkMessageRepetition(message);
    if (repetitionCheck.isRepetitive) {
      return {
        action: "stop",
        stopReason: "REPETITION",
        detail: repetitionCheck.reason,
      };
    }

    // 4. Continue to next agent
    const nextRecipient = message.to === "gemini" ? "gemini" : message.to === "codex" ? "codex" : this.getNextAgent(message.from as AgentRoleName);

    return {
      action: "proceed",
      nextRecipient,
    };
  }

  /**
   * Checks if consecutive agent outputs are repeating identically or near identically
   */
  private checkMessageRepetition(currentMessage: AgentMessage): {
    isRepetitive: boolean;
    reason?: string;
  } {
    const normalizedCurrent = this.normalizeContent(currentMessage.content);
    if (!normalizedCurrent || normalizedCurrent.length < 10) {
      return { isRepetitive: false };
    }

    let sameCount = 0;
    // Inspect prior agent messages
    for (let i = this.messageHistory.length - 2; i >= 0; i--) {
      const prev = this.messageHistory[i];
      if (prev.from === "user" || prev.from === "system") continue;

      const normalizedPrev = this.normalizeContent(prev.content);
      const similarity = this.calculateSimilarity(normalizedCurrent, normalizedPrev);

      if (similarity >= this.config.similarityThreshold) {
        sameCount++;
        if (sameCount >= this.config.maxSameMessage) {
          return {
            isRepetitive: true,
            reason: `Loop detected: repetitive responses (${sameCount + 1} matching turns) between agents. STOP_REASON = REPETITION.`,
          };
        }
      }
    }

    return { isRepetitive: false };
  }

  private normalizeContent(text: string): string {
    return text
      .replace(/AGENT_STATUS:\s*(DONE|CONTINUE|NEED_USER)/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  private calculateSimilarity(a: string, b: string): number {
    if (a === b) return 1.0;
    if (a.length === 0 || b.length === 0) return 0.0;

    // Fast check for subset / substring
    if (a.includes(b) || b.includes(a)) {
      const minLen = Math.min(a.length, b.length);
      const maxLen = Math.max(a.length, b.length);
      if (minLen / maxLen > 0.9) return 0.95;
    }

    // Levenshtein / Dice Coefficient approximation on character trigrams
    const getTrigrams = (str: string) => {
      const trigrams = new Set<string>();
      for (let i = 0; i < str.length - 2; i++) {
        trigrams.add(str.slice(i, i + 3));
      }
      return trigrams;
    };

    const triA = getTrigrams(a);
    const triB = getTrigrams(b);
    if (triA.size === 0 || triB.size === 0) return a === b ? 1.0 : 0.0;

    let intersection = 0;
    for (const t of triA) {
      if (triB.has(t)) intersection++;
    }

    return (2.0 * intersection) / (triA.size + triB.size);
  }
}
