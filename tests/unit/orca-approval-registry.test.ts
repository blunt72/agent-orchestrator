import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readOrcaApprovalRegistry } from "../../src/integrations/orca-approval-registry.js";
import { parseOrcaLimitedApproval } from "../../src/integrations/orca-limited-approval.js";

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const operator = { namespace: "agenthub-local-operator-v1", subject: "11111111-1111-4111-8111-111111111111" };
const scope = { taskId: "task", projectId: "project", generation: 1, bindingDigest: "a".repeat(64) };
let root: string, sessions: string, filename: string, proposalDigest: string;
let entry: any, wrapper: any, decision: any, proposal: any;
const write = () => fs.writeFileSync(filename, JSON.stringify(entry), { mode: 0o600 });
const read = () => readOrcaApprovalRegistry(root, sessions, scope, proposalDigest);
const repin = () => {
  entry.rawDecision = JSON.stringify(decision);
  entry.decisionDigest = sha(entry.rawDecision);
  wrapper.decisionDigest = entry.decisionDigest;
  entry.rawApproval = JSON.stringify(wrapper);
  entry.approvalDigest = parseOrcaLimitedApproval(entry.rawApproval, entry.rawDecision, entry.decisionDigest, [operator as any]).digest;
  entry.rawProposal = JSON.stringify(proposal);
  entry.proposalDigest = proposalDigest = sha(entry.rawProposal);
  write();
};
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-issuance-")));
  sessions = path.join(root, "sessions"); fs.mkdirSync(sessions);
  fs.mkdirSync(path.join(root, "data", "orca-trust-v1"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, "data", "orca-evidence-v1"));
  fs.writeFileSync(path.join(root, "data", "orca-trust-v1", "enrollment.json"), JSON.stringify({ version: 1,
    purpose: "LOCAL_HUMAN_SUPERVISED_PILOT_ENROLLMENT", registeredAt: "2026-10-12T00:00:00.000Z", operator, scope,
    evidenceRoots: [sessions, path.join(root, "data", "orca-evidence-v1")], authorizationBasis: "synthetic only",
    sourceAuthenticated: false, canCompleteTask: false }), { mode: 0o600 });
  decision = { version: 1, purpose: "LIMITED_LOCAL_PILOT_STANDARD_DECISION", decisionId: "22222222-2222-4222-8222-222222222222",
    recordedAt: "2026-10-12T00:00:00.000Z", operator, ...scope,
    historicalGap: "EXECUTION_PERMISSION_NOT_STRUCTURALLY_DIGEST_BOUND", userStatement: "保留历史缺口",
    completionApproved: false, sourceAuthenticated: false };
  const subjects = { operator, ...scope, expectedRevision: 10, dispatchId: "dispatch", runId: "run", runtimeId: "runtime",
    orcaTaskId: "orca-task", ownerId: "gemini", reviewerId: "codex", claimId: null, deliveryDigest: "b".repeat(64),
    testReceiptDigest: "c".repeat(64), reviewReceiptDigest: "d".repeat(64), workspaceDigest: "e".repeat(64),
    baselineDigest: "f".repeat(64), manifestDigest: "0".repeat(64), allowedFiles: ["test.ts"] };
  wrapper = { version: 1, purpose: "LIMITED_LOCAL_HUMAN_PILOT_COMPLETION", decisionDigest: sha(JSON.stringify(decision)),
    historicalGap: decision.historicalGap, completion: { version: 1, purpose: "SCOPED_ORCA_PILOT_COMPLETION",
      approvalId: "33333333-3333-4333-8333-333333333333", approvedAt: "2026-10-12T00:01:00.000Z", ...subjects } };
  proposal = { version: 1, purpose: "LIMITED_LOCAL_HUMAN_PILOT_COMPLETION_PROPOSAL", status: "NOT_APPROVED",
    decisionDigest: wrapper.decisionDigest, historicalGap: decision.historicalGap, completionSubjects: subjects,
    sourceAuthenticated: false, approvalIssued: false, canCompleteTask: false };
  entry = { version: 1, purpose: "LOCAL_HUMAN_LIMITED_APPROVAL_ISSUANCE", issuedAt: wrapper.completion.approvedAt,
    authorizationBasis: "synthetic explicit human approval fixture; never operational", sourceAuthenticated: false };
  filename = path.join(root, "data", "orca-trust-v1", "task.approval.json"); repin();
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it("reads fixed private issuance but never grants completion or provider authentication", () => {
  const before = fs.readFileSync(filename);
  expect(read()).toMatchObject({ localIssuanceRecorded: true, canCompleteTask: false, sourceAuthenticated: false,
    proposalDigest, completion: wrapper.completion, scope: "LOCAL_ISSUANCE_RECORD_ONLY" });
  expect(fs.readFileSync(filename)).toEqual(before);
});
it("does not initialize a missing issuance", () => {
  fs.unlinkSync(filename); expect(read).toThrow(); expect(fs.existsSync(filename)).toBe(false);
});
it.each(["proposalDigest", "decisionDigest", "approvalDigest"])("rejects altered %s", key => {
  entry[key] = "9".repeat(64); write(); expect(read).toThrow();
});
it.each(["rawProposal", "rawDecision", "rawApproval"])("rejects substituted %s", key => {
  entry[key] = "{}"; write(); expect(read).toThrow();
});
it.each(["version", "purpose", "issuedAt", "authorizationBasis", "sourceAuthenticated", "extra"])("rejects invalid registry %s", key => {
  entry[key] = key === "sourceAuthenticated" ? true : key === "authorizationBasis" ? "" : "bad"; write(); expect(read).toThrow();
});
it.each(["status", "purpose", "historicalGap", "decisionDigest", "sourceAuthenticated", "approvalIssued", "canCompleteTask", "extra"])("rejects repinned invalid proposal %s", key => {
  proposal[key] = ["sourceAuthenticated", "approvalIssued", "canCompleteTask"].includes(key) ? true : "bad";
  repin(); expect(read).toThrow();
});
it.each(["expectedRevision", "dispatchId", "allowedFiles", "reviewerId", "operator"])("rejects proposal/approval subject mismatch %s", key => {
  proposal.completionSubjects = { ...proposal.completionSubjects, [key]: key === "expectedRevision" ? 11 : "different" };
  repin(); expect(read).toThrow();
});
it("rejects unknown subject keys", () => {
  proposal.completionSubjects = { ...proposal.completionSubjects, extra: true }; repin(); expect(read).toThrow();
});
it("rejects changed trusted proposal pin even if the registry internally matches", () => {
  expect(() => readOrcaApprovalRegistry(root, sessions, scope, "9".repeat(64))).toThrow();
});
it.each(["../task", "task\n", "", "a".repeat(129)])("rejects unsafe task ID %j", taskId => {
  expect(() => readOrcaApprovalRegistry(root, sessions, { ...scope, taskId }, proposalDigest)).toThrow();
});
it("rejects completion timestamp not equal to issuance timestamp", () => {
  entry.issuedAt = "2026-10-12T00:02:00.000Z"; write(); expect(read).toThrow();
});
it.each(["taskId", "projectId", "generation", "bindingDigest"])("rejects changed enrolled scope %s", key => {
  expect(() => readOrcaApprovalRegistry(root, sessions, { ...scope, [key]: key === "generation" ? 2 : "other" }, proposalDigest)).toThrow();
});
it.each(["file-mode", "directory-mode", "symlink", "hardlink", "oversize", "utf8", "duplicate"])("rejects unsafe storage %s", kind => {
  if (kind === "file-mode") fs.chmodSync(filename, 0o644);
  if (kind === "directory-mode") fs.chmodSync(path.dirname(filename), 0o755);
  if (kind === "symlink") { fs.renameSync(filename, filename + ".original"); fs.symlinkSync(filename + ".original", filename); }
  if (kind === "hardlink") fs.linkSync(filename, filename + ".alias");
  if (kind === "oversize") fs.writeFileSync(filename, " ".repeat(131073));
  if (kind === "utf8") fs.writeFileSync(filename, Buffer.from([0xff]));
  if (kind === "duplicate") fs.writeFileSync(filename, JSON.stringify(entry).replace('"version":1', '"version":1,"version":1'));
  expect(read).toThrow();
});
it.each(["registry-mode", "registry-replace", "enrollment", "sessions"])("rejects mutation during registry read: %s", kind => {
  const original = fs.readSync;
  let mutated = false;
  vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const count = Reflect.apply(original, fs, args);
    const stat = fs.fstatSync(args[0]);
    if (!mutated && stat.ino === fs.lstatSync(filename).ino) {
      mutated = true;
      if (kind === "registry-mode") fs.chmodSync(filename, 0o644);
      if (kind === "registry-replace") { fs.renameSync(filename, filename + ".old"); write(); }
      if (kind === "enrollment") fs.chmodSync(path.join(path.dirname(filename), "enrollment.json"), 0o644);
      if (kind === "sessions") { fs.renameSync(sessions, sessions + ".old"); fs.mkdirSync(sessions); }
    }
    return count;
  }) as typeof fs.readSync);
  expect(read).toThrow();
});
