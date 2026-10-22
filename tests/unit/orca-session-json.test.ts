import { describe, it, expect } from "vitest";
import { decodeOrcaJson, decodeOrcaSessionRecordJson, ORCA_SESSION_JSON_MAX_BYTES } from "../../src/integrations/orca-json.js";
describe("separate bounded journal JSON (synthetic)",()=>{
  it("leaves CLI byte budget unchanged while supporting large original string records",()=>{
    const raw=JSON.stringify({output:"x".repeat(2251254)});
    expect(decodeOrcaJson(raw).ok).toBe(false);
    const result=decodeOrcaSessionRecordJson(raw);expect(result.ok).toBe(true);
    if(result.ok)expect((result.value as any).output.length).toBe(2251254);
    const cli='{}'+' '.repeat(262142);expect(decodeOrcaJson(cli).ok).toBe(true);expect(decodeOrcaJson(cli+' ').ok).toBe(false);
  });
  it("checks exact journal UTF-8 limit and one byte over",()=>{
    const raw=JSON.stringify({value:"\u4e2d"}),exact=raw+' '.repeat(ORCA_SESSION_JSON_MAX_BYTES-Buffer.byteLength(raw));
    expect(decodeOrcaSessionRecordJson(exact)).toEqual({ok:true,value:{value:"\u4e2d"}});
    expect(decodeOrcaSessionRecordJson(exact+' ').ok).toBe(false);
  });
  it("preserves node/depth limits for both entry points",()=>{
    for(const decode of [decodeOrcaJson,decodeOrcaSessionRecordJson]){
      expect(decode(JSON.stringify(Array(19999).fill(null))).ok).toBe(true);
      expect(decode(JSON.stringify(Array(20000).fill(null))).ok).toBe(false);
      expect(decode('['.repeat(24)+'0'+']'.repeat(24)).ok).toBe(true);
      expect(decode('['.repeat(25)+'0'+']'.repeat(25)).ok).toBe(false);
    }
  });
  it.each(['{"a":1,"\\u0061":2}','{"x":{"a":1,"a":2}}','"bad\\x"','"bad\\u123"','"bad\\u12xz"','"unterminated',
    '"raw\ncontrol"','{} trailing','{"x":1,}','[1,]','\ufeff{}','"trailing\\','"bad\\v"'])('rejects ambiguity and malformed string syntax %j',raw=>{
    expect(decodeOrcaJson(raw).ok).toBe(false);expect(decodeOrcaSessionRecordJson(raw).ok).toBe(false);
  });
  it("retains escape semantics and duplicate detection after iterative scanning",()=>{
    const raw='{"value":"\\\"\\\\\\/\\b\\f\\n\\r\\t\\u4e2d"}';
    for(const decode of [decodeOrcaJson,decodeOrcaSessionRecordJson])expect(decode(raw)).toEqual({ok:true,value:JSON.parse(raw)});
  });
});
