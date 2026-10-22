import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Agent, AgentResponse, TextChunkCallback, EventCallback, AgentProvenance, AgentTurnPendingError, PendingAgentTurn } from "./agent.js";

export interface AntigravityAgentConfig {
  role?: "developer" | "reviewer";
  executablePath?: string;
  model?: "flash" | "pro" | "flash_lite" | string;
  timeoutMs?: number;
  /** Explicit Antigravity brain directory; bind only the requested conversation ID. */
  transcriptBrainRoot?: string;
}

const FAKE_AGY_SHA256 = "268283862a1c166eb2b69f32e5ff57d5083238af10cbbc62fc0fcb1a9441a312";

export class AntigravityAgent implements Agent {
  public static readonly ROLE = "Reviewer / Architect";
  public readonly name = "gemini" as const;
  public readonly provider = "antigravity";

  private config: AntigravityAgentConfig;
  private executablePath: string = "";
  private model: string;
  private timeoutMs: number;
  private conversationId?: string;
  private transcriptPath?: string;
  private transcriptBrainRoot?: string;
  private lastProcessedStepIndex: number = -1;
  private isInitialized: boolean = false;
  private pendingTurnHandler?: (checkpoint: PendingAgentTurn) => Promise<void>;

  public setPendingTurnHandler(handler: (checkpoint: PendingAgentTurn) => Promise<void>): void {
    this.pendingTurnHandler = handler;
  }

  private onTextChunkCallbacks: TextChunkCallback[] = [];
  private onRawEventCallbacks: EventCallback[] = [];

  constructor(config?: AntigravityAgentConfig) {
    this.config = config || {};
    this.model = this.config.model || "flash";
    this.timeoutMs = this.config.timeoutMs || 120000;
    this.transcriptBrainRoot = this.config.transcriptBrainRoot;
  }

  public onTextChunk(cb: TextChunkCallback): () => void {
    this.onTextChunkCallbacks.push(cb);
    return () => {
      this.onTextChunkCallbacks = this.onTextChunkCallbacks.filter((c) => c !== cb);
    };
  }

  public onRawEvent(cb: EventCallback): () => void {
    this.onRawEventCallbacks.push(cb);
    return () => {
      this.onRawEventCallbacks = this.onRawEventCallbacks.filter((c) => c !== cb);
    };
  }

  public isRunning(): boolean {
    return this.isInitialized && !!this.conversationId;
  }

  public getExecutablePath(): string {
    return this.executablePath;
  }

  public getConversationId(): string | undefined {
    return this.conversationId;
  }

  public async start(): Promise<void> {
    await this.initialize();
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) return;

    this.executablePath = this.resolveExecutable();

    // Verify authenticity: ensure NOT fake-agy
    this.verifyAuthenticity(this.executablePath);

    // Verify command execution
    await this.verifyExecutableRunnable(this.executablePath);

