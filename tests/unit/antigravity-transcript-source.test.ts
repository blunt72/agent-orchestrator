import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { extractAntigravityTranscriptPair, ANTIGRAVITY_TRANSCRIPT_MAX_BYTES } from "../../src/integrations/antigravity-transcript-source.js";
const sha=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
const row=(source:string,type:string,content:string,created_at="2026-10-14T00:00:00Z")=>({source,type,content,created_at});
function fixture(){
  const rows=[row("USER_EXPLICIT","USER_INPUT","<USER_REQUEST>{\"review\":true}</USER_REQUEST>"),
    row("TOOL","COMMAND","synthetic tool record"),row("MODEL","PLANNER_RESPONSE","{\"verdict\":\"PASS\"}")];
  const bytes=Buffer.from(rows.map(r=>JSON.stringify(r)+"\n").join(""));
  const selector={sourceSha256:sha(bytes),requestLine:1,responseLine:3,requestSha256:sha(Buffer.from('{"review":true}')),responseSha256:sha(Buffer.from('{"verdict":"PASS"}'))};
  return {rows,bytes,selector};
}
const inspect=(f=fixture())=>extractAntigravityTranscriptPair(f.bytes,JSON.stringify(f.selector));
function refresh(f:ReturnType<typeof fixture>){f.bytes=Buffer.from(f.rows.map(r=>JSON.stringify(r)+"\n").join(""));f.selector.sourceSha256=sha(f.bytes);}
it("retains exact synthetic rows and extracted text without asserting identity, completion or authority",()=>{
  const f=fixture(),before=Buffer.from(f.bytes),result=inspect(f);
  expect(result.requestBytes.toString()).toBe('{"review":true}');
  expect(result.responseRecordBytes.toString()).toBe(JSON.stringify(f.rows[2])+"\n");
  expect(result).toMatchObject({scope:"PINNED_LOCAL_ANTIGRAVITY_TRANSCRIPT_PAIR",sourceAuthenticated:false,
    terminalIdentityVerified:false,turnCompletionVerified:false,canFinalizeReview:false,canCompleteTask:false});
  expect(f.bytes).toEqual(before);
});
it.each([["USER","REQUEST"],["USER_EXPLICIT","USER_INPUT"]])("supports known native request %s/%s without wrappers",(source,type)=>{
  const f=fixture();f.rows[0]=row(source,type,'{"review":true}');refresh(f);expect(inspect(f).requestBytes.toString()).toBe('{"review":true}');
});
it.each(["user","model"])("rejects intervening %s rather than skipping turns",kind=>{
  const f=fixture();f.rows[1]=kind==="user"?row("USER","REQUEST","other"):row("MODEL","PLANNER_RESPONSE","other");refresh(f);
  expect(()=>inspect(f)).toThrow("AMBIGUOUS_ANTIGRAVITY_TRANSCRIPT_PAIR");
});
it.each(["request-role","response-role","time","partial-wrapper","nested-wrapper","empty","surrogate"])("rejects malformed selected record %s",kind=>{
  const f=fixture();
  if(kind==="request-role")f.rows[0].source="MODEL";
  if(kind==="response-role")f.rows[2].type="THOUGHT";
  if(kind==="time")f.rows[2].created_at="2026-10-13T00:00:00Z";
  if(kind==="partial-wrapper")f.rows[0].content="<USER_REQUEST>incomplete";
  if(kind==="nested-wrapper")f.rows[0].content="<USER_REQUEST><USER_REQUEST>x</USER_REQUEST></USER_REQUEST>";
  if(kind==="empty")f.rows[2].content="";
  if(kind==="surrogate")f.rows[2].content="\ud800";
  refresh(f);expect(()=>inspect(f)).toThrow("INVALID_ANTIGRAVITY_TRANSCRIPT");
});
it.each(["source","request","response"])("rejects incorrect %s pin",kind=>{
  const f=fixture();(f.selector as any)[`${kind}Sha256`]="0".repeat(64);expect(()=>inspect(f)).toThrow();
});
it.each(["extra","fraction","order","missing","oversize-selector"])("rejects selector %s",kind=>{
  const f=fixture();let raw=JSON.stringify(f.selector);
  if(kind==="extra")raw=JSON.stringify({...f.selector,approved:true});
  if(kind==="fraction")raw=JSON.stringify({...f.selector,requestLine:1.5});
  if(kind==="order")raw=JSON.stringify({...f.selector,responseLine:1});
  if(kind==="missing")raw=JSON.stringify({...f.selector,responseLine:99});
  if(kind==="oversize-selector")raw=" ".repeat(4097);
  expect(()=>extractAntigravityTranscriptPair(f.bytes,raw)).toThrow();
});
it.each(["utf8","bom","duplicate","trailing-partial","blank","oversize-row","oversize-source","wrong-type"])("rejects invalid source %s",kind=>{
  const f=fixture();
  if(kind==="utf8")f.bytes=Buffer.from([255,10]);
  if(kind==="bom")f.bytes=Buffer.concat([Buffer.from("\ufeff"),f.bytes]);
  if(kind==="duplicate")f.bytes=Buffer.from(f.bytes.toString().replace('{','{"x":1,"x":2,'));
  if(kind==="trailing-partial")f.bytes=f.bytes.subarray(0,-1);
  if(kind==="blank")f.bytes=Buffer.concat([f.bytes,Buffer.from("\n")]);
  if(kind==="oversize-row")f.bytes=Buffer.from(JSON.stringify(row("TOOL","COMMAND","x".repeat(262144)))+"\n");
  if(kind==="oversize-source")f.bytes=Buffer.alloc(ANTIGRAVITY_TRANSCRIPT_MAX_BYTES+1,10);
  f.selector.sourceSha256=sha(f.bytes);
  if(kind==="wrong-type")f.bytes=new Uint8Array([10]) as any;
  expect(()=>inspect(f)).toThrow();
});

it("preserves unusual original row whitespace and CRLF independently of extracted text",()=>{
  const f=fixture(), lines=f.rows.map(r=>"  "+JSON.stringify(r)+" \r\n");
  f.bytes=Buffer.from(lines.join(""));f.selector.sourceSha256=sha(f.bytes);
  const result=inspect(f);
  expect(result.requestRecordBytes).toEqual(Buffer.from(lines[0]));
  expect(result.responseRecordBytes).toEqual(Buffer.from(lines[2]));
  expect(result.requestRecordSha256).toBe(sha(Buffer.from(lines[0])));
  expect(result.responseBytes.toString()).toBe('{"verdict":"PASS"}');
});
it("round trips valid UTF16 surrogate pairs without replacement",()=>{
  const f=fixture();f.rows[2].content="valid \ud83d\ude00 pair";refresh(f);
  f.selector.responseSha256=sha(Buffer.from(f.rows[2].content));
  expect(inspect(f).responseBytes.toString()).toBe(f.rows[2].content);
});
it.each(["{broken}\n",'{"source":"TOOL"}\n'])("validates malformed nonblank rows after the selected pair",suffix=>{
  const f=fixture();f.bytes=Buffer.concat([f.bytes,Buffer.from(suffix)]);f.selector.sourceSha256=sha(f.bytes);
  expect(()=>inspect(f)).toThrow("INVALID_ANTIGRAVITY_TRANSCRIPT");
});
