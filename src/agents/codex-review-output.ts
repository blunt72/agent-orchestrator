import fs from "node:fs";
import path from "node:path";

export const CODEX_REVIEW_OUTPUT_MAX_BYTES = 262144;

/** Local CLI event observation, not provider authentication. */
export function inspectCodexReviewEvents(stdout: Buffer): { providerSessionId: string } {
  if (!Buffer.isBuffer(stdout) || stdout.length > 3600000) throw new Error("Invalid Codex event stream");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  let thread: string | undefined;
  let started = false;
  let completed = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") throw new Error("Invalid Codex event");
    if (completed) throw new Error("Codex events after completion");
    if (event.type === "thread.started") {
      if (thread || started || typeof event.thread_id !== "string" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(event.thread_id)) throw new Error("Invalid Codex thread identity");
      thread = event.thread_id;
    } else if (event.type === "turn.started") {
      if (!thread || started) throw new Error("Invalid Codex turn start");
      started = true;
    } else if (event.type === "turn.completed") {
      if (!started) throw new Error("Invalid Codex turn completion");
      completed = true;
    } else if (event.type === "error" || event.type === "turn.failed") {
      throw new Error("Codex reported a failed review");
    } else if (!started || !["item.started", "item.updated", "item.completed"].includes(event.type)) {
      throw new Error("Unknown or out-of-order Codex event");
    }
  }
  if (!thread || !completed) throw new Error("Incomplete Codex review events");
  return { providerSessionId: thread };
}

/** Command plan only; callers must bind a fresh review before executing it. */
export function planCodexReviewCommand(workspace: string, outputFile: string, schemaFile: string): string[] {
  for (const value of [workspace, outputFile, schemaFile]) {
    if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
      throw new Error("Codex review paths must be absolute");
    }
  }
  if (path.resolve(outputFile) === path.resolve(schemaFile)) {
    throw new Error("Review output must not overwrite its schema");
  }
  return ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
    "--sandbox", "read-only", "-c", 'approval_policy="never"',
    "--cd", workspace, "--output-schema", schemaFile,
    "--output-last-message", outputFile, "--json", "-"];
}

/** Never fall back to stdout: it may contain commentary or tool events. */
export function readCodexReviewFinalOutput(outputFile: string, exitCode: number | null): Buffer {
  if (exitCode !== 0) throw new Error("Codex review did not exit successfully");
  const fd = fs.openSync(outputFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(CODEX_REVIEW_OUTPUT_MAX_BYTES)) {
      throw new Error("Invalid Codex final output size or file type");
    }
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (n === 0) break;
      count += n;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(outputFile, { bigint: true });
    for (const stat of [after, current]) {
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino ||
          stat.size !== before.size || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs) {
        throw new Error("Codex final output changed while reading");
      }
    }
    if (count !== Number(before.size)) throw new Error("Incomplete Codex final output");
    const result = bytes.subarray(0, count);
    new TextDecoder("utf-8", { fatal: true }).decode(result);
    return result;
  } finally {
    fs.closeSync(fd);
  }
}
