import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Agent, AgentResponse } from "./agent.js";
import { inspectCodexReviewEvents, planCodexReviewCommand, readCodexReviewFinalOutput } from "./codex-review-output.js";

export interface CodexExecReviewConfig {
  command: string;
  schema: Record<string, unknown>;
  timeoutMs?: number;
  maxStreamBytes?: number;
}

/** Dedicated single-turn reviewer. Not selected by the formal acceptance flow yet. */
export class CodexExecReviewAgent implements Agent {
  readonly name = "codex" as const;
  readonly provider = "openai";
  private session?: { id: string; workspace: string; root: string };
  private child?: ChildProcess;
  private pending?: Promise<AgentResponse>;
  private used = false;
  private closed = false;
  private readonly config: CodexExecReviewConfig;
  private failure?: Error;
  public evidenceDirectory?: string;

  constructor(config: CodexExecReviewConfig) {
    if (!path.isAbsolute(config.command) || config.command.includes("\0")) throw new Error("Absolute executable required");
    for (const n of [config.timeoutMs ?? 600000, config.maxStreamBytes ?? 1048576]) {
      if (!Number.isSafeInteger(n) || n < 1 || n > 1048576) throw new Error("Invalid process limit");
    }
    if (!config.schema || typeof config.schema !== "object" || Array.isArray(config.schema) ||
        Buffer.byteLength(JSON.stringify(config.schema)) > 262144) throw new Error("Invalid review schema");
    this.config = structuredClone(config);
  }
  async start(): Promise<void> { if (this.closed) throw new Error("Reviewer closed"); }
  async initialize(): Promise<void> { await this.start(); }
  async createSession(workspace: string): Promise<string> {
    await this.start();
    if (this.session || !path.isAbsolute(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error("Invalid review session");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-codex-review-"));
    fs.chmodSync(root, 0o700);
    this.evidenceDirectory = root;
    this.session = { id: randomUUID(), workspace, root };
    return this.session.id;
  }
  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    if (this.closed || this.used || !this.session || this.session.id !== sessionId) throw new Error("Invalid or consumed review session");
    if (typeof message !== "string" || Buffer.byteLength(message) > 1048576) throw new Error("Review prompt too large");
    this.used = true;
    const { root, workspace } = this.session;
    const schemaFile = path.join(root, "schema.json");
    const outputFile = path.join(root, "final.json");
    fs.writeFileSync(schemaFile, JSON.stringify(this.config.schema), { flag: "wx", mode: 0o600 });
    const requestTime = new Date().toISOString();
    this.pending = new Promise<AgentResponse>((resolve, reject) => {
      const streams = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      const counts = { stdout: 0, stderr: 0 };
      const child = spawn(this.config.command, planCodexReviewCommand(workspace, outputFile, schemaFile), {
        cwd: workspace, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      const stop = (error: Error) => { this.failure ??= error; this.kill(); };
      const timer = setTimeout(() => stop(new Error("Codex review timeout")), this.config.timeoutMs ?? 600000);
      for (const key of ["stdout", "stderr"] as const) {
        child[key]!.on("data", (chunk: Buffer) => {
          const remaining = (this.config.maxStreamBytes ?? 1048576) - counts[key];
          if (remaining > 0) {
            const retained = Buffer.from(chunk.subarray(0, remaining));
            streams[key].push(retained);
            counts[key] += retained.length;
          }
          if (chunk.length > remaining) stop(new Error(`Codex ${key} limit exceeded`));
        });
      }
      child.on("error", error => { this.failure ??= error; });
      child.stdin!.on("error", error => stop(error));
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        this.child = undefined;
        try {
          for (const key of ["stdout", "stderr"] as const) fs.writeFileSync(path.join(root, `${key}.bin`), Buffer.concat(streams[key]), { flag: "wx", mode: 0o600 });
          fs.writeFileSync(path.join(root, "process.json"), JSON.stringify({ code, signal, requestTime, responseTime: new Date().toISOString(), failure: this.failure?.message ?? null }), { flag: "wx", mode: 0o600 });
          if (this.failure) throw this.failure;
          const bytes = readCodexReviewFinalOutput(outputFile, code);
          const identity = inspectCodexReviewEvents(Buffer.concat(streams.stdout));
          const nativeReviewTransport = JSON.stringify({ version: 1, code, adapterSessionId: sessionId,
            providerSessionId: identity.providerSessionId, finalHash: createHash("sha256").update(bytes).digest("hex"),
            stdout: Buffer.concat(streams.stdout).toString("utf8"), stderrBase64: Buffer.concat(streams.stderr).toString("base64") });
          resolve({ text: bytes.toString("utf8"), nativeReviewTransport, stopReason: "end_turn", provenance: {
            provider: "openai", adapter: "codex-exec", model: "configured-default", endpoint: this.config.command,
            providerSessionId: identity.providerSessionId, adapterSessionId: sessionId,
            requestTime, responseTime: new Date().toISOString(),
          } });
        } catch (error) { reject(error); }
      });
      child.stdin!.end(message);
    });
    return this.pending;
  }
  private kill(): void {
    if (!this.child?.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-this.child.pid, "SIGKILL");
      else this.child.kill("SIGKILL");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  async cancel(): Promise<void> {
    if (this.child) { this.failure ??= new Error("Codex review cancelled"); this.kill(); }
    if (this.pending) await this.pending.catch(() => {});
  }
  async close(): Promise<void> { this.closed = true; await this.cancel(); }
  isRunning(): boolean { return !!this.child; }
}
