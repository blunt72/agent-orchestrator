import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_REVIEW_OUTPUT_MAX_BYTES, inspectCodexReviewEvents, planCodexReviewCommand, readCodexReviewFinalOutput } from "../../src/agents/codex-review-output.js";

const roots: string[] = [];
function output(bytes: string | Buffer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-final-unit-"));
  roots.push(root);
  const file = path.join(root, "final.json");
  fs.writeFileSync(file, bytes);
  return file;
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("Codex final output boundary (synthetic, no model invocation)", () => {
  it("plans an explicit read-only native command with stdin and separate final output", () => {
    const args = planCodexReviewCommand("/repo with spaces", "/scratch/final.json", "/scratch/schema.json");
    expect(args).toContain("read-only");
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("--output-last-message");
    expect(args.at(-1)).toBe("-");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });
  it.each(["relative", "", "/bad\0path"])("rejects unsafe command paths %j", value => {
    expect(() => planCodexReviewCommand(value, "/out", "/schema")).toThrow();
  });
  it("rejects schema/output aliases", () => {
    expect(() => planCodexReviewCommand("/repo", "/tmp/a/../schema", "/tmp/schema")).toThrow();
  });
  it("preserves exact bytes without stripping commentary or whitespace", () => {
    const text = 'commentary\n{"verdict":"PASS"}\n';
    expect(readCodexReviewFinalOutput(output(text), 0)).toEqual(Buffer.from(text));
  });
  it.each([1, null, -1])("rejects unsuccessful exit %j even with valid bytes", code => {
    expect(() => readCodexReviewFinalOutput(output('{"verdict":"PASS"}'), code)).toThrow();
  });
  it("accepts the byte limit and rejects oversized, empty and invalid UTF-8 files", () => {
    expect(readCodexReviewFinalOutput(output(Buffer.alloc(CODEX_REVIEW_OUTPUT_MAX_BYTES, 32)), 0).length).toBe(CODEX_REVIEW_OUTPUT_MAX_BYTES);
    for (const bytes of [Buffer.alloc(CODEX_REVIEW_OUTPUT_MAX_BYTES + 1), Buffer.alloc(0), Buffer.from([0xff])]) {
      expect(() => readCodexReviewFinalOutput(output(bytes), 0)).toThrow();
    }
  });
  it("rejects symlinks, missing output and directories without stdout fallback", () => {
    const file = output("{}");
    const link = file + ".link";
    fs.symlinkSync(file, link);
    for (const invalid of [link, file + ".missing", path.dirname(file)]) {
      expect(() => readCodexReviewFinalOutput(invalid, 0)).toThrow();
    }
  });
  it.each(["replace", "append", "truncate"])("rejects output drift during the read: %s", kind => {
    const file = output("{}");
    const original = fs.readSync.bind(fs);
    let changed = false;
    vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const count = original(...args);
      if (!changed) {
        changed = true;
        if (kind === "replace") {
          fs.renameSync(file, file + ".old");
          fs.writeFileSync(file, "{}");
        } else if (kind === "append") fs.appendFileSync(file, "x");
        else fs.truncateSync(file, 1);
      }
      return count;
    }) as typeof fs.readSync);
    expect(() => readCodexReviewFinalOutput(file, 0)).toThrow();
  });
});

const thread = { type: "thread.started", thread_id: "01900000-0000-7000-8000-000000000002" };
const start = { type: "turn.started" };
const done = { type: "turn.completed" };
const stream = (events: unknown[]) => Buffer.from(events.map(e => JSON.stringify(e)).join("\n") + "\n");
describe("native event identity (synthetic, not authentication)", () => {
  it("uses the observed thread, not the local adapter correlation ID", () => {
    expect(inspectCodexReviewEvents(stream([thread, start, { type: "item.completed", item: {} }, done])))
      .toEqual({ providerSessionId: thread.thread_id });
  });
  it.each([
    [], [thread], [thread, start], [start, thread, done], [thread, done],
    [thread, thread, start, done], [thread, start, start, done], [thread, start, done, done],
    [thread, start, { type: "turn.failed" }], [thread, start, { type: "error" }, done],
    [thread, start, { type: "unknown" }, done], [{ ...thread, thread_id: "fake" }, start, done],
    [thread, start, done, { type: "item.completed" }], [null], [[]],
  ])("rejects missing, ambiguous or failed lifecycle %#", events => {
    expect(() => inspectCodexReviewEvents(stream(events))).toThrow();
  });
  it("rejects invalid UTF-8, prose, oversized and wrong-typed streams", () => {
    for (const bytes of [Buffer.from([255]), Buffer.from("commentary"), Buffer.alloc(3600001), "not-buffer"]) {
      expect(() => inspectCodexReviewEvents(bytes as Buffer)).toThrow();
    }
  });
});
