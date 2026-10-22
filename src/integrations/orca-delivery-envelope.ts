import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";
import { parseOrcaCompletionBinding } from "./orca-evidence-manifest.js";
import { snapshotOrcaMessage } from "./orca-delivery.js";
const invalid = (): never => { throw new Error("INVALID_ORCA_DELIVERY_ENVELOPE"); };
const object = (v: any): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const sha = (v: Buffer) => createHash("sha256").update(v).digest("hex");
const token = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}(?![\s\S])/.test(v);

/** A derived message representation, never the original lexical message bytes. */
export function selectOrcaDeliveryEnvelope(rawBinding: string, input: Buffer, rawExpectation: string) {
  const { binding } = parseOrcaCompletionBinding(rawBinding);
  if (!Buffer.isBuffer(input) || !input.length || input.length > 262144 ||
    typeof rawExpectation !== "string" || Buffer.byteLength(rawExpectation, "utf8") > 4096) return invalid();
  const expected = decodeOrcaJson(rawExpectation);
  if (!expected.ok || !object(expected.value)) return invalid();
  const e = expected.value;
  if (JSON.stringify(Object.keys(e).sort()) !== '["deliveryId","envelopeSha256","messageId","receiptId"]' ||
    !token(e.deliveryId) || !token(e.messageId) || !token(e.receiptId) || typeof e.envelopeSha256 !== "string" ||
    !/^[a-f0-9]{64}(?![\s\S])/.test(e.envelopeSha256)) return invalid();
  const envelopeBytes = Buffer.from(input);
  if (sha(envelopeBytes) !== e.envelopeSha256) throw Error("ORCA_ENVELOPE_HASH_MISMATCH");
  let parsed;
  try { parsed = decodeOrcaJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(envelopeBytes)); }
  catch { return invalid(); }
  if (!parsed.ok || !object(parsed.value)) return invalid();
  const v = parsed.value, r = v.result;
  if (JSON.stringify(Object.keys(v).sort()) !== '["_meta","id","ok","result"]' ||
    v.id !== e.receiptId || v.ok !== true || !object(v._meta) || v._meta.runtimeId !== binding.runtimeId || !object(r) ||
    r.runId !== binding.runId || r.deliveryId !== e.deliveryId || r.count !== 1 || !Array.isArray(r.messages) || r.messages.length !== 1 ||
    r.replayed !== false || r.acknowledged !== null || r.timedOut !== false || r.cancelled !== false || r.connectionLost !== false) return invalid();
  const originalMessage = r.messages[0], message: any = snapshotOrcaMessage(originalMessage);
  if (!object(message) || message.id !== e.messageId || message.type !== "worker_done" ||
    message.delivery_contract !== "current_delivery" || message.run_id !== binding.runId ||
    message.from_handle !== binding.terminalHandle || message.to_handle !== `run:${binding.runId}` || !object(message.payload) ||
    message.payload.taskId !== binding.taskId || message.payload.dispatchId !== binding.dispatchId ||
    !["succeeded", "failed"].includes(message.payload.outcome)) return invalid();
  const derivedMessageBytes = Buffer.from(JSON.stringify(originalMessage));
  if (derivedMessageBytes.length > 262144) return invalid();
  return { envelopeBytes, envelopeSha256: e.envelopeSha256 as string, derivedMessageBytes,
    derivedMessageSha256: sha(derivedMessageBytes), representation: "DERIVED_JSON_MESSAGE" as const,
    messageId: e.messageId as string, deliveryId: e.deliveryId as string,
    sourceAuthenticated: false as const, canCompleteTask: false as const };
}
