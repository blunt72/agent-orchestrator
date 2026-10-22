import chalk from "chalk";
import path from "node:path";
import ora from "ora";
import { TaskEngine } from "../tasks/task-engine.js";
import { Task, TaskPriority } from "../tasks/task.js";

export function formatTaskStatus(task: Task): string {
  const lines: string[] = [
    `${chalk.bold("Task:")}          ${task.id}`,
    `${chalk.bold("Title:")}         ${task.title}`,
    `${chalk.bold("Project:")}       ${task.projectId}`,
    `${chalk.bold("Status:")}        ${formatStatusBadge(task.status)}`,
    `${chalk.bold("Owner:")}         ${task.owner}`,
    `${chalk.bold("Reviewer:")}      ${task.reviewerId || task.reviewer || "gemini"}`,
    `${chalk.bold("Priority:")}      ${task.priority}`,
    `${chalk.bold("Branch:")}        ${task.branch || "(not created yet)"}`,
    `${chalk.bold("Worktree:")}      ${task.worktree || "(not created yet)"}`,
    `${chalk.bold("Rounds:")}        ${task.currentRound} / ${task.maxRounds}`,
    `${chalk.bold("Tests:")}         ${task.result?.testStatus || (task.status === "TESTING" ? "IN_PROGRESS" : "NOT_RUN")}`,
    `${chalk.bold("Review:")}        ${task.result?.reviewStatus || (task.status === "REVIEW" ? "IN_PROGRESS" : "NOT_RUN")}`,
    `${chalk.bold("Changed Files:")} ${task.result?.changedFiles.length ?? 0}`,
  ];

  if (task.result?.changedFiles && task.result.changedFiles.length > 0) {
    lines.push(chalk.dim("  - " + task.result.changedFiles.join("\n  - ")));
  }

  return lines.join("\n");
}

function formatStatusBadge(status: Task["status"]): string {
  switch (status) {
    case "DONE":
      return chalk.bold.green(status);
    case "FAILED":
      return chalk.bold.red(status);
    case "CANCELLED":
      return chalk.gray(status);
    case "NEED_USER":
      return chalk.bold.yellow(status);
    case "REWORK":
      return chalk.bold.magenta(status);
    case "DOING":
    case "TESTING":
    case "REVIEW":
      return chalk.bold.cyan(status);
    default:
      return chalk.white(status);
  }
}

export async function runTaskCreateCli(options: {
  project?: string;
  workspace?: string;
  title?: string;
  description?: string;
  priority?: string;
  maxRounds?: string;
  testCommand?: string;
}): Promise<void> {
  const engine = new TaskEngine();

  const projectId = options.project || "default";
  const workspace = path.resolve(options.workspace || process.cwd());
  const title = options.title || "";
  const description = options.description || title || "";

  if (!title) {
    console.error(chalk.red("Error: --title is required."));
    process.exitCode = 1;
    return;
  }

  const task = await engine.createTask({
    projectId,
    workspace,
    title,
    description,
    priority: (options.priority as TaskPriority) || "MEDIUM",
    maxRounds: options.maxRounds ? parseInt(options.maxRounds, 10) : 6,
    testCommand: options.testCommand,
  });

  console.log(chalk.bold.green("\n✓ Task Created Successfully"));
  console.log(formatTaskStatus(task));
  console.log(chalk.dim(`\nRun this task using: agenthub task run ${task.id}\n`));
}

export async function runTaskExecuteCli(taskId: string): Promise<void> {
  const engine = new TaskEngine();

  const spinner = ora({
    text: `Loading task ${taskId}...`,
    color: "cyan",
  }).start();

  try {
    const task = await engine.getTask(taskId);
    spinner.text = `Executing task ${task.id} (${task.title})...`;

    const updated = await engine.runTask(taskId);
    spinner.stop();

    console.log(chalk.bold.green("\n════════════════════════════════════════"));
    console.log(chalk.bold.green("✨ Task Execution Finished"));
    console.log(chalk.bold.green("════════════════════════════════════════"));
    console.log(formatTaskStatus(updated));
    console.log();
  } catch (err: any) {
    spinner.stop();
    console.error(chalk.bold.red("\n✖ Task Execution Failed:"), err.message);
    process.exitCode = 1;
  }
}

export async function runTaskStatusCli(taskId: string): Promise<void> {
  const engine = new TaskEngine();
  try {
    const task = await engine.getTask(taskId);
    console.log(chalk.bold.cyan("\n📋 Task Status"));
    console.log(formatTaskStatus(task));
    console.log();
  } catch (err: any) {
    console.error(chalk.red("\n✖ Error:"), err.message);
    process.exitCode = 1;
  }
}

export async function runTaskEventsCli(taskId: string): Promise<void> {
  const engine = new TaskEngine();
  try {
    const events = await engine.getStore().getEvents(taskId);
    console.log(chalk.bold.cyan(`\n📜 Event History for Task ${taskId} (${events.length} events)`));
    for (const ev of events) {
      console.log(
        `${chalk.dim(ev.timestamp)} [${chalk.bold.blue(ev.type)}] by ${chalk.yellow(ev.actor)}${
          ev.details ? ` - ${JSON.stringify(ev.details)}` : ""
        }`
      );
    }
    console.log();
  } catch (err: any) {
    console.error(chalk.red("\n✖ Error:"), err.message);
    process.exitCode = 1;
  }
}

export async function runTaskCancelCli(taskId: string): Promise<void> {
  const engine = new TaskEngine();
  try {
    await engine.cancelTask(taskId);
    console.log(chalk.bold.yellow(`\n✓ Task ${taskId} has been cancelled.`));
  } catch (err: any) {
    console.error(chalk.red("\n✖ Error:"), err.message);
    process.exitCode = 1;
  }
}
