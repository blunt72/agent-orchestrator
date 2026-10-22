import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { inspectOrcaReviewSourceBytes } from "../../src/integrations/orca-review-source.js";
import { ORCA_EVIDENCE_MAX_BYTES } from "../../src/integrations/orca-evidence.js";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const fields = { reviewId: "11111111-1111-4111-8111-111111111111", taskId: "synthetic", digest: "a".repeat(64), generation: 1,
    workspaceHash: "b".repeat(64), testRunId: "22222222-2222-4222-8222-222222222222", testRunHash: "c".repeat(64) };
  const response = Buffer.from(JSON.stringify({ ...fields, verdict: "PASS" })), output = Buffer.from(" synthetic output\n\u4e2d\n");
  return { fields, response, output, expected: { ...fields, responseSha256: sha(response), testOutputSha256: sha(output), testOutputBytes: output.length } };
}
const inspect = (f = fixture()) => inspectOrcaReviewSourceBytes(f.response, f.output, JSON.stringify(f.expected));
describe("review and test source linkage (synthetic bytes, no authorization)", () => {
  it("matches original PASS response and normalized test output without source authority", () => {
    expect(inspect()).toMatchObject({ semanticMatch: true, sourceAuthenticated: false, canCompleteTask: false });
  });
  it.each(["reviewId", "taskId", "digest", "generation", "workspaceHash", "testRunId", "testRunHash"])("rejects mismatched response field %s with matching raw hash", key => {
    const f = fixture(); f.response = Buffer.from(JSON.stringify({ ...f.fields, [key]: key === "generation" ? 2 : "other", verdict: "PASS" })); f.expected.responseSha256 = sha(f.response);
    expect(() => inspect(f)).toThrow("ORCA_REVIEW_SOURCE_SEMANTICS_MISMATCH");
  });
  it.each(["REQUEST_CHANGES", "INVALIDATED", "pass"])("rejects non-PASS verdict %s", verdict => {
    const f = fixture(); f.response = Buffer.from(JSON.stringify({ ...f.fields, verdict })); f.expected.responseSha256 = sha(f.response);
    expect(() => inspect(f)).toThrow("ORCA_REVIEW_SOURCE_SEMANTICS_MISMATCH");
  });
  it("checks full original response bytes including inert metadata", () => {
    const f = fixture(); f.response = Buffer.concat([f.response, Buffer.from('\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-1|note=[inert]\n</citation_entries>\n<rollout_ids>\n</rollout_ids>\n</oai-mem-citation>')]);
    expect(() => inspect(f)).toThrow("ORCA_REVIEW_SOURCE_BYTES_MISMATCH");
    f.expected.responseSha256 = sha(f.response); expect(inspect(f).semanticMatch).toBe(true);
  });
  it("rejects output edits, truncation and wrong expected byte count", () => {
    for (const mode of ["edit", "truncate", "count"]) {
      const f = fixture(); if (mode === "edit") f.output[0] ^= 1;
      if (mode === "truncate") f.output = f.output.subarray(1);
      if (mode === "count") f.expected.testOutputBytes++;
      expect(() => inspect(f)).toThrow("ORCA_REVIEW_SOURCE_BYTES_MISMATCH");
    }
  });
  it("rejects invalid UTF-8, BOM, duplicate JSON keys and summary text", () => {
    const original = fixture();
    for (const bytes of [Buffer.from([0xff]), Buffer.concat([Buffer.from("\ufeff"), original.response]),
      Buffer.from(original.response.toString().replace('"verdict":"PASS"', '"verdict":"PASS","\\u0076erdict":"PASS"')),
      Buffer.from("review passed")]) {
      const f = fixture(); f.response = bytes; f.expected.responseSha256 = sha(bytes); expect(() => inspect(f)).toThrow("INVALID_ORCA_REVIEW_SOURCE");
    }
  });
  it("rejects extra response fields and missing identity", () => {
    for (const value of [{ ...fixture().fields, verdict: "PASS", extra: true }, { verdict: "PASS" }]) {
      const f = fixture(); f.response = Buffer.from(JSON.stringify(value)); f.expected.responseSha256 = sha(f.response);
      expect(() => inspect(f)).toThrow("ORCA_REVIEW_SOURCE_SEMANTICS_MISMATCH");
    }
  });
  it("rejects malformed expectations and duplicate escaped keys", () => {
    const f = fixture(), raw = JSON.stringify(f.expected);
    for (const value of [{ ...f.expected, extra: true }, { ...f.expected, reviewId: f.expected.reviewId + "\n" },
      { ...f.expected, testRunId: "agent" }, { ...f.expected, generation: 0 }, { ...f.expected, testOutputBytes: -1 },
      { ...f.expected, responseSha256: "A".repeat(64) }, { ...f.expected, taskId: "task\n" }, {}])
      expect(() => inspectOrcaReviewSourceBytes(f.response, f.output, JSON.stringify(value))).toThrow("INVALID_ORCA_REVIEW_SOURCE");
    expect(() => inspectOrcaReviewSourceBytes(f.response, f.output, raw.replace('"generation":1', '"generation":1,"\\u0067eneration":1'))).toThrow("INVALID_ORCA_REVIEW_SOURCE");
  });
  it("accepts empty/exact-limit output and exact response/expectation limits, rejects one over", () => {
    for (const output of [Buffer.alloc(0), Buffer.alloc(ORCA_EVIDENCE_MAX_BYTES)]) {
      const f = fixture(); f.output = output; f.expected.testOutputBytes = output.length; f.expected.testOutputSha256 = sha(output);
      expect(inspect(f).semanticMatch).toBe(true);
    }
    const f = fixture(); f.response = Buffer.concat([f.response, Buffer.alloc(262144 - f.response.length, 32)]); f.expected.responseSha256 = sha(f.response);
    const raw = JSON.stringify(f.expected), exact = raw + " ".repeat(32768 - Buffer.byteLength(raw));
    expect(inspectOrcaReviewSourceBytes(f.response, f.output, exact).semanticMatch).toBe(true);
    expect(() => inspectOrcaReviewSourceBytes(f.response, f.output, exact + " ")).toThrow("INVALID_ORCA_REVIEW_SOURCE");
    f.response = Buffer.concat([f.response, Buffer.from(" ")]); expect(() => inspect(f)).toThrow("INVALID_ORCA_REVIEW_SOURCE");
    expect(() => inspectOrcaReviewSourceBytes(fixture().response, Buffer.alloc(ORCA_EVIDENCE_MAX_BYTES + 1), raw)).toThrow("INVALID_ORCA_REVIEW_SOURCE");
  });
});
