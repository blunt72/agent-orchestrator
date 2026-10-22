import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withTaskFileLock } from "./task-file-lock.js";
import { decodeOrcaJson } from "./orca-json.js";
import { releaseDigest,releaseExact,releaseFail,releaseHash } from "./orca-execution-release-schema.js";

export type ExecutionReleaseState="INSTALLED"|"RESERVED"|"REPLY_RECORDED"|"OUTCOME_UNKNOWN"|"REVOKED"|"EXPIRED";
export interface ExecutionReleaseRecord {
  version:1; taskId:string; taskRevision:number; requestSha256:string;approvalSha256:string;permissionSha256:string;authorityEvidenceSha256:string;
  bootId:string;expiresAtMonotonic:number;state:ExecutionReleaseState;intentId:string|null;receipt:Record<string,string>|null;lateRevocation:boolean;
}
const id=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?![\s\S])/.test(v);
const uuid=(v:unknown)=>typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/.test(v);
function record(value:unknown):ExecutionReleaseRecord {
  if(!releaseExact(value,["version","taskId","taskRevision","requestSha256","approvalSha256","permissionSha256","authorityEvidenceSha256","bootId","expiresAtMonotonic","state","intentId","receipt","lateRevocation"])||
    value.version!==1||!id(value.taskId)||!Number.isSafeInteger(value.taskRevision)||value.taskRevision<1||
    ![value.requestSha256,value.approvalSha256,value.permissionSha256,value.authorityEvidenceSha256].every(releaseDigest)||!uuid(value.bootId)||
    !["INSTALLED","RESERVED","REPLY_RECORDED","OUTCOME_UNKNOWN","REVOKED","EXPIRED"].includes(value.state)||
    !Number.isFinite(value.expiresAtMonotonic)||value.expiresAtMonotonic<0||value.expiresAtMonotonic>Number.MAX_SAFE_INTEGER||
    typeof value.lateRevocation!=="boolean")return releaseFail("INVALID_EXECUTION_RELEASE_RECORD");
  const consumed=["RESERVED","REPLY_RECORDED","OUTCOME_UNKNOWN"].includes(value.state);
  if((consumed?!uuid(value.intentId):value.intentId!==null)||(!consumed&&value.lateRevocation)||
    (value.state!=="REPLY_RECORDED"?value.receipt!==null:
      !releaseExact(value.receipt,["runId","dispatchId","questionId","replyBodySha256","messageId"])||
      Object.values(value.receipt).some(v=>typeof v!=="string"||v.length<1||v.length>256)))
    return releaseFail("INVALID_EXECUTION_RELEASE_RECORD");
  return value as unknown as ExecutionReleaseRecord;
}

