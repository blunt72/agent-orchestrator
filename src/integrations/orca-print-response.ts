import { decodeOrcaJson, type OrcaJsonResult } from "./orca-json.js";

export type OrcaPrintResponseFormat = "raw-json-v1" | "json-fence-v1";

/** Explicit syntax policy only; original response bytes remain the evidence. */
export function decodeOrcaPrintResponse(input:unknown,format:OrcaPrintResponseFormat):OrcaJsonResult {
  const invalid:OrcaJsonResult={ok:false,code:"INVALID_JSON"};
  if(typeof input!=="string"||input.length>262144||Buffer.byteLength(input)>262144)return invalid;
  if(format==="raw-json-v1")return decodeOrcaJson(input);
  if(format!=="json-fence-v1"||!input.startsWith("```json\n"))return invalid;
  const end=input.endsWith("\n```\n")?input.length-5:input.endsWith("\n```")?input.length-4:-1;
  if(end<8)return invalid;
  return decodeOrcaJson(input.slice(8,end));
}
