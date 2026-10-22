import chalk from "chalk";
import { SessionStore } from "../storage/store.js";

export async function runStatusCli(sessionIdOption?: string): Promise<void> {
  const store = new SessionStore();

  let sessionData = null;
  if (sessionIdOption) {
    sessionData = await store.getSession(sessionIdOption);
  } else {
    sessionData = await store.getLatestSession();
  }

  if (!sessionData) {
    console.log(chalk.yellow("\nNo active or past sessions found.\n"));
    return;
  }

  console.log(chalk.bold.cyan("\n📊 AgentHub Session Status"));
  console.log(chalk.dim("────────────────────────────────────────"));
  console.log(`${chalk.bold("Session ID:")}   ${sessionData.id}`);
  console.log(`${chalk.bold("Workspace:")}    ${sessionData.workspace}`);
  console.log(`${chalk.bold("State:")}        ${formatState(sessionData.status)}`);
  console.log(`${chalk.bold("Round:")}        ${sessionData.round} / ${sessionData.maxRounds}`);
  console.log(`${chalk.bold("Created At:")}   ${sessionData.createdAt}`);
  console.log(`${chalk.bold("Updated At:")}   ${sessionData.updatedAt}\n`);

  console.log(chalk.bold.blue("Codex (Developer / Writer):"));
  console.log(`  status:    ${sessionData.agents.codex.status}`);
  console.log(`  session:   ${sessionData.agents.codex.sessionId || "none"}`);
  console.log(`  restarts:  ${sessionData.agents.codex.restarts}`);

  console.log(chalk.bold.magenta("\nGemini (Reviewer / Plan):"));
  console.log(`  status:    ${sessionData.agents.gemini.status}`);
  console.log(`  session:   ${sessionData.agents.gemini.sessionId || "none"}`);
  console.log(`  restarts:  ${sessionData.agents.gemini.restarts}`);

  if (sessionData.lastMessage) {
    console.log(chalk.bold.yellow("\nLast Message:"));
    console.log(`  [Round ${sessionData.lastMessage.round}] ${sessionData.lastMessage.from} → ${sessionData.lastMessage.to}`);
    console.log(`  Summary: ${sessionData.lastMessage.contentSummary}...`);
    console.log(`  Time:    ${sessionData.lastMessage.timestamp}`);
  }

  const logPath = store.getSessionLogPath(sessionData.id);
  console.log(chalk.dim(`\nLog Path: ${logPath}\n`));
}

function formatState(state: string): string {
  switch (state) {
    case "RUNNING":
      return chalk.green.bold("RUNNING");
    case "DONE":
      return chalk.green.bold("DONE");
    case "WAITING_AGENT":
      return chalk.cyan.bold("WAITING_AGENT");
    case "NEED_USER":
      return chalk.yellow.bold("NEED_USER");
    case "ERROR":
      return chalk.red.bold("ERROR");
    default:
      return chalk.gray(state);
  }
}
