import { describe, expect, it } from "vitest";
import { inspectAntigravityPrintStream } from "../../src/integrations/antigravity-print-stream.js";
const id = "aaaaaaaa-0000-4000-8000-000000000007";
function rows(): any[] { return [
  {event:"init",conversation_id:id,init:{cwd:"/probe",tools:[],permission_mode:"request-review"}},
  {event:"step_update",step_update:{conversation_id:id,step_index:0,state:"DONE",step_type:"user_input"}},
  {event:"step_update",step_update:{conversation_id:id,step_index:1,state:"ACTIVE",step_type:"agent_response",text_delta:"OK"}},
  {event:"step_update",step_update:{conversation_id:id,step_index:1,state:"DONE",step_type:"agent_response",text_delta:"\n"}},
  {event:"result",result:{conversation_id:id,status:"SUCCESS",response:"OK\n",duration_seconds:1,num_turns:1,usage:{}}},
]; }
const encode = (r: any[]) => Buffer.from(r.map(v=>JSON.stringify(v)).join("\n")+"\n");
describe("observed Antigravity no-tool print protocol",()=> {
  it("recognizes complete protocol without acceptance authority",()=> {
    const r = inspectAntigravityPrintStream(encode(rows()),0,"/probe");
    expect(r.response).toBe("OK\n"); expect(r.observedProtocolComplete).toBe(true);
    expect(r.sourceAuthenticated).toBe(false); expect(r.canFinalizeReview).toBe(false);
  });
  it.each(["missing-result","missing-done","duplicate-init","trailing-event","mixed-session","wrong-response","tool","bad-cwd","error","extra-key"])("rejects %s",kind=> {
    const r = rows();
    if(kind === "missing-result") r.pop();
    if(kind === "missing-done") r.splice(3,1);
    if(kind === "duplicate-init") r.splice(1,0,r[0]);
    if(kind === "trailing-event") r.push(r[0]);
    if(kind === "mixed-session") r[2].step_update.conversation_id = "other";
    if(kind === "wrong-response") r[4].result.response = "wrong";
    if(kind === "tool") r[2].step_update.step_type = "tool_call";
    if(kind === "bad-cwd") r[0].init.cwd = "/other";
    if(kind === "error") r[4].result.status = "ERROR";
    if(kind === "extra-key") r[4].approved = true;
    expect(()=>inspectAntigravityPrintStream(encode(r),0,"/probe")).toThrow();
  });
  it.each([1,null,"0",undefined])("rejects unsuccessful or unknown exit %s",code=>expect(()=>inspectAntigravityPrintStream(encode(rows()),code,"/probe")).toThrow());
  it("rejects DONE without ACTIVE even with matching response",()=> {
    const r = rows(); r.splice(2,1); r[2].step_update.text_delta = "OK\n";
    expect(()=>inspectAntigravityPrintStream(encode(r),0,"/probe")).toThrow();
  });
  it.each([1,2,3])("validates optional metadata at step %s", index=> {
    for (const [field,value] of [["duration_seconds","bad"],["duration_seconds",-1],["duration_seconds",null],["usage",null],["usage",[]]]) {
      const r = rows(); r[index].step_update[field as string] = value;
      expect(()=>inspectAntigravityPrintStream(encode(r),0,"/probe")).toThrow();
    }
    const r = rows(); r[index].step_update.duration_seconds = 0; r[index].step_update.usage = {};
    expect(inspectAntigravityPrintStream(encode(r),0,"/probe").observedProtocolComplete).toBe(true);
  });
  it.each([Buffer.from("{}"),Buffer.from('{"event":"init","event":"result"}\n'),Buffer.from([255,10]),Buffer.alloc(4*1024*1024+1,10)])("rejects malformed bounded bytes",bytes=>expect(()=>inspectAntigravityPrintStream(bytes,0,"/probe")).toThrow());
});
