import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectStore } from "../../src/projects/project-store.js";
import type { TaskEvent } from "../../src/tasks/task-events.js";
import { verifyTaskEventReadOnly, TASK_EVENT_LOG_MAX_BYTES } from "../../src/integrations/task-event-store.js";

let root: string;
const event: TaskEvent = { id: "event", taskId: "task", timestamp: "2026-10-11T00:00:00Z", type: "STATUS_CHANGED", actor: "gemini" };
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "event-store-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it("read-only verification never initializes a missing log directory", async () => {
  await expect(verifyTaskEventReadOnly(root, event)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readdir(root)).toEqual([]);
});

it.each([
  { id: "broken", taskId: "task" }, { ...event, id: "other", timestamp: "invalid" },
  { ...event, id: "other", type: "UNKNOWN" }, { ...event, id: "other", actor: "" },
  { ...event, id: "other", secret: "SECRET-EXTRA" },
])("rejects corrupt non-target event rows: %j", async broken => {
  const store = new ProjectStore(root);
  await store.appendTaskEvent(event);
  const file = path.join(root, "logs/tasks/task.jsonl");
  const content = JSON.stringify(event) + "\n" + JSON.stringify(broken) + "\n";
  await fs.writeFile(file, content);
  await expect(verifyTaskEventReadOnly(root, event)).rejects.toThrow("CORRUPT_EVENT_LOG");
  expect(await fs.readFile(file, "utf8")).toBe(content);
});

it("rejects blank rows and duplicated non-target IDs without repair", async () => {
  const store = new ProjectStore(root);
  await store.appendTaskEvent(event);
  const file = path.join(root, "logs/tasks/task.jsonl");
  const other = JSON.stringify({ ...event, id: "other" });
  for (const suffix of ["\n", other + "\n" + other + "\n"]) {
    const content = JSON.stringify(event) + "\n" + suffix;
    await fs.writeFile(file, content);
    await expect(verifyTaskEventReadOnly(root, event)).rejects.toThrow("CORRUPT_EVENT_LOG");
    expect(await fs.readFile(file, "utf8")).toBe(content);
  }
});

it("read-only verification rejects oversized logs without reading or changing contents", async () => {
  const store = new ProjectStore(root);
  await store.appendTaskEvent(event);
  const file = path.join(root, "logs/tasks/task.jsonl");
  await fs.truncate(file, 8 * 1024 * 1024 + 1);
  await expect(verifyTaskEventReadOnly(root, event)).rejects.toThrow("EVENT_LOG_LIMIT");
  expect((await fs.stat(file)).size).toBe(8 * 1024 * 1024 + 1);
});

it("read-only verification rejects conflicting events, invalid UTF-8 and truncated records", async () => {
  const store = new ProjectStore(root);
  await store.appendTaskEvent({ ...event, actor: "wrong" });
  await expect(verifyTaskEventReadOnly(root, event)).rejects.toThrow("EVENT_NOT_VERIFIED");
  const file = path.join(root, "logs/tasks/task.jsonl");
  for (const bytes of [Buffer.from([0xff, 0x0a]), Buffer.from(JSON.stringify(event))]) {
    await fs.writeFile(file, bytes);
    await expect(verifyTaskEventReadOnly(root, event)).rejects.toThrow();
    expect(await fs.readFile(file)).toEqual(bytes);
  }
});

it("retries directory durability after rename succeeded but sync failed", async () => {
  const open = fs.open.bind(fs);
  let directorySyncs = 0;
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === path.join(root, "logs/tasks")) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        directorySyncs++;
        if (directorySyncs === 1) throw new Error("directory sync failed");
        await sync();
      });
    }
    return handle;
  });
  const store = new ProjectStore(root);
  await expect(store.appendTaskEventOnce(event)).rejects.toThrow("directory sync failed");
  expect(await store.appendTaskEventOnce(event)).toBe("duplicate");
  expect(directorySyncs).toBe(2);
  expect(await store.getTaskEvents("task")).toEqual([event]);
});

it("normal and idempotent writers both respect an existing cross-store lock", async () => {
  const dir = path.join(root, "logs/tasks");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "task.jsonl.lock"), "operator-owned");
  await expect(new ProjectStore(root).appendTaskEvent(event)).rejects.toMatchObject({ code: "EEXIST" });
  await expect(new ProjectStore(root).appendTaskEventOnce(event)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await fs.readFile(path.join(dir, "task.jsonl.lock"), "utf8")).toBe("operator-owned");
});

