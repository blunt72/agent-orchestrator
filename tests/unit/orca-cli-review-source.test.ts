import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { inspectOrcaCliReviewSourceBytes } from "../../src/integrations/orca-cli-review-source.js";
const sha = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
function fixture() {
  const subjects = {reviewId:"11111111-1111-4111-8111-111111111111",taskId:"synthetic",digest:"a".repeat(64),
    generation:1,workspaceHash:"b".repeat(64),testRunId:"22222222-2222-4222-8222-222222222222",testRunHash:"c".repeat(64),
    revision:4,bindingDigest:"d".repeat(64),runtimeId:"runtime",hostId:"local",runId:"run",dispatchId:"dispatch",
    workerTerminalHandle:"worker",reviewerTerminalHandle:"reviewer",reviewerIncarnation:"33333333-3333-4333-8333-333333333333",
    turnId:"turn",developer:"codex",reviewer:"gemini"};
  const output=Buffer.from("synthetic test output\n");
  const prompt={version:1,purpose:"INDEPENDENT_STATIC_REVIEW",subjects,requirements:"Synthetic requirements, not authority",testOutputSha256:sha(output),testOutputBytes:output.length};
  const {reviewId,taskId,digest,generation,workspaceHash,testRunId,testRunHash}=subjects;
  const answer={reviewId,taskId,digest,generation,workspaceHash,testRunId,testRunHash,verdict:"PASS"};
  const source={version:1,provider:"google",adapter:"antigravity-cli",sourceKind:"original-provider-turn",status:"completed",endTurn:true,
    runtimeId:subjects.runtimeId,hostId:subjects.hostId,runId:subjects.runId,dispatchId:subjects.dispatchId,
    reviewerTerminalHandle:subjects.reviewerTerminalHandle,reviewerIncarnation:subjects.reviewerIncarnation,turnId:subjects.turnId,
    requestSha256:sha(bytes(prompt)),responseSha256:sha(bytes(answer))};
  const expectation={subjects,requestSha256:sha(bytes(prompt)),responseSha256:sha(bytes(answer)),transportSha256:sha(bytes(source)),
    testOutputSha256:sha(output),testOutputBytes:output.length,requirementsSha256:sha(prompt.requirements)};
  return {prompt,answer,source,expectation,output};
}
function inspect(f=fixture()) {
  return inspectOrcaCliReviewSourceBytes(bytes(f.prompt),bytes(f.answer),bytes(f.source),f.output,JSON.stringify(f.expectation));
}
function refresh(f: ReturnType<typeof fixture>) {
  f.expectation.requestSha256=sha(bytes(f.prompt)); f.expectation.responseSha256=sha(bytes(f.answer));
  f.source.requestSha256=f.expectation.requestSha256; f.source.responseSha256=f.expectation.responseSha256;
  f.expectation.transportSha256=sha(bytes(f.source));
}
it.each(["PASS","REQUEST_CHANGES"])("matches synthetic %s without granting trust or authority",verdict=>{
  const f=fixture(); f.answer.verdict=verdict; refresh(f);
  expect(inspect(f)).toMatchObject({verdict,scope:"SUPPLIED_CLI_REVIEW_BYTES_ONLY",suppliedEvidenceConsistent:true,sourceAuthenticated:false,
    trustedExtractionVerified:false,canFinalizeReview:false,canCompleteTask:false});
});
it.each(["reviewId","taskId","digest","generation","workspaceHash","testRunId","testRunHash"])("rejects changed response %s even with matching byte hashes",key=>{
  const f=fixture(); (f.answer as any)[key]=key==="generation"?2:"other"; refresh(f);
  expect(()=>inspect(f)).toThrow("CLI_REVIEW_RESPONSE_MISMATCH");
});
it.each(["runtimeId","hostId","runId","dispatchId","reviewerTerminalHandle","reviewerIncarnation","turnId"])("rejects changed transport %s",key=>{
  const f=fixture(); (f.source as any)[key]="other"; refresh(f);
  expect(()=>inspect(f)).toThrow("CLI_REVIEW_TRANSPORT_MISMATCH");
});
it.each(["input_accepted","running","unknown","interrupted"])("rejects noncomplete turn %s",status=>{
  const f=fixture(); f.source.status=status; refresh(f);
  expect(()=>inspect(f)).toThrow("CLI_REVIEW_TRANSPORT_MISMATCH");
});
it.each(["adapter","sourceKind","provider","endTurn"])("rejects relabeled or partial transport %s",key=>{
  const f=fixture(); (f.source as any)[key]=key==="endTurn"?false:key==="adapter"?"antigravity-agentapi":"terminal-tail"; refresh(f);
  expect(()=>inspect(f)).toThrow("CLI_REVIEW_TRANSPORT_MISMATCH");
});
it.each(Object.keys(fixture().expectation.subjects))("rejects changed request subject %s",key=>{
  const f=fixture(); f.prompt.subjects={...f.prompt.subjects,[key]:["revision","generation"].includes(key)?99:"other"}; refresh(f);
  expect(()=>inspect(f)).toThrow("CLI_REVIEW_REQUEST_MISMATCH");
});
it("rejects self review, missing/extra response identity, and changed requirements",()=>{
  const self=fixture();self.expectation.subjects.reviewerTerminalHandle=self.expectation.subjects.workerTerminalHandle;
  expect(()=>inspect(self)).toThrow("INVALID_CLI_REVIEW_EVIDENCE");
  for(const value of [{verdict:"PASS"},{...fixture().answer,extra:true}]){
    const f=fixture(); f.answer=value as any; refresh(f); expect(()=>inspect(f)).toThrow("CLI_REVIEW_RESPONSE_MISMATCH");
  }
  const f=fixture();f.prompt.requirements="changed";refresh(f);expect(()=>inspect(f)).toThrow("CLI_REVIEW_REQUEST_MISMATCH");
});
it.each(["request","response","transport","output"])("rejects raw byte changes in %s",key=>{
  const f=fixture(), inputs=[bytes(f.prompt),bytes(f.answer),bytes(f.source),f.output];
  inputs[["request","response","transport","output"].indexOf(key)][0]^=1;
  expect(()=>inspectOrcaCliReviewSourceBytes(inputs[0],inputs[1],inputs[2],inputs[3],JSON.stringify(f.expectation))).toThrow("CLI_REVIEW_BYTES_MISMATCH");
});
it.each(["request","response","transport"])("rejects duplicate JSON, BOM and invalid UTF8 in %s",target=>{
  for(const kind of ["duplicate","bom","utf8"]){
    const f=fixture(), inputs=[bytes(f.prompt),bytes(f.answer),bytes(f.source)], i=["request","response","transport"].indexOf(target);
    inputs[i]=kind==="utf8"?Buffer.from([255]):kind==="bom"?Buffer.concat([Buffer.from("\ufeff"),inputs[i]]):Buffer.from(inputs[i].toString().replace('{','{"extra":1,"extra":2,'));
    (f.expectation as any)[["requestSha256","responseSha256","transportSha256"][i]]=sha(inputs[i]);
    expect(()=>inspectOrcaCliReviewSourceBytes(inputs[0],inputs[1],inputs[2],f.output,JSON.stringify(f.expectation))).toThrow("INVALID_CLI_REVIEW_EVIDENCE");
  }
});
it("rejects extra expectation fields, duplicate keys and oversized/type-invalid inputs before matching",()=>{
  const f=fixture(), raw=JSON.stringify(f.expectation);
  for(const bad of [JSON.stringify({...f.expectation,approved:true}),raw.replace('{','{"x":1,"x":2,')," ".repeat(32769)])
    expect(()=>inspectOrcaCliReviewSourceBytes(bytes(f.prompt),bytes(f.answer),bytes(f.source),f.output,bad)).toThrow("INVALID_CLI_REVIEW_EVIDENCE");
  for(const [i,size] of [[0,262145],[1,262145],[2,32769],[3,4*1024*1024+1]]){
    const inputs=[bytes(f.prompt),bytes(f.answer),bytes(f.source),f.output];inputs[i]=Buffer.alloc(size);
    expect(()=>inspectOrcaCliReviewSourceBytes(inputs[0],inputs[1],inputs[2],inputs[3],raw)).toThrow("INVALID_CLI_REVIEW_EVIDENCE");
  }
  expect(()=>inspectOrcaCliReviewSourceBytes("not buffer" as any,bytes(f.answer),bytes(f.source),f.output,raw)).toThrow("INVALID_CLI_REVIEW_EVIDENCE");
});

