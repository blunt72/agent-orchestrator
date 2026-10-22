import { randomUUID } from "node:crypto";
import type { ExecutionReleaseController } from "./orca-execution-release.js";
import { inspectExecutionReplyReceipt,releaseFail,releaseHash,snapshotReleaseMaterial,type ReleaseMaterial } from "./orca-execution-release-schema.js";

export interface FencedExecutionReplyTransport {
  /** Must be supported and enforced by the remote operation, not inferred from a preceding read. */
  atomicOwnershipFence:true;
  reply:(input:{identity:ReturnType<ExecutionReleaseController["match"]>["identity"];body:string;
    intentId:string;requestSha256:string;expiresAt:string})=>Promise<unknown>;
}

/** One local transport attempt; an uncertain result is never automatically retransmitted. */
export async function sendExecutionReply(controller:ExecutionReleaseController,input:ReleaseMaterial,body:string,
  transport?:FencedExecutionReplyTransport){
  const m=snapshotReleaseMaterial(input);
  if(typeof body!=="string"||Buffer.byteLength(body)<1||Buffer.byteLength(body)>16384)return releaseFail("INVALID_EXECUTION_REPLY_BODY");
  if(!transport||transport.atomicOwnershipFence!==true||typeof transport.reply!=="function")
    return releaseFail("ATOMIC_REPLY_CAPABILITY_UNAVAILABLE");
  const {inspectReleaseMaterial}=await import("./orca-execution-release-schema.js");
  const context=inspectReleaseMaterial(m);
  if(releaseHash(body)!==context.request.replyBodySha256)return releaseFail("EXECUTION_REPLY_BODY_MISMATCH");
  return controller.store.exclusive(context.taskId,async revalidate=>{
    const current=controller.store.read(context.taskId);
    if(!current)return releaseFail("EXECUTION_RELEASE_NOT_INSTALLED");
    controller.match(current.record,m);
    if(current.record.bootId!==controller.bootId)return releaseFail("EXECUTION_RELEASE_RESTART_REQUIRES_APPROVAL");
    if(current.record.state!=="INSTALLED")return releaseFail("EXECUTION_RELEASE_NOT_CONSUMABLE");
    try{controller.checkTime(m,current.record.expiresAtMonotonic);}catch(error){
      if(error instanceof Error&&error.message==="EXECUTION_RELEASE_EXPIRED")
        controller.store.save({...current.record,state:"EXPIRED"},current.pin);
      throw error;
    }
    const observed=await controller.observation(context);
    await controller.context(m);controller.checkTime(m,current.record.expiresAtMonotonic);controller.assertFresh(observed);revalidate();
    const reserved=controller.store.save({...current.record,state:"RESERVED",intentId:randomUUID()},current.pin);
    let attempted=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      controller.checkTime(m,reserved.record.expiresAtMonotonic);controller.assertFresh(observed);
      attempted=true;
      const operation=transport.reply({identity:structuredClone(context.identity),body,
        intentId:reserved.record.intentId!,requestSha256:context.requestSha256,expiresAt:context.request.expiresAt});
      const response=await Promise.race([operation,new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(Error("EXECUTION_REPLY_TIMEOUT")),5000);
      })]);
      const receipt=inspectExecutionReplyReceipt(response,context);revalidate();
      const saved=controller.store.save({...reserved.record,state:"REPLY_RECORDED",receipt},reserved.pin);
      return {...saved,transportAttempted:true,replyRecorded:true,workerReceiptVerified:false,
        workerExecutionVerified:false,canCompleteTask:false,sourceAuthenticated:false};
    }catch{
      // A failed fsync/receipt may still have an external effect. Never retry, even if local accounting fails.
      try{controller.store.save({...reserved.record,state:"OUTCOME_UNKNOWN"},reserved.pin);}catch{}
      return releaseFail(attempted?"EXECUTION_REPLY_OUTCOME_UNKNOWN":"EXECUTION_REPLY_RESERVED_NOT_SENT");
    }finally{if(timer!==undefined)clearTimeout(timer);}
  });
}

/** External lookup only; it cannot resend and does not grant execution authority after restart. */
export async function reconcileExecutionReply(controller:ExecutionReleaseController,input:ReleaseMaterial,
  lookup?:(request:{questionId:string;runId:string;dispatchId:string;replyBodySha256:string})=>Promise<unknown>){
  if(!lookup)return releaseFail("REPLY_LOOKUP_CAPABILITY_UNAVAILABLE");
  const m=snapshotReleaseMaterial(input);
  const {inspectReleaseMaterial}=await import("./orca-execution-release-schema.js");
  const context=inspectReleaseMaterial(m);
  return controller.store.exclusive(context.taskId,async revalidate=>{
    const current=controller.store.read(context.taskId);
    if(!current)return releaseFail("EXECUTION_RELEASE_NOT_INSTALLED");
    controller.match(current.record,m);
    if(!["RESERVED","OUTCOME_UNKNOWN"].includes(current.record.state))return releaseFail("EXECUTION_REPLY_NOT_RECONCILABLE");
    const query={questionId:context.identity.questionId,runId:context.identity.runId,
      dispatchId:context.identity.dispatchId,replyBodySha256:context.request.replyBodySha256};
    const receipt=inspectExecutionReplyReceipt(await lookup(query),context);
    revalidate();
    return {...controller.store.save({...current.record,state:"REPLY_RECORDED",receipt},current.pin),
      replyRecorded:true,transportAttempted:false,workerReceiptVerified:false,canCompleteTask:false};
  });
}
