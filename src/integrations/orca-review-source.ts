import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";
import { decodeOrcaReviewResponse } from "./orca-review-response.js";
import { ORCA_EVIDENCE_MAX_BYTES } from "./orca-evidence.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/.test(value);
const exact = (value: any, keys: readonly string[]) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const invalid = (): never => { throw new Error("INVALID_ORCA_REVIEW_SOURCE"); };
const responseKeys = ["reviewId", "taskId", "digest", "generation", "workspaceHash", "testRunId", "testRunHash"] as const;

/** Matches supplied original bytes against explicit receipt expectations only.
 * No provider/source authentication, current-task validation or completion writes.
 */
export function inspectOrcaReviewSourceBytes(response: Buffer, testOutput: Buffer, rawExpectation: string) {
  if (typeof rawExpectation !== "string" || Buffer.byteLength(rawExpectation, "utf8") > 32768 ||
    !Buffer.isBuffer(response) || response.length < 1 || response.length > 262144 ||
    !Buffer.isBuffer(testOutput) || testOutput.length > ORCA_EVIDENCE_MAX_BYTES) return invalid();
  const decoded = decodeOrcaJson(rawExpectation);
  if (!decoded.ok) return invalid();
  const expected = decoded.value as any;
  if (!exact(expected, [...responseKeys, "responseSha256", "testOutputSha256", "testOutputBytes"]) ||
    !uuid(expected.reviewId) || !uuid(expected.testRunId) ||
    typeof expected.taskId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}(?![\s\S])/.test(expected.taskId) ||
    !Number.isSafeInteger(expected.generation) || expected.generation < 1 ||
    ![expected.digest, expected.workspaceHash, expected.testRunHash, expected.responseSha256, expected.testOutputSha256].every(hash) ||
    !Number.isSafeInteger(expected.testOutputBytes) || expected.testOutputBytes < 0 || expected.testOutputBytes > ORCA_EVIDENCE_MAX_BYTES) return invalid();
  if (sha(response) !== expected.responseSha256 || testOutput.length !== expected.testOutputBytes || sha(testOutput) !== expected.testOutputSha256)
    throw new Error("ORCA_REVIEW_SOURCE_BYTES_MISMATCH");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(response); }
  catch { return invalid(); }
  const parsed = decodeOrcaReviewResponse(text);
  if (!parsed.ok) return invalid();
  const verdict = parsed.value as any;
  if (!exact(verdict, [...responseKeys, "verdict"]) || responseKeys.some(key => verdict[key] !== expected[key]) || verdict.verdict !== "PASS")
    throw new Error("ORCA_REVIEW_SOURCE_SEMANTICS_MISMATCH");
  return { reviewId: expected.reviewId as string, testRunId: expected.testRunId as string,
    responseSha256: expected.responseSha256 as string, testOutputSha256: expected.testOutputSha256 as string,
    semanticMatch: true as const, sourceAuthenticated: false as const, canCompleteTask: false as const,
    scope: "LOCAL_REVIEW_SOURCE_MATCH_ONLY" as const };
}
