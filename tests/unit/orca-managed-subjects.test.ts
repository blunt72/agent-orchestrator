import { expect, it } from "vitest";
import { parseOrcaManagedDraftSubjects } from "../../src/integrations/orca-managed-subjects.js";
const h = "a".repeat(64);
const fixture = () => ({ bindingHash: h, deliveryDigest: h, testRunHash: h, finalizationHash: h, captureHash: h,
  workspaceHash: h, bindingDigest: h, enrollmentDigest: h, originalTaskDigest: h, settlementSha256: h, releaseSha256: h,
  taskId: "synthetic", revision: 4, attempt: "initial", operator: { namespace: "agenthub-local-operator-v1", subject: "synthetic" },
  changedFiles: ["test/boundary.mjs"], workerIncarnation: "11111111-1111-4111-8111-111111111111", resourceId: "resource" });
const parse = (value: unknown) => parseOrcaManagedDraftSubjects(Buffer.from(JSON.stringify(value)));
it("accepts synthetic exact draft schema without verifying evidence or issuing authority", () => {
  expect(parse(fixture())).toMatchObject({ evidenceVerified: false, approvalIssued: false, canCompleteTask: false });
});
it.each([
  { extra: true }, { revision: Number.MAX_SAFE_INTEGER }, { revision: 0 }, { attempt: "other" },
  { bindingHash: h + "\n" }, { resourceId: "r\n" }, { workerIncarnation: "invalid" },
  { operator: { namespace: "local", subject: "synthetic" } },
])("rejects invalid exact subjects: %j", patch => expect(() => parse({ ...fixture(), ...patch })).toThrow());
it.each([[], ["../file"], ["/absolute"], ["C:/file"], ["a\\b"], ["a//b"], ["./file"], ["a/../b"], ["a\n"], ["a", "a"], ["b", "a"]].map(files => ({ files })))(
  "rejects unsafe, duplicate or unordered changed paths: %j", ({ files }) => expect(() => parse({ ...fixture(), changedFiles: files })).toThrow());
it("rejects missing fields and invalid bounded raw input", () => {
  for (const key of Object.keys(fixture())) { const s: any = fixture(); delete s[key]; expect(() => parse(s)).toThrow(); }
  for (const b of [Buffer.alloc(0), Buffer.alloc(32769), Buffer.from([0xff]), Buffer.from('{"x":1,"x":1}')])
    expect(() => parseOrcaManagedDraftSubjects(b)).toThrow();
});
