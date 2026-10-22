import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { inspectOrcaManagedApproval } from "../../src/integrations/orca-managed-approval.js";
const expected = { operator: { namespace: "local", subject: "operator" }, subjects: { taskId: "synthetic", revision: 4, resourceId: "resource" } };
const approval = () => ({ version: 1, purpose: "TASK_SCOPED_PRINT_MANAGED_COMPLETION_APPROVAL", approvedAt: "2020-01-01T00:00:00.000Z",
  sourceAuthenticated: false, ...structuredClone(expected) });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
it("checks synthetic supplied approval only, without issuing permissions", () => {
  const b = Buffer.from(JSON.stringify(approval()));
  expect(inspectOrcaManagedApproval(b, sha(b), expected)).toMatchObject({ approvalEvidenceConsistent: true,
    approvalIssued: false, operatorAuthenticated: false, canCompleteTask: false, canReleaseWorker: false, globalGateApproved: false });
});
it.each([
  { purpose: "TASK_SCOPED_PRINT_LIMITED_COMPLETION_APPROVAL" }, { version: 2 }, { sourceAuthenticated: true },
  { approvedAt: "2999-01-01T00:00:00.000Z" }, { approvedAt: "2020-01-01" }, { approvedAt: "bad" },
  { subjects: { ...expected.subjects, revision: 5 } }, { subjects: { ...expected.subjects, extra: true } },
  { operator: { namespace: "local", subject: "other" } }, { retainedGaps: [] },
])("rejects semantic mismatch despite a recomputed hash: %j", patch => {
  const b = Buffer.from(JSON.stringify({ ...approval(), ...patch }));
  expect(() => inspectOrcaManagedApproval(b, sha(b), expected)).toThrow();
});
it("rejects stale pins and bounded malformed input", () => {
  const good = Buffer.from(JSON.stringify(approval()));
  expect(() => inspectOrcaManagedApproval(good, "0".repeat(64), expected)).toThrow();
  for (const b of [Buffer.alloc(0), Buffer.alloc(32769), Buffer.from([0xff]), Buffer.from('{"version":1,"version":1}')])
    expect(() => inspectOrcaManagedApproval(b, sha(b), expected)).toThrow();
});
it("rejects missing or non-JSON expected subjects instead of weakening exact equality", () => {
  const b = Buffer.from(JSON.stringify(approval()));
  for (const subjects of [{}, { value: undefined }, { value: NaN }])
    expect(() => inspectOrcaManagedApproval(b, sha(b), { ...expected, subjects })).toThrow();
});
