import { expect,it } from "vitest";
import { inspectOrcaPrintCompletionRuntime } from "../../src/integrations/orca-print-completion-runtime.js";
import { completeOrcaPrintTaskLimited } from "../../src/integrations/orca-print-task-completion.js";
it("rejects completion runtime identity from an ordinary workspace import",()=>{
  expect(()=>inspectOrcaPrintCompletionRuntime()).toThrow("FROZEN_PRINT_RUNTIME_REQUIRED");
});
it("rejects live completion outside the frozen standalone entry before task writes",async()=>{
  await expect(completeOrcaPrintTaskLimited({projectRoot:"/not-a-runtime-project",sessionsRoot:"/not-a-session-root",taskId:"task",
    expectedApprovalDigest:"a".repeat(64),expectedImplementationDigest:"b".repeat(64),action:"complete",settlement:Buffer.from("x"),release:Buffer.from("x")}))
    .rejects.toThrow("FROZEN_PRINT_RUNTIME_REQUIRED");
});
