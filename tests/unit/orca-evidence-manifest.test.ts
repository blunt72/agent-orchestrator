import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { OrcaEvidenceStore } from "../../src/integrations/orca-evidence.js";
import { ORCA_MANIFEST_ROLES, parseOrcaCompletionBinding, inspectOrcaEvidenceManifest } from "../../src/integrations/orca-evidence-manifest.js";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const binding = () => ({ agenthubTaskId: "synthetic", projectId: "project", revision: "2", generation: 1,
  runtimeId: "runtime", hostId: "local", runId: "run", taskId: "orca-task", dispatchId: "dispatch", workspaceId: "workspace",
  workspacePath: "/synthetic/repo", terminalHandle: "terminal", developer: "gemini", reviewer: "codex", provider: "antigravity", ownerId: "gemini", claimId: null });
// Independent test oracle: JSON replacer uses a known sorted union of schema keys.
const canonical = (value: any) => JSON.stringify(value, ["agenthubTaskId", "bindingDigest", "bytes", "capturedAt", "claimId", "developer", "dispatchId", "entries", "evidence", "generation", "hostId", "mediaType", "ownerId", "projectId", "provider", "reviewer", "revision", "role", "runId", "runtimeId", "schemaVersion", "sha256", "source", "sourceReceipt", "taskId", "terminalHandle", "version", "workspaceId", "workspacePath"]);
let root: string, store: OrcaEvidenceStore, manifest: any;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orca-manifest-")));
  store = new OrcaEvidenceStore(root);
  const entries = [];
  for (const role of ORCA_MANIFEST_ROLES) entries.push({ role, source: "LOCAL_ORIGINAL_BYTES_UNAUTHENTICATED", mediaType: "text/plain", schemaVersion: 1,
    taskId: "synthetic", dispatchId: "dispatch", runId: "run", capturedAt: "2026-10-12T00:00:00.000Z", sourceReceipt: `synthetic:${role}`,
    evidence: await store.put(Buffer.from(`synthetic only: ${role}\n\u4e2d`)) });
  manifest = { version: 1, bindingDigest: sha(canonical(binding())), entries };
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const inspect = (value = manifest, rawBinding = JSON.stringify(binding()), digest = sha(canonical(value)), reader = { readOrcaEvidence: (ref: any) => store.read(ref) }) =>
  inspectOrcaEvidenceManifest(reader, JSON.stringify(value), rawBinding, digest);
