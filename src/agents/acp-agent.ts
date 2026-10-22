import { spawn, ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { Agent, AgentResponse, TextChunkCallback, EventCallback } from "./agent.js";

export { Agent, AgentResponse, TextChunkCallback, EventCallback };

export interface AcpAgentConfig {
  name: "codex" | "gemini";
  command: string;
  args: string[];
  env?: Record<string, string>;
  maxRestarts?: number;
  reviewOnly?: boolean;
}

export class AcpAgent implements Agent {
  public readonly name: "codex" | "gemini";
  public readonly provider: string = "acp";
  protected config: AcpAgentConfig;
  protected process: ChildProcess | null = null;
  protected connection: acp.ClientConnection | null = null;
  protected restartCount: number = 0;
  protected readonly maxRestarts: number;
  protected currentSessionId?: string;
  protected stderrBuffer: string[] = [];
  protected isExplicitlyClosed: boolean = false;
  protected readonly reviewOnly: boolean;
  private readonly reviewSessions = new Set<string>();

  private onTextChunkCallbacks: TextChunkCallback[] = [];
  private onRawEventCallbacks: EventCallback[] = [];

  constructor(config: AcpAgentConfig) {
    this.name = config.name;
    this.config = config;
    this.reviewOnly = config.reviewOnly === true;
    this.maxRestarts = this.reviewOnly ? 0 : config.maxRestarts ?? 2;
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

  public getRestartCount(): number {
    return this.restartCount;
  }

  public isRunning(): boolean {
    return this.process !== null && !this.process.killed && this.process.exitCode === null;
  }

  public async start(): Promise<void> {
    if (this.isRunning()) {
      return;
    }
    this.isExplicitlyClosed = false;
    this.stderrBuffer = [];

    const env = { ...process.env, ...this.config.env };
    this.process = spawn(this.config.command, this.config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      this.stderrBuffer.push(text);
      if (this.stderrBuffer.length > 50) {
        this.stderrBuffer.shift();
      }
    });

    this.process.on("error", (err) => {
      this.stderrBuffer.push(`Process error: ${err.message}`);
    });

    this.process.on("exit", (code, signal) => {
      if (!this.isExplicitlyClosed) {
        this.stderrBuffer.push(`Process exited unexpectedly with code ${code}, signal ${signal}`);
      }
    });

    if (!this.process.stdin || !this.process.stdout) {
      throw new Error(`Failed to establish stdio pipes for ${this.name} ACP process.`);
    }

    const input = Writable.toWeb(this.process.stdin) as any;
    const output = Readable.toWeb(this.process.stdout) as any;
    const stream = acp.ndJsonStream(input, output);

    const client = acp.client({ name: `agenthub-${this.name}-client` })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        if (this.reviewOnly) return { outcome: { outcome: "cancelled" as const } };
        // Auto-grant permission: find allow/grant option or default to first
        const allowOption = ctx.params.options.find(
          (opt) =>
            opt.optionId.toLowerCase().includes("allow") ||
            opt.optionId.toLowerCase().includes("grant") ||
            opt.optionId.toLowerCase().includes("approve") ||
            opt.optionId.toLowerCase().includes("yes")
        );
        const selectedOption = allowOption?.optionId || ctx.params.options[0]?.optionId || "allow";
        return {
          outcome: {
            outcome: "selected",
            optionId: selectedOption,
          },
        };
      })
      .onNotification(acp.methods.client.session.update, async (ctx) => {
        const update = ctx.params.update;
        for (const cb of this.onRawEventCallbacks) {
          try {
            cb(ctx.params);
          } catch {
            // Ignore subscriber error
          }
        }

        if (update && typeof update === "object" && "sessionUpdate" in update) {
          if (update.sessionUpdate === "agent_message_chunk") {
            const content = (update as { content?: { type?: string; text?: string } }).content;
            if (content?.type === "text" && content.text) {
              for (const cb of this.onTextChunkCallbacks) {
                try {
                  cb(content.text);
                } catch {
                  // Ignore subscriber error
                }
              }
            }
          }
        }
      });

    this.connection = client.connect(stream);
  }

  public async initialize(): Promise<void> {
    if (!this.connection) {
      await this.start();
    }
    if (!this.connection) {
      throw new Error(`Cannot initialize ${this.name}: connection not active.`);
    }

    try {
      await this.connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: !this.reviewOnly,
          },
        },
      });
    } catch (err: unknown) {
      const stderr = this.stderrBuffer.join("\n");
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ACP initialize failed for ${this.name}: ${msg}${stderr ? `\nAgent stderr:\n${stderr}` : ""}`);
    }
  }

  public async createSession(workspace: string): Promise<string> {
    if (!this.connection) {
      await this.initialize();
    }
    if (!this.connection) {
      throw new Error(`Cannot create session for ${this.name}: connection not active.`);
    }

    try {
      const res = await this.connection.agent.request(acp.methods.agent.session.new, {
        cwd: workspace,
        mcpServers: [],
      });
      if (this.reviewOnly) {
        await this.verifyReadOnlyMode(res.sessionId);
        this.reviewSessions.add(res.sessionId);
      }
      this.currentSessionId = res.sessionId;
      return res.sessionId;
    } catch (err: unknown) {
      const stderr = this.stderrBuffer.join("\n");
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ACP session/new failed for ${this.name}: ${msg}${stderr ? `\nAgent stderr:\n${stderr}` : ""}`);
    }
  }

  public async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    if (this.reviewOnly) {
      if (!this.connection || !this.isRunning() || !this.reviewSessions.has(sessionId))
        throw new Error("READ_ONLY_SESSION_NOT_READY");
      // Reassert and verify the mode before every turn; never fall back to a writable session.
      this.reviewSessions.delete(sessionId);
      await this.verifyReadOnlyMode(sessionId);
      this.reviewSessions.add(sessionId);
    }
    if (!this.connection || !this.isRunning()) {
      // Attempt restart if allowed
      if (this.restartCount < this.maxRestarts) {
        this.restartCount++;
        await this.start();
        await this.initialize();
        // create new session in previous workspace if needed
      } else {
        throw new Error(`${this.name} process crashed and exceeded maximum restart limit (${this.maxRestarts}).`);
      }
    }

    if (!this.connection) {
      throw new Error(`Cannot prompt ${this.name}: connection not established.`);
    }

    let accumulatedText = "";
    const rawEvents: unknown[] = [];

    const unsubscribeText = this.onTextChunk((chunk) => {
      accumulatedText += chunk;
    });

    const unsubscribeRaw = this.onRawEvent((event) => {
      rawEvents.push(event);
    });

    const startTime = new Date().toISOString();
    try {
      const res = await this.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [
          {
            type: "text",
            text: message,
          },
        ],
      });

      // res may contain stopReason or final response
      const stopReason = (res as { stopReason?: string }).stopReason || "end_turn";

      return {
        text: accumulatedText.trim(),
        stopReason,
        usage: (res as { usage?: unknown }).usage,
        rawEvents,
        provenance: {
          provider: "openai",
          adapter: "codex-acp",
          model: "gpt-5.5",
          endpoint: this.config.command || "@agentclientprotocol/codex-acp@2.0.1",
          providerSessionId: sessionId,
          requestTime: startTime,
          responseTime: new Date().toISOString(),
        },
      };
    } catch (err: unknown) {
      const stderr = this.stderrBuffer.join("\n");
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ACP session/prompt failed for ${this.name}: ${msg}${stderr ? `\nAgent stderr:\n${stderr}` : ""}`);
    } finally {
      unsubscribeText();
      unsubscribeRaw();
    }
  }

  public async cancel(sessionId: string): Promise<void> {
    if (this.connection) {
      try {
        await this.connection.agent.request(acp.methods.agent.session.cancel, {
          sessionId,
        });
      } catch {
        // Ignore cancel errors
      }
    }
  }

  public async close(): Promise<void> {
    this.reviewSessions.clear();
    this.isExplicitlyClosed = true;
    if (this.connection) {
      try {
        this.connection.close();
      } catch {
        // Ignore connection close error
      }
      this.connection = null;
    }

    if (this.process && !this.process.killed) {
      try {
        this.process.kill("SIGTERM");
      } catch {
        // Ignore kill error
      }
      this.process = null;
    }
  }

  private async verifyReadOnlyMode(sessionId: string): Promise<void> {
    if (!this.connection) throw new Error("READ_ONLY_SESSION_NOT_READY");
    const result = await this.connection.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId, configId: "mode", value: "read-only",
    });
    const modes = result.configOptions.filter(option => option.id === "mode");
    if (modes.length !== 1 || modes[0].type !== "select" || modes[0].currentValue !== "read-only")
      throw new Error("READ_ONLY_MODE_NOT_CONFIRMED");
  }
}
