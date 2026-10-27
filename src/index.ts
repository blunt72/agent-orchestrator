#!/usr/bin/env node
import { Command } from "commander";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runDoctor } from "./cli/doctor.js";
import { runChatCli } from "./cli/chat.js";
import { runTaskCli } from "./cli/run.js";
import { runStatusCli } from "./cli/status.js";
import {
  runTaskCreateCli,
  runTaskExecuteCli,
  runTaskStatusCli,
  runTaskEventsCli,
  runTaskCancelCli,
} from "./cli/task.js";
import { startServer } from "./server/server.js";
import { runOrcaProjectionCli } from "./cli/orca-projection.js";
import { runAutomationPreflightCli } from "./cli/automation-preflight.js";
import { runLimitedWorkflowCli } from "./cli/limited-workflow.js";
import { registerPrintWorkflowCommands } from "./cli/print-workflow-commands.js";

const program = new Command();

program
  .name("agenthub")
  .description("Codex × Gemini AgentHub - Bidirectional ACP Multi-Agent Collaborator & Task Engine")
  .version("0.3.1");

// Doctor diagnostic
program
  .command("doctor")
  .description("Diagnose environment, Node.js, ACP SDK, Codex ACP, Gemini ACP, and workspace")
  .option("-w, --workspace <path>", "Path to workspace directory")
  .action(async (options) => {
    const { success } = await runDoctor(options.workspace);
    if (!success) {
      process.exitCode = 1;
    }
  });

// V0.1 Chat
program
  .command("chat")
  .description("Start interactive multi-turn AgentHub session")
  .option("-w, --workspace <path>", "Workspace directory for both agents", "./examples/demo-workspace")
  .option("-f, --first <agent>", "First agent to start turn (codex|gemini)", "codex")
  .option("-r, --max-rounds <number>", "Maximum rounds before stopping", "6")
  .action(async (options) => {
    await runChatCli(options);
  });

// V0.1 Run
program
  .command("run <task>")
  .description("Run a single goal/task across Codex and Gemini autonomously")
  .option("-w, --workspace <path>", "Workspace directory for both agents", "./examples/demo-workspace")
  .option("-f, --first <agent>", "First agent to start turn (codex|gemini)", "codex")
  .option("-r, --max-rounds <number>", "Maximum rounds before stopping", "6")
  .action(async (task, options) => {
    await runTaskCli(task, options);
  });

// V0.1 Status
program
  .command("status [sessionId]")
  .description("Show the status of the current or latest AgentHub session")
  .action(async (sessionId) => {
    await runStatusCli(sessionId);
  });

// V0.2 Task Engine Command Group
const taskCmd = program.command("task").description("Manage and execute formal development tasks");

taskCmd
  .command("create")
  .description("Create a new formal development task")
  .requiredOption("-t, --title <title>", "Task title")
  .option("-d, --description <desc>", "Detailed task description")
  .option("-p, --project <project>", "Project ID", "default")
  .option("-w, --workspace <path>", "Path to Git workspace directory", process.cwd())
  .option("--priority <priority>", "Task priority: LOW | MEDIUM | HIGH | CRITICAL", "MEDIUM")
  .option("-r, --max-rounds <number>", "Max rework rounds before pausing", "6")
  .option("--test-command <cmd>", "Custom test command override")
  .action(async (options) => {
    await runTaskCreateCli(options);
  });

taskCmd
  .command("run <taskId>")
  .description("Execute an existing task through the Worktree, Test Gate, and Reviewer flow")
  .action(async (taskId) => {
    await runTaskExecuteCli(taskId);
  });

taskCmd
  .command("status <taskId>")
  .description("Inspect the live status, branch, worktree, and results of a task")
  .action(async (taskId) => {
    await runTaskStatusCli(taskId);
  });

taskCmd
  .command("events <taskId>")
  .description("Display the audit event log stream for a task")
  .action(async (taskId) => {
    await runTaskEventsCli(taskId);
  });

taskCmd
  .command("cancel <taskId>")
  .description("Cancel a pending or running task")
  .action(async (taskId) => {
    await runTaskCancelCli(taskId);
  });