it.each(["request","response","transport","expectation","output"])("accepts the exact %s byte budget without granting authority",target=>{
  const f=fixture();
  if(target==="output"){
    f.output=Buffer.alloc(4*1024*1024);
    f.prompt.testOutputBytes=f.expectation.testOutputBytes=f.output.length;
    f.prompt.testOutputSha256=f.expectation.testOutputSha256=sha(f.output);
    refresh(f);
  }
  let request=bytes(f.prompt),response=bytes(f.answer),transport=bytes(f.source);
  const pad=(b:Buffer,n:number)=>Buffer.concat([b,Buffer.alloc(n-b.length,32)]);
  if(target==="request")request=pad(request,262144);
  if(target==="response")response=pad(response,262144);
  f.expectation.requestSha256=sha(request);f.expectation.responseSha256=sha(response);
  f.source.requestSha256=sha(request);f.source.responseSha256=sha(response);
  transport=bytes(f.source);
  if(target==="transport")transport=pad(transport,32768);
  f.expectation.transportSha256=sha(transport);
  let raw=JSON.stringify(f.expectation);
  if(target==="expectation")raw+=" ".repeat(32768-Buffer.byteLength(raw));
  expect(inspectOrcaCliReviewSourceBytes(request,response,transport,f.output,raw).canFinalizeReview).toBe(false);
});

