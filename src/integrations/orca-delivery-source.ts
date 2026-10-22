import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";
import { planOrcaDelivery } from "./orca-delivery.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(value);
const invalid = (): never => { throw new Error("INVALID_ORCA_DELIVERY_SOURCE"); };
function originalJson(bytes: Buffer): unknown {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 262144) return invalid();
  try {
    const decoded = decodeOrcaJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!decoded.ok) return invalid();
    return decoded.value;
  } catch { return invalid(); }
}

/** Original-byte and cross-receipt semantic matching, NOT source authentication.
 * All inputs must be obtained by a future trusted original-record extractor.
 * No CLI/provider calls, evidence writes or task completion are performed.
 */
export function inspectOrcaDeliverySourceBytes(rawBinding: string, workerDone: Buffer, settlement: Buffer, rawExpectation: string) {
  const { binding, digest: bindingDigest } = parseOrcaCompletionBinding(rawBinding);
  if (typeof rawExpectation !== "string" || Buffer.byteLength(rawExpectation, "utf8") > 32768) return invalid();
  const decoded = decodeOrcaJson(rawExpectation);
  if (!decoded.ok) return invalid();
  const expected = decoded.value as any;
  if (!expected || typeof expected !== "object" || Array.isArray(expected) ||
    JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify(["deliveryDigest", "messageId", "settlementSha256", "workerDoneSha256"]) ||
    !hash(expected.deliveryDigest) || !hash(expected.workerDoneSha256) || !hash(expected.settlementSha256) ||
    typeof expected.messageId !== "string" || !expected.messageId.length || expected.messageId.length > 4096 ||
    /[\x00-\x1f]/.test(expected.messageId)) return invalid();
  const message = originalJson(workerDone);
  const receipt = originalJson(settlement);
  if (sha(workerDone) !== expected.workerDoneSha256 || sha(settlement) !== expected.settlementSha256)
    throw new Error("ORCA_SOURCE_BYTES_MISMATCH");
  const plan = planOrcaDelivery(binding, { taskId: binding.agenthubTaskId, projectId: binding.projectId,
    revision: binding.revision, generation: binding.generation, status: "DOING", ownerId: binding.ownerId,
    claimId: binding.claimId, reviewerId: binding.reviewer }, message, receipt);
  if (plan.kind !== "candidate" || plan.proposedStatus !== "REVIEW") throw new Error("ORCA_SOURCE_SEMANTICS_MISMATCH");
  if (plan.messageId !== expected.messageId || plan.digest !== expected.deliveryDigest)
    throw new Error("ORCA_SOURCE_DELIVERY_MISMATCH");
  return { bindingDigest, deliveryDigest: plan.digest, messageId: plan.messageId,
    workerDoneSha256: expected.workerDoneSha256 as string, settlementSha256: expected.settlementSha256 as string,
    semanticMatch: true as const, sourceAuthenticated: false as const, canCompleteTask: false as const,
    scope: "LOCAL_DELIVERY_SOURCE_MATCH_ONLY" as const };
}
