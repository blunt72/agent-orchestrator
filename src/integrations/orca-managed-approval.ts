import { createHash } from "node:crypto";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";

const purpose = "TASK_SCOPED_PRINT_MANAGED_COMPLETION_APPROVAL";
const fail = (): never => { throw Error("INVALID_MANAGED_COMPLETION_APPROVAL"); };
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(value);

/** Supplied approval consistency only; never installs approval or authorizes a writer. */
export function inspectOrcaManagedApproval(bytes: Buffer, pin: string, expected: {
  operator: { namespace: string; subject: string }; subjects: Record<string, unknown>;
}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 32768 || !digest(pin) ||
      !expected || typeof expected !== "object" || Array.isArray(expected) ||
      Object.keys(expected).sort().join(",") !== "operator,subjects") return fail();
  const e = structuredClone(expected);
  if (!e.operator || Object.keys(e.operator).sort().join(",") !== "namespace,subject" ||
      typeof e.operator.namespace !== "string" || !e.operator.namespace || e.operator.namespace.length > 256 ||
      typeof e.operator.subject !== "string" || !e.operator.subject || e.operator.subject.length > 256 ||
      !e.subjects || typeof e.subjects !== "object" || Array.isArray(e.subjects)) return fail();
  const expectedJson = decodeOrcaJson(JSON.stringify(e.subjects));
  if (!expectedJson.ok || !isDeepStrictEqual(expectedJson.value, e.subjects) || !Object.keys(e.subjects).length) return fail();
  const raw = Buffer.from(bytes);
  if (createHash("sha256").update(raw).digest("hex") !== pin) return fail();
  const decoded = decodeOrcaJson(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  const a = decoded.ok ? decoded.value as any : null;
  if (!a || Object.keys(a).sort().join(",") !== "approvedAt,operator,purpose,sourceAuthenticated,subjects,version" ||
      a.version !== 1 || a.purpose !== purpose || a.sourceAuthenticated !== false ||
      !isDeepStrictEqual(a.operator, e.operator) || !isDeepStrictEqual(a.subjects, e.subjects) ||
      typeof a.approvedAt !== "string" || !Number.isFinite(Date.parse(a.approvedAt)) ||
      new Date(a.approvedAt).toISOString() !== a.approvedAt || Date.parse(a.approvedAt) > Date.now()) return fail();
  return { approvalDigest: pin, approvalEvidenceConsistent: true, approvalIssued: false,
    operatorAuthenticated: false, sourceAuthenticated: false, canCompleteTask: false, canReleaseWorker: false,
    globalGateApproved: false, scope: "SUPPLIED_MANAGED_APPROVAL_ONLY" };
}
