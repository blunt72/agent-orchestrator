import { expect,it } from "vitest";
import { inspectAntigravityReadStream } from "../../src/integrations/antigravity-read-stream.js";
const id="aaaaaaaa-0000-4000-8000-000000000006";
const step=(index:number,type:string,state:string,extra:any={})=>({event:"step_update",step_update:{conversation_id:id,step_index:index,step_type:type,state,...extra}});
const tool=(state:string)=>step(2,"tool",state,{tool_name:"view_file",tool_info:{name:"view_file",parameters:{AbsolutePath:"/probe/fixture.txt"},...(state==="DONE"?{output:"1 line"}:{})}});
function rows(){return [
  {event:"init",conversation_id:id,init:{cwd:"/probe",tools:["view_file"],permission_mode:"request-review"}},
  step(0,"user_input","DONE"),step(1,"agent_response","DONE"),tool("ACTIVE"),tool("DONE"),
  step(3,"agent_response","ACTIVE",{text_delta:"OK"}),step(3,"agent_response","DONE",{text_delta:"\n"}),
  {event:"result",result:{conversation_id:id,status:"SUCCESS",response:"OK\n",duration_seconds:1,num_turns:1,usage:{}}},
];}
const encode=(r:any[])=>Buffer.from(r.map(v=>JSON.stringify(v)).join("\n")+"\n");
const inspect=(r:any[])=>inspectAntigravityReadStream(encode(r),0,"/probe",["/probe/fixture.txt"]);
it("accepts only the configured optional model declaration",()=>{
  const r:any[]=rows();r[0].init.model="gemini-3.8-flash-high";
  expect(()=>inspect(r)).toThrow();
  expect(inspectAntigravityReadStream(encode(r),0,"/probe",["/probe/fixture.txt"],"gemini-3.8-flash-high").response).toBe("OK\n");
  for(const model of [null,"claude-opus-4.6","gemini-3.8-flash-low",""]){
    r[0].init.model=model;
    expect(()=>inspectAntigravityReadStream(encode(r),0,"/probe",["/probe/fixture.txt"],"gemini-3.8-flash-high")).toThrow();
  }
});
function interleaved(){
  const r:any[]=rows();
  r.splice(5,0,step(3,"agent_response","DONE"),
    step(4,"tool","ACTIVE",{tool_name:"view_file",tool_info:{name:"view_file",parameters:{AbsolutePath:"/probe/fixture.txt"}}}),
    step(4,"tool","DONE",{tool_name:"view_file",tool_info:{name:"view_file",parameters:{AbsolutePath:"/probe/fixture.txt"},output:"1 line"}}));
  r[8].step_update.step_index=5;r[9].step_update.step_index=5;return r;
}
it("accepts empty planning between completed reads",()=>expect(inspect(interleaved()).toolCount).toBe(2));
it("requires a paired read after intermediate planning",()=>{
  const r=interleaved();r.splice(6,2);r[6].step_update.step_index=4;r[7].step_update.step_index=4;
  expect(()=>inspect(r)).toThrow();
});
it("preserves distinct-path coverage across planning",()=>{
  const r=interleaved();for(const i of [6,7])r[i].step_update.tool_info.parameters.AbsolutePath="/probe/second.txt";
  expect(inspectAntigravityReadStream(encode(r),0,"/probe",["/probe/fixture.txt","/probe/second.txt"]).readPaths).toHaveLength(2);
  expect(()=>inspectAntigravityReadStream(encode(interleaved()),0,"/probe",["/probe/fixture.txt","/probe/second.txt"])).toThrow();
});
it("allows absent model declaration without authenticating configured model",()=>{
  expect(inspectAntigravityReadStream(encode(rows()),0,"/probe",["/probe/fixture.txt"],"gemini-3.8-flash-high").sourceAuthenticated).toBe(false);
});
it.each([null,"claude-opus-4.6","",{}])("rejects invalid expected model %s",model=>{
  expect(()=>inspectAntigravityReadStream(encode(rows()),0,"/probe",["/probe/fixture.txt"],model as any)).toThrow();
});
it.each(["text","tool","active","index","mid-tool"])("rejects invalid interleaved planning %s",kind=>{
  const r=interleaved(),s=r[5].step_update;
  if(kind==="text")s.text_delta="";
  if(kind==="tool")s.tool_name="run_command";
  if(kind==="active")s.state="ACTIVE";
  if(kind==="index")s.step_index=8;
  if(kind==="mid-tool"){r.splice(5,1);r.splice(4,0,step(2,"agent_response","DONE"));}
  expect(()=>inspect(r)).toThrow();
});
it("accepts the observed read sequence without authenticating file contents",()=> {
  const r=inspect(rows());expect(r.readPaths).toEqual(["/probe/fixture.txt"]);expect(r.toolCount).toBe(1);
  expect(r.fileContentsVerified).toBe(false);expect(r.canFinalizeReview).toBe(false);
});
it.each(["tool-name","outside","changed-path","extra-parameter","failed-tool","missing-start","missing-done","index","session","result","trailing","answer-without-active"])("rejects %s",kind=> {
  const r:any[]=rows();
  if(kind==="tool-name")r[3].step_update.tool_name="run_command";
  if(kind==="outside")r[3].step_update.tool_info.parameters.AbsolutePath="/other";
  if(kind==="changed-path")r[4].step_update.tool_info.parameters.AbsolutePath="/other";
  if(kind==="extra-parameter")r[3].step_update.tool_info.parameters.command="cat /other";
  if(kind==="failed-tool")r[4].step_update.state="ERROR";
  if(kind==="missing-start")r.splice(3,1);
  if(kind==="missing-done")r.splice(4,1);
  if(kind==="index")r[4].step_update.step_index=4;
  if(kind==="session")r[4].step_update.conversation_id="other";
  if(kind==="result")r[7].result.response="wrong";
  if(kind==="trailing")r.push(r[0]);
  if(kind==="answer-without-active"){r.splice(5,1);r[5].step_update.text_delta="OK\n";}
  expect(()=>inspect(r)).toThrow();
});
it.each([1,null,"0"])("rejects exit %s",code=>expect(()=>inspectAntigravityReadStream(encode(rows()),code,"/probe",["/probe/fixture.txt"])).toThrow());
it.each([[],["/probe/../file"],["/probe/file","/probe/file"],["relative"],["/probe/unused"]])("rejects missing/invalid coverage",paths=>expect(()=>inspectAntigravityReadStream(encode(rows()),0,"/probe",paths)).toThrow());
it("rejects raw malformed or oversized bytes",()=> {
  for(const b of [Buffer.from([255,10]),Buffer.from("{}"),Buffer.from('{"event":"init","event":"init"}\n'),Buffer.alloc(4194305)])
    expect(()=>inspectAntigravityReadStream(b,0,"/probe",["/probe/fixture.txt"])).toThrow();
});
