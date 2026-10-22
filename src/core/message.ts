import crypto from "node:crypto";
import type { AgentProvenance } from "../agents/agent.js";

export type AgentRoleName = "codex" | "gemini";
export type MessageSender = "user" | "codex" | "gemini" | "system";
export type MessageRecipient = "codex" | "gemini" | "user" | "system";
export type MessageType = "task" | "review" | "response" | "system" | "error";
export type AgentControlStatus = "continue" | "done" | "need_user";

export interface AgentMessage {
  id: string;
  sessionId: string;
  round: number;
  from: MessageSender;
  to: MessageRecipient;
  type: MessageType;
  content: string;
  timestamp: string;
  status?: AgentControlStatus;
  stopReason?: string;
  rawEvents?: unknown[];
  provenance?: AgentProvenance;
  metadata?: Record<string, unknown>;
}

export interface PromptTemplateParams {
  role: string;
  task: string;
  round: number;
  from: string;
  message: string;
}

/**
 * Formats structured prompt for an Agent turn following the protocol specification:
 * 
 * 你是 AgentHub 中的 {ROLE}。
 * 
 * 当前任务：
 * {TASK}
 * 
 * 当前轮次：
 * {ROUND}
 * 
 * 上一位 Agent：
 * {FROM}
 * 
 * 上一位 Agent 的输出：
 * 
 * --- BEGIN MESSAGE ---
 * {MESSAGE}
 * --- END MESSAGE ---
 * 
 * 请基于以上内容继续工作。
 * 
 * 如果任务已经完成：
 * AGENT_STATUS: DONE
 * 
 * 如果需要另一个 Agent 继续：
 * AGENT_STATUS: CONTINUE
 * 
 * 如果需要用户决策：
 * AGENT_STATUS: NEED_USER
 */
export function formatAgentPrompt(params: PromptTemplateParams): string {
  const roleGuidance = params.role.includes("Developer")
    ? "提示：作为 Developer，完成当前修改或测试后请转交给 Reviewer 审查，输出 AGENT_STATUS: CONTINUE。"
    : "提示：作为 Reviewer，请审查修改。若需改进请给出明确意见并输出 AGENT_STATUS: CONTINUE；若审查通过且全部要求已满足，输出 AGENT_STATUS: DONE。";

  return `你是 AgentHub 中的 ${params.role}。

当前任务：
${params.task}

当前轮次：
${params.round}

上一位 Agent：
${params.from}

上一位 Agent 的输出：

--- BEGIN MESSAGE ---
${params.message}
--- END MESSAGE ---

请基于以上内容继续工作。
${roleGuidance}

如果任务已经完成：
AGENT_STATUS: DONE

如果需要另一个 Agent 继续：
AGENT_STATUS: CONTINUE

如果需要用户决策：
AGENT_STATUS: NEED_USER`;
}

export interface ParsedAgentOutput {
  status: AgentControlStatus;
  warning?: string;
  cleanText: string;
}

/**
 * Parses AGENT_STATUS from agent output.
 * If not found or malformed, defaults to CONTINUE and produces a warning.
 */
export function parseAgentStatus(outputText: string): ParsedAgentOutput {
  if (!outputText) {
    return {
      status: "continue",
      warning: "Empty agent response. Defaulting to CONTINUE.",
      cleanText: "",
    };
  }

  const lines = outputText.trim().split("\n");
  const lastLines = lines.slice(-5); // check trailing lines

  for (let i = lastLines.length - 1; i >= 0; i--) {
    const line = lastLines[i].trim();
    const match = line.match(/^AGENT_STATUS:\s*(DONE|CONTINUE|NEED_USER)$/i);
    if (match) {
      const parsed = match[1].toLowerCase() as AgentControlStatus;
      return {
        status: parsed,
        cleanText: outputText,
      };
    }
  }

  // Fallback: check whole text regex if agent included status in body
  const bodyMatch = outputText.match(/AGENT_STATUS:\s*(DONE|CONTINUE|NEED_USER)/i);
  if (bodyMatch) {
    const parsed = bodyMatch[1].toLowerCase() as AgentControlStatus;
    return {
      status: parsed,
      cleanText: outputText,
    };
  }

  return {
    status: "continue",
    warning: "Agent did not output explicit AGENT_STATUS. Defaulting to CONTINUE.",
    cleanText: outputText,
  };
}

/**
 * Creates a unique message object
 */
export function createAgentMessage(
  sessionId: string,
  round: number,
  from: MessageSender,
  to: MessageRecipient,
  type: MessageType,
  content: string,
  options?: {
    status?: AgentControlStatus;
    stopReason?: string;
    rawEvents?: unknown[];
    provenance?: AgentProvenance;
    metadata?: Record<string, unknown>;
  }
): AgentMessage {
  return {
    id: `msg-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    sessionId,
    round,
    from,
    to,
    type,
    content,
    timestamp: new Date().toISOString(),
    status: options?.status,
    stopReason: options?.stopReason,
    rawEvents: options?.rawEvents,
    provenance: options?.provenance,
    metadata: options?.metadata,
  };
}

/**
 * Sanitizes sensitive credentials (API keys, bearer tokens, passwords)
 */
export function sanitizeLog(text: string): string {
  if (!text) return text;
  return text
    .replace(/(sk-[a-zA-Z0-9_-]{20,})/g, "sk-***REDACTED***")
    .replace(/(AIza[0-9A-Za-z-_]{35})/g, "AIza***REDACTED***")
    .replace(/(Bearer\s+)[a-zA-Z0-9._-]+/gi, "$1***REDACTED***")
    .replace(/(GEMINI_API_KEY|CODEX_API_KEY|OPENAI_API_KEY)\s*=\s*['"]?[^\s'"]+/gi, "$1=***REDACTED***")
    .replace(/(password|token|secret)\s*[:=]\s*['"]?[^\s'"]+/gi, "$1=***REDACTED***");
}
