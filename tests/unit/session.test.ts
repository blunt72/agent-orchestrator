import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../../src/storage/store.js";
import { createAgentMessage } from "../../src/core/message.js";

describe("SessionStore & Logging", () => {
  let tempDir: string;
  let store: SessionStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-test-"));
    store = new SessionStore(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("appends and sanitizes logs in JSONL format", async () => {
    const sessionId = "test-session-1";
    const msg = createAgentMessage(
      sessionId,
      1,
      "codex",
      "gemini",
      "response",
      "API Key is sk-abcdef1234567890abcdef123456",
      { status: "continue" }
    );

    await store.appendMessage(sessionId, msg);

    const logPath = store.getSessionLogPath(sessionId);
    const content = await fs.readFile(logPath, "utf-8");
    expect(content).toContain("test-session-1");
    expect(content).toContain("***REDACTED***");
    expect(content).not.toContain("sk-abcdef1234567890abcdef123456");

    const parsed = JSON.parse(content.trim());
    expect(parsed.round).toBe(1);
    expect(parsed.from).toBe("codex");
    expect(parsed.to).toBe("gemini");
  });

  it("saves and retrieves session metadata", async () => {
    const sessionData = {
      id: "sess-meta-1",
      workspace: "/path/to/work",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "RUNNING",
      round: 2,
      maxRounds: 6,
      agents: {
        codex: { status: "running" as const, sessionId: "c-1", restarts: 0 },
        gemini: { status: "ready" as const, sessionId: "g-1", restarts: 0 },
      },
    };

    await store.saveSession(sessionData);

    const retrieved = await store.getSession("sess-meta-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe("sess-meta-1");
    expect(retrieved?.status).toBe("RUNNING");
    expect(retrieved?.round).toBe(2);

    const latest = await store.getLatestSession();
    expect(latest?.id).toBe("sess-meta-1");
  });
});
