import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { parseOrcaLimitedApproval } from "../../src/integrations/orca-limited-approval.js";
const operator = { namespace: "agenthub-local-operator-v1" as const, subject: "11111111-1111-4111-8111-111111111111" };
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const fixture = () => {
  const decision = { version: 1, purpose: "LIMITED_LOCAL_PILOT_STANDARD_DECISION", decisionId: "22222222-2222-4222-8222-222222222222",
    recordedAt: "2026-10-12T00:00:00.000Z", operator: { ...operator }, taskId: "task", projectId: "project", generation: 1,
    bindingDigest: "a".repeat(64), historicalGap: "EXECUTION_PERMISSION_NOT_STRUCTURALLY_DIGEST_BOUND", userStatement: "保留历史缺口",
    completionApproved: false, sourceAuthenticated: false };
  const completion = { version: 1, purpose: "SCOPED_ORCA_PILOT_COMPLETION", approvalId: "33333333-3333-4333-8333-333333333333",
    approvedAt: "2026-10-12T00:01:00.000Z", operator: { ...operator }, taskId: "task", projectId: "project", generation: 1,
    bindingDigest: "a".repeat(64), expectedRevision: 10, dispatchId: "dispatch", runId: "run", runtimeId: "runtime",
    orcaTaskId: "orca-task", ownerId: "gemini", reviewerId: "codex", claimId: null, deliveryDigest: "b".repeat(64),
    testReceiptDigest: "c".repeat(64), reviewReceiptDigest: "d".repeat(64), workspaceDigest: "e".repeat(64),
    baselineDigest: "f".repeat(64), manifestDigest: "0".repeat(64), allowedFiles: ["test.ts"] };
  return { decision, value: { version: 1, purpose: "LIMITED_LOCAL_HUMAN_PILOT_COMPLETION", decisionDigest: sha(JSON.stringify(decision)),
    historicalGap: decision.historicalGap, completion } };
};
const parse = (f = fixture()) => parseOrcaLimitedApproval(JSON.stringify(f.value), JSON.stringify(f.decision), sha(JSON.stringify(f.decision)), [operator]);
it("binds the retained gap and human decision without claiming issuance or granting completion (synthetic)", () => {
  expect(parse()).toMatchObject({ historicalGap: "EXECUTION_PERMISSION_NOT_STRUCTURALLY_DIGEST_BOUND", humanIssuanceVerified: false,
    sourceAuthenticated: false, canCompleteTask: false });
});
it("rejects the standard decision used alone as an approval", () => {
  const f = fixture(), raw = JSON.stringify(f.decision);
  expect(() => parseOrcaLimitedApproval(raw, raw, sha(raw), [operator])).toThrow("INVALID_LIMITED_LOCAL_APPROVAL");
});
it.each(["taskId", "projectId", "generation", "bindingDigest", "operator"])("rejects decision/approval scope mismatch %s", key => {
  const f = fixture(); (f.decision as any)[key] = key === "generation" ? 2 : key === "operator" ? { ...operator, subject: "44444444-4444-4444-8444-444444444444" } : "other";
  f.value.decisionDigest = sha(JSON.stringify(f.decision)); expect(() => parse(f)).toThrow("INVALID_LIMITED_LOCAL_APPROVAL");
});
it.each(["completionApproved", "sourceAuthenticated", "historicalGap", "purpose", "userStatement", "extra"])("rejects invalid decision %s", key => {
  const f = fixture(); (f.decision as any)[key] = key === "completionApproved" || key === "sourceAuthenticated" ? true : "other";
  f.value.decisionDigest = sha(JSON.stringify(f.decision)); expect(() => parse(f)).toThrow("INVALID_LIMITED_LOCAL_APPROVAL");
});
it.each(["historicalGap", "purpose", "decisionDigest", "extra"])("rejects invalid wrapper %s", key => {
  const f = fixture(); (f.value as any)[key] = "other"; expect(() => parse(f)).toThrow("INVALID_LIMITED_LOCAL_APPROVAL");
});
it("rejects completion approval preceding the standard decision", () => {
  const f = fixture(); f.value.completion.approvedAt = "2026-10-11T23:59:59.999Z"; expect(() => parse(f)).toThrow("INVALID_LIMITED_LOCAL_APPROVAL");
});
it("rejects unknown identity and invalid nested approval", () => {
  const f = fixture(), raw = JSON.stringify(f.decision);
  expect(() => parseOrcaLimitedApproval(JSON.stringify(f.value), raw, sha(raw), [])).toThrow("UNREGISTERED_OPERATOR");
  f.value.completion.reviewerId = "gemini"; expect(() => parse(f)).toThrow("INVALID_COMPLETION_APPROVAL");
});
it("rejects duplicate keys, oversize and changed exact decision bytes", () => {
  const f = fixture(), raw = JSON.stringify(f.decision), value = JSON.stringify(f.value);
  expect(() => parseOrcaLimitedApproval(value.replace('"version":1', '"version":1,"version":1'), raw, sha(raw), [operator])).toThrow();
  expect(() => parseOrcaLimitedApproval(value, raw + "\n", sha(raw), [operator])).toThrow();
  expect(() => parseOrcaLimitedApproval(" ".repeat(32769), raw, sha(raw), [operator])).toThrow();
  expect(() => parseOrcaLimitedApproval(value, " ".repeat(32769), sha(raw), [operator])).toThrow();
});
it("canonicalizes the wrapper without normalizing the decision byte pin", () => {
  const f = fixture(), first = parse(f), raw = JSON.stringify(f.decision);
  expect(parseOrcaLimitedApproval(JSON.stringify(Object.fromEntries(Object.entries(f.value).reverse())), raw, sha(raw), [operator])).toEqual(first);
  const changed = raw + "\n"; f.value.decisionDigest = sha(changed);
  expect(parseOrcaLimitedApproval(JSON.stringify(f.value), changed, sha(changed), [operator]).digest).not.toBe(first.digest);
  expect(first.digest).toBe(sha(first.canonical));
});
