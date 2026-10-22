import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { AgentMessage, sanitizeLog } from "../core/message.js";
import { StateSnapshot } from "../core/state-machine.js";

export interface SessionData {
  id: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  round: number;
  maxRounds: number;
  agents: {
    codex: {
      status: "idle" | "running" | "ready" | "error";
      sessionId?: string;
      restarts: number;
    };
    gemini: {
      status: "idle" | "running" | "ready" | "error";
      sessionId?: string;
      restarts: number;
    };
  };
  lastMessage?: {
    from: string;
    to: string;
    round: number;
    contentSummary: string;
    timestamp: string;
  };
}

export class SessionStore {
  private readonly logsDir: string;
  private readonly dataDir: string;
  private readonly sessionsFile: string;

  constructor(baseDir?: string) {
    const root = baseDir || process.cwd();
    this.logsDir = path.join(root, "logs");
    this.dataDir = path.join(root, "data");
    this.sessionsFile = path.join(this.dataDir, "sessions.json");
    this.ensureDirs();
  }

  private ensureDirs(): void {
    if (!fsSync.existsSync(this.logsDir)) {
      fsSync.mkdirSync(this.logsDir, { recursive: true });
    }
    if (!fsSync.existsSync(this.dataDir)) {
      fsSync.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  public getSessionLogPath(sessionId: string): string {
    return path.join(this.logsDir, `session-${sessionId}.jsonl`);
  }

  public async appendLog(sessionId: string, record: Record<string, unknown>): Promise<void> {
    const filePath = this.getSessionLogPath(sessionId);
    const sanitizedRecord = JSON.parse(sanitizeLog(JSON.stringify(record)));
    const line = JSON.stringify(sanitizedRecord) + "\n";
    await fs.appendFile(filePath, line, "utf-8");
  }

  public async appendMessage(sessionId: string, message: AgentMessage): Promise<void> {
    const record = {
      timestamp: message.timestamp,
      sessionId: message.sessionId,
      round: message.round,
      from: message.from,
      to: message.to,
      type: message.type,
      content: message.content,
      status: message.status,
      stopReason: message.stopReason,
      rawEvents: message.rawEvents,
      provenance: message.provenance,
    };
    await this.appendLog(sessionId, record);
  }

  public async saveSession(sessionData: SessionData): Promise<void> {
    let sessions: Record<string, SessionData> = {};
    try {
      if (fsSync.existsSync(this.sessionsFile)) {
        const content = await fs.readFile(this.sessionsFile, "utf-8");
        sessions = JSON.parse(content);
      }
    } catch {
      sessions = {};
    }

    sessions[sessionData.id] = sessionData;
    await fs.writeFile(this.sessionsFile, JSON.stringify(sessions, null, 2), "utf-8");
  }

  public async getSession(sessionId: string): Promise<SessionData | null> {
    try {
      if (!fsSync.existsSync(this.sessionsFile)) return null;
      const content = await fs.readFile(this.sessionsFile, "utf-8");
      const sessions = JSON.parse(content) as Record<string, SessionData>;
      return sessions[sessionId] || null;
    } catch {
      return null;
    }
  }

  public async getLatestSession(): Promise<SessionData | null> {
    try {
      if (!fsSync.existsSync(this.sessionsFile)) return null;
      const content = await fs.readFile(this.sessionsFile, "utf-8");
      const sessions = JSON.parse(content) as Record<string, SessionData>;
      const list = Object.values(sessions);
      if (list.length === 0) return null;
      list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      return list[0];
    } catch {
      return null;
    }
  }
}
