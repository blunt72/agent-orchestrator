import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";
import { readOrcaLocalEnrollment, type LocalEnrollmentScope } from "./orca-local-enrollment.js";
import { parseOrcaLimitedApproval } from "./orca-limited-approval.js";

const sha = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
const fail = (): never => { throw Error("INVALID_LOCAL_APPROVAL_REGISTRY"); };
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(value);
const limit = 131072;

/** Fixed local operator policy, not provider authentication or a completion capability.
 * The pinned proposal digest comes from trusted operator configuration, not task evidence.
 * The transaction must separately revalidate current subjects, original sources and locks.
 */
export function readOrcaApprovalRegistry(projectRoot: string, sessionsRoot: string,
  expected: LocalEnrollmentScope, expectedProposalDigest: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}(?![\s\S])/.test(expected.taskId) || !digest(expectedProposalDigest)) fail();
  const enrollment = readOrcaLocalEnrollment(projectRoot, sessionsRoot, expected);
  const directory = path.join(projectRoot, "data", "orca-trust-v1");
  const directories = [projectRoot, path.join(projectRoot, "data"), directory, sessionsRoot,
    path.join(projectRoot, "data", "orca-evidence-v1")].map(name => ({ name, stat: fs.lstatSync(name) }));
  const filename = path.join(directory, `${expected.taskId}.approval.json`);
  const before = fs.lstatSync(filename), uid = process.getuid?.();
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > limit ||
    (before.mode & 0o777) !== 0o600 || (uid !== undefined && before.uid !== uid)) fail();
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev) fail();
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd), current = fs.lstatSync(filename);
    if (length !== before.size || length > limit || current.ino !== before.ino || current.dev !== before.dev ||
      !current.isFile() || after.nlink !== 1 || current.nlink !== 1 || after.size !== before.size || current.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.mtimeMs !== before.mtimeMs ||
      current.ctimeMs !== before.ctimeMs || after.mode !== before.mode || after.uid !== before.uid ||
      current.mode !== before.mode || current.uid !== before.uid) fail();
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    const parsed = decodeOrcaJson(raw);
    if (!parsed.ok) return fail();
    const entry = parsed.value;
    if (!exact(entry, ["version", "purpose", "issuedAt", "authorizationBasis", "proposalDigest", "decisionDigest",
      "approvalDigest", "rawProposal", "rawDecision", "rawApproval", "sourceAuthenticated"]) ||
      entry.version !== 1 || entry.purpose !== "LOCAL_HUMAN_LIMITED_APPROVAL_ISSUANCE" || entry.sourceAuthenticated !== false ||
      typeof entry.issuedAt !== "string" || !Number.isFinite(Date.parse(entry.issuedAt)) ||
      new Date(entry.issuedAt).toISOString() !== entry.issuedAt ||
      typeof entry.authorizationBasis !== "string" || entry.authorizationBasis.length < 1 || entry.authorizationBasis.length > 2048 ||
      !digest(entry.proposalDigest) || entry.proposalDigest !== expectedProposalDigest || !digest(entry.decisionDigest) ||
      !digest(entry.approvalDigest) || typeof entry.rawProposal !== "string" || Buffer.byteLength(entry.rawProposal) > 32768 ||
      typeof entry.rawDecision !== "string" || typeof entry.rawApproval !== "string" || sha(entry.rawProposal) !== entry.proposalDigest ||
      sha(entry.rawDecision) !== entry.decisionDigest) return fail();
    const approval = parseOrcaLimitedApproval(entry.rawApproval, entry.rawDecision, entry.decisionDigest, [enrollment.operator]);
    if (approval.digest !== entry.approvalDigest || approval.completion.approvedAt !== entry.issuedAt) fail();
    const proposalParsed = decodeOrcaJson(entry.rawProposal);
    if (!proposalParsed.ok) return fail();
    const proposal = proposalParsed.value;
    const { version: _version, purpose: _purpose, approvalId: _id, approvedAt: _at, ...subjects } = approval.completion;
    if (!exact(proposal, ["version", "purpose", "status", "decisionDigest", "historicalGap", "completionSubjects",
      "sourceAuthenticated", "approvalIssued", "canCompleteTask"]) || proposal.version !== 1 ||
      proposal.purpose !== "LIMITED_LOCAL_HUMAN_PILOT_COMPLETION_PROPOSAL" || proposal.status !== "NOT_APPROVED" ||
      proposal.decisionDigest !== approval.decisionDigest || proposal.historicalGap !== approval.historicalGap ||
      proposal.sourceAuthenticated !== false || proposal.approvalIssued !== false || proposal.canCompleteTask !== false ||
      !isDeepStrictEqual(proposal.completionSubjects, subjects) || subjects.taskId !== expected.taskId ||
      subjects.projectId !== expected.projectId || subjects.generation !== expected.generation ||
      subjects.bindingDigest !== expected.bindingDigest) fail();
    for (const { name, stat } of directories) {
      const now = fs.lstatSync(name);
      if (!now.isDirectory() || fs.realpathSync(name) !== name || now.ino !== stat.ino || now.dev !== stat.dev ||
        now.mode !== stat.mode || now.uid !== stat.uid) fail();
    }
    if (!isDeepStrictEqual(readOrcaLocalEnrollment(projectRoot, sessionsRoot, expected), enrollment)) fail();
    return { completion: approval.completion, historicalGap: approval.historicalGap, decisionDigest: approval.decisionDigest,
      approvalDigest: approval.digest, proposalDigest: expectedProposalDigest, registryDigest: sha(buffer.subarray(0, length)),
      enrollmentDigest: enrollment.digest, authorizationBasis: entry.authorizationBasis,
      localIssuanceRecorded: true as const, sourceAuthenticated: false as const, canCompleteTask: false as const,
      scope: "LOCAL_ISSUANCE_RECORD_ONLY" as const };
  } finally { fs.closeSync(fd); }
}
