import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

describe("Item 6: CLI Acceptance E2E (Sub-process Execution)", () => {
  const cliPath = path.resolve(process.cwd(), "dist/index.js");
  let testWorkspace: string;
  let createdTaskId: string = "";

  beforeAll(async () => {
    testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-cli-ws-"));
  });

  afterAll(async () => {
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
    // Clean up created task file if needed
    if (createdTaskId) {
      const taskFile = path.resolve(process.cwd(), `data/tasks/${createdTaskId}.json`);
      const eventsFile = path.resolve(process.cwd(), `logs/tasks/${createdTaskId}.jsonl`);
      if (fs.existsSync(taskFile)) fs.rmSync(taskFile, { force: true });
      if (fs.existsSync(eventsFile)) fs.rmSync(eventsFile, { force: true });
    }
  });

  it("prints version 0.3.1", async () => {
    const { stdout, stderr } = await execFileAsync("node", [cliPath, "--version"]);
    expect(stdout.trim()).toBe("0.3.1");
    expect(stderr).toBe("");
  });

  it("executes 'task create' CLI sub-process and persists task to disk", async () => {
    const { stdout, stderr } = await execFileAsync("node", [
      cliPath,
      "task",
      "create",
      "-t",
      "CLI Automated Task Creation",
      "-d",
      "Created via CLI subprocess test",
      "-p",
      "cli-test-project",
      "-w",
      testWorkspace,
      "--priority",
      "HIGH",
    ]);

    expect(stdout).toContain("Task Created Successfully");
    expect(stdout).toContain("CLI Automated Task Creation");
    expect(stdout).toContain("HIGH");

    // Match Task ID
    const match = stdout.match(/Task:\s+(TASK-[A-Z0-9-]+)/);
    expect(match).toBeTruthy();
    createdTaskId = match![1];

    // Verify task exists on disk
    const taskFilePath = path.resolve(process.cwd(), `data/tasks/${createdTaskId}.json`);
    expect(fs.existsSync(taskFilePath)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(taskFilePath, "utf-8"));
    expect(saved.id).toBe(createdTaskId);
    expect(saved.title).toBe("CLI Automated Task Creation");
    expect(saved.priority).toBe("HIGH");
    expect(saved.status).toBe("TODO");
  });

  it("executes 'task status' CLI sub-process", async () => {
    expect(createdTaskId).toBeTruthy();

    const { stdout } = await execFileAsync("node", [
      cliPath,
      "task",
      "status",
      createdTaskId,
    ]);

    expect(stdout).toContain("Task Status");
    expect(stdout).toContain(createdTaskId);
    expect(stdout).toContain("CLI Automated Task Creation");
    expect(stdout).toContain("TODO");
    expect(stdout).toContain("HIGH");
  });

  it("executes 'task events' CLI sub-process", async () => {
    expect(createdTaskId).toBeTruthy();

    const { stdout } = await execFileAsync("node", [
      cliPath,
      "task",
      "events",
      createdTaskId,
    ]);

    expect(stdout).toContain(`Event History for Task ${createdTaskId}`);
    expect(stdout).toContain("TASK_CREATED");
  });

  it("executes 'task cancel' CLI sub-process and transitions task to CANCELLED", async () => {
    expect(createdTaskId).toBeTruthy();

    const { stdout: cancelStdout } = await execFileAsync("node", [
      cliPath,
      "task",
      "cancel",
      createdTaskId,
    ]);

    expect(cancelStdout).toContain(`Task ${createdTaskId} has been cancelled.`);

    // Check status via CLI
    const { stdout: statusStdout } = await execFileAsync("node", [
      cliPath,
      "task",
      "status",
      createdTaskId,
    ]);
    expect(statusStdout).toContain("CANCELLED");

    // Check disk file directly
    const taskFilePath = path.resolve(process.cwd(), `data/tasks/${createdTaskId}.json`);
    const saved = JSON.parse(fs.readFileSync(taskFilePath, "utf-8"));
    expect(saved.status).toBe("CANCELLED");
  });
});
