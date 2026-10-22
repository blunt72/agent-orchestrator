import {createHash} from "node:crypto";
import {describe,it,expect} from "vitest";
import {inspectOrcaLimitedReadiness,validateLimitedMetadataSnapshot} from "../../src/integrations/orca-limited-readiness.js";
const sha=(v:string)=>createHash("sha256").update(v).digest("hex");
const ref={version:1,sha256:"a".repeat(64),bytes:1};
const base=()=>({version:1,taskId:"task",bindingDigest:"a".repeat(64),entries:Object.fromEntries(
 ["startup","binding","bindingOutput","workerDone","settlement","testOutput","reviewResponse","cleanup"].map(role=>[role,{...ref}]))});
describe("limited readiness input boundary (synthetic)",()=>{
 it("rejects transient metadata capture even if later filesystem state is restored",()=>{
  const head="a".repeat(40),original={".DS_Store":{type:"file" as const,hash:"b".repeat(64),mode:33188}};
  const hash=sha(JSON.stringify({head,files:Object.keys(original).sort().map(k=>[k,original[k as keyof typeof original]])}));
  expect(()=>validateLimitedMetadataSnapshot(head,original,hash)).not.toThrow();
  const transient={".DS_Store":{...original[".DS_Store"],hash:"c".repeat(64)}};
  expect(()=>validateLimitedMetadataSnapshot(head,transient,hash)).toThrow();
  expect(()=>validateLimitedMetadataSnapshot(head,original,hash)).not.toThrow();
 });
 it.each(["{}","null","[]","not json","x".repeat(32769)])("rejects malformed/bounded bundle before filesystem reads %#",async raw=>{
  await expect(inspectOrcaLimitedReadiness("/nonexistent-root","/nonexistent-sessions","task",raw,sha(raw),"{}",sha("{}"))).rejects.toThrow();
 });
 it.each(["task","role","ref","extra","duplicate","pin"])("rejects changed bundle %s before filesystem reads",async kind=>{
  const v=base();if(kind==="task")v.taskId="other";
  if(kind==="role")delete v.entries.cleanup;
  if(kind==="ref")v.entries.cleanup.bytes=-1;
  if(kind==="extra")Object.assign(v,{canCompleteTask:true});
  let raw=JSON.stringify(v);if(kind==="duplicate")raw=raw.replace('"version":1','"version":1,"version":1');
  await expect(inspectOrcaLimitedReadiness("/nonexistent-root","/nonexistent-sessions","task",raw,kind==="pin"?"0".repeat(64):sha(raw),"{}",sha("{}"))).rejects.toThrow("INVALID_LIMITED_READINESS_EVIDENCE");
 });
});
