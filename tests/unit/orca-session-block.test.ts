import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractOrcaSessionTextBlock, extractOrcaSessionToolOutput } from "../../src/integrations/orca-session-source.js";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sessionId = "11111111-1111-4111-8111-111111111111";
const rows = () => [
  { ordinal: 0, type: "session_meta", payload: { id: sessionId } },
  { ordinal: 1, type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "call_one", input: "never execute" } },
  { ordinal: 2, type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_one", output: [
    { type: "input_text", text: "wrapper" }, { type: "input_text", text: " exact\n中" }] } },
];
const encode = (r: unknown[]) => Buffer.from(r.map(v => JSON.stringify(v)).join("\n") + "\n");
const selector = (bytes: Buffer, patch = {}) => JSON.stringify({ sessionId, callId: "call_one", toolName: "exec", ordinal: 2,
  sourceSha256: sha(bytes), blockIndex: 1, blockSha256: sha(Buffer.from(" exact\n中")), ...patch });
describe("explicit custom block selection (synthetic, no source authority)", () => {
  it("copies the exact record and only the selected block without concatenation", () => {
    const bytes = encode(rows()), result = extractOrcaSessionTextBlock(bytes, selector(bytes));
    expect(result.outputBytes.equals(Buffer.from(" exact\n中"))).toBe(true);
    expect(result.recordBytes.equals(Buffer.from(JSON.stringify(rows()[2]) + "\n"))).toBe(true);
    expect(result).toMatchObject({ blockIndex: 1, sourceAuthenticated: false, canCompleteTask: false });
    bytes.fill(0); expect(result.outputBytes.toString()).toBe(" exact\n中");
  });
  it.each([-1, 0.5, 2, Number.MAX_SAFE_INTEGER])("rejects invalid index %s", blockIndex => {
    const bytes = encode(rows()); expect(() => extractOrcaSessionTextBlock(bytes, selector(bytes, { blockIndex }))).toThrow();
  });
  it("requires exact selected block hash and does not fall back to another block", () => {
    const bytes = encode(rows());
    expect(() => extractOrcaSessionTextBlock(bytes, selector(bytes, { blockIndex: 0 }))).toThrow("ORCA_SESSION_BLOCK_HASH_MISMATCH");
  });
  it.each([{ type: "image", text: "x" }, { type: "input_text", text: "x", extra: true },
    { type: "input_text", text: 1 }, { type: "input_text", text: "\ud800" }])("rejects unsupported unselected blocks %j", block => {
    const r = rows(); (r[2].payload.output as unknown[])[0] = block;
    const bytes = encode(r); expect(() => extractOrcaSessionTextBlock(bytes, selector(bytes))).toThrow();
  });
  it("rejects mixed call formats, duplicate calls and outputs", () => {
    for (const mode of ["mixed", "duplicateCall", "duplicateOutput"]) {
      const r = rows();
      if (mode === "mixed") r[1].payload.type = "function_call";
      if (mode === "duplicateCall") r.splice(2, 0, { ...r[1], ordinal: 2 });
      if (mode === "duplicateCall") r[3].ordinal = 3;
      if (mode === "duplicateOutput") r.push({ ...r[2], ordinal: 3 });
      const bytes = encode(r);
      expect(() => extractOrcaSessionTextBlock(bytes, selector(bytes, { ordinal: mode === "duplicateCall" ? 3 : 2 }))).toThrow();
    }
  });
  it("does not widen the ordinary string selector", () => {
    for (const custom of [true, false]) {
      const r = rows();
      if (!custom) { r[1].payload.type = "function_call"; r[2].payload.type = "function_call_output"; }
      const bytes = encode(r), { blockIndex, blockSha256, ...ordinary } = JSON.parse(selector(bytes));
      expect(() => extractOrcaSessionToolOutput(bytes, JSON.stringify(ordinary))).toThrow("INVALID_ORCA_SESSION_SOURCE");
    }
  });
});