it("deduplicates parsed event content independent of key order", async () => {
  const store = new ProjectStore(root);
  await store.appendTaskEvent(event);
  const reordered = Object.fromEntries(Object.entries(event).reverse()) as unknown as TaskEvent;
  expect(await new ProjectStore(root).appendTaskEventOnce(reordered)).toBe("duplicate");
  expect(await store.getTaskEvents("task")).toEqual([event]);
});

it("rejects invalid UTF-8 without changing the original log", async () => {
  const dir = path.join(root, "logs/tasks");
  await fs.mkdir(dir, { recursive: true });
  const bytes = Buffer.from([0xff, 0x0a]);
  const file = path.join(dir, "task.jsonl");
  await fs.writeFile(file, bytes);
  await expect(new ProjectStore(root).appendTaskEventOnce(event)).rejects.toThrow();
  expect(await fs.readFile(file)).toEqual(bytes);
});

function logAtBytes(size: number): string {
  const rows: string[] = [];
  let remaining = size;
  while (remaining) {
    const row = { ...event, id: `filler-${rows.length}`, details: "" };
    const empty = JSON.stringify(row) + "\n";
    const length = Math.min(200000, remaining);
    if (length < empty.length) throw new Error("fixture remainder too small");
    row.details = "x".repeat(length - empty.length);
    rows.push(JSON.stringify(row) + "\n");
    remaining -= length;
  }
  return rows.join("");
}

it("admits the exact journal byte limit, permits exact replay and rejects one more append without writes", async () => {
  const store = new ProjectStore(root);
  const file = path.join(root, "logs/tasks/task.jsonl");
  const line = JSON.stringify(event) + "\n";
  await fs.writeFile(file, logAtBytes(TASK_EVENT_LOG_MAX_BYTES - Buffer.byteLength(line)));
  expect(await store.appendTaskEventOnce(event)).toBe("written");
  expect((await fs.stat(file)).size).toBe(TASK_EVENT_LOG_MAX_BYTES);
  await verifyTaskEventReadOnly(root, event);
  const before = await fs.readFile(file);
  expect(await store.appendTaskEventOnce(event)).toBe("duplicate");
  await expect(store.appendTaskEventOnce({ ...event, id: "overflow" })).rejects.toThrow("EVENT_LOG_LIMIT");
  expect(await fs.readFile(file)).toEqual(before);
  expect((await fs.readdir(path.dirname(file))).filter(n => n.endsWith(".tmp") || n.endsWith(".lock"))).toEqual([]);
}, 120000);

it("rejects an already oversized journal before publishing a replacement", async () => {
  const store = new ProjectStore(root);
  const file = path.join(root, "logs/tasks/task.jsonl");
  await fs.writeFile(file, "");
  await fs.truncate(file, TASK_EVENT_LOG_MAX_BYTES + 1);
  await expect(store.appendTaskEventOnce(event)).rejects.toThrow("EVENT_LOG_LIMIT");
  expect((await fs.stat(file)).size).toBe(TASK_EVENT_LOG_MAX_BYTES + 1);
});

it("rejects an oversized new record without publishing a journal", async () => {
  const store = new ProjectStore(root);
  await expect(store.appendTaskEventOnce({ ...event, details: "x".repeat(262144) })).rejects.toThrow("CORRUPT_EVENT_LOG");
  expect(await fs.readdir(path.join(root, "logs/tasks"))).toEqual([]);
});

it("rejects an oversized existing record below the journal limit without appending", async () => {
  const store = new ProjectStore(root), file = path.join(root, "logs/tasks/task.jsonl");
  const content = JSON.stringify({ ...event, id: "old", details: "x".repeat(262144) }) + "\n";
  await fs.writeFile(file, content);
  await expect(store.appendTaskEventOnce(event)).rejects.toThrow("CORRUPT_EVENT_LOG");
  expect(await fs.readFile(file, "utf8")).toBe(content);
});

it.each(["blank","duplicate-key","invalid-schema"])("rejects existing %s rows before publication",async kind=>{
  const store = new ProjectStore(root), file = path.join(root,"logs/tasks/task.jsonl");
  const line=JSON.stringify({...event,id:"old"});
  const content=kind==="blank"?line+"\n\n":kind==="duplicate-key"?line.replace('"id":"old"','"id":"old","id":"old"')+"\n":JSON.stringify({id:"old",taskId:"task"})+"\n";
  await fs.writeFile(file,content);
  await expect(store.appendTaskEventOnce(event)).rejects.toThrow("CORRUPT_EVENT_LOG");
  expect(await fs.readFile(file,"utf8")).toBe(content);
});
