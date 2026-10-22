import { describe, expect, it } from "vitest";
import { extractOrcaWaitReceipt } from "../../src/integrations/orca-wait-stream.js";
const heartbeat = (patch = {}) => JSON.stringify({ _keepalive: true, _heartbeat: true, elapsedMs: 15003, deadlineMs: 120000, ...patch });
const receipt = JSON.stringify({ id: "receipt", ok: true, result: {}, _meta: {} }, null, 2);
const bytes = (prefix = heartbeat(), tail = receipt) => Buffer.from(prefix + "\n" + tail);
describe("explicit wait framing (synthetic, no authority)", () => {
  it("retains the full stream and exact receipt slice without reserialization", () => {
    const input = bytes(), result = extractOrcaWaitReceipt(input);
    expect(result.streamBytes.equals(input)).toBe(true);
    expect(result.receiptBytes.equals(Buffer.from(receipt))).toBe(true);
    expect(result).toMatchObject({ heartbeatCount: 1, sourceAuthenticated: false, canCompleteTask: false });
    input.fill(0); expect(result.receiptBytes.toString()).toBe(receipt);
  });
  it("accepts increasing heartbeat lines and original CRLF receipt framing", () => {
    const tail = receipt.replace(/\n/g, "\r\n") + "\r\n";
    const result = extractOrcaWaitReceipt(bytes(heartbeat() + "\r\n" + heartbeat({ elapsedMs: 30000 }), tail));
    expect(result.heartbeatCount).toBe(2); expect(result.receiptBytes.toString()).toBe(tail);
  });
  it("accepts a compact receipt without final newline", () => {
    const compact = JSON.stringify(JSON.parse(receipt));
    expect(extractOrcaWaitReceipt(bytes(heartbeat(), compact)).receiptBytes.toString()).toBe(compact);
  });
  it.each([{ _keepalive: false }, { _heartbeat: 1 }, { elapsedMs: -1 }, { elapsedMs: 1.5 },
    { deadlineMs: 0 }, { elapsedMs: 120001 }, { extra: true }])("rejects unknown or invalid heartbeat %j", patch => {
    expect(() => extractOrcaWaitReceipt(bytes(heartbeat(patch)))).toThrow();
  });
  it.each(["noise", "{}", "", '\ufeff' + heartbeat(), heartbeat().replace('"_keepalive":true', '"_keepalive":true,"_keepalive":true')])
    ("rejects unsupported prefixes", prefix => expect(() => extractOrcaWaitReceipt(bytes(prefix))).toThrow());
  it("rejects repeated elapsed, changed deadline and excessive heartbeat count", () => {
    for (const prefix of [heartbeat() + "\n" + heartbeat(), heartbeat() + "\n" + heartbeat({ elapsedMs: 30000, deadlineMs: 120001 }),
      Array.from({ length: 129 }, (_, elapsedMs) => heartbeat({ elapsedMs })).join("\n")])
      expect(() => extractOrcaWaitReceipt(bytes(prefix))).toThrow();
  });
  it.each([receipt + "\n" + receipt, receipt + " trailing", "[]", '{"id":"x","ok":false,"result":{},"_meta":{}}', ""])
    ("rejects duplicate, incomplete or nonreceipt tails", tail => expect(() => extractOrcaWaitReceipt(bytes(heartbeat(), tail))).toThrow());
  it("rejects malformed UTF-8, oversize and plain single receipts", () => {
    for (const input of [Buffer.concat([bytes(), Buffer.from([255])]), Buffer.alloc(262145), Buffer.from(receipt)])
      expect(() => extractOrcaWaitReceipt(input)).toThrow();
  });
});
