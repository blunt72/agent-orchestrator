import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { decodeOrcaJson } from "./orca-json.js";

const root=path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const sha=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
const fail=():never=>{throw Error("FROZEN_PRINT_RUNTIME_REQUIRED");};
function read(file:string,max:number){
  const before=fs.lstatSync(file,{bigint:true});
  if(!before.isFile()||before.nlink!==1n||before.size>BigInt(max)||(before.mode&0o222n)!==0n||before.uid!==BigInt(process.getuid!())||fs.realpathSync(file)!==file)return fail();
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const same=(s:typeof before)=>s.isFile()&&s.ino===before.ino&&s.dev===before.dev&&s.size===before.size&&s.mode===before.mode&&s.uid===before.uid&&
    s.nlink===before.nlink&&s.mtimeNs===before.mtimeNs&&s.ctimeNs===before.ctimeNs;
  try{
    if(!same(fs.fstatSync(fd,{bigint:true})))return fail();const bytes=Buffer.alloc(Number(before.size)+1);let n=0;
    while(n<bytes.length){const k=fs.readSync(fd,bytes,n,bytes.length-n,n);if(!k)break;n+=k;}
    if(n!==Number(before.size)||!same(fs.fstatSync(fd,{bigint:true}))||!same(fs.lstatSync(file,{bigint:true})))return fail();return bytes.subarray(0,n);
  }finally{fs.closeSync(fd);}
}
function inspect(){
  const manifest=read(path.join(root,".print-completion-runtime-v1.json"),262144),p=decodeOrcaJson(manifest.toString("utf8")),m=p.ok?p.value as any:null;
  if(!m||Object.keys(m).sort().join(",")!=="dependencyRoot,entry,files,nodeExecutable,nodeVersion,purpose,version"||m.version!==1||m.purpose!=="FROZEN_PRINT_COMPLETION_RUNTIME"||
      m.entry!=="print-completion-entry.mjs"||m.nodeVersion!==process.version||m.nodeExecutable!==fs.realpathSync(process.execPath)||
      typeof m.dependencyRoot!=="string"||!path.isAbsolute(m.dependencyRoot)||fs.realpathSync(path.join(root,"node_modules"))!==m.dependencyRoot||
      !m.files||typeof m.files!=="object"||Array.isArray(m.files))return fail();
  const files=Object.entries(m.files);if(files.length<3||files.length>2048||!Object.hasOwn(m.files,m.entry)||!Object.hasOwn(m.files,"package.json")||
      !Object.hasOwn(m.files,"src/integrations/orca-print-task-completion.js"))return fail();
  for(const [name,digest] of files){
    if(name.length>4096||name.startsWith("/")||name.split("/").some(p=>!p||p==="."||p==="..")||name.includes("\\")||
        typeof digest!=="string"||!/^[a-f0-9]{64}(?![\s\S])/.test(digest)||
        ![".js",".mjs",".json"].includes(path.extname(name)))return fail();
    if(sha(read(path.join(root,name),4194304))!==digest)return fail();
  }
  return {digest:sha(manifest),root};
}
// A normal workspace import remains usable for preparation, never for commit.
const loaded=(()=>{try{return inspect();}catch{return null;}})();
export function inspectOrcaPrintCompletionRuntime(){
  if(!loaded||process.execArgv.length!==0||process.env.NODE_OPTIONS||!process.argv[1]||
      fs.realpathSync(process.argv[1])!==path.join(root,"print-completion-entry.mjs"))return fail();
  const current=inspect();if(current.digest!==loaded.digest||current.root!==loaded.root)return fail();return current;
}
