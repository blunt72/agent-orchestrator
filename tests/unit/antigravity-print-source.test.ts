import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { inspectAntigravityPrintSource } from "../../src/integrations/antigravity-print-source.js";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const encode = (v: unknown) => Buffer.from(JSON.stringify(v));
function fixture() {
  const id = "aaaaaaaa-0000-4000-8000-000000000003", request = Buffer.from("diagnostic"), stderr = Buffer.alloc(0);
  const stdout = Buffer.from([
    {event:"init",conversation_id:id,init:{cwd:"/probe",tools:[],permission_mode:"request-review"}},
    {event:"step_update",step_update:{conversation_id:id,step_index:0,state:"DONE",step_type:"user_input"}},
    {event:"step_update",step_update:{conversation_id:id,step_index:1,state:"ACTIVE",step_type:"agent_response",text_delta:"OK"}},
    {event:"step_update",step_update:{conversation_id:id,step_index:1,state:"DONE",step_type:"agent_response",text_delta:"\n"}},
    {event:"result",result:{conversation_id:id,status:"SUCCESS",response:"OK\n",duration_seconds:1,num_turns:1,usage:{}}},
  ].map(v=>JSON.stringify(v)).join("\n")+"\n");
  const intent = {version:1,requestId:id,executable:"/bin/agy",cwd:"/probe",requestSha256:sha(request),requestBytes:request.length,createdAt:"2026-10-14T00:00:00Z",automaticRetry:false};
  const receipt = {version:1,requestId:id,pid:123,code:0,signal:null,closedAt:"2026-10-14T00:00:01Z",failure:null,
    stdoutBytes:stdout.length,stderrBytes:0,stdoutSha256:sha(stdout),stderrSha256:sha(stderr),truncated:false,automaticRetry:false,
    sourceAuthenticated:false,terminalIdentityVerified:false,canFinalizeReview:false,canCompleteTask:false};
  const expected = {requestId:id,cwd:"/probe",executable:"/bin/agy",requestSha256:sha(request)};
  return {request,stdout,stderr,intent,receipt,expected};
}
const inspect = (f: ReturnType<typeof fixture>) => inspectAntigravityPrintSource(f.request,encode(f.intent),f.stdout,f.stderr,encode(f.receipt),JSON.stringify(f.expected));
it("matches a supplied bundle without claiming launch authority",()=> {
  const r = inspect(fixture()); expect(r.response).toBe("OK\n"); expect(r.adapter).toBe("antigravity-print");
  expect(r.trustedExtractionVerified).toBe(false); expect(r.canFinalizeReview).toBe(false);
});
it.each(["request","stdout","stderr","id","cwd","executable","exit","signal","failure","truncated","authority","time","extra"])("rejects %s mismatch",kind=> {
  const f = fixture();
  if(kind === "request") f.request = Buffer.from("changed");
  if(kind === "stdout") f.stdout = Buffer.from("{}\n");
  if(kind === "stderr") f.stderr = Buffer.from("changed");
  if(kind === "id") f.receipt.requestId = "other";
  if(kind === "cwd") f.expected.cwd = "/other";
  if(kind === "executable") f.expected.executable = "/other";
  if(kind === "exit") f.receipt.code = 1;
  if(kind === "signal") (f.receipt as any).signal = "SIGTERM";
  if(kind === "failure") (f.receipt as any).failure = "TIMEOUT";
  if(kind === "truncated") f.receipt.truncated = true;
  if(kind === "authority") f.receipt.canFinalizeReview = true;
  if(kind === "time") f.receipt.closedAt = "2026-10-13T00:00:00Z";
  if(kind === "extra") (f.intent as any).turnId = "invented";
  expect(()=>inspect(f)).toThrow();
});
it("rejects duplicate keys in the original receipt",()=> {
  const f = fixture(), p = encode(f.receipt).toString().replace('"code":0','"code":0,"code":0');
  expect(()=>inspectAntigravityPrintSource(f.request,encode(f.intent),f.stdout,f.stderr,Buffer.from(p),JSON.stringify(f.expected))).toThrow();
});
it("rejects oversized request before parsing",()=> { const f = fixture(); f.request = Buffer.alloc(65537); expect(()=>inspect(f)).toThrow(); });
it.each(["sourceAuthenticated","terminalIdentityVerified","canFinalizeReview","canCompleteTask"])("rejects asserted %s authority",field=> {
  const f = fixture(); (f.receipt as any)[field] = true; expect(()=>inspect(f)).toThrow();
});
it.each(["stdoutBytes","stderrBytes"])("rejects mismatched %s count",field=> {
  const f = fixture(); (f.receipt as any)[field]++; expect(()=>inspect(f)).toThrow();
});
it("rejects malformed request UTF-8 even with matching hashes",()=> {
  const f = fixture(); f.request = Buffer.from([255]); f.intent.requestSha256 = sha(f.request);
  f.intent.requestBytes = f.request.length; f.expected.requestSha256 = sha(f.request);
  expect(()=>inspect(f)).toThrow();
});
it.each([0,1,2,3,4])("rejects non-buffer input %s before processing",index=> {
  const f = fixture(), args: any[] = [f.request,encode(f.intent),f.stdout,f.stderr,encode(f.receipt),JSON.stringify(f.expected)];
  args[index] = "not-bytes";
  expect(()=>inspectAntigravityPrintSource(...args as Parameters<typeof inspectAntigravityPrintSource>)).toThrow();
});
it.each([[1,32769],[2,4194305],[3,4194305],[4,32769]])("rejects oversized input %s",(index,size)=> {
  const f = fixture(), args: any[] = [f.request,encode(f.intent),f.stdout,f.stderr,encode(f.receipt),JSON.stringify(f.expected)];
  args[index] = Buffer.alloc(size);
  expect(()=>inspectAntigravityPrintSource(...args as Parameters<typeof inspectAntigravityPrintSource>)).toThrow();
});
it("rejects non-string or oversized expectations",()=> {
  const f = fixture(); for(const e of [null,{},"x".repeat(32769)])
    expect(()=>inspectAntigravityPrintSource(f.request,encode(f.intent),f.stdout,f.stderr,encode(f.receipt),e as string)).toThrow();
});
