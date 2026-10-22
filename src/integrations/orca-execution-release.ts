import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { inspectOrcaPermissionPreflight } from "./orca-permission-preflight.js";
import { readOrcaPrintTaskSnapshot } from "./orca-print-completion-readiness.js";
import { ExecutionReleaseStore, type ExecutionReleaseRecord } from "./orca-execution-release-store.js";
import { inspectReleaseApproval,inspectReleaseMaterial,inspectReleaseObservation,releaseExact,releaseFail,releaseHash,
  snapshotReleaseMaterial,type ReleaseMaterial } from "./orca-execution-release-schema.js";

export interface ExecutionReleaseAdapters {
  /** Trusted operator-entry integration, never a caller-supplied approval JSON decoder. No default. */
  verifyHumanApproval?:(input:{requestSha256:string;approvalSha256:string;approvedAt:string;operator:{namespace:string;subject:string}})=>Promise<unknown>;
  /** Must observe only the exact target without consumption or lifecycle mutation. No default. */
  observe?:(identity:ReturnType<typeof inspectReleaseMaterial>["identity"])=>Promise<unknown>;
  clock?:()=>{wallMs:number;monotonicMs:number};
}
/** No CLI/runtime wiring. Adapter trust is an explicit embedding boundary, not provider authentication. */
export class ExecutionReleaseController {
  readonly store:ExecutionReleaseStore;
  readonly bootId=randomUUID();
  private previous:{wallMs:number;monotonicMs:number}|undefined;
  private clockFailed=false;
  constructor(root:string,readonly sessionsRoot:string,private readonly adapters:ExecutionReleaseAdapters={}){
    this.store=new ExecutionReleaseStore(root);
  }
  now(){
    const n=this.adapters.clock?.()??{wallMs:Date.now(),monotonicMs:performance.now()};
    if(this.clockFailed||!Number.isFinite(n.wallMs)||!Number.isFinite(n.monotonicMs)||n.wallMs<0||n.monotonicMs<0||
      n.wallMs>Number.MAX_SAFE_INTEGER||n.monotonicMs>Number.MAX_SAFE_INTEGER-900000||
      (this.previous&&(n.wallMs<this.previous.wallMs||n.monotonicMs<this.previous.monotonicMs))){
      this.clockFailed=true;return releaseFail("EXECUTION_RELEASE_CLOCK_UNVERIFIED");
    }
    this.previous={...n};return {...n};
  }
  checkTime(m:ReleaseMaterial,expiresAtMonotonic?:number){
    const c=inspectReleaseMaterial(m),now=this.now();
    if(now.wallMs<Date.parse(c.request.issuedAt)||now.wallMs>=Date.parse(c.request.expiresAt)||
      (expiresAtMonotonic!==undefined&&now.monotonicMs>=expiresAtMonotonic))
      return releaseFail("EXECUTION_RELEASE_EXPIRED");
    return now;
  }
  async context(m:ReleaseMaterial){
    const c=inspectReleaseMaterial(m);
    const before=readOrcaPrintTaskSnapshot(this.store.root,c.taskId);
    if(!before.orcaBaseline||before.pendingAgentTurn||before.pendingHumanResponse!==undefined)
      return releaseFail("EXECUTION_RELEASE_TASK_NOT_READY");
    await inspectOrcaPermissionPreflight(this.store.root,this.sessionsRoot,c.taskId,m.rawPolicy,m.permission,m.expected);
    if(!isDeepStrictEqual(readOrcaPrintTaskSnapshot(this.store.root,c.taskId),before))
      return releaseFail("EXECUTION_RELEASE_CONTEXT_CHANGED");
    return c;
  }
  async observation(c:ReturnType<typeof inspectReleaseMaterial>){
    if(!this.adapters.observe)return releaseFail("RELEASE_OBSERVATION_CAPABILITY_UNAVAILABLE");
    const start=this.now();
    inspectReleaseObservation(await this.adapters.observe(structuredClone(c.identity)),c.identity);
    return start.monotonicMs;
  }
  assertFresh(start:number){
    const n=this.now();
    if(n.monotonicMs-start>2000)return releaseFail("RELEASE_OBSERVATION_STALE");
  }
  match(record:ExecutionReleaseRecord,m:ReleaseMaterial){
    const c=inspectReleaseMaterial(m);
    if(record.taskId!==c.taskId||record.taskRevision!==c.taskRevision||record.requestSha256!==c.requestSha256||
      record.permissionSha256!==releaseHash(m.permission))return releaseFail("RELEASE_SCOPE_MISMATCH");
    return c;
  }
  async install(input:ReleaseMaterial,approvalInput:Buffer){
    const m=snapshotReleaseMaterial(input),c=inspectReleaseMaterial(m);
    const approval=Buffer.isBuffer(approvalInput)&&approvalInput.length<=32768?Buffer.from(approvalInput):releaseFail("INVALID_RELEASE_BYTES");
    const a=inspectReleaseApproval(approval,c,this.checkTime(m).wallMs);
    if(!this.adapters.verifyHumanApproval)return releaseFail("HUMAN_APPROVAL_CAPABILITY_UNAVAILABLE");
    return this.store.exclusive(c.taskId,async revalidate=>{
      // A trusted callback must bind its independent event to these exact bytes; JSON alone cannot install.
      const query={requestSha256:c.requestSha256,approvalSha256:a.approvalSha256,approvedAt:a.approvedAt,operator:c.operator};
      const attestation=await this.adapters.verifyHumanApproval!(structuredClone(query));
      if(!releaseExact(attestation,["requestSha256","approvalSha256","evidenceId","humanApprovalVerified"])||
        attestation.requestSha256!==query.requestSha256||attestation.approvalSha256!==query.approvalSha256||
        attestation.humanApprovalVerified!==true||typeof attestation.evidenceId!=="string"||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}(?![\s\S])/.test(attestation.evidenceId))return releaseFail("HUMAN_APPROVAL_NOT_VERIFIED");
      const attested=Buffer.from(JSON.stringify(attestation));
      const observed=await this.observation(c);
      await this.context(m);this.checkTime(m);this.assertFresh(observed);revalidate();
      this.store.initialize();
      if(this.store.read(c.taskId))return releaseFail("EXECUTION_RELEASE_ALREADY_EXISTS");
      this.store.archive(c.taskId,"request",m.request);this.store.archive(c.taskId,"approval",approval);
      this.store.archive(c.taskId,"permission",m.permission);this.store.archive(c.taskId,"authority",attested);
      const installedAt=this.checkTime(m);this.assertFresh(observed);
      const installed=this.store.save({version:1,taskId:c.taskId,taskRevision:c.taskRevision,requestSha256:c.requestSha256,
        approvalSha256:a.approvalSha256,permissionSha256:releaseHash(m.permission),authorityEvidenceSha256:releaseHash(attested),
        bootId:this.bootId,expiresAtMonotonic:installedAt.monotonicMs+Date.parse(c.request.expiresAt)-installedAt.wallMs,
        state:"INSTALLED",intentId:null,receipt:null,lateRevocation:false},null);
      return {...installed,scope:"LOCAL_EXECUTION_RELEASE_REGISTRY",humanApprovalVerifiedByAdapter:true,
        sourceAuthenticated:false,canReply:false,canCompleteTask:false};
    });
  }
  async revoke(taskId:string,expectedPin:string){
    return this.store.exclusive(taskId,async()=>{
      const current=this.store.read(taskId);
      if(!current||current.pin!==expectedPin)return releaseFail("EXECUTION_RELEASE_CONFLICT");
      const consumed=current.record.intentId!==null;
      return {...this.store.save({...current.record,state:consumed?current.record.state:"REVOKED",
        lateRevocation:consumed},expectedPin),late:consumed,undeliveryVerified:false,canStopOrRelease:false};
    });
  }
}