it.each(["reviewId","testRunId","reviewerIncarnation","revision","generation","developer","reviewer","bindingDigest"])("rejects malformed expected subject %s",key=>{
  const f=fixture();(f.expectation.subjects as any)[key]=["revision","generation"].includes(key)?0:"invalid";
  expect(()=>inspect(f)).toThrow("INVALID_CLI_REVIEW_EVIDENCE");
});

it("does not mutate source buffers and rejects malformed verdicts and mismatched output size",()=>{
  const f=fixture(),request=bytes(f.prompt),response=bytes(f.answer),transport=bytes(f.source),output=Buffer.from(f.output);
  const before=[request,response,transport,output].map(b=>Buffer.from(b));
  inspectOrcaCliReviewSourceBytes(request,response,transport,output,JSON.stringify(f.expectation));
  expect([request,response,transport,output]).toEqual(before);
  for(const verdict of ["pass","INVALIDATED",true,null]){
    const f=fixture();(f.answer as any).verdict=verdict;refresh(f);
    expect(()=>inspect(f)).toThrow("CLI_REVIEW_RESPONSE_MISMATCH");
  }
  f.expectation.testOutputBytes++;
  expect(()=>inspect(f)).toThrow("CLI_REVIEW_BYTES_MISMATCH");
});

it.each(["version","purpose","testOutputSha256","testOutputBytes"])("rejects changed request metadata %s with consistent outer hashes",key=>{
  const f=fixture();(f.prompt as any)[key]=key==="version"?2:key==="testOutputBytes"?999:"other";refresh(f);
  expect(()=>inspect(f)).toThrow("CLI_REVIEW_REQUEST_MISMATCH");
});
it.each(["requestSha256","responseSha256"])("rejects changed transport %s with consistent outer hash",key=>{
  const f=fixture();(f.source as any)[key]="0".repeat(64);f.expectation.transportSha256=sha(bytes(f.source));
  expect(()=>inspect(f)).toThrow("CLI_REVIEW_TRANSPORT_MISMATCH");
});
it.each(["request-extra","request-missing","transport-extra","transport-missing"])("rejects schema mismatch %s",mode=>{
  const f=fixture();
  if(mode.startsWith("request")){
    if(mode.endsWith("extra"))(f.prompt as any).approved=true;else delete (f.prompt as any).purpose;
    refresh(f);
  }else{
    if(mode.endsWith("extra"))(f.source as any).approved=true;else delete (f.source as any).status;
    f.expectation.transportSha256=sha(bytes(f.source));
  }
  expect(()=>inspect(f)).toThrow(mode.startsWith("request")?"CLI_REVIEW_REQUEST_MISMATCH":"CLI_REVIEW_TRANSPORT_MISMATCH");
});
it.each(["container-null","container-array","revision-fraction","generation-unsafe","identifier-newline","identifier-long"])("rejects expected boundary %s",mode=>{
  const f=fixture();
  if(mode==="container-null")f.expectation.subjects=null as any;
  if(mode==="container-array")f.expectation.subjects=[] as any;
  if(mode==="revision-fraction")f.expectation.subjects.revision=1.5;
  if(mode==="generation-unsafe")f.expectation.subjects.generation=Number.MAX_SAFE_INTEGER+1;
  if(mode==="identifier-newline")f.expectation.subjects.turnId="turn\n";
  if(mode==="identifier-long")f.expectation.subjects.turnId="x".repeat(257);
  expect(()=>inspect(f)).toThrow("INVALID_CLI_REVIEW_EVIDENCE");
});
it.each([0,1,2,3])("rejects non-Buffer stream %s before decoding",index=>{
  const f=fixture(),inputs:any[]=[bytes(f.prompt),bytes(f.answer),bytes(f.source),f.output];inputs[index]=new Uint8Array([1]);
  expect(()=>inspectOrcaCliReviewSourceBytes(inputs[0],inputs[1],inputs[2],inputs[3],JSON.stringify(f.expectation))).toThrow("INVALID_CLI_REVIEW_EVIDENCE");
});
