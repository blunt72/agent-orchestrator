import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const cli = process.env.AGENTHUB_TEST_CLI ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");
it.each([["status"], ["preflight"], ["request"], ["complete"], ["reconcile"], ["complete", "--approve"], ["not-a-command"]])
  ("print CLI parser rejects missing/expanded authority %#", args => {
    const r = spawnSync(process.execPath, [cli, "automation", "print", ...args], { shell: false, timeout: 10000, maxBuffer: 32768 });
    expect(r.error).toBeUndefined(); expect(r.status).not.toBe(0); expect(r.stdout.toString()).toBe("");
    expect(JSON.parse(r.stderr.toString())).toEqual({ ok: false, code: "INVALID_OPTIONS", automaticRetry: false });
  });
it.each(["request", "complete", "reconcile"])("ordinary CLI cannot %s even with syntactically complete flags", action => {
  const args = [cli, "automation", "print", action, "--input", "/nonexistent/operator.json", "--sha256", "a".repeat(64)];
  if (action === "request") args.push("--output", "/nonexistent/approval-request.json");
  const r = spawnSync(process.execPath, args, { shell: false, timeout: 10000, maxBuffer: 32768 });
  expect(r.status).toBe(1); expect(r.stderr.toString()).toBe("");
  expect(JSON.parse(r.stdout.toString())).toEqual({ ok: false, code: "PRINT_WORKFLOW_REJECTED", automaticRetry: false, outcome: "UNKNOWN_OR_REJECTED" });
});
it.each([["preflight"], ["complete", "--approve"]])("retains legacy limited parser behavior in the same compiled entry %#", args => {
  const r = spawnSync(process.execPath, [cli, "automation", "limited", ...args], { shell: false, timeout: 10000, maxBuffer: 32768 });
  expect(r.error).toBeUndefined(); expect(r.status).toBe(1); expect(r.stdout.toString()).toBe("");
  expect(JSON.parse(r.stderr.toString())).toEqual({ ok: false, code: "INVALID_OPTIONS", automaticRetry: false });
});
