import readline from "node:readline/promises";
import chalk from "chalk";
import ora from "ora";
import path from "node:path";
import { AgentHubOrchestrator } from "../core/orchestrator.js";
import { AgentRoleName } from "../core/message.js";

export interface ChatCliOptions {
  workspace?: string;
  first?: "codex" | "gemini";
  maxRounds?: string | number;
}

export async function runChatCli(options: ChatCliOptions): Promise<void> {
  const workspace = path.resolve(options.workspace || process.cwd());
  const firstAgent: AgentRoleName = (options.first as AgentRoleName) || "codex";
  const maxRounds = options.maxRounds ? parseInt(String(options.maxRounds), 10) : 6;

  console.log(chalk.bold.cyan("\n💬 AgentHub Interactive Chat Mode"));
  console.log(`${chalk.dim("Workspace:")}   ${workspace}`);
  console.log(`${chalk.dim("First Agent:")} ${firstAgent}`);
  console.log(`${chalk.dim("Max Rounds:")}  ${maxRounds}`);
  console.log(chalk.dim("Type your instructions below, or 'exit' / 'quit' to end.\n"));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const orchestrator = new AgentHubOrchestrator(
    {
      workspace,
      firstAgent,
      maxRounds,
    },
    {
      onRoundStart: (round, agent, role) => {
        const displayName = agent === "gemini" ? "Gemini Reviewer" : "Codex";
        console.log(chalk.bold.magenta(`\n▶ [Round ${round}] ${displayName} (${role}) starting...`));
      },
      onAgentChunk: (agent, chunk) => {
        process.stdout.write(chunk);
      },
      onRoundEnd: (round, agent, message) => {
        const displayName = agent === "gemini" ? "Gemini Reviewer" : "Codex";
        console.log(chalk.dim(`\n--- End of Round ${round} [${displayName}] (Status: ${message.status || "continue"}) ---\n`));
      },
      onWarning: (warning) => {
        console.log(chalk.yellow(`⚠ [Warning]: ${warning}`));
      },
      onError: (err) => {
        console.error(chalk.red(`✖ [Error]: ${err.message}`));
      },
    }
  );

  try {
    const initSpinner = ora("Initializing Codex & Gemini ACP Agents...").start();
    await orchestrator.initialize();
    initSpinner.succeed("Agents initialized and connected to shared workspace.\n");

    while (true) {
      const input = await rl.question(chalk.bold.green("You > "));
      const trimmed = input.trim();

      if (!trimmed) continue;
      if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
        console.log(chalk.cyan("Exiting AgentHub chat session. Goodbye!"));
        break;
      }

      console.log(chalk.dim("Dispatching task to orchestrator..."));
      const result = await orchestrator.runTask(trimmed);

      console.log(chalk.bold.cyan("\n[AgentHub Session Summary]"));
      console.log(`Status: ${result.finalState} | StopReason: ${result.stopReason || "COMPLETE"} | Rounds: ${result.totalRounds}`);
      console.log(`Log: ${result.logPath}\n`);
    }
  } catch (err: any) {
    console.error(chalk.red("\n✖ Chat session encountered an error:"), err.message);
  } finally {
    rl.close();
    await orchestrator.stop();
  }
}
