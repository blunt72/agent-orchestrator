import { describe, expect, it } from "vitest";
import { decodeOrcaJson } from "../../src/integrations/orca-json.js";

describe("Orca CLI JSON decoder (synthetic unit cases)", () => {
  it.each(['{"ok":true,"result":[null,1,-2.5e2,"a\\\"b"]}', " \n{}\t", '[{"id":1},{"id":2}]'])
    ("matches native decoding for valid data %s", input => {
      expect(decodeOrcaJson(input)).toEqual({ ok: true, value: JSON.parse(input) });
    });
  it.each(['{"id":1,"id":2}', '{"id":1,"\\u0069d":2}', '{"nested":{"x":1,"x":1}}',
    '{"__proto__":1,"__proto__":2}', '{"a":{},"a":[]}'])
    ("rejects duplicate keys %s", input => {
      expect(decodeOrcaJson(input)).toEqual({ ok: false, code: "INVALID_JSON" });
    });
  it.each(["", "undefined", "NaN", "1e999", "01", "true false", "{} log", "[1,]", '{"x":1,}',
    '{"x" 1}', '{"x":}', '"\\x20"', '"\n"', "/*comment*/{}", "\ufeff{}"])
    ("rejects malformed or non-finite data %s", input => {
      expect(decodeOrcaJson(input).ok).toBe(false);
    });
  it("rejects objects without invoking conversion", () => {
    let calls = 0;
    expect(decodeOrcaJson({ toString() { calls++; return "{}"; } }).ok).toBe(false);
    expect(calls).toBe(0);
  });
  it("enforces UTF-8 bytes including exact boundary", () => {
    const exact = JSON.stringify("界".repeat(87380) + "aa");
    expect(Buffer.byteLength(exact)).toBe(262144);
    expect(decodeOrcaJson(exact).ok).toBe(true);
    expect(decodeOrcaJson(JSON.stringify("界".repeat(87381))).ok).toBe(false);
  });
  it("bounds nesting and node count", () => {
    expect(decodeOrcaJson("[".repeat(24) + "0" + "]".repeat(24)).ok).toBe(true);
    expect(decodeOrcaJson("[".repeat(25) + "0" + "]".repeat(25)).ok).toBe(false);
    expect(decodeOrcaJson(JSON.stringify(Array(19999).fill(0))).ok).toBe(true);
    expect(decodeOrcaJson(JSON.stringify(Array(20000).fill(0))).ok).toBe(false);
  });
  it("does not interpret prototype keys or string contents as syntax", () => {
    const result = decodeOrcaJson('{"__proto__":{"polluted":true},"text":"{\\\"id\\\":1,\\\"id\\\":2}"}');
    expect(result.ok).toBe(true);
    expect(({} as any).polluted).toBeUndefined();
  });
});
