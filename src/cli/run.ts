import chalk from "chalk";
import ora from "ora";
import path from "node:path";
import { AgentHubOrchestrator } from "../core/orchestrator.js";
import { AgentRoleName } from "../core/message.js";

export interface RunCliOptions {
  workspace?: string;
  first?: "codex" | "gemini";
  maxRounds?: string | number;
}

export async function runTaskCli(task: string, options: RunCliOptions): Promise<void> {
  const workspace = path.resolve(options.workspace || process.cwd());
  const firstAgent: AgentRoleName = (options.first as AgentRoleName) || "codex";
  const maxRounds = options.maxRounds ? parseInt(String(options.maxRounds), 10) : 6;

  console.log(chalk.bold.cyan("\n🚀 AgentHub Task Execution"));
  console.log(`${chalk.dim("Workspace:")}   ${workspace}`);
  console.log(`${chalk.dim("First Agent:")} ${firstAgent}`);
  console.log(`${chalk.dim("Max Rounds:")}  ${maxRounds}`);
  console.log(`${chalk.dim("Task:")}        ${task}\n`);

  const spinner = ora({
    text: "Initializing Agents (Codex & Gemini Reviewer)...",
    color: "cyan",
  }).start();

  let currentRoundNum = 0;
  let currentAgentName = "";

  const orchestrator = new AgentHubOrchestrator(
    {
      workspace,
      firstAgent,
      maxRounds,
    },
    {
      onRoundStart: (round, agent, role) => {
        currentRoundNum = round;
        currentAgentName = agent;
        const displayName = agent === "gemini" ? "Gemini Reviewer" : "Codex";
        spinner.text = `[Round ${round}] ${displayName} (${role}) is processing...`;
      },
      onAgentChunk: (agent, chunk) => {
        // can be used for streaming if spinner is paused
      },
      onRoundEnd: (round, agent, message) => {
        spinner.stop();
        const displayName = agent === "gemini" ? "Gemini Reviewer" : "Codex";
        console.log(chalk.bold.blue(`\n--- [Round ${round}] [${displayName}] ---`));
        console.log(message.content);
        console.log(chalk.dim(`Status: ${message.status || "continue"} | StopReason: ${message.stopReason || "none"}\n`));
        spinner.start(`Waiting for next turn...`);
      },
      onWarning: (warning) => {
        spinner.stop();
        console.log(chalk.yellow(`⚠ [Warning]: ${warning}`));
        spinner.start();
      },
      onError: (err) => {
        spinner.stop();
        console.error(chalk.red(`✖ [Error]: ${err.message}`));
      },
    }
  );

  try {
    const result = await orchestrator.runTask(task);
    spinner.stop();

    console.log(chalk.bold.green("\n════════════════════════════════════════"));
    console.log(chalk.bold.green("✨ Task Execution Completed"));
    console.log(chalk.bold.green("════════════════════════════════════════"));
    console.log(`${chalk.bold("Session ID:")}   ${result.sessionId}`);
    console.log(`${chalk.bold("Total Rounds:")} ${result.totalRounds}`);
    console.log(`${chalk.bold("Final State:")}  ${result.finalState}`);
    console.log(`${chalk.bold("Stop Reason:")}  ${result.stopReason || "COMPLETE"}`);
    console.log(`${chalk.bold("Log File:")}     ${result.logPath}\n`);
  } catch (err: any) {
    spinner.stop();
    console.error(chalk.bold.red("\n✖ Execution failed:"), err.message);
    process.exitCode = 1;
  } finally {
    await orchestrator.stop();
  }
}
