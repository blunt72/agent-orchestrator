import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readOrcaLocalEnrollment, readOrcaTaskEnrollment } from "../../src/integrations/orca-local-enrollment.js";

let root: string;
let sessions: string;
let filename: string;
const scope = { taskId: "task", projectId: "project", generation: 1, bindingDigest: "a".repeat(64) };
let value: Record<string, unknown>;
const write = () => fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
const read = () => readOrcaLocalEnrollment(root, sessions, scope);
it("keeps task-scoped and legacy records independent without fallback", () => {
  expect(()=>readOrcaTaskEnrollment(root,sessions,scope)).toThrow();
  const original=fs.readFileSync(filename);
  const taskFile=path.join(path.dirname(filename),"task.enrollment.json");
  fs.writeFileSync(taskFile,original,{mode:0o600});
  expect(readOrcaTaskEnrollment(root,sessions,scope).digest).toBe(read().digest);
  expect(fs.readFileSync(filename)).toEqual(original);
  fs.writeFileSync(taskFile,"invalid");
  expect(()=>readOrcaTaskEnrollment(root,sessions,scope)).toThrow();
  expect(read().digest).toBe(createHash("sha256").update(original).digest("hex"));
});
it.each(["../task","/task","task\n",""])("rejects unsafe task enrollment path %j",taskId=>{
  expect(()=>readOrcaTaskEnrollment(root,sessions,{...scope,taskId})).toThrow();
});
it("applies original private-file and symlink checks to task-scoped enrollment",()=>{
  const taskFile=path.join(path.dirname(filename),"task.enrollment.json");
  fs.symlinkSync(filename,taskFile);
  expect(()=>readOrcaTaskEnrollment(root,sessions,scope)).toThrow();
  fs.unlinkSync(taskFile);fs.copyFileSync(filename,taskFile);fs.chmodSync(taskFile,0o644);
  expect(()=>readOrcaTaskEnrollment(root,sessions,scope)).toThrow();
});
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-enrollment-")));
  sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions);
  fs.mkdirSync(path.join(root, "data", "orca-trust-v1"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, "data", "orca-evidence-v1"));
  filename = path.join(root, "data", "orca-trust-v1", "enrollment.json");
  value = { version: 1, purpose: "LOCAL_HUMAN_SUPERVISED_PILOT_ENROLLMENT", registeredAt: "2026-10-12T13:20:21.211Z",
    operator: { namespace: "agenthub-local-operator-v1", subject: "aaaaaaaa-0000-4000-8000-000000000005" }, scope,
    evidenceRoots: [sessions, path.join(root, "data", "orca-evidence-v1")], authorizationBasis: "synthetic test only",
    sourceAuthenticated: false, canCompleteTask: false };
  write();
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it("reads a scoped local record without granting completion or source authentication", () => {
  expect(read()).toMatchObject({ sourceAuthenticated: false, canCompleteTask: false, scope: "LOCAL_ENROLLMENT_RECORD_ONLY" });
  expect(read().operator).toEqual(value.operator);
  expect(read().digest).toBe(createHash("sha256").update(fs.readFileSync(filename)).digest("hex"));
});
it.each(["canCompleteTask", "sourceAuthenticated"])("rejects elevated %s", key => {
  value[key] = true; write(); expect(read).toThrow();
});
it("rejects a different binding", () => {
  expect(() => readOrcaLocalEnrollment(root, sessions, { ...scope, bindingDigest: "b".repeat(64) })).toThrow();
});
it("rejects broader roots", () => { value.evidenceRoots = [root]; write(); expect(read).toThrow(); });
it("rejects unknown keys", () => { value.extra = true; write(); expect(read).toThrow(); });
it("rejects duplicate JSON keys", () => {
  fs.writeFileSync(filename, JSON.stringify(value).replace('"version":1', '"version":1,"version":1'));
  expect(read).toThrow();
});
it("rejects public file permissions", () => { fs.chmodSync(filename, 0o644); expect(read).toThrow(); });
it("rejects public registry permissions", () => { fs.chmodSync(path.dirname(filename), 0o755); expect(read).toThrow(); });
it("rejects file hardlinks", () => { fs.linkSync(filename, path.join(root, "alias")); expect(read).toThrow(); });
it("rejects file symlinks", () => {
  fs.renameSync(filename, path.join(root, "original")); fs.symlinkSync(path.join(root, "original"), filename); expect(read).toThrow();
});
it("rejects oversize records", () => { fs.writeFileSync(filename, " ".repeat(16385)); expect(read).toThrow(); });
it("rejects malformed UTF-8", () => { fs.writeFileSync(filename, Buffer.from([0xff])); expect(read).toThrow(); });
it("rejects an unrecognized operator namespace", () => {
  value.operator = { namespace: "google", subject: "aaaaaaaa-0000-4000-8000-000000000005" }; write(); expect(read).toThrow();
});
it.each(["taskId", "projectId", "generation", "bindingDigest"])("rejects scope mismatch %s", key => {
  const changed = { ...scope, [key]: key === "generation" ? 2 : "different" };
  expect(() => readOrcaLocalEnrollment(root, sessions, changed)).toThrow();
});
it.each([0, -1, 1.5, "1", null])("rejects invalid generation %s", generation => {
  value.scope = { ...scope, generation }; write(); expect(read).toThrow();
});
it.each(["bad", "a".repeat(64) + "\n"])("rejects invalid digest %s", bindingDigest => {
  value.scope = { ...scope, bindingDigest }; write(); expect(read).toThrow();
});
it("rejects invalid UUID", () => {
  value.operator = { namespace: "agenthub-local-operator-v1", subject: "not-a-uuid" }; write(); expect(read).toThrow();
});
it.each(["operator", "scope"])("rejects nested unknown keys in %s", key => {
  value[key] = { ...(value[key] as object), extra: true }; write(); expect(read).toThrow();
});
it.each(["operator", "scope", "registeredAt", "evidenceRoots"])("rejects missing %s", key => {
  delete value[key]; write(); expect(read).toThrow();
});
it("rejects reversed roots", () => { (value.evidenceRoots as string[]).reverse(); write(); expect(read).toThrow(); });
it("rejects sessions symlink", () => {
  fs.renameSync(sessions, sessions + "-original"); fs.symlinkSync(sessions + "-original", sessions); expect(read).toThrow();
});
it.each(["permissions", "sessions", "evidence", "file"])("rejects read-time mutation: %s", kind => {
  const original = fs.readSync;
  let mutated = false;
  vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const result = Reflect.apply(original, fs, args);
    if (!mutated) {
      mutated = true;
      if (kind === "permissions") fs.chmodSync(path.dirname(filename), 0o755);
      else if (kind === "file") fs.chmodSync(filename, 0o644);
      else {
        const name = kind === "sessions" ? sessions : path.join(root, "data", "orca-evidence-v1");
        fs.renameSync(name, name + "-original"); fs.symlinkSync(name + "-original", name);
      }
    }
    return result;
  }) as typeof fs.readSync);
  expect(read).toThrow();
});