describe("manifest integrity (synthetic source bytes, actual local storage; NOT authority)", () => {
  it("matches independent binding encoding and verifies all seven original byte references", async () => {
    expect(parseOrcaCompletionBinding(JSON.stringify(binding())).canonical).toBe(canonical(binding()));
    expect(parseOrcaCompletionBinding(JSON.stringify(binding())).digest).toBe(sha(canonical(binding())));
    const result = await inspect();
    expect(result).toMatchObject({ byteIntegrityVerified: true, sourceAuthenticated: false, canCompleteTask: false });
    expect(result.canonical).toBe(canonical(manifest));
    expect(result.digest).toBe(sha(canonical(manifest)));
  });
  it("rejects missing or corrupt original bytes, never substitutes their hashes", async () => {
    const file = path.join(root, "data/orca-evidence-v1", manifest.entries[0].evidence.sha256);
    await fs.writeFile(file, "corruption"); await expect(inspect()).rejects.toThrow();
    await fs.unlink(file); await expect(inspect()).rejects.toThrow();
  });
  it("rejects symlink substitution and mismatched bytes from a reader", async () => {
    const file = path.join(root, "data/orca-evidence-v1", manifest.entries[0].evidence.sha256);
    await fs.unlink(file); await fs.symlink(path.join(root, "outside"), file);
    await expect(inspect()).rejects.toThrow();
    await expect(inspect(manifest, JSON.stringify(binding()), sha(canonical(manifest)), { readOrcaEvidence: async () => Buffer.from("wrong") })).rejects.toThrow("INVALID_ORCA_MANIFEST");
  });
  it.each(["taskId", "dispatchId", "runId", "source", "role", "schemaVersion", "mediaType", "capturedAt", "sourceReceipt"])("rejects entry mismatch %s before reading", async key => {
    manifest.entries[0][key] = key === "sourceReceipt" ? "invalid\nlabel" : "wrong";
    const read = vi.fn(); await expect(inspect(manifest, JSON.stringify(binding()), sha(canonical(manifest)), { readOrcaEvidence: read })).rejects.toThrow("INVALID_ORCA_MANIFEST");
    expect(read).not.toHaveBeenCalled();
  });
  it("treats a valid source label as unverified metadata, not authority", async () => {
    const old = sha(canonical(manifest));
    manifest.entries[0].sourceReceipt = "different-valid-label";
    const result = await inspect();
    expect(result.digest).not.toBe(old);
    expect(result.sourceAuthenticated).toBe(false);
    expect(result.canCompleteTask).toBe(false);
  });
  it("permits empty test output but no other empty source role", async () => {
    const empty = await store.put(Buffer.alloc(0));
    manifest.entries.find((e: any) => e.role === "test_output").evidence = empty;
    expect((await inspect()).byteIntegrityVerified).toBe(true);
    for (const role of ORCA_MANIFEST_ROLES.filter(role => role !== "test_output")) {
      const copy = structuredClone(manifest); copy.entries.find((e: any) => e.role === role).evidence = empty;
      await expect(inspect(copy)).rejects.toThrow("INVALID_ORCA_MANIFEST");
    }
  });
  it("does not let a custom reader alter the expected byte reference", async () => {
    await expect(inspect(manifest, JSON.stringify(binding()), sha(canonical(manifest)), {
      readOrcaEvidence: async ref => {
        const bytes = Buffer.from("substitute"); ref.bytes = bytes.length; ref.sha256 = sha(bytes); return bytes;
      },
    })).rejects.toThrow("INVALID_ORCA_MANIFEST");
  });
  it("rejects missing/duplicate/reordered roles, empty artifacts and extra keys", async () => {
    for (const mutate of [(m: any) => m.entries.pop(), (m: any) => m.entries[1] = m.entries[0],
      (m: any) => m.entries.reverse(), (m: any) => m.extra = true, (m: any) => m.entries[0].extra = true,
      (m: any) => m.entries[0].evidence.extra = true, (m: any) => m.entries[0].evidence.bytes = 0,
      (m: any) => m.entries[0].evidence.sha256 += "\n"]) {
      const copy = structuredClone(manifest); mutate(copy); await expect(inspect(copy)).rejects.toThrow("INVALID_ORCA_MANIFEST");
    }
  });
  it("rejects stale manifest or binding digest before reading", async () => {
    const read = vi.fn();
    await expect(inspect(manifest, JSON.stringify(binding()), "a".repeat(64), { readOrcaEvidence: read })).rejects.toThrow("STALE_ORCA_MANIFEST");
    await expect(inspect(manifest, JSON.stringify({ ...binding(), runId: "changed" }), sha(canonical(manifest)), { readOrcaEvidence: read })).rejects.toThrow("INVALID_ORCA_MANIFEST");
    expect(read).not.toHaveBeenCalled();
  });
  it("binds each valid binding field change to a different digest", () => {
    const original = binding(); const digest = parseOrcaCompletionBinding(JSON.stringify(original)).digest;
    for (const key of Object.keys(original)) {
      if (["developer", "reviewer", "provider", "ownerId"].includes(key)) continue;
      const old = (original as any)[key];
      const next = key === "revision" ? "3" : key === "generation" ? 2 : key === "claimId" ? "claim" : old + "-other";
      expect(parseOrcaCompletionBinding(JSON.stringify({ ...original, [key]: next })).digest, key).not.toBe(digest);
    }
    expect(parseOrcaCompletionBinding(JSON.stringify({ ...original, developer: "codex", reviewer: "gemini", ownerId: "codex", provider: "codex" })).digest).not.toBe(digest);
  });
  it("rejects malformed binding schema, revision and JSON ambiguity", () => {
    for (const patch of [{ extra: true }, { revision: "02" }, { revision: "2\n" }, { revision: "9007199254740992" }, { generation: 0 }, { reviewer: "gemini" }])
      expect(() => parseOrcaCompletionBinding(JSON.stringify({ ...binding(), ...patch }))).toThrow("INVALID_ORCA_MANIFEST");
    const raw = JSON.stringify(binding());
    for (const bad of [raw.replace('"revision":"2"', '"revision":"2","\\u0072evision":"2"'), raw + "{}", "[]", " ".repeat(32769) + raw])
      expect(() => parseOrcaCompletionBinding(bad)).toThrow("INVALID_ORCA_MANIFEST");
  });
  it("rejects manifest raw ambiguity and exact byte overflow", async () => {
    const raw = JSON.stringify(manifest), b = JSON.stringify(binding()), digest = sha(canonical(manifest));
    const exact = raw + " ".repeat(32768 - Buffer.byteLength(raw, "utf8"));
    expect((await inspectOrcaEvidenceManifest({ readOrcaEvidence: ref => store.read(ref) }, exact, b, digest)).canCompleteTask).toBe(false);
    for (const bad of [exact + " ", raw + "{}", raw.replace('"version":1', '"version":1,"version":1'),
      raw.replace('"runId":"run"', '"runId":"run","\\u0072unId":"run"')])
      await expect(inspectOrcaEvidenceManifest({ readOrcaEvidence: ref => store.read(ref) }, bad, b, digest)).rejects.toThrow("INVALID_ORCA_MANIFEST");
  });
});
