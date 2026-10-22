import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexExecReviewAgent } from "../../src/agents/codex-exec-review-agent.js";

const roots: string[] = [];
const agents: CodexExecReviewAgent[] = [];
function agent(body: string, options: { timeoutMs?: number; maxStreamBytes?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-process-test-"));
  roots.push(root);
  const command = path.join(root, "fixture");
  fs.writeFileSync(command, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst out = args[args.indexOf('--output-last-message')+1];\n${body}`, { mode: 0o700 });
  const result = new CodexExecReviewAgent({ command, schema: { type: "object" }, ...options });
  agents.push(result);
  return result;
}
afterEach(async () => {
  for (const a of agents.splice(0)) {
    await a.close();
    if (a.evidenceDirectory) fs.rmSync(a.evidenceDirectory, { recursive: true, force: true });
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("native review lifecycle (synthetic local executables, no provider)", () => {
  it("uses final bytes only, retains streams and consumes the session once", async () => {
    const a = agent(`process.stdin.resume(); process.stdin.on('end', () => { for (const e of [{type:'thread.started',thread_id:'01900000-0000-7000-8000-000000000002'},{type:'turn.started'},{type:'item.completed',item:{type:'reasoning',text:'commentary'}},{type:'turn.completed'}]) console.log(JSON.stringify(e)); console.error('diagnostic'); fs.writeFileSync(out, '{"verdict":"PASS"}\\n'); });`);
    const session = await a.createSession(os.tmpdir());
    const response = await a.prompt(session, "inspect only");
    expect(response.text).toBe('{"verdict":"PASS"}\n');
    expect(response.provenance?.adapter).toBe("codex-exec");
    expect(response.provenance?.adapterSessionId).toBe(session);
    expect(response.provenance?.providerSessionId).not.toBe(session);
    expect(fs.readFileSync(path.join(a.evidenceDirectory!, "stdout.bin"), "utf8")).toContain("commentary");
    expect(fs.readFileSync(path.join(a.evidenceDirectory!, "stderr.bin"), "utf8")).toContain("diagnostic");
    await expect(a.prompt(session, "again")).rejects.toThrow();
    expect(a.isRunning()).toBe(false);
  });
  it.each([
    `console.log('{"verdict":"PASS"}');`,
    `fs.writeFileSync(out, '{}'); process.exitCode = 2;`,
    `fs.symlinkSync('/dev/null', out);`,
  ])("rejects missing, failed or symlink final output %#", async body => {
    const a = agent(body);
    const session = await a.createSession(os.tmpdir());
    await expect(a.prompt(session, "inspect")).rejects.toThrow();
    expect(fs.existsSync(path.join(a.evidenceDirectory!, "process.json"))).toBe(true);
  });
  it("kills a timed-out process and retains its exit record", async () => {
    const a = agent(`setInterval(() => {}, 1000);`, { timeoutMs: 100 });
    const session = await a.createSession(os.tmpdir());
    await expect(a.prompt(session, "inspect")).rejects.toThrow("timeout");
    expect(a.isRunning()).toBe(false);
  });
  it("cancels an active process and prevents later reuse", async () => {
    const a = agent(`setInterval(() => {}, 1000);`);
    const session = await a.createSession(os.tmpdir());
    const result = a.prompt(session, "inspect");
    const rejection = expect(result).rejects.toThrow("cancelled");
    await a.close();
    await rejection;
    expect(a.isRunning()).toBe(false);
    await expect(a.createSession(os.tmpdir())).rejects.toThrow("closed");
  });
  it("bounds noisy output and rejects even if a final file exists", async () => {
    const a = agent(`fs.writeFileSync(out, '{}'); process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000);`, { maxStreamBytes: 64 });
    const session = await a.createSession(os.tmpdir());
    await expect(a.prompt(session, "inspect")).rejects.toThrow("limit exceeded");
    expect(fs.statSync(path.join(a.evidenceDirectory!, "stdout.bin")).size).toBe(64);
  });
  it("handles executable spawn failure without hanging", async () => {
    const a = new CodexExecReviewAgent({ command: "/nonexistent/codex", schema: {} });
    agents.push(a);
    const session = await a.createSession(os.tmpdir());
    await expect(a.prompt(session, "inspect")).rejects.toThrow();
    expect(a.isRunning()).toBe(false);
  });
});
