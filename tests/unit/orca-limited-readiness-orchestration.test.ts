import {createHash} from "node:crypto";
import {beforeEach,describe,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({task:null as any,bytes:new Map<string,Buffer>(),attributionHash:"",files:{} as any,finalHash:"",head:"a".repeat(40)}));
vi.mock("../../src/integrations/orca-read-only-store.js",()=>({OrcaReadOnlyStore:class{
 async getTask(){return structuredClone(state.task);}
 async readOrcaEvidence(ref:any){return state.bytes.get(ref.sha256)!;}
}}));
vi.mock("../../src/integrations/orca-local-enrollment.js",()=>({readOrcaTaskEnrollment:()=>({digest:"enrollment"})}));
vi.mock("../../src/integrations/orca-acceptance.js",()=>({inspectOrcaAcceptance:vi.fn(async()=>({localEvidenceConsistent:true,canCompleteTask:false})),hashOrcaReviewRun:()=>"review"}));
vi.mock("../../src/integrations/orca-review.js",()=>({hashOrcaTestRun:()=>"test"}));
vi.mock("../../src/integrations/orca-baseline.js",()=>({inspectOrcaFileAttribution:vi.fn(async()=>({workspaceHash:state.attributionHash,outsideWhitelist:[".DS_Store"],changedFiles:[".DS_Store","test.ts"]}))}));
vi.mock("../../src/git/git-service.js",()=>({GitService:{captureBaseline:vi.fn(async()=>structuredClone(state.files)),exec:vi.fn(async()=>({exitCode:0,stdout:state.head}))}}));
vi.mock("../../src/integrations/orca-tests.js",()=>({fingerprintOrcaWorkspace:vi.fn(async()=>state.finalHash)}));
vi.mock("../../src/integrations/orca-delivery.js",async importOriginal=>{
 const actual=await importOriginal<any>();return {...actual,planOrcaDelivery:vi.fn(()=>({kind:"candidate",digest:"delivery"}))};
});
vi.mock("../../src/integrations/orca-limited-exceptions.js",()=>({inspectOrcaLimitedExceptions:vi.fn(()=>({exceptionEvidenceConsistent:true,canCompleteTask:false}))}));
import {inspectOrcaLimitedReadiness} from "../../src/integrations/orca-limited-readiness.js";
import {parseOrcaCompletionBinding} from "../../src/integrations/orca-evidence-manifest.js";
import {inspectOrcaLimitedExceptions} from "../../src/integrations/orca-limited-exceptions.js";
import {fingerprintOrcaWorkspace} from "../../src/integrations/orca-tests.js";
const sha=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex");
const files=(hash:string)=>({".DS_Store":{type:"file",hash,mode:33188}});
const fingerprint=(f:object)=>sha(JSON.stringify({head:state.head,files:Object.entries(f).sort(([a],[b])=>a.localeCompare(b))}));
let raw:string;
beforeEach(()=>{
 vi.clearAllMocks();state.bytes.clear();
 const b={agenthubTaskId:"task",projectId:"project",revision:"4",generation:1,runtimeId:"runtime",hostId:"local",runId:"run",taskId:"orca-task",dispatchId:"dispatch",workspaceId:"workspace",workspacePath:"/workspace",terminalHandle:"terminal",developer:"gemini",reviewer:"codex",provider:"antigravity",ownerId:"gemini",claimId:null};
 const digest=parseOrcaCompletionBinding(JSON.stringify(b)).digest;
 function ref(v:unknown){const bytes=Buffer.from(typeof v==="string"?v:JSON.stringify(v)),key=sha(bytes);state.bytes.set(key,bytes);return {version:1,sha256:key,bytes:bytes.length};}
 const wrap=(v:unknown)=>({exit_code:0,output:JSON.stringify(v)});
 state.files=files("b".repeat(64));const A=fingerprint(state.files);state.attributionHash=A;state.finalHash=A;
 const settlement=ref(wrap({ok:true})),testOutput=ref("test output"),reviewResponse=ref("review response");
 const baseline=ref({allowedFiles:["test.ts"]});
 state.task={id:"task",revision:19,orcaBinding:b,orcaBaseline:{workspaceHash:"baseline",evidence:baseline},
  orcaDelivery:{digest:"delivery",messageId:"done"},orcaTestRun:{workspaceHash:A,outputEvidence:testOutput},orcaReviewRun:{responseEvidence:reviewResponse}};
 const entries={startup:ref({ok:true,_meta:{runtimeId:"runtime"},result:{messages:[{id:"question",type:"question",run_id:"run",from_handle:"dispatch:dispatch",to_handle:"run:run",payload:{taskId:"orca-task",dispatchId:"dispatch"}}]}}),
  binding:ref({taskId:"task",revision:4,generation:1,claimId:null,bindingDigest:digest,baselineSha256:baseline.sha256,workspaceHash:"baseline",bound:true,baselineVerified:true,developmentReleased:false,questionId:"question"}),
  bindingOutput:ref(wrap("opaque binding output")),workerDone:ref(wrap({ok:true,_meta:{runtimeId:"runtime"},result:{messages:[{id:"done",type:"worker_done",run_id:"run",from_handle:"terminal",to_handle:"run:run",payload:{taskId:"orca-task",dispatchId:"dispatch",outcome:"succeeded"}}]}})),
  settlement,testOutput,reviewResponse,cleanup:settlement};
 raw=JSON.stringify({version:1,taskId:"task",bindingDigest:digest,entries});
});
const inspect=()=>inspectOrcaLimitedReadiness("/synthetic-root","/synthetic-sessions","task",raw,sha(raw),"policy","pin");
describe("limited-readiness snapshot orchestration (isolated mocks, not E2E)",()=>{
 it("reaches preparation only for a consistent A snapshot",async()=>{
  expect(await inspect()).toMatchObject({retainedEvidenceConsistent:true,canCompleteTask:false});
  expect(inspectOrcaLimitedExceptions).toHaveBeenCalledOnce();
 });
 it("rejects A acceptance -> B attribution/capture -> A final state",async()=>{
  state.files=files("c".repeat(64));state.attributionHash=fingerprint(state.files);
  await expect(inspect()).rejects.toThrow("INVALID_LIMITED_READINESS_EVIDENCE");
  expect(inspectOrcaLimitedExceptions).not.toHaveBeenCalled();
  expect(fingerprintOrcaWorkspace).not.toHaveBeenCalled();
 });
 it("rejects A attribution -> transient B capture -> A final state",async()=>{
  state.files=files("c".repeat(64));
  await expect(inspect()).rejects.toThrow("INVALID_LIMITED_READINESS_EVIDENCE");
  expect(inspectOrcaLimitedExceptions).not.toHaveBeenCalled();
 });
});
