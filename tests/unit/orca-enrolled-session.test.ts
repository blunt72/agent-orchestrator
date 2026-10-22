import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { readOrcaEnrolledSessionBlock } from "../../src/integrations/orca-enrolled-session.js";
import { parseOrcaCompletionBinding } from "../../src/integrations/orca-evidence-manifest.js";
let root: string, sessions: string, task: any, enrollment: any, selector: string;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const writeTask = () => fs.writeFile(path.join(root, "data/tasks/task.json"), JSON.stringify(task));
const writeEnrollment = () => fs.writeFile(path.join(root, "data/orca-trust-v1/enrollment.json"), JSON.stringify(enrollment), { mode: 0o600 });
const run = () => readOrcaEnrolledSessionBlock(root, sessions, "task", 10, "session.jsonl", selector);
async function inventory(folder: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await fs.readdir(folder)).sort()) {
    const file = path.join(folder, name), stat = await fs.lstat(file);
    result.push([name, stat.mode, stat.isDirectory() ? await inventory(file) : (await fs.readFile(file)).toString("base64")]);
  }
  return result;
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orca-enrolled-"))); sessions = path.join(root, "sessions");
  for (const folder of [sessions, path.join(root, "data/tasks"), path.join(root, "data/orca-evidence-v1"), path.join(root, "data/orca-trust-v1")])
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const binding = { agenthubTaskId: "task", projectId: "project", revision: "3", generation: 1, runtimeId: "runtime", hostId: "local", runId: "run", taskId: "orca-task", dispatchId: "dispatch", workspaceId: "workspace", workspacePath: root, terminalHandle: "terminal", developer: "gemini", reviewer: "codex", provider: "antigravity", ownerId: "gemini", claimId: null };
  task = { id: "task", revision: 10, status: "REVIEW", orcaGeneration: 1, orcaBinding: binding }; await writeTask();
  enrollment = { version: 1, purpose: "LOCAL_HUMAN_SUPERVISED_PILOT_ENROLLMENT", registeredAt: "2026-10-12T13:20:21.211Z",
    operator: { namespace: "agenthub-local-operator-v1", subject: "aaaaaaaa-0000-4000-8000-000000000005" },
    scope: { taskId: "task", projectId: "project", generation: 1, bindingDigest: parseOrcaCompletionBinding(JSON.stringify(binding)).digest },
    evidenceRoots: [sessions, path.join(root, "data/orca-evidence-v1")], authorizationBasis: "synthetic fixture only",
    sourceAuthenticated: false, canCompleteTask: false }; await writeEnrollment();
  const sessionId = "11111111-1111-4111-8111-111111111111", output = "original bytes";
  const rows = [{ ordinal: 0, type: "session_meta", payload: { id: sessionId } },
    { ordinal: 1, type: "response_item", payload: { type: "custom_tool_call", call_id: "call_one", name: "exec" } },
    { ordinal: 2, type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_one", output: [{ type: "input_text", text: output }] } }];
  const source = rows.map(r => JSON.stringify(r)).join("\n") + "\n"; await fs.writeFile(path.join(sessions, "session.jsonl"), source);
  selector = JSON.stringify({ sessionId, callId: "call_one", toolName: "exec", ordinal: 2, blockIndex: 0, sourceSha256: sha(source), blockSha256: sha(output) });
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
it("reads actual temporary task, enrollment and source without writes or completion authority (NOT provider E2E)", async () => {
  const before = await inventory(root); const result = await run();
  expect(result.extracted.outputBytes.toString()).toBe("original bytes"); expect(result.canCompleteTask).toBe(false);
  expect(result.sourceAuthenticated).toBe(false); expect(await inventory(root)).toEqual(before);
});
it("rejects stale revision", async () => { task.revision = 11; await writeTask(); await expect(run()).rejects.toThrow("ENROLLED_SESSION_TASK_NOT_READY"); });
it.each(["status", "result", "pendingAgentTurn"])("rejects non-ready %s", async key => {
  task[key] = "invalid"; await writeTask(); await expect(run()).rejects.toThrow("ENROLLED_SESSION_TASK_NOT_READY");
});
it("rejects changed binding", async () => {
  task.orcaBinding.dispatchId = "other"; await writeTask(); await expect(run()).rejects.toThrow("INVALID_LOCAL_ENROLLMENT");
});
it("rejects missing enrollment", async () => {
  await fs.unlink(path.join(root, "data/orca-trust-v1/enrollment.json")); await expect(run()).rejects.toThrow();
});
it("rejects a caller-selected broader session root", async () => {
  await expect(readOrcaEnrolledSessionBlock(root, root, "task", 10, "sessions/session.jsonl", selector)).rejects.toThrow("INVALID_LOCAL_ENROLLMENT");
});
it("rejects a source selector hash mismatch", async () => {
  selector = JSON.stringify({ ...JSON.parse(selector), sourceSha256: "a".repeat(64) }); await expect(run()).rejects.toThrow("ORCA_SESSION_HASH_MISMATCH");
});
it("rejects task drift during source open", async () => {
  const original = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith("session.jsonl")) { task.revision = 11; await writeTask(); }
    return Reflect.apply(original, fs, args);
  });
  await expect(run()).rejects.toThrow("ENROLLED_SESSION_SNAPSHOT_CHANGED");
});
it("rejects enrollment drift during source open", async () => {
  const original = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith("session.jsonl")) { enrollment.operator.subject = "11111111-1111-4111-8111-111111111111"; await writeEnrollment(); }
    return Reflect.apply(original, fs, args);
  });
  await expect(run()).rejects.toThrow("ENROLLED_SESSION_SNAPSHOT_CHANGED");
});
it("rejects enrollment drift during final asynchronous task read", async () => {
  const original = fs.readFile; let reads = 0;
  vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).endsWith("data/tasks/task.json") && ++reads === 2) {
      enrollment.operator.subject = "11111111-1111-4111-8111-111111111111"; await writeEnrollment();
    }
    return Reflect.apply(original, fs, args);
  }) as typeof fs.readFile);
  await expect(run()).rejects.toThrow("ENROLLED_SESSION_SNAPSHOT_CHANGED"); expect(reads).toBe(2);
});
it("does not initialize directories on missing task", async () => {
  await fs.rm(path.join(root, "data"), { recursive: true }); const before = await inventory(root);
  await expect(run()).rejects.toThrow("ENROLLED_SESSION_TASK_NOT_READY"); expect(await inventory(root)).toEqual(before);
});
