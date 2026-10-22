import { Command } from "commander";
import { runPrintWorkflowCli } from "./print-workflow.js";

export function registerPrintWorkflowCommands(command: Command) {
  const output = { outputError: (_message: string, write: (message: string) => void) =>
    write(JSON.stringify({ ok: false, code: "INVALID_OPTIONS", automaticRetry: false }) + "\n") };
  command.configureOutput(output).showSuggestionAfterError(false).showHelpAfterError(false);
  for (const action of ["status", "preflight", "request", "complete", "reconcile"] as const) {
    const c = command.command(action).configureOutput(output).showSuggestionAfterError(false).showHelpAfterError(false)
      .description("One explicit print acceptance action; never launches workers, tests or models")
      .requiredOption("--input <path>", "Absolute action-specific original-byte JSON configuration")
      .requiredOption("--sha256 <digest>", "Independently selected SHA-256 of the configuration bytes");
    if (action === "request") c.requiredOption("--output <path>", "Exclusive new NOT_APPROVED request file");
    c.action(options => runPrintWorkflowCli(action, options));
  }
  return command;
}
