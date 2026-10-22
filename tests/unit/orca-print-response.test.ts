import { expect,it } from "vitest";
import { decodeOrcaPrintResponse } from "../../src/integrations/orca-print-response.js";
it("keeps raw JSON and fenced JSON separate",()=>{
  expect(decodeOrcaPrintResponse('{"verdict":"PASS"}',"raw-json-v1")).toEqual({ok:true,value:{verdict:"PASS"}});
  expect(decodeOrcaPrintResponse('```json\n{"verdict":"PASS"}\n```\n',"raw-json-v1").ok).toBe(false);
  expect(decodeOrcaPrintResponse('{"verdict":"PASS"}',"json-fence-v1").ok).toBe(false);
});
it.each(["","\n"])("accepts exactly one json fence with optional final LF %s",ending=>{
  expect(decodeOrcaPrintResponse('```json\n{"verdict":"PASS"}\n```'+ending,"json-fence-v1")).toEqual({ok:true,value:{verdict:"PASS"}});
});
it.each([
  'prefix\n```json\n{}\n```',' ```json\n{}\n```','```JSON\n{}\n```','```\n{}\n```',
  '```json\r\n{}\r\n```','```json\n{}\n```\n\n','```json\n{}\n```suffix',
  '```json\n{}\n```\n```json\n{}\n```','```json\n{} {}\n```',
  '```json\n{"x":1,"x":2}\n```','```json\n{"x":1,"\\u0078":2}\n```','```json\n{}',
])("rejects ambiguous or invalid framed input %s",input=>expect(decodeOrcaPrintResponse(input,"json-fence-v1").ok).toBe(false));
it.each([null,{},"x".repeat(262145),"汉".repeat(90000)])("rejects type or size violations",input=>expect(decodeOrcaPrintResponse(input,"json-fence-v1").ok).toBe(false));
it.each([null,"auto","json",{}])("rejects unknown explicit policy %s",format=>expect(decodeOrcaPrintResponse('{}',format as any).ok).toBe(false));
