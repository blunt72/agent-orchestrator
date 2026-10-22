import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { parseOrcaCompletionApproval, type OrcaCompletionApproval } from "../../src/integrations/orca-completion-approval.js";

const operator = { namespace: "agenthub-local-operator-v1" as const, subject: "11111111-1111-4111-8111-111111111111" };
const fixture = (): OrcaCompletionApproval => ({
  version: 1, purpose: "SCOPED_ORCA_PILOT_COMPLETION", approvalId: "22222222-2222-4222-8222-222222222222",
  approvedAt: "2026-10-12T00:00:00.000Z", operator: { ...operator }, taskId: "synthetic", projectId: "project",
  dispatchId: "dispatch", runId: "run", runtimeId: "runtime", orcaTaskId: "orca-task", ownerId: "gemini", reviewerId: "codex",
  claimId: null, expectedRevision: 10, generation: 1, bindingDigest: "a".repeat(64), deliveryDigest: "b".repeat(64),
  testReceiptDigest: "c".repeat(64), reviewReceiptDigest: "d".repeat(64), workspaceDigest: "e".repeat(64),
  baselineDigest: "f".repeat(64), manifestDigest: "0".repeat(64), allowedFiles: ["test/a.ts", "test/b.ts"],
});
const parse = (value: unknown) => parseOrcaCompletionApproval(JSON.stringify(value), [operator]);
describe("completion approval schema (synthetic identity only; no operational authorization)", () => {
  it("canonicalizes nested keys without granting completion authority", () => {
    const value = fixture();
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    reordered.operator = { subject: operator.subject, namespace: operator.namespace };
    expect(parse(reordered)).toEqual(parse(value));
    expect(parse(value).canCompleteTask).toBe(false);
  });
  it("requires an exactly enrolled operator, without alias normalization", () => {
    expect(() => parseOrcaCompletionApproval(JSON.stringify(fixture()), [])).toThrow("UNREGISTERED_OPERATOR");
    for (const subject of [operator.subject + " ", "ABCDEFAB-1111-4111-8111-111111111111", "agent-gemini"]) {
      expect(() => parse({ ...fixture(), operator: { ...operator, subject } })).toThrow("INVALID_COMPLETION_APPROVAL");
    }
    expect(() => parse({ ...fixture(), operator: { ...operator, extra: true } })).toThrow("INVALID_COMPLETION_APPROVAL");
  });
  it.each([
    { extra: true }, { version: 2 }, { purpose: "DONE" }, { approvalId: "alias" }, { approvedAt: "2026-02-30T00:00:00.000Z" },
    { approvedAt: "2026-10-12" }, { expectedRevision: 0 }, { expectedRevision: Number.MAX_SAFE_INTEGER }, { generation: 1.5 },
    { claimId: " ../escape" }, { reviewerId: "gemini" }, { ownerId: "HUMAN" }, { taskId: "task\n" },
    { manifestDigest: "A".repeat(64) }, { allowedFiles: [] }, { allowedFiles: ["b.ts", "a.ts"] },
    { approvalId: "22222222-2222-4222-8222-222222222222\n" }, { manifestDigest: "a".repeat(64) + "\n" },
    { allowedFiles: ["a.ts", "a.ts"] }, { allowedFiles: ["../escape"] }, { allowedFiles: ["a\\b"] },
    { allowedFiles: [".git/config"] }, { allowedFiles: ["a\nb"] }, { allowedFiles: Array(257).fill("a.ts") },
  ])("rejects malformed approval %j", patch => {
    expect(() => parse({ ...fixture(), ...patch })).toThrow("INVALID_COMPLETION_APPROVAL");
  });
  it("rejects missing keys, duplicate JSON keys and oversized input", () => {
    const value: any = fixture(); delete value.baselineDigest;
    expect(() => parse(value)).toThrow("INVALID_COMPLETION_APPROVAL");
    const raw = JSON.stringify(fixture());
    expect(() => parseOrcaCompletionApproval(raw.replace('"version":1', '"version":1,"version":1'), [operator])).toThrow("INVALID_COMPLETION_APPROVAL");
    expect(() => parseOrcaCompletionApproval(" ".repeat(32769) + raw, [operator])).toThrow("INVALID_COMPLETION_APPROVAL");
  });
  it("binds every semantic field to the digest, preserving Unicode literally", () => {
    const first = parse(fixture());
    for (const patch of [{ generation: 2 }, { claimId: "claim" }, { allowedFiles: ["test/c.ts"] },
      { manifestDigest: "1".repeat(64) }, { operator: { ...operator, subject: "33333333-3333-4333-8333-333333333333" } }]) {
      const value = { ...fixture(), ...patch };
      expect(parseOrcaCompletionApproval(JSON.stringify(value), [value.operator]).digest).not.toBe(first.digest);
    }
    expect(parse({ ...fixture(), allowedFiles: ["\u00e9.ts"] }).digest)
      .not.toBe(parse({ ...fixture(), allowedFiles: ["e\u0301.ts"] }).digest);
  });
  it("matches an independently ordered canonical encoding and UTF-8 SHA256", () => {
    const v = fixture();
    const expected = JSON.stringify({ allowedFiles: v.allowedFiles, approvalId: v.approvalId, approvedAt: v.approvedAt,
      baselineDigest: v.baselineDigest, bindingDigest: v.bindingDigest, claimId: null, deliveryDigest: v.deliveryDigest,
      dispatchId: v.dispatchId, expectedRevision: 10, generation: 1, manifestDigest: v.manifestDigest,
      operator: { namespace: operator.namespace, subject: operator.subject }, orcaTaskId: v.orcaTaskId, ownerId: "gemini", projectId: "project",
      purpose: v.purpose, reviewReceiptDigest: v.reviewReceiptDigest, reviewerId: "codex", runId: "run", runtimeId: "runtime",
      taskId: "synthetic", testReceiptDigest: v.testReceiptDigest, version: 1, workspaceDigest: v.workspaceDigest });
    expect(parse(v).canonical).toBe(expected);
    expect(parse(v).digest).toBe(createHash("sha256").update(expected, "utf8").digest("hex"));
    const swapped = expected.replace('"ownerId":"gemini"', '"ownerId":"codex"').replace('"reviewerId":"codex"', '"reviewerId":"gemini"');
    expect(parse({ ...v, ownerId: "codex", reviewerId: "gemini" }).canonical).toBe(swapped);
    expect(parse({ ...v, ownerId: "codex", reviewerId: "gemini" }).digest).toBe(createHash("sha256").update(swapped, "utf8").digest("hex"));
    expect(parse({ ...v, allowedFiles: ["a.ts", "\u00e9.ts"] }).canonical).toContain('["a.ts","\u00e9.ts"]');
  });
  it("binds each mutable semantic field separately", () => {
    const original = fixture();
    for (const key of Object.keys(original) as (keyof OrcaCompletionApproval)[]) {
      if (["version", "purpose", "operator", "ownerId", "reviewerId"].includes(key)) continue;
      const old = original[key];
      const next = key === "approvalId" ? "44444444-4444-4444-8444-444444444444" :
        key === "approvedAt" ? "2026-10-13T00:00:00.000Z" : key === "allowedFiles" ? ["other.ts"] :
        key === "claimId" ? "claim" : typeof old === "number" ? old + 1 : key.endsWith("Digest") ? "9".repeat(64) : String(old) + "-other";
      expect(parse({ ...original, [key]: next }).digest, key).not.toBe(parse(original).digest);
    }
    expect(parse({ ...original, ownerId: "codex", reviewerId: "gemini" }).digest).not.toBe(parse(original).digest);
  });
  it("rejects ambiguous or non-JSON raw input at every object depth", () => {
    const raw = JSON.stringify(fixture());
    for (const bad of [raw.replace('"subject":', `"subject":"${operator.subject}","subject":`),
      raw.replace('"subject":', `"\\u0073ubject":"${operator.subject}","subject":`),
      raw.replace('"version":1', '"version":1,"\\u0076ersion":1'), raw + "{}", raw + " trailing",
      "/*comment*/" + raw, raw.replace('"version":1,', '"version":1,,'), raw.slice(0, -1) + ",}",
      "{", "null", "[]", "true", '"string"']) {
      expect(() => parseOrcaCompletionApproval(bad, [operator])).toThrow("INVALID_COMPLETION_APPROVAL");
    }
  });
  it("requires exact identity shape and strict UUID version, variant and whitespace", () => {
    const unknown = { ...operator, subject: "55555555-5555-4555-8555-555555555555" };
    expect(() => parse({ ...fixture(), operator: unknown })).toThrow("UNREGISTERED_OPERATOR");
    for (const subject of [" " + operator.subject, operator.subject + "\n", operator.subject.replace("4111", "5111"),
      operator.subject.replace("8111", "7111")]) {
      expect(() => parse({ ...fixture(), operator: { ...operator, subject } })).toThrow("INVALID_COMPLETION_APPROVAL");
      expect(() => parse({ ...fixture(), approvalId: subject })).toThrow("INVALID_COMPLETION_APPROVAL");
    }
    for (const identity of [{ subject: operator.subject }, { namespace: "other", subject: operator.subject },
      { namespace: operator.namespace }, { ...operator, extra: "x" }])
      expect(() => parse({ ...fixture(), operator: identity })).toThrow("INVALID_COMPLETION_APPROVAL");
  });
  it("checks exact UTF-8, identifier, file and integer boundaries", () => {
    const value = { ...fixture(), allowedFiles: ["\u00e9".repeat(100) + ".ts"] };
    const raw = JSON.stringify(value);
    const exact = raw + " ".repeat(32768 - Buffer.byteLength(raw, "utf8"));
    expect(parseOrcaCompletionApproval(exact, [operator]).approval).toEqual(value);
    expect(() => parseOrcaCompletionApproval(exact + " ", [operator])).toThrow("INVALID_COMPLETION_APPROVAL");
    expect(parse({ ...fixture(), taskId: "a".repeat(128) }).approval.taskId).toHaveLength(128);
    expect(() => parse({ ...fixture(), taskId: "a".repeat(129) })).toThrow("INVALID_COMPLETION_APPROVAL");
    expect(parse({ ...fixture(), allowedFiles: ["a".repeat(4096)] }).approval.allowedFiles[0]).toHaveLength(4096);
    expect(() => parse({ ...fixture(), allowedFiles: ["a".repeat(4097)] })).toThrow("INVALID_COMPLETION_APPROVAL");
    const files = Array.from({ length: 256 }, (_, i) => `f${String(i).padStart(3, "0")}.ts`);
    expect(parse({ ...fixture(), allowedFiles: files }).approval.allowedFiles).toHaveLength(256);
    expect(() => parse({ ...fixture(), allowedFiles: [...files, "last.ts"] })).toThrow("INVALID_COMPLETION_APPROVAL");
    expect(parse({ ...fixture(), expectedRevision: Number.MAX_SAFE_INTEGER - 1, generation: Number.MAX_SAFE_INTEGER }).canCompleteTask).toBe(false);
    expect(() => parse({ ...fixture(), generation: Number.MAX_SAFE_INTEGER + 1 })).toThrow("INVALID_COMPLETION_APPROVAL");
  });
});
