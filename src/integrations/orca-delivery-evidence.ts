import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";
import { selectOrcaDeliveryEnvelope } from "./orca-delivery-envelope.js";
import { inspectOrcaDeliverySourceBytes } from "./orca-delivery-source.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const invalid = (): never => { throw new Error("INVALID_ORCA_DELIVERY_EVIDENCE"); };
function parse(bytes: Buffer): any {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 262144) return invalid();
  try {
    const result = decodeOrcaJson(new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!result.ok || !result.value || typeof result.value !== "object" || Array.isArray(result.value)) return invalid();
    return result.value;
  } catch { return invalid(); }
}
function unwrap(value: any): Buffer {
  if (JSON.stringify(Object.keys(value).sort()) !== '["chunk_id","exit_code","original_token_count","output","wall_time_seconds"]' ||
    typeof value.chunk_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}(?![\s\S])/.test(value.chunk_id) || value.exit_code !== 0 ||
    typeof value.wall_time_seconds !== "number" || !Number.isFinite(value.wall_time_seconds) || value.wall_time_seconds < 0 ||
    !Number.isSafeInteger(value.original_token_count) || value.original_token_count < 0 || typeof value.output !== "string") return invalid();
  const bytes = Buffer.from(value.output, "utf8");
  parse(bytes);
  return bytes;
}

/** Strict single exec record; returned JSON bytes are decoded, not original wrapper bytes. */
export function decodeOrcaExecEvidenceBytes(input: Buffer): Buffer {
  if (!Buffer.isBuffer(input) || !input.length || input.length > 262144) return invalid();
  return unwrap(parse(Buffer.from(input)));
}

/** Local byte lineage only. Decoding never authenticates a source or grants completion. */
export function inspectOrcaDeliveryEvidenceBytes(rawBinding: string, workerInput: Buffer, settlementInput: Buffer,
  rawExpectation: string) {
  if (!Buffer.isBuffer(workerInput) || !workerInput.length || workerInput.length > 262144 ||
    !Buffer.isBuffer(settlementInput) || !settlementInput.length || settlementInput.length > 262144 ||
    typeof rawExpectation !== "string" || !rawExpectation.length || Buffer.byteLength(rawExpectation, "utf8") > 32768) return invalid();
  const worker = Buffer.from(workerInput), settlement = Buffer.from(settlementInput);
  const w = parse(worker), s = parse(settlement);
  const expected = parse(Buffer.from(rawExpectation, "utf8"));
  if (JSON.stringify(Object.keys(expected).sort()) !== '["deliveryDigest","messageId","settlementSha256","workerDoneSha256"]' ||
    expected.workerDoneSha256 !== sha(worker) || expected.settlementSha256 !== sha(settlement)) return invalid();
  const wrapped = Object.hasOwn(w, "output"), settlementWrapped = Object.hasOwn(s, "output");
  if (wrapped !== settlementWrapped) return invalid();
  if (!wrapped) return { representation: "DIRECT_JSON" as const,
    check: inspectOrcaDeliverySourceBytes(rawBinding, worker, settlement, rawExpectation),
    sourceAuthenticated: false as const, canCompleteTask: false as const };
  const envelopeBytes = unwrap(w), settlementBytes = unwrap(s), envelope = parse(envelopeBytes);
  const selected = selectOrcaDeliveryEnvelope(rawBinding, envelopeBytes, JSON.stringify({ receiptId: envelope.id,
    deliveryId: envelope.result?.deliveryId, messageId: expected.messageId, envelopeSha256: sha(envelopeBytes) }));
  const check = inspectOrcaDeliverySourceBytes(rawBinding, selected.derivedMessageBytes, settlementBytes,
    JSON.stringify({ ...expected, workerDoneSha256: sha(selected.derivedMessageBytes), settlementSha256: sha(settlementBytes) }));
  return { representation: "EXEC_WRAPPED_ENVELOPE" as const,
    lineage: { originalWorkerSha256: sha(worker), originalSettlementSha256: sha(settlement),
      decodedEnvelopeSha256: sha(envelopeBytes), decodedSettlementSha256: sha(settlementBytes),
      derivedMessageSha256: selected.derivedMessageSha256, messageId: selected.messageId, deliveryId: selected.deliveryId },
    check, sourceAuthenticated: false as const, canCompleteTask: false as const };
}
