import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { TASK_EVENT_TYPES, type TaskEvent } from "../tasks/task-events.js";
import { decodeOrcaJson } from "./orca-json.js";

export const TASK_EVENT_LOG_MAX_BYTES = 8 * 1024 * 1024;

function parseEventLog(content: string, taskId: string): TaskEvent[] {
  if (!content.endsWith("\n")) throw new Error("CORRUPT_EVENT_LOG");
  const seen = new Set<string>();
  const textField = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value);
  return content.slice(0, -1).split("\n").map(line => {
    const parsed = decodeOrcaJson(line);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) throw new Error("CORRUPT_EVENT_LOG");
    const item = parsed.value as TaskEvent;
    if (Object.keys(item).some(key => !["id", "taskId", "timestamp", "type", "actor", "details"].includes(key)) ||
      item.taskId !== taskId || !textField(item.id) || seen.has(item.id) || !textField(item.actor) ||
      !textField(item.timestamp) || !Number.isFinite(Date.parse(item.timestamp)) || !TASK_EVENT_TYPES.includes(item.type))
      throw new Error("CORRUPT_EVENT_LOG");
    seen.add(item.id);
    return item;
  });
}

/** Read-only acceptance check. Never repairs logs or creates locks/directories. */
export function verifyTaskEventBytes(bytes:Buffer,event:TaskEvent):void {
  if(!Buffer.isBuffer(bytes)||bytes.length>TASK_EVENT_LOG_MAX_BYTES)throw new Error("EVENT_LOG_LIMIT");
  const events=parseEventLog(new TextDecoder("utf-8",{fatal:true}).decode(bytes),event.taskId);
  const matches=events.filter(item=>item.id===event.id);
  if(matches.length!==1||!isDeepStrictEqual(matches[0],event))throw new Error("EVENT_NOT_VERIFIED");
}

export async function verifyTaskEventReadOnly(root: string, event: TaskEvent): Promise<void> {
  if (typeof event.taskId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(event.taskId)) throw new Error("INVALID_EVENT");
  const file = await fs.open(path.join(root, "logs/tasks", `${event.taskId}.jsonl`), "r");
  let bytes: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > TASK_EVENT_LOG_MAX_BYTES) throw new Error("EVENT_LOG_LIMIT");
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== stat.size) throw new Error("EVENT_LOG_CHANGED");
    bytes = buffer.subarray(0, offset);
  } finally { await file.close(); }
  verifyTaskEventBytes(bytes,event);
}

/** All task log writers share this lock. Orphan locks require operator reconciliation. */
export async function writeTaskEvent(root: string, input: TaskEvent, once: boolean): Promise<"written" | "duplicate"> {
  const event = JSON.parse(JSON.stringify(input)) as TaskEvent;
  if (typeof event.taskId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(event.taskId) || typeof event.id !== "string" || !event.id)
    throw new Error("INVALID_EVENT");
  const line = JSON.stringify(event) + "\n";
  parseEventLog(line, event.taskId);
  const dir = path.join(root, "logs/tasks");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${event.taskId}.jsonl`);
  const lockPath = `${file}.lock`;
  const lock = await fs.open(lockPath, "wx", 0o600);
  const identity = await lock.stat();
  const temporary = `${file}.${randomUUID()}.tmp`;
  const syncDirectory = async () => {
    const directory = await fs.open(dir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  };
  try {
    let content = "";
    try {
      const existing = await fs.open(file, "r");
      try {
        const before = await existing.stat();
        if (!before.isFile() || before.size > TASK_EVENT_LOG_MAX_BYTES) throw new Error("EVENT_LOG_LIMIT");
        const buffer = Buffer.alloc(before.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const read = await existing.read(buffer, offset, buffer.length - offset, offset);
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        const after = await existing.stat();
        if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs) throw new Error("EVENT_LOG_CHANGED");
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
      } finally { await existing.close(); }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const events = content ? parseEventLog(content, event.taskId) : [];
    const matches = events.filter(item => item.id === event.id);
    if (once && matches.length) {
      if (matches.length !== 1 || !isDeepStrictEqual(matches[0], event)) throw new Error("EVENT_ID_CONFLICT");
      const existing = await fs.open(file, "r");
      try { await existing.sync(); } finally { await existing.close(); }
      await syncDirectory();
      return "duplicate";
    }
    if (matches.length) throw new Error("EVENT_ID_CONFLICT");
    if (Buffer.byteLength(content) + Buffer.byteLength(line) > TASK_EVENT_LOG_MAX_BYTES)
      throw new Error("EVENT_LOG_LIMIT");
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(content + line); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
    await syncDirectory();
    return "written";
  } finally {
    await fs.rm(temporary, { force: true });
    await lock.close();
    const current = await fs.stat(lockPath).catch(() => null);
    if (current?.ino === identity.ino && current.dev === identity.dev) await fs.unlink(lockPath);
  }
}
