import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeEach,afterEach,expect,it,vi } from "vitest";
vi.mock("../../src/integrations/orca-permission-preflight.js",()=>({inspectOrcaPermissionPreflight:vi.fn(async()=>({localPreflightPassed:true}))}));
vi.mock("../../src/integrations/orca-print-completion-readiness.js",()=>({readOrcaPrintTaskSnapshot:vi.fn(()=>({id:"new-task",orcaBaseline:{synthetic:true}}))}));
import { inspectOrcaPermissionPreflight } from "../../src/integrations/orca-permission-preflight.js";
import { ExecutionReleaseController } from "../../src/integrations/orca-execution-release.js";
import { sendExecutionReply,reconcileExecutionReply } from "../../src/integrations/orca-execution-reply.js";
import { releaseFixture } from "./execution-release-fixture.js";

let f:ReturnType<typeof releaseFixture>;
beforeEach(()=>{vi.clearAllMocks();f=releaseFixture();});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();fs.rmSync(f.root,{recursive:true,force:true});});
const install=()=>f.controller.install(f.material,f.approval());
const send=(reply=vi.fn(async()=>f.receipt()))=>sendExecutionReply(f.controller,f.material,f.body,{atomicOwnershipFence:true,reply});

it("persists reservation before one synthetic call and records only exact reply receipt",async()=>{
  await install();
  const reply=vi.fn(async()=>{
    expect(f.controller.store.read("new-task")?.record).toMatchObject({state:"RESERVED",receipt:null});
    return f.receipt();
  });
  const result=await send(reply);
  expect(reply).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({record:{state:"REPLY_RECORDED"},workerReceiptVerified:false,
    workerExecutionVerified:false,canCompleteTask:false,sourceAuthenticated:false});
  await expect(send(reply)).rejects.toThrow("EXECUTION_RELEASE_NOT_CONSUMABLE");
  expect(reply).toHaveBeenCalledTimes(1);
});
it("refuses absence of remotely atomic ownership capability without reserving",async()=>{
  await install();
  await expect(sendExecutionReply(f.controller,f.material,f.body)).rejects.toThrow("ATOMIC_REPLY_CAPABILITY_UNAVAILABLE");
  expect(f.controller.store.read("new-task")?.record.state).toBe("INSTALLED");
});
it("rejects altered body before external invocation",async()=>{
  await install();const reply=vi.fn();
  await expect(sendExecutionReply(f.controller,f.material,"changed",{atomicOwnershipFence:true,reply})).rejects.toThrow("EXECUTION_REPLY_BODY_MISMATCH");
  expect(reply).not.toHaveBeenCalled();
});
it("does not resume an installed grant from a new controller instance",async()=>{
  await install();const c=new ExecutionReleaseController(f.root,"/synthetic-sessions",f.adapters),reply=vi.fn();
  await expect(sendExecutionReply(c,f.material,f.body,{atomicOwnershipFence:true,reply})).rejects.toThrow("EXECUTION_RELEASE_RESTART_REQUIRES_APPROVAL");
  expect(reply).not.toHaveBeenCalled();
});
it("persists expiry and rejects consumption",async()=>{
  await install();f.clock.wallMs+=300001;f.clock.monotonicMs+=300001;
  const reply=vi.fn();await expect(send(reply)).rejects.toThrow("EXECUTION_RELEASE_EXPIRED");
  expect(reply).not.toHaveBeenCalled();expect(f.controller.store.read("new-task")?.record.state).toBe("EXPIRED");
});
it("expires on elapsed monotonic time even when the wall clock is frozen",async()=>{
  await install();f.clock.monotonicMs+=300001;const reply=vi.fn();
  await expect(send(reply)).rejects.toThrow("EXECUTION_RELEASE_EXPIRED");expect(reply).not.toHaveBeenCalled();
});
it.each(["wallMs","monotonicMs"] as const)("latches %s clock regression and prohibits sends",async key=>{
  await install();f.clock[key]-=1;const reply=vi.fn();
  await expect(send(reply)).rejects.toThrow("EXECUTION_RELEASE_CLOCK_UNVERIFIED");
  f.clock[key]+=100;await expect(send(reply)).rejects.toThrow("EXECUTION_RELEASE_CLOCK_UNVERIFIED");
  expect(reply).not.toHaveBeenCalled();
});
it("revocation before reservation prohibits send",async()=>{
  const installed=await install();await f.controller.revoke("new-task",installed.pin);
  const reply=vi.fn();await expect(send(reply)).rejects.toThrow("EXECUTION_RELEASE_NOT_CONSUMABLE");
  expect(reply).not.toHaveBeenCalled();
});
it("late revocation preserves recorded external reply",async()=>{
  await install();const result=await send();const revoked=await f.controller.revoke("new-task",result.pin);
  expect(revoked).toMatchObject({record:{state:"REPLY_RECORDED",lateRevocation:true},late:true,undeliveryVerified:false});
});
it("rejects managed ownership drift before reservation",async()=>{
  await install();f.observe.mockImplementationOnce(async identity=>({...identity,ownership:"user_owned",retained:true,dispatchActive:true,questionPending:true}));
  const reply=vi.fn();await expect(send(reply)).rejects.toThrow("RELEASE_OBSERVATION_REJECTED");expect(reply).not.toHaveBeenCalled();
});
it("rejects context drift before reservation",async()=>{
  await install();vi.mocked(inspectOrcaPermissionPreflight).mockRejectedValueOnce(Error("CONTEXT_CHANGED"));
  const reply=vi.fn();await expect(send(reply)).rejects.toThrow("CONTEXT_CHANGED");expect(reply).not.toHaveBeenCalled();
});
it.each(["transport-failed","mismatch","malformed"])("marks %s outcome unknown without retries",async kind=>{
  await install();const reply=vi.fn(async()=>{
    if(kind==="transport-failed")throw Error("SENSITIVE_TRANSPORT_ERROR");
    return kind==="mismatch"?{...f.receipt(),dispatchId:"other"}:{};
  });
  await expect(send(reply)).rejects.toThrow("EXECUTION_REPLY_OUTCOME_UNKNOWN");
  expect(f.controller.store.read("new-task")?.record.state).toBe("OUTCOME_UNKNOWN");
  await expect(send(reply)).rejects.toThrow("EXECUTION_RELEASE_NOT_CONSUMABLE");expect(reply).toHaveBeenCalledTimes(1);
});
it("does not send from a crash-left reservation",async()=>{
  const installed=await install();
  f.controller.store.save({...installed.record,state:"RESERVED",intentId:randomUUID()},installed.pin);
  const reply=vi.fn();await expect(send(reply)).rejects.toThrow("EXECUTION_RELEASE_NOT_CONSUMABLE");expect(reply).not.toHaveBeenCalled();
});
it("does not call transport after failed reservation persistence",async()=>{
  await install();vi.spyOn(f.controller.store,"save").mockImplementationOnce(()=>{throw Error("FSYNC_FAILED");});
  const reply=vi.fn();await expect(send(reply)).rejects.toThrow("FSYNC_FAILED");expect(reply).not.toHaveBeenCalled();
});
it("permits one concurrent caller and refuses a competing reservation",async()=>{
  await install();let entered!:()=>void,finish!:(v:unknown)=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});
  const reply=vi.fn(async()=>{entered();return new Promise(resolve=>{finish=resolve;});});
  const first=send(reply);await ready;
  await expect(send(reply)).rejects.toThrow("EXECUTION_RELEASE_BUSY");
  finish(f.receipt());await first;expect(reply).toHaveBeenCalledTimes(1);
});
it("records timeout and ignores a late synthetic receipt without another call",async()=>{
  await install();vi.useFakeTimers();let entered!:()=>void,finish!:(v:unknown)=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});
  const reply=vi.fn(async()=>{entered();return new Promise(resolve=>{finish=resolve;});});
  const pending=send(reply).then(()=>"unexpected",error=>error.message);await ready;
  await vi.advanceTimersByTimeAsync(5001);
  expect(await pending).toBe("EXECUTION_REPLY_OUTCOME_UNKNOWN");
  finish(f.receipt());await Promise.resolve();
  expect(f.controller.store.read("new-task")?.record.state).toBe("OUTCOME_UNKNOWN");
  expect(reply).toHaveBeenCalledTimes(1);
});
it("reconciles only an exact independently supplied receipt, without sending",async()=>{
  await install();const reply=vi.fn(async()=>{throw Error("uncertain");});
  await expect(send(reply)).rejects.toThrow();
  await expect(reconcileExecutionReply(f.controller,f.material,async()=>({...f.receipt(),questionId:"other"}))).rejects.toThrow("INVALID_EXECUTION_REPLY_RECEIPT");
  const result=await reconcileExecutionReply(f.controller,f.material,async()=>f.receipt());
  expect(result).toMatchObject({record:{state:"REPLY_RECORDED"},transportAttempted:false,workerReceiptVerified:false,canCompleteTask:false});
  expect(reply).toHaveBeenCalledTimes(1);
});