/** Participating-writer CAS only; local private ownership is not approval authentication. */
export class ExecutionReleaseStore {
  constructor(readonly root:string){this.baseDirectories();}
  private baseDirectories(){
    if(!process.getuid||typeof this.root!=="string"||!path.isAbsolute(this.root)||path.resolve(this.root)!==this.root)
      return releaseFail("UNSAFE_EXECUTION_RELEASE_ROOT");
    return [this.root,path.join(this.root,"data")].map(name=>this.directory(name,false));
  }
  private directory(name:string,privateMode:boolean){
    const stat=fs.lstatSync(name,{bigint:true});
    if(!stat.isDirectory()||fs.realpathSync(name)!==name||stat.uid!==BigInt(process.getuid!())||
      (stat.mode&0o022n)!==0n||(privateMode&&(stat.mode&0o777n)!==0o700n))return releaseFail("UNSAFE_EXECUTION_RELEASE_ROOT");
    return {name,stat};
  }
  private directories(){return [...this.baseDirectories(),this.directory(path.join(this.root,"data/orca-execution-v1"),true)];}
  private stable(entries:ReturnType<ExecutionReleaseStore["directories"]>){
    for(const {name,stat} of entries){
      const current=this.directory(name,name.endsWith("/orca-execution-v1")).stat;
      if(current.dev!==stat.dev||current.ino!==stat.ino||current.uid!==stat.uid||current.mode!==stat.mode)
        return releaseFail("EXECUTION_RELEASE_ROOT_CHANGED");
    }
  }
  initialize(){
    const base=this.baseDirectories(),directory=path.join(this.root,"data/orca-execution-v1");
    try{fs.mkdirSync(directory,{mode:0o700});}catch(e:any){if(e.code!=="EEXIST")throw e;}
    this.stable(base);this.directories();
  }
  async exclusive<T>(taskId:string,operation:(revalidate:()=>void)=>Promise<T>):Promise<T>{
    if(!id(taskId))return releaseFail("INVALID_RELEASE_TASK_ID");
    const before=this.baseDirectories();
    const registry=path.join(this.root,"data/orca-execution-v1");
    try{fs.lstatSync(registry);before.push(this.directory(registry,true));}catch(e:any){if(e.code!=="ENOENT")throw e;}
    const busy=()=>Error("EXECUTION_RELEASE_BUSY");
    return withTaskFileLock(this.root,taskId,"task-executions",busy,()=>
      withTaskFileLock(this.root,taskId,"task-writes",busy,async()=>{
        const revalidate=()=>this.stable(before);revalidate();
        const result=await operation(revalidate);revalidate();return result;
      }));
  }
  private name(taskId:string){
    if(!id(taskId))return releaseFail("INVALID_RELEASE_TASK_ID");
    return path.join(this.root,"data/orca-execution-v1",`${taskId}.release.json`);
  }
  private readBytes(name:string,max:number){
    const dirs=this.directories(),s=fs.lstatSync(name,{bigint:true});
    if(!s.isFile()||s.nlink!==1n||s.uid!==BigInt(process.getuid!())||(s.mode&0o777n)!==0o600n||s.size<1n||s.size>BigInt(max))
      return releaseFail("UNSAFE_EXECUTION_RELEASE_FILE");
    const same=(current:typeof s)=>["dev","ino","size","mode","uid","nlink","mtimeNs","ctimeNs"].every(k=>(current as any)[k]===(s as any)[k])&&current.isFile();
    const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try{
      if(!same(fs.fstatSync(fd,{bigint:true})))return releaseFail("EXECUTION_RELEASE_FILE_CHANGED");
      const bytes=Buffer.alloc(Number(s.size)+1);let count=0;
      while(count<bytes.length){const n=fs.readSync(fd,bytes,count,bytes.length-count,count);if(!n)break;count+=n;}
      if(count!==Number(s.size)||!same(fs.fstatSync(fd,{bigint:true}))||!same(fs.lstatSync(name,{bigint:true})))
        return releaseFail("EXECUTION_RELEASE_FILE_CHANGED");
      this.stable(dirs);return bytes.subarray(0,count);
    }finally{fs.closeSync(fd);}
  }
  read(taskId:string){
    const name=this.name(taskId);this.directories();
    try{fs.lstatSync(name);}catch(e:any){if(e.code==="ENOENT")return null;throw e;}
    const bytes=this.readBytes(name,32768),decoded=decodeOrcaJson(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    if(!decoded.ok)return releaseFail("INVALID_EXECUTION_RELEASE_RECORD");
    const value=record(decoded.value);
    if(value.taskId!==taskId)return releaseFail("RELEASE_SCOPE_MISMATCH");
    return {record:value,pin:releaseHash(bytes)};
  }
  private publish(name:string,bytes:Buffer,replace:boolean,beforeRename?:()=>void){
    const dirs=this.directories(),temporary=path.join(path.dirname(name),`.${randomUUID()}.tmp`);
    const fd=fs.openSync(temporary,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
    try{
      try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      this.stable(dirs);beforeRename?.();
      if(replace)fs.renameSync(temporary,name);else fs.linkSync(temporary,name);
    }finally{try{fs.unlinkSync(temporary);}catch(e:any){if(e.code!=="ENOENT")throw e;}}
    const directory=fs.openSync(path.dirname(name),"r");try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
    this.stable(dirs);
  }
  archive(taskId:string,kind:"request"|"approval"|"permission"|"authority",bytes:Buffer){
    this.name(taskId);
    if(!["request","approval","permission","authority"].includes(kind)||!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>32768)
      return releaseFail("INVALID_RELEASE_BYTES");
    const snapshot=Buffer.from(bytes),name=path.join(this.root,"data/orca-execution-v1",`${taskId}.${kind}.${releaseHash(snapshot)}.json`);
    try{this.publish(name,snapshot,false);}catch(e:any){if(e.code!=="EEXIST")throw e;}
    if(!this.readBytes(name,32768).equals(snapshot))return releaseFail("EXECUTION_RELEASE_ARCHIVE_CONFLICT");
  }
  save(value:ExecutionReleaseRecord,expectedPin:string|null){
    record(value);
    const bytes=Buffer.from(JSON.stringify(value));
    if(bytes.length>32768)return releaseFail("INVALID_RELEASE_BYTES");
    const check=()=>{if((this.read(value.taskId)?.pin??null)!==expectedPin)return releaseFail("EXECUTION_RELEASE_CONFLICT");};
    check();this.publish(this.name(value.taskId),bytes,expectedPin!==null,check);
    const saved=this.read(value.taskId);
    if(!saved||saved.pin!==releaseHash(bytes))return releaseFail("EXECUTION_RELEASE_WRITE_UNKNOWN");
    return saved;
  }
}
