import { Command } from "commander";
import { registerPrintWorkflowCommands } from "./print-workflow-commands.js";
import { inspectOrcaPrintCompletionRuntime } from "../integrations/orca-print-completion-runtime.js";
import { fingerprintOrcaPrintCompletionImplementation } from "../integrations/orca-print-task-completion.js";
const command = registerPrintWorkflowCommands(new Command().name("print-completion-entry"));
command.command("probe").action(() => {
  const runtime = inspectOrcaPrintCompletionRuntime();
  console.log(JSON.stringify({ ok: true, report: { runtime, implementationDigest: fingerprintOrcaPrintCompletionImplementation(),
    taskMutated: false, modelInvoked: false, approvalIssued: false } }));
});
command.parseAsync(process.argv).catch(() => {
  console.log(JSON.stringify({ ok: false, code: "PRINT_WORKFLOW_REJECTED", automaticRetry: false, outcome: "UNKNOWN_OR_REJECTED" }));
  process.exitCode = 1;
});
