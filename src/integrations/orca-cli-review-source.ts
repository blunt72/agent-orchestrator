import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";
import { ORCA_EVIDENCE_MAX_BYTES } from "./orca-evidence.js";

const sha = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const exact = (v: any, keys: readonly string[]) => v !== null && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}(?![\s\S])/.test(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/.test(v);
const invalid = (): never => { throw new Error("INVALID_CLI_REVIEW_EVIDENCE"); };
const responseKeys = ["reviewId", "taskId", "digest", "generation", "workspaceHash", "testRunId", "testRunHash"] as const;
const subjectKeys = [...responseKeys, "revision", "bindingDigest", "runtimeId", "hostId", "runId", "dispatchId",
  "workerTerminalHandle", "reviewerTerminalHandle", "reviewerIncarnation", "turnId", "developer", "reviewer"] as const;
const expectationKeys = ["subjects", "requestSha256", "responseSha256", "transportSha256", "testOutputSha256", "testOutputBytes", "requirementsSha256"];

function decode(bytes: Buffer) {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalid(); }
  const decoded = decodeOrcaJson(text);
  if (!decoded.ok) return invalid();
  return decoded.value as any;
}

/** Pure supplied-byte matching only. Transport fields are untrusted local claims,
 * not extraction proof, a trusted adapter receipt, review finalization or approval.
 */
export function inspectOrcaCliReviewSourceBytes(request: Buffer, response: Buffer, transport: Buffer,
  testOutput: Buffer, rawExpectation: string) {
  if (typeof rawExpectation !== "string" || Buffer.byteLength(rawExpectation) > 32768 ||
    !Buffer.isBuffer(request) || request.length < 1 || request.length > 262144 ||
    !Buffer.isBuffer(response) || response.length < 1 || response.length > 262144 ||
    !Buffer.isBuffer(transport) || transport.length < 1 || transport.length > 32768 ||
    !Buffer.isBuffer(testOutput) || testOutput.length > ORCA_EVIDENCE_MAX_BYTES) return invalid();
  const decoded = decodeOrcaJson(rawExpectation);
  const expected = decoded.ok ? decoded.value as any : null;
  if (!exact(expected, expectationKeys) || !exact(expected.subjects, subjectKeys) ||
    ![expected.requestSha256, expected.responseSha256, expected.transportSha256,
      expected.testOutputSha256, expected.requirementsSha256].every(hash) ||
    !Number.isSafeInteger(expected.testOutputBytes) || expected.testOutputBytes < 0 ||
    expected.testOutputBytes > ORCA_EVIDENCE_MAX_BYTES) return invalid();
  const s = expected.subjects;
  if (!uuid(s.reviewId) || !uuid(s.testRunId) || !uuid(s.reviewerIncarnation) ||
    !Number.isSafeInteger(s.generation) || s.generation < 1 || !Number.isSafeInteger(s.revision) || s.revision < 1 ||
    ![s.digest, s.workspaceHash, s.testRunHash, s.bindingDigest].every(hash) ||
    ![s.taskId, s.runtimeId, s.hostId, s.runId, s.dispatchId, s.workerTerminalHandle, s.reviewerTerminalHandle, s.turnId].every(id) ||
    s.developer !== "codex" || s.reviewer !== "gemini" || s.workerTerminalHandle === s.reviewerTerminalHandle) return invalid();
  if (sha(request) !== expected.requestSha256 || sha(response) !== expected.responseSha256 ||
    sha(transport) !== expected.transportSha256 || sha(testOutput) !== expected.testOutputSha256 ||
    testOutput.length !== expected.testOutputBytes) throw new Error("CLI_REVIEW_BYTES_MISMATCH");
  const prompt = decode(request), answer = decode(response), source = decode(transport);
  if (!exact(prompt, ["version", "purpose", "subjects", "requirements", "testOutputSha256", "testOutputBytes"]) ||
    prompt.version !== 1 || prompt.purpose !== "INDEPENDENT_STATIC_REVIEW" || !exact(prompt.subjects, subjectKeys) ||
    subjectKeys.some(key => prompt.subjects[key] !== s[key]) || typeof prompt.requirements !== "string" ||
    !prompt.requirements.trim() || sha(prompt.requirements) !== expected.requirementsSha256 ||
    prompt.testOutputSha256 !== expected.testOutputSha256 || prompt.testOutputBytes !== expected.testOutputBytes)
    throw new Error("CLI_REVIEW_REQUEST_MISMATCH");
  if (!exact(answer, [...responseKeys, "verdict"]) || responseKeys.some(key => answer[key] !== s[key]) ||
    !["PASS", "REQUEST_CHANGES"].includes(answer.verdict)) throw new Error("CLI_REVIEW_RESPONSE_MISMATCH");
  const transportIdentities = ["runtimeId", "hostId", "runId", "dispatchId", "reviewerTerminalHandle", "reviewerIncarnation", "turnId"] as const;
  if (!exact(source, ["version", "provider", "adapter", "sourceKind", "status", "endTurn", "requestSha256", "responseSha256", ...transportIdentities]) ||
    source.version !== 1 || source.provider !== "google" || source.adapter !== "antigravity-cli" ||
    source.sourceKind !== "original-provider-turn" || source.status !== "completed" || source.endTurn !== true ||
    transportIdentities.some(key => source[key] !== s[key]) || source.requestSha256 !== expected.requestSha256 ||
    source.responseSha256 !== expected.responseSha256) throw new Error("CLI_REVIEW_TRANSPORT_MISMATCH");
  return { reviewId: s.reviewId as string, taskId: s.taskId as string,
    verdict: answer.verdict as "PASS" | "REQUEST_CHANGES", requestSha256: expected.requestSha256 as string,
    responseSha256: expected.responseSha256 as string, transportSha256: expected.transportSha256 as string,
    testOutputSha256: expected.testOutputSha256 as string,
    scope: "SUPPLIED_CLI_REVIEW_BYTES_ONLY" as const, suppliedEvidenceConsistent: true as const,
    sourceAuthenticated: false as const, trustedExtractionVerified: false as const,
    canFinalizeReview: false as const, canCompleteTask: false as const };
}
