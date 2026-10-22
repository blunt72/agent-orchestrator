import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { ExecutionReleaseController } from "../../src/integrations/orca-execution-release.js";
import { parseOrcaCompletionBinding } from "../../src/integrations/orca-evidence-manifest.js";
import { releaseHash,type ReleaseMaterial } from "../../src/integrations/orca-execution-release-schema.js";

export function releaseFixture(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"release-synthetic-")));
  fs.mkdirSync(path.join(root,"data"));
  const clock={wallMs:Date.now(),monotonicMs:1000};
  const binding={agenthubTaskId:"new-task",projectId:"project",revision:"4",generation:1,runtimeId:"synthetic-runtime",hostId:"local",
    runId:"synthetic-run",taskId:"synthetic-orca-task",dispatchId:"synthetic-dispatch",workspaceId:"workspace",workspacePath:"/synthetic-workspace",
    terminalHandle:"term_synthetic",developer:"codex",reviewer:"gemini",provider:"codex",ownerId:"codex",claimId:null};
  const rawBinding=JSON.stringify(binding),operator={namespace:"agenthub-local-operator-v1",subject:"synthetic-operator"};
  const h="a".repeat(64),body="Synthetic release body; never sent to Orca.";
  const subjects={taskId:binding.agenthubTaskId,projectId:binding.projectId,generation:1,
    bindingDigest:parseOrcaCompletionBinding(rawBinding).digest,runtimeId:binding.runtimeId,runId:binding.runId,
    orcaTaskId:binding.taskId,dispatchId:binding.dispatchId,terminalHandle:binding.terminalHandle,
    workerIncarnation:"11111111-1111-4111-8111-111111111111",resourceId:"wtr_synthetic",taskRevision:4,
    questionId:"msg_111111111111",policySha256:h,workspaceHash:h};
  const permission=Buffer.from(JSON.stringify({version:1,purpose:"TASK_SCOPED_ORCA_EXECUTION_PERMISSION",
    approvedAt:new Date(clock.wallMs-50).toISOString(),operator,sourceAuthenticated:false,subjects}));
  const request={version:1,purpose:"TASK_SCOPED_ORCA_EXECUTION_RELEASE_REQUEST",decision:"NOT_APPROVED",
    requestId:"aaaaaaaa-0000-4000-8000-000000000005",permissionSha256:releaseHash(permission),enrollmentDigest:h,
    replyBodySha256:releaseHash(body),issuedAt:new Date(clock.wallMs-100).toISOString(),expiresAt:new Date(clock.wallMs+300000).toISOString()};
  const material:ReleaseMaterial={request:Buffer.from(JSON.stringify(request)),permission,rawBinding,rawPolicy:"synthetic-policy",
    expected:{permissionSha256:releaseHash(permission),enrollmentDigest:h,operator,questionId:subjects.questionId,
      policySha256:h,workspaceHash:h,workerIncarnation:subjects.workerIncarnation,resourceId:subjects.resourceId,taskRevision:4}};
  const approval=()=>Buffer.from(JSON.stringify({version:1,purpose:"TASK_SCOPED_ORCA_EXECUTION_RELEASE_APPROVAL",decision:"APPROVED",
    requestSha256:releaseHash(material.request),approvedAt:new Date(clock.wallMs).toISOString(),operator}));
  const verifyHumanApproval=vi.fn(async(input:any)=>({requestSha256:input.requestSha256,
    approvalSha256:input.approvalSha256,humanApprovalVerified:true,evidenceId:"synthetic-event-not-human-approval"}));
  const observe=vi.fn(async(identity:any)=>({...identity,ownership:"managed",retained:false,dispatchActive:true,questionPending:true}));
  const adapters={verifyHumanApproval,observe,clock:()=>({...clock})};
  const controller=new ExecutionReleaseController(root,path.join(root,"synthetic-sessions"),adapters);
  const receipt=()=>({runId:subjects.runId,dispatchId:subjects.dispatchId,questionId:subjects.questionId,
    replyBodySha256:releaseHash(body),messageId:"msg_222222222222"});
  return {root,clock,binding,subjects,request,material,approval,body,verifyHumanApproval,observe,adapters,controller,receipt};
}