taskCmd
  .command("orca-project <taskId>")
  .description("Preview or reconcile an already imported Orca task event; never imports or approves delivery")
  .configureOutput({ outputError: (_message, write) => write(JSON.stringify({ ok: false, code: "INVALID_OPTIONS" }) + "\n") })
  .showSuggestionAfterError(false)
  .showHelpAfterError(false)
  .requiredOption("--store-root <path>", "Absolute AgentHub store root")
  .option("--apply", "Write the event projection with explicit attempt confirmation")
  .option("--revision <number>", "Expected current task revision (required with --apply)")
  .option("--generation <number>", "Expected delivery generation (required with --apply)")
  .option("--digest <sha256>", "Expected delivery digest (required with --apply)")
  .action(runOrcaProjectionCli);

const automation=program.command("automation").description("Inspect reusable project automation policies");
registerPrintWorkflowCommands(automation.command("print").description("Explicit supervised print acceptance; writes require a frozen entry"));
automation.command("preflight")
  .description("Read-only project policy check; never creates tasks or starts agents")
  .requiredOption("--policy <absolute-path>", "Operator-selected project policy JSON")
  .requiredOption("--sha256 <digest>", "Expected SHA-256 of the original policy bytes")
  .action(runAutomationPreflightCli);

const limitedErrorOutput={outputError:(_message:string,write:(message:string)=>void)=>write(JSON.stringify({ok:false,code:"INVALID_OPTIONS",automaticRetry:false})+"\n")};
const limited=automation.command("limited").description("Operator-supervised limited acceptance; never launches workers or issues approval")
 .configureOutput(limitedErrorOutput).showSuggestionAfterError(false).showHelpAfterError(false);
for(const action of ["preflight","request","complete","reconcile"] as const){
 const command=limited.command(action)
  .configureOutput(limitedErrorOutput).showSuggestionAfterError(false).showHelpAfterError(false)
  .description(action==="preflight"?"Read-only retained-evidence preflight":action==="request"?"Exclusively write a NOT_APPROVED request":"Execute exactly one explicitly approved completion action")
  .requiredOption("--store-root <path>","Absolute AgentHub store root")
  .requiredOption("--sessions-root <path>","Absolute trusted sessions root")
  .requiredOption("--task-id <id>","Exact existing bound task")
  .requiredOption("--bundle <path>","Absolute retained evidence bundle file")
  .requiredOption("--bundle-sha256 <digest>","Expected original bundle digest")
  .requiredOption("--policy <path>","Absolute task-specific limited exception policy")
  .requiredOption("--policy-sha256 <digest>","Expected original policy digest");
 if(action==="request")command.requiredOption("--output <path>","Absolute new request file; never overwritten");
 if(action==="complete"||action==="reconcile")command
  .requiredOption("--approval-sha256 <digest>","Operator-pinned private human approval digest; no approval is issued")
  .requiredOption("--implementation-sha256 <digest>","Frozen reviewed critical implementation digest");
 command.action(options=>runLimitedWorkflowCli(action,options));
}

// V0.2 REST API Server
program
  .command("server")
  .description("Start the AgentHub REST API server")
  .option("-p, --port <number>", "Port to bind to", "3000")
  .option("-H, --host <host>", "Host address to bind to", "127.0.0.1")
  .action(async (options) => {
    const port = parseInt(options.port, 10);
    const host = options.host;
    console.log(`Starting AgentHub REST API server on ${host}:${port}...`);
    const { url } = await startServer({ port, host, logger: true });
    console.log(`AgentHub REST API server listening at ${url}`);
  });

// Export library components
export * from "./agents/agent.js";
export * from "./agents/acp-agent.js";
export * from "./agents/codex-agent.js";
export * from "./agents/antigravity-agent.js";
export * from "./agents/gemini-agent.js";
export * from "./core/message.js";
export * from "./core/state-machine.js";
export * from "./core/router.js";
export * from "./core/session.js";
export * from "./core/orchestrator.js";
export * from "./storage/store.js";

// V0.2 Exports
export * from "./tasks/task.js";
export * from "./tasks/project.js";
export * from "./tasks/task-events.js";
export * from "./tasks/task-state-machine.js";
export * from "./tasks/task-store.js";
export * from "./tasks/task-runner.js";
export * from "./tasks/task-engine.js";
export * from "./git/git-service.js";
export * from "./git/worktree-manager.js";
export * from "./testing/test-detector.js";
export * from "./testing/test-runner.js";
export * from "./server/server.js";

// Run CLI if invoked directly
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  program.parse(process.argv);
}
