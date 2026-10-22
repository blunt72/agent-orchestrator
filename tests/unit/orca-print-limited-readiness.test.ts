import { beforeEach,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({task:vi.fn(),review:vi.fn(),enrollment:vi.fn(),retained:vi.fn()}));
vi.mock("../../src/integrations/orca-print-completion-readiness.js",()=>({readOrcaPrintTaskSnapshot:mocks.task,inspectOrcaPrintCompletionReadiness:mocks.review}));
vi.mock("../../src/integrations/orca-local-enrollment.js",()=>({readOrcaTaskEnrollment:mocks.enrollment}));
vi.mock("../../src/integrations/orca-retained-terminal.js",()=>({inspectOrcaRetainedTerminalEvidence:mocks.retained}));
import { inspectOrcaPrintLimitedReadiness } from "../../src/integrations/orca-print-limited-readiness.js";
const hash="a".repeat(64),b={agenthubTaskId:"task",projectId:"project",revision:"4",generation:1,runtimeId:"runtime",hostId:"local",runId:"run",taskId:"orca-task",
  dispatchId:"dispatch",workspaceId:"workspace",workspacePath:"/workspace",terminalHandle:"terminal",developer:"codex",reviewer:"gemini",provider:"codex",ownerId:"codex",claimId:null};
const task={id:"task",projectId:"project",revision:15,status:"REVIEW",orcaBinding:b};
const e={revision:15,attempt:"recovery" as const,finalizationHash:hash,enrollmentDigest:hash,settlementSha256:hash,releaseSha256:hash,workerIncarnation:"11111111-1111-4111-8111-111111111111"};
const run=()=>inspectOrcaPrintLimitedReadiness("/project","/sessions","task",e,Buffer.from("settlement"),Buffer.from("release"));
beforeEach(()=>{vi.resetAllMocks();mocks.task.mockImplementation(()=>structuredClone(task));mocks.enrollment.mockReturnValue({digest:hash,operator:{namespace:"local",subject:"operator"}});
  mocks.retained.mockReturnValue({resourceId:"resource"});mocks.review.mockResolvedValue({subjects:{taskId:"task",revision:15}});});
it("composes synthetic local checks without approval or completion authority",async()=>{
  const r=await run();expect(r.localChecksPassed).toBe(true);expect(r.approvalIssued).toBe(false);expect(r.canCompleteTask).toBe(false);
  expect(r.retainedTerminalExceptionApproved).toBe(false);expect(r.subjects.enrollmentDigest).toBe(hash);
});
it.each(["review","enrollment","retained"])("rejects failed dependency %s",async key=>{
  mocks[key as "review"].mockImplementation(()=>{throw Error("rejected");});await expect(run()).rejects.toThrow();
});
it("rejects mismatched enrollment pin",async()=>{mocks.enrollment.mockReturnValue({digest:"b".repeat(64)});await expect(run()).rejects.toThrow();});
it("rejects task drift during awaits",async()=>{mocks.task.mockReturnValueOnce(task).mockReturnValue({...task,revision:16});await expect(run()).rejects.toThrow();});
it("rejects enrollment drift during awaits",async()=>{mocks.enrollment.mockReturnValueOnce({digest:hash}).mockReturnValue({digest:"b".repeat(64)});await expect(run()).rejects.toThrow();});
it("snapshots caller buffers before awaiting review",async()=>{
  const s=Buffer.from("settlement"),r=Buffer.from("release");mocks.review.mockImplementation(async()=>{s.fill(0);r.fill(0);return {subjects:{}};});
  await inspectOrcaPrintLimitedReadiness("/project","/sessions","task",e,s,r);
  expect(mocks.retained.mock.calls[0][1].toString()).toBe("settlement");
});