    this.isInitialized = true;
  }

  public async createSession(workspace: string): Promise<string> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const initialRolePrompt = this.config.role === "developer"
      ? `You are Google Gemini Developer in a multi-agent pair programming system. Codex is the independent Reviewer.
Workspace: ${workspace}
For this initial turn reply only READY. Do not use tools, explore files, or edit anything until the concrete task message arrives. Then implement only its authorized scope, run relevant tests, and report changed files and remaining risks. When implementation is ready for independent review, return AGENT_STATUS: CONTINUE. When a material user decision is needed, return AGENT_STATUS: NEED_USER. Do not self-approve or modify files during reviewer turns.`
      : `You are Google Gemini Code Reviewer in a multi-agent pair programming system, collaborating with Codex (Developer).
Workspace: ${workspace}

Reviewer Instructions:
1. Examine code modifications, implementation logic, boundary conditions, edge cases, and test results.
2. In Round 2 (first review), provide constructive critique and suggest at least one specific enhancement or extra edge-case test (e.g. testing negative zero, safe integer bounds, or specific error message verification) so Codex can refine it. End your review turn with:
   AGENT_STATUS: CONTINUE
3. In subsequent rounds after Codex incorporates your feedback, verify the workspace diff and test execution. If all requirements are satisfied, approve with:
   AGENT_STATUS: DONE`;

    const result = await this.execCommand([
      "new-conversation",
      `--model=${this.model}`,
      initialRolePrompt,
    ]);

    let parsed: any;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (e) {
      throw new Error(`Failed to parse agentapi new-conversation output: ${result.stdout}\nStderr: ${result.stderr}`);
    }

    const conversationId = parsed?.response?.newConversation?.conversationId;
    if (!conversationId) {
      throw new Error(`agentapi new-conversation did not return a valid conversationId: ${result.stdout}`);
    }

    this.conversationId = conversationId;
    this.lastProcessedStepIndex = -1;
    this.transcriptPath = this.resolveTranscriptPath(conversationId);

    // Wait for turn 0 (role acknowledgement) to settle in transcript
    await this.waitForInitialTurn(this.transcriptPath);

    return conversationId;
  }

  public async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    if (!this.conversationId || !this.transcriptPath) {
      throw new Error("AntigravityAgent session not initialized. Call createSession() first.");
    }

    const requestTime = new Date().toISOString();
    const startStepIndex = this.lastProcessedStepIndex;
    await this.pendingTurnHandler?.({ sessionId: this.conversationId, startStepIndex, requestTime });

    // Send message to conversation
    const sendResult = await this.execCommand([
      "send-message",
      this.conversationId,
      message,
    ]);

    if (sendResult.exitCode !== 0) {
      throw new Error(`agentapi send-message failed (code ${sendResult.exitCode}): ${sendResult.stderr}`);
    }

    // Poll transcript until model finishes this turn
    return this.waitForPendingTurn({ sessionId: this.conversationId, startStepIndex, requestTime });
  }

  public async restorePendingTurn(checkpoint: PendingAgentTurn): Promise<string> {
    if (!/^[a-f0-9-]{36}$/i.test(checkpoint.sessionId)) throw new Error("Invalid pending conversation ID");
    this.conversationId = checkpoint.sessionId;
    this.transcriptPath = this.resolveTranscriptPath(checkpoint.sessionId);
    this.lastProcessedStepIndex = checkpoint.startStepIndex;
    return checkpoint.sessionId;
  }

  public async waitForPendingTurn(checkpoint: PendingAgentTurn, signal?: AbortSignal): Promise<AgentResponse> {
    await this.restorePendingTurn(checkpoint);
    let responseText: string;
    let capturedSteps: unknown[];
    try {
      ({ responseText, capturedSteps } = await this.pollTranscriptForTurn(this.transcriptPath!, checkpoint.startStepIndex, this.timeoutMs, signal));
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("AntigravityAgent turn timed out")) throw new AgentTurnPendingError(checkpoint);
      throw err;
    }

    const responseTime = new Date().toISOString();

    const provenance: AgentProvenance = {
      provider: "google",
      adapter: "antigravity-agentapi",
      model: `gemini-3.8-${this.model}`,
      endpoint: this.executablePath,
      providerSessionId: this.conversationId,
      requestTime: checkpoint.requestTime,
      responseTime,
    };

    return {
      text: responseText.trim(),
      stopReason: "end_turn",
      rawEvents: capturedSteps,
      provenance,
    };
  }

  public async cancel(sessionId?: string): Promise<void> {
    // No-op for agentapi
  }

  public async close(): Promise<void> {
    this.conversationId = undefined;
    this.transcriptPath = undefined;
    this.lastProcessedStepIndex = -1;
    this.isInitialized = false;
  }

  /** Refuse ambiguous roots; never use a different session's latest transcript. */
  private resolveTranscriptPath(conversationId: string): string {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(conversationId)) {
      throw new Error("INVALID_ANTIGRAVITY_CONVERSATION_ID");
    }
    const roots = this.transcriptBrainRoot
      ? [this.transcriptBrainRoot]
      : [path.join(os.homedir(), ".gemini/antigravity-cli/brain"),
         path.join(os.homedir(), ".gemini/antigravity/brain")];
    const candidates = roots.map(root => {
      if (!path.isAbsolute(root)) throw new Error("INVALID_ANTIGRAVITY_TRANSCRIPT_ROOT");
      return path.join(root, conversationId, ".system_generated/logs/transcript.jsonl");
    });
    const existing = candidates.filter(p => fs.existsSync(p));
    if (existing.length > 1) throw new Error("AMBIGUOUS_ANTIGRAVITY_TRANSCRIPT_SOURCE");
    if (existing.length === 1) return existing[0];
    if (this.transcriptBrainRoot) return candidates[0];
    // Neither conversation has emitted a transcript. Select only when one
    // installation has a brain root; otherwise require explicit configuration.
    const existingRoots = roots.filter(root => fs.existsSync(root));
    if (existingRoots.length !== 1) throw new Error("ANTIGRAVITY_TRANSCRIPT_ROOT_UNRESOLVED");
    return candidates[roots.indexOf(existingRoots[0])];
  }

  // --- Internal Helpers ---

  private resolveExecutable(): string {
    const candidates = [
      this.config.executablePath,
      path.join(os.homedir(), ".gemini/antigravity/bin/agentapi"),
      path.join(os.homedir(), ".gemini/antigravity-ide/bin/agentapi"),
      process.env.ANTIGRAVITY_AGENTAPI_EXE?.endsWith("agentapi") ? process.env.ANTIGRAVITY_AGENTAPI_EXE : undefined,
      "/Applications/Antigravity.app/Contents/Resources/bin/agentapi",
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        } catch {
          // not executable, continue
        }
      }
    }

    throw new Error(
      `Google Antigravity agentapi executable not found. Checked: ${candidates.join(", ")}`
    );
  }

  private verifyAuthenticity(exePath: string): void {
    if (!fs.existsSync(exePath)) {
      throw new Error(`Executable does not exist: ${exePath}`);
    }

    const content = fs.readFileSync(exePath);
    const hash = crypto.createHash("sha256").update(content).digest("hex");

    if (hash === FAKE_AGY_SHA256) {
      throw new Error(
        `SECURITY REJECTION: The binary at ${exePath} matches the SHA256 of fake-agy simulator. Real Google Antigravity Provider is required.`
      );
    }

    const textSample = content.subarray(0, 4096).toString("utf-8");
    if (textSample.includes("fake-agy") || textSample.includes("STREAM_JSON_STATE_MEMORY")) {
      throw new Error(
        `SECURITY REJECTION: The binary at ${exePath} contains simulated mock code. Real Google Antigravity Provider is required.`
      );
    }
  }

  private async verifyExecutableRunnable(exePath: string): Promise<void> {
    const res = await this.execCommand(["--help"]);
    if (res.exitCode !== 0 || !res.stdout.includes("new-conversation")) {
      throw new Error(
        `agentapi failed executable verification. Output: ${res.stdout}\nError: ${res.stderr}`
      );
    }
  }

  private execCommand(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.executablePath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let resolved = false;

      const finish = (code: number | null) => {
        if (!resolved) {
          resolved = true;
          try {
            proc.kill("SIGKILL");
          } catch {}
          resolve({
            exitCode: code ?? 0,
            stdout,
            stderr,
          });
        }
      };

      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf-8");
        if (stdout.includes("newConversation") || stdout.includes("sendMessage") || stdout.includes("Available Commands")) {
          setTimeout(() => finish(0), 50);
        }
      });

      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf-8");
      });

      proc.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      proc.on("exit", (code) => finish(code));
      proc.on("close", (code) => finish(code));

      setTimeout(() => finish(0), 15000);
    });
  }

  private async waitForInitialTurn(transcriptPath: string): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < 30000) {
      await new Promise((r) => setTimeout(r, 400));
      if (!fs.existsSync(transcriptPath)) continue;

      const content = fs.readFileSync(transcriptPath, "utf-8").trim();
      if (!content) continue;

      const lines = content.split("\n");
      for (const line of lines) {
        try {
          const step = JSON.parse(line);
          if (step.source === "MODEL" && step.status === "DONE") {
            this.lastProcessedStepIndex = Math.max(this.lastProcessedStepIndex, step.step_index);
            return;
          }
        } catch {
          // ignore partial json
        }
      }
    }
  }

  private async pollTranscriptForTurn(
    transcriptPath: string,
    startStepIndex: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ responseText: string; capturedSteps: unknown[] }> {
    const startTime = Date.now();
    const capturedSteps: unknown[] = [];
    let candidateResponse = "";
    let candidateStepIndex = -1;
    let turnCompleted = false;

    while (Date.now() - startTime < timeoutMs) {
      if (signal?.aborted) throw new Error("Pending wait aborted; remote cancellation not confirmed");
      await new Promise((r) => setTimeout(r, 500));
      if (!fs.existsSync(transcriptPath)) continue;

      const content = fs.readFileSync(transcriptPath, "utf-8").trim();
      if (!content) continue;

      const lines = content.split("\n");
      for (const line of lines) {
        try {
          const step = JSON.parse(line);
          if (typeof step.step_index === "number" && step.step_index > startStepIndex) {
            if (!capturedSteps.some((s: any) => s.step_index === step.step_index)) {
              capturedSteps.push(step);
              for (const cb of this.onRawEventCallbacks) {
                cb(step);
              }
            }

            if (step.source === "MODEL" && step.type === "PLANNER_RESPONSE") {
              // 1. Check if model sent a message via send_message tool call
              if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
                const sm = step.tool_calls.find((t: any) => t.name === "send_message");
                if (sm?.args?.Message) {
                  let msg = sm.args.Message;
                  try {
                    msg = JSON.parse(msg);
                  } catch {}
                  candidateResponse = String(msg);
                  candidateStepIndex = step.step_index;
                  turnCompleted = true;
                  break;
                }
                // If model made other tool calls (view_file, run_command), turn is still ongoing
              } else if (step.content && step.status === "DONE") {
                // 2. Model produced direct markdown content without tool calls
                candidateResponse = String(step.content);
                candidateStepIndex = step.step_index;
                turnCompleted = true;
                break;
              }
            }
          }
        } catch {
          // ignore partial json
        }
      }

      if (turnCompleted && candidateResponse) {
        this.lastProcessedStepIndex = Math.max(this.lastProcessedStepIndex, candidateStepIndex);
        for (const cb of this.onTextChunkCallbacks) {
          cb(candidateResponse);
        }
        return { responseText: candidateResponse, capturedSteps };
      }
    }

    if (candidateResponse) {
      this.lastProcessedStepIndex = Math.max(this.lastProcessedStepIndex, candidateStepIndex);
      return { responseText: candidateResponse, capturedSteps };
    }

    throw new Error(
      `AntigravityAgent turn timed out after ${timeoutMs}ms without receiving model response. Conversation ID: ${this.conversationId}`
    );
  }
}
