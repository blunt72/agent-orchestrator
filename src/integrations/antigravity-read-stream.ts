import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeOrcaJson } from "./orca-json.js";

const fail = ():never=>{throw new Error("INVALID_ANTIGRAVITY_READ_STREAM");};
const object=(v:any)=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const keys=(v:any,required:string[],optional:string[]=[])=>object(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const text=(v:unknown):v is string=>typeof v==="string"&&Buffer.from(v).toString("utf8")===v;
const absolute=(v:unknown):v is string=>typeof v==="string"&&v.length<=4096&&Buffer.byteLength(v)<=4096&&text(v)&&v.startsWith("/")&&!v.includes("\0")&&v.slice(1).split("/").every(p=>!!p&&p!=="."&&p!=="..");

export function snapshotAntigravityReadPaths(value:unknown):string[] {
  if(!Array.isArray(value)||!value.length||value.length>16)return fail();
  for(let i=0;i<value.length;i++)if(!Object.hasOwn(value,i)||!absolute(value[i]))return fail();
  if(new Set(value).size!==value.length)return fail();
  return [...value].sort();
}

/** Narrow observed view_file protocol. Tool records are supplied claims, not
 * execution authentication, content proof or a system read-only sandbox.
 */
export function inspectAntigravityReadStream(bytes:Buffer,exitCode:unknown,expectedCwd:string,allowedPaths:readonly string[],expectedModel?:string) {
  if(expectedModel!==undefined&&!["gemini-3.8-flash-high","gemini-3.8-flash-medium","gemini-3.8-flash-low"].includes(expectedModel))return fail();
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>4194304||bytes[bytes.length-1]!==10||exitCode!==0||!absolute(expectedCwd)||
      !Array.isArray(allowedPaths)||!allowedPaths.length||allowedPaths.length>16||!allowedPaths.every(absolute)||new Set(allowedPaths).size!==allowedPaths.length) return fail();
  const allowed=new Set(allowedPaths),read=new Set<string>();
  let id="",phase:"init"|"user"|"planning"|"tool-start"|"tool-required"|"tool-done"|"answer"|"result"|"end"="init";
  let index=0,toolPath="",response="",active=false,toolCount=0,lines=0;
  for(let offset=0,end=bytes.indexOf(10);end>=0;end=bytes.indexOf(10,offset)) {
    const line=bytes.subarray(offset,end);offset=end+1;
    if(!line.length||line.length>262144||++lines>10000||phase==="end")return fail();
    let raw:string;try{raw=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(line);}catch{return fail();}
    const parsed=decodeOrcaJson(raw),row=parsed.ok?parsed.value as any:null;if(!object(row))return fail();
    if(phase==="init"){
      if(!keys(row,["event","conversation_id","init"])||row.event!=="init"||typeof row.conversation_id!=="string"||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(row.conversation_id)||
          !keys(row.init,["cwd","tools","permission_mode"],expectedModel===undefined?[]:["model"])||
          (Object.hasOwn(row.init,"model")&&row.init.model!==expectedModel)||row.init.cwd!==expectedCwd||row.init.permission_mode!=="request-review"||
          !Array.isArray(row.init.tools)||!row.init.tools.every(text))return fail();
      id=row.conversation_id;phase="user";continue;
    }
    if(phase==="result"){
      const r=row.result;
      if(!keys(row,["event","result"])||row.event!=="result"||!keys(r,["conversation_id","status","response","duration_seconds","num_turns","usage"])||
          r.conversation_id!==id||r.status!=="SUCCESS"||r.num_turns!==1||r.response!==response||!response.length||
          typeof r.duration_seconds!=="number"||!Number.isFinite(r.duration_seconds)||r.duration_seconds<0||!object(r.usage)||read.size!==allowed.size)return fail();
      phase="end";continue;
    }
    const s=row.step_update;
    if(!keys(row,["event","step_update"])||row.event!=="step_update"||!keys(s,["conversation_id","step_index","state","step_type"],
      ["duration_seconds","usage","text_delta","tool_name","tool_info"])||s.conversation_id!==id||s.step_index!==index||
      (Object.hasOwn(s,"duration_seconds")&&(typeof s.duration_seconds!=="number"||!Number.isFinite(s.duration_seconds)||s.duration_seconds<0))||
      (Object.hasOwn(s,"usage")&&!object(s.usage)))return fail();
    if(phase==="user"){
      if(s.step_type!=="user_input"||s.state!=="DONE"||Object.hasOwn(s,"text_delta")||Object.hasOwn(s,"tool_name")||Object.hasOwn(s,"tool_info"))return fail();
      index++;phase="planning";continue;
    }
    if(phase==="planning"){
      if(s.step_type!=="agent_response"||s.state!=="DONE"||Object.hasOwn(s,"text_delta")||Object.hasOwn(s,"tool_name")||Object.hasOwn(s,"tool_info"))return fail();
      index++;phase="tool-start";continue;
    }
    if(phase==="tool-start"||phase==="tool-required"||phase==="tool-done"){
      // Empty planning may occur between completed file reads, never mid-tool.
      if(phase==="tool-start"&&toolCount>0&&s.step_type==="agent_response"&&s.state==="DONE"&&
          !Object.hasOwn(s,"text_delta")&&!Object.hasOwn(s,"tool_name")&&!Object.hasOwn(s,"tool_info")){
        index++;phase="tool-required";continue;
      }
      // After a completed tool, the next contiguous step may begin the answer.
      if(phase==="tool-start"&&toolCount>0&&s.step_type==="agent_response")phase="answer";
      else {
        const done=phase==="tool-done",info=s.tool_info;
        if(s.step_type!=="tool"||s.tool_name!=="view_file"||s.state!==(done?"DONE":"ACTIVE")||Object.hasOwn(s,"text_delta")||
            !keys(info,done?["name","parameters","output"]:["name","parameters"])||info.name!=="view_file"||
            !keys(info.parameters,["AbsolutePath"])||!allowed.has(info.parameters.AbsolutePath)||
            (done&&(!text(info.output)||info.parameters.AbsolutePath!==toolPath)))return fail();
        if(done){read.add(toolPath);index++;phase="tool-start";}
        else{if(++toolCount>32)return fail();toolPath=info.parameters.AbsolutePath;phase="tool-done";}
        continue;
      }
    }
    if(phase!=="answer"||s.step_type!=="agent_response"||!["ACTIVE","DONE"].includes(s.state)||!text(s.text_delta)||
        Object.hasOwn(s,"tool_name")||Object.hasOwn(s,"tool_info"))return fail();
    response+=s.text_delta;
    if(s.state==="ACTIVE")active=true;
    else{if(!active)return fail();phase="result";}
  }
  if(phase!=="end")return fail();
  return {conversationId:id,response,readPaths:[...read].sort(),toolCount,sourceSha256:createHash("sha256").update(bytes).digest("hex"),
    suppliedProtocolConsistent:true as const,sourceAuthenticated:false as const,fileContentsVerified:false as const,
    canFinalizeReview:false as const,canCompleteTask:false as const};
}
