import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it } from "vitest";
import { OrcaReadOnlyStore } from "../../src/integrations/orca-read-only-store.js";
let root: string;
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orca-read-only-"))); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it("construction and missing task reads create nothing", async () => {
  const store = new OrcaReadOnlyStore(root); expect(await store.getTask("missing")).toBeNull(); expect(await fs.readdir(root)).toEqual([]);
  expect(store).not.toHaveProperty("saveTask"); expect(store).not.toHaveProperty("putOrcaEvidence");
});
it("missing evidence and event reads do not initialize storage", async () => {
  const store = new OrcaReadOnlyStore(root);
  await expect(store.readOrcaEvidence({ version: 1, sha256: "a".repeat(64), bytes: 1 })).rejects.toThrow();
  await expect(store.verifyTaskEventReadOnly({ id: "event", taskId: "task", timestamp: "2026-10-12T00:00:00.000Z", type: "STATUS_CHANGED", actor: "test", details: {} })).rejects.toThrow();
  expect(await fs.readdir(root)).toEqual([]);
});
it("reads existing task without actor/log initialization or task modification", async () => {
  await fs.mkdir(path.join(root, "data/tasks"), { recursive: true });
  const file = path.join(root, "data/tasks/task.json"), bytes = Buffer.from('{"id":"task","revision":10,"status":"REVIEW"}');
  await fs.writeFile(file, bytes); const store = new OrcaReadOnlyStore(root);
  expect(await store.getTask("task")).toMatchObject({ revision: 10, status: "REVIEW" });
  expect(await fs.readdir(root)).toEqual(["data"]); expect(await fs.readdir(path.join(root, "data"))).toEqual(["tasks"]);
  expect(await fs.readFile(file)).toEqual(bytes);
});
