import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";
import { parseOrcaCompletionApproval, type OrcaOperatorIdentity } from "./orca-completion-approval.js";

const gap = "EXECUTION_PERMISSION_NOT_STRUCTURALLY_DIGEST_BOUND";
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const invalid = (): never => { throw Error("INVALID_LIMITED_LOCAL_APPROVAL"); };
function decode(raw: string) {
  if (typeof raw !== "string" || raw.length > 32768 || Buffer.byteLength(raw) > 32768) return invalid();
  const parsed = decodeOrcaJson(raw); if (!parsed.ok) return invalid(); return parsed.value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Pure schema validation only. The standard decision is not completion approval.
 * Caller must independently establish human issuance of the nested approval.
 */
export function parseOrcaLimitedApproval(raw: string, rawDecision: string, expectedDecisionDigest: string,
  enrolled: readonly OrcaOperatorIdentity[]) {
  if (typeof expectedDecisionDigest !== "string" || !/^[a-f0-9]{64}(?![\s\S])/.test(expectedDecisionDigest)) invalid();
  const decision = decode(rawDecision);
  if (sha(rawDecision) !== expectedDecisionDigest ||
    !exact(decision, ["version", "purpose", "decisionId", "recordedAt", "operator", "taskId", "projectId", "generation",
      "bindingDigest", "historicalGap", "userStatement", "completionApproved", "sourceAuthenticated"]) ||
    decision.version !== 1 || decision.purpose !== "LIMITED_LOCAL_PILOT_STANDARD_DECISION" || decision.historicalGap !== gap ||
    decision.userStatement !== "保留历史缺口" || decision.completionApproved !== false || decision.sourceAuthenticated !== false ||
    typeof decision.decisionId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/.test(decision.decisionId) ||
    typeof decision.recordedAt !== "string" || !Number.isFinite(Date.parse(decision.recordedAt)) ||
    new Date(decision.recordedAt).toISOString() !== decision.recordedAt) return invalid();
  const value = decode(raw);
  if (!exact(value, ["version", "purpose", "decisionDigest", "historicalGap", "completion"]) || value.version !== 1 ||
    value.purpose !== "LIMITED_LOCAL_HUMAN_PILOT_COMPLETION" || value.decisionDigest !== expectedDecisionDigest || value.historicalGap !== gap) return invalid();
  const parsed = parseOrcaCompletionApproval(JSON.stringify(value.completion), enrolled);
  const completion = parsed.approval;
  // Nested approval validation also validates the matching decision subject fields.
  if (!isDeepStrictEqual(decision.operator, completion.operator) || decision.taskId !== completion.taskId ||
    decision.projectId !== completion.projectId || decision.generation !== completion.generation ||
    decision.bindingDigest !== completion.bindingDigest || Date.parse(completion.approvedAt) < Date.parse(decision.recordedAt)) invalid();
  const encoded = canonical(value);
  return { completion, decisionDigest: expectedDecisionDigest, historicalGap: gap, canonical: encoded, digest: sha(encoded),
    humanIssuanceVerified: false as const, sourceAuthenticated: false as const, canCompleteTask: false as const,
    scope: "LIMITED_LOCAL_APPROVAL_SCHEMA_ONLY" as const };
}
