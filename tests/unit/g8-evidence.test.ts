import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GitService } from "../../src/git/git-service.js";
import { ProjectEngine } from "../../src/projects/project-engine.js";
import { formatTaskStatus } from "../../src/cli/task.js";
import { Agent, AgentResponse } from "../../src/agents/agent.js";
import { Task } from "../../src/tasks/task.js";

class ScriptedDeveloperAgent implements Agent {
  public readonly name = "codex";
  public initialized = false;
  private onPrompt?: (sessionId: string, prompt: string) => Promise<AgentResponse>;

  constructor(onPrompt?: (sessionId: string, prompt: string) => Promise<AgentResponse>) {
    this.onPrompt = onPrompt;
  }

  async start(): Promise<void> {}
  async initialize(): Promise<void> { this.initialized = true; }
  async createSession(): Promise<string> { return "dev-sess"; }
  async restorePendingTurn(checkpoint: any): Promise<string> { return checkpoint.sessionId; }
  async waitForPendingTurn(): Promise<AgentResponse> { return { text: "Implemented changes.\nAGENT_STATUS: CONTINUE" }; }
  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    if (this.onPrompt) return this.onPrompt(sessionId, message);
    return { text: "Implemented changes.\nAGENT_STATUS: CONTINUE" };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
  isRunning(): boolean { return this.initialized; }
}

class ScriptedReviewerAgent implements Agent {
  public readonly name = "gemini";
  public initialized = false;
  private onPrompt?: (sessionId: string, prompt: string) => Promise<AgentResponse>;

  constructor(onPrompt?: (sessionId: string, prompt: string) => Promise<AgentResponse>) {
    this.onPrompt = onPrompt;
  }

  async start(): Promise<void> {}
  async initialize(): Promise<void> { this.initialized = true; }
  async createSession(): Promise<string> { return "rev-sess"; }
  async restorePendingTurn(checkpoint: any): Promise<string> { return checkpoint.sessionId; }
  async waitForPendingTurn(): Promise<AgentResponse> { return { text: "REVIEW_STATUS: PASS\nAGENT_STATUS: DONE" }; }
  async prompt(sessionId: string, message: string): Promise<AgentResponse> {
    if (this.onPrompt) return this.onPrompt(sessionId, message);
    return { text: "REVIEW_STATUS: PASS\nAGENT_STATUS: DONE" };
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
  isRunning(): boolean { return this.initialized; }
}

describe("G8-REPAIR Evidence & Baseline Tests", () => {
  let tempBaseDir: string;
  let testRepoDir: string;

  beforeEach(async () => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "g8-base-"));
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "g8-repo-"));

    await GitService.exec(["init"], testRepoDir);
    await GitService.exec(["config", "user.name", "G8 Tester"], testRepoDir);
    await GitService.exec(["config", "user.email", "g8@test.local"], testRepoDir);

    fs.writeFileSync(path.join(testRepoDir, "README.md"), "# Initial Repo\n", "utf-8");
    fs.writeFileSync(
      path.join(testRepoDir, "package.json"),
      JSON.stringify({ name: "g8-test", scripts: { test: "node test.js" } }),
      "utf-8"
    );
    fs.writeFileSync(path.join(testRepoDir, "test.js"), "process.exit(0);", "utf-8");

    await GitService.exec(["add", "."], testRepoDir);
    await GitService.exec(["commit", "-m", "initial baseline"], testRepoDir);
  });

  afterEach(() => {
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
    fs.rmSync(testRepoDir, { recursive: true, force: true });
  });

  describe("Bug 2: Reviewer roles, consistency and CLI display", () => {
    it("creates consistent metadata for reviewer and reviewerId when reviewerId is codex", async () => {
      const engine = new ProjectEngine({ baseDir: tempBaseDir });
      const project = await engine.createProject({ name: "P1", workspace: testRepoDir });
      const task = await engine.createTask({
        projectId: project.id,
        title: "Codex Reviewer Task",
        description: "Reviewer assigned to codex",
        reviewerId: "codex",
      });

      expect(task.reviewerId).toBe("codex");
      expect(task.reviewer).toBe("codex");
    });

    it("creates consistent metadata when owner is gemini and reviewerId defaults to codex", async () => {
      const engine = new ProjectEngine({ baseDir: tempBaseDir });
      const project = await engine.createProject({ name: "P2", workspace: testRepoDir });
      const task = await engine.createTask({
        projectId: project.id,
        title: "Gemini Developer Task",
        description: "Gemini dev defaults to codex reviewer",
        ownerId: "gemini",
      });

      expect(task.reviewerId).toBe("codex");
      expect(task.reviewer).toBe("codex");
    });

    it("creates consistent metadata when owner is codex and reviewer defaults to gemini", async () => {
      const engine = new ProjectEngine({ baseDir: tempBaseDir });
      const project = await engine.createProject({ name: "P3", workspace: testRepoDir });
      const task = await engine.createTask({
        projectId: project.id,
        title: "Codex Developer Task",
        description: "Codex dev defaults to gemini reviewer",
        ownerId: "codex",
      });

      expect(task.reviewerId).toBe("gemini");
      expect(task.reviewer).toBe("gemini");
    });

    it("prefers reviewerId for legacy inconsistent records in formatTaskStatus", () => {
      const legacyTask: Task = {
        id: "TASK-LEGACY-001",
        projectId: "PROJ-1",
        title: "Legacy Inconsistent Task",
        description: "Has old reviewer=gemini but reviewerId=codex",
        status: "TODO",
        owner: "gemini",
        ownerType: "AGENT",
        ownerId: "gemini",
        reviewer: "gemini",
        reviewerId: "codex",
        priority: "MEDIUM",
        workspace: testRepoDir,
        maxRounds: 6,
        currentRound: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const formatted = formatTaskStatus(legacyTask);
      expect(formatted).toContain("Reviewer:      codex");
      expect(formatted).not.toContain("Reviewer:      gemini");
    });

    it("falls back to reviewer field when reviewerId is undefined in formatTaskStatus", () => {
      const legacyTask: Task = {
        id: "TASK-LEGACY-002",
        projectId: "PROJ-1",
        title: "Legacy Task Without reviewerId",
        description: "Only has reviewer=codex",
        status: "TODO",
        owner: "gemini",
        ownerType: "AGENT",
        ownerId: "gemini",
        reviewer: "codex",
        priority: "MEDIUM",
        workspace: testRepoDir,
        maxRounds: 6,
        currentRound: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const formatted = formatTaskStatus(legacyTask);
      expect(formatted).toContain("Reviewer:      codex");
    });
  });

  describe("Bug 1: GitService baseline capture and derivation", () => {
    it("strictly throws on nonzero git exit when directory is not a git repo", async () => {
      const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "non-repo-"));
      try {
        await expect(GitService.listRepositoryFiles(nonRepo)).rejects.toThrow("Failed to list repository files");
      } finally {
        fs.rmSync(nonRepo, { recursive: true, force: true });
      }
    });

    it("safely handles __proto__ and constructor filenames across JSON persistence without prototype pollution", async () => {
      // Create real files named __proto__ and constructor in git repo
      fs.writeFileSync(path.join(testRepoDir, "__proto__"), "special proto content", "utf-8");
      fs.writeFileSync(path.join(testRepoDir, "constructor"), "special constructor content", "utf-8");

      const baseline = await GitService.captureBaseline(testRepoDir);
      expect(Object.hasOwn(baseline, "__proto__")).toBe(true);
      expect(Object.hasOwn(baseline, "constructor")).toBe(true);

      // JSON persistence roundtrip (as stored on Task)
      const serialized = JSON.stringify(baseline);
      expect(serialized).toContain('"__proto__":');
      expect(serialized).toContain('"constructor":');

      const restored = JSON.parse(serialized);
      expect(Object.hasOwn(restored, "__proto__")).toBe(true);
      expect(Object.hasOwn(restored, "constructor")).toBe(true);

      // Modify __proto__ and delete constructor
      fs.writeFileSync(path.join(testRepoDir, "__proto__"), "modified proto content", "utf-8");
      fs.unlinkSync(path.join(testRepoDir, "constructor"));

      const changed = await GitService.deriveChangedFiles(testRepoDir, restored);
      expect(changed).toContain("__proto__");
      expect(changed).toContain("constructor");
    });

    it("captures tracked, untracked, nested, spaces, leading spaces, and symlinks, while excluding ignored files", async () => {
      // 1. Preexisting dirty tracked file
      fs.appendFileSync(path.join(testRepoDir, "README.md"), "Preexisting uncommitted tracked edit\n");

      // 2. Preexisting untracked directory and nested files
      fs.mkdirSync(path.join(testRepoDir, "preexisting_dir/nested"), { recursive: true });
      fs.writeFileSync(path.join(testRepoDir, "preexisting_dir/nested/dirty.txt"), "preexisting nested untracked");

      // 3. Preexisting file with leading spaces
      fs.writeFileSync(path.join(testRepoDir, " leading_space.txt"), "leading space content");

      // 4. Preexisting file with spaces
      fs.writeFileSync(path.join(testRepoDir, "file with spaces.txt"), "spaces content");

      // 5. Preexisting symlink pointing to an external nonexistent path (tests no target reading)
      const symlinkPath = path.join(testRepoDir, "ext_symlink");
      fs.symlinkSync("/nonexistent/external/path/target", symlinkPath);

      // 6. Ignored files
      fs.writeFileSync(path.join(testRepoDir, ".gitignore"), "*.ignored\nignored_dir/\n");
      fs.writeFileSync(path.join(testRepoDir, "file.ignored"), "secret ignored");
      fs.mkdirSync(path.join(testRepoDir, "ignored_dir"), { recursive: true });
      fs.writeFileSync(path.join(testRepoDir, "ignored_dir/hidden.txt"), "hidden");

      // Capture baseline
      const baseline = await GitService.captureBaseline(testRepoDir);

      // Verified excluded
      expect(baseline["file.ignored"]).toBeUndefined();
      expect(baseline["ignored_dir/hidden.txt"]).toBeUndefined();

      // Verified included with exact paths
      expect(baseline["README.md"]).toBeDefined();
      expect(baseline["preexisting_dir/nested/dirty.txt"]).toBeDefined();
      expect(baseline[" leading_space.txt"]).toBeDefined();
      expect(baseline["file with spaces.txt"]).toBeDefined();
      expect(baseline["ext_symlink"]).toBeDefined();
      expect(baseline["ext_symlink"].type).toBe("symlink");

      // Now developer modifies some files, creates new files, deletes a file, leaves preexisting dirt untouched
      fs.writeFileSync(path.join(testRepoDir, "new_feature.ts"), "export const a = 1;");
      fs.writeFileSync(path.join(testRepoDir, " new_leading_feature.ts"), "export const b = 2;");
      fs.unlinkSync(path.join(testRepoDir, "file with spaces.txt")); // deleted file
      fs.writeFileSync(path.join(testRepoDir, "script.sh"), "#!/bin/bash\necho ok", "utf-8");
      fs.chmodSync(path.join(testRepoDir, "script.sh"), 0o755); // newly created executable

      const changed = await GitService.deriveChangedFiles(testRepoDir, baseline);

      // Must INCLUDE newly created, modified, deleted files
      expect(changed).toContain("new_feature.ts");
      expect(changed).toContain(" new_leading_feature.ts");
      expect(changed).toContain("file with spaces.txt");
      expect(changed).toContain("script.sh");

      // Must EXCLUDE untouched preexisting dirty tracked files and untracked folders
      expect(changed).not.toContain("README.md");
      expect(changed).not.toContain("preexisting_dir/nested/dirty.txt");
      expect(changed).not.toContain(" leading_space.txt");
      expect(changed).not.toContain("ext_symlink");
      expect(changed).not.toContain("file.ignored");
    });
  });

  describe("Bug 1: TaskRunner & TaskEngine Integration with real Git and Store", () => {
    it("captures baseline before first developer turn, saves to store, and attributes only task changes to changedFiles", async () => {
      // Setup preexisting dirt before task runs
      fs.appendFileSync(path.join(testRepoDir, "README.md"), "Preexisting dirty tracked file\n");
      fs.mkdirSync(path.join(testRepoDir, "preexisting_untracked"), { recursive: true });
      fs.writeFileSync(path.join(testRepoDir, "preexisting_untracked/dirt.txt"), "preexisting dirt");

      const devAgent = new ScriptedDeveloperAgent(async () => {
        // Developer creates a new file and changes test.js
        fs.writeFileSync(path.join(testRepoDir, "feature.ts"), "export const x = 42;");
        fs.writeFileSync(path.join(testRepoDir, " nested feature.ts"), "export const y = 99;");
        return { text: "Work complete.\nAGENT_STATUS: CONTINUE" };
      });

      const revAgent = new ScriptedReviewerAgent();

      const engine = new ProjectEngine({
        baseDir: tempBaseDir,
        codexAgent: devAgent,
        geminiAgent: revAgent,
      });

      const project = await engine.createProject({ name: "Attribution Project", workspace: testRepoDir });
      const task = await engine.createTask({
        projectId: project.id,
        title: "Clean Attribution Task",
        description: "Must only attribute actual task changes",
        testCommand: "node test.js",
      });

      // Point worktree directly to testRepoDir for this test
      task.worktree = testRepoDir;
      task.branch = "master";
      await engine.getStore().saveTask(task);

      const completed = await engine.runTask(task.id);

      expect(completed.status).toBe("DONE");
      expect(completed.baseline).toBeDefined();
      expect(completed.baseline!["README.md"]).toBeDefined();
      expect(completed.baseline!["preexisting_untracked/dirt.txt"]).toBeDefined();

      // Verify changedFiles in TaskResult
      const changedFiles = completed.result?.changedFiles ?? [];
      expect(changedFiles).toContain("feature.ts");
      expect(changedFiles).toContain(" nested feature.ts");

      // Verify preexisting dirt was NOT attributed to the task!
      expect(changedFiles).not.toContain("README.md");
      expect(changedFiles).not.toContain("preexisting_untracked/dirt.txt");
    });

    it("persists baseline on task and reuses unchanged after process/engine recovery without rebaselining", async () => {
      // 1. Initial engine runs turn 1 where baseline is captured
      const devAgent1 = new ScriptedDeveloperAgent(async () => {
        fs.writeFileSync(path.join(testRepoDir, "turn1.txt"), "turn 1 content");
        return { text: "Round 1 done. AGENT_STATUS: CONTINUE" };
      });

      // Reviewer requests changes in round 1 to trigger multi-round
      let round = 1;
      const revAgent = new ScriptedReviewerAgent(async () => {
        if (round === 1) {
          round++;
          return { text: "REVIEW_STATUS: REQUEST_CHANGES\nPlease refine implementation.\nAGENT_STATUS: CONTINUE" };
        }
        return { text: "REVIEW_STATUS: PASS\nAGENT_STATUS: DONE" };
      });

      const engine1 = new ProjectEngine({
        baseDir: tempBaseDir,
        codexAgent: devAgent1,
        geminiAgent: revAgent,
      });

      const project = await engine1.createProject({ name: "Multi-round Baseline", workspace: testRepoDir });
      const task = await engine1.createTask({
        projectId: project.id,
        title: "Persisted Baseline Task",
        description: "Baseline must not be re-captured in round 2",
        testCommand: "node test.js",
      });
      task.worktree = testRepoDir;
      task.branch = "master";
      await engine1.getStore().saveTask(task);

      // Run until REWORK or completion
      const completed = await engine1.runTask(task.id);

      // Verify baseline captured before round 1 does NOT contain turn1.txt
      expect(completed.baseline).toBeDefined();
      expect(completed.baseline!["turn1.txt"]).toBeUndefined();
      expect(completed.result?.changedFiles).toContain("turn1.txt");

      // Now simulate process restart by constructing a new engine pointing to same store
      const engine2 = new ProjectEngine({
        baseDir: tempBaseDir,
        codexAgent: new ScriptedDeveloperAgent(),
        geminiAgent: revAgent,
      });

      const loadedTask = await engine2.getStore().getTask(task.id);
      expect(loadedTask).not.toBeNull();
      expect(loadedTask!.baseline).toEqual(completed.baseline);
    });

    it("legacy pending records without an original baseline must transition to NEED_USER and never return DONE with HEAD-wide attribution", async () => {
      const devAgent = new ScriptedDeveloperAgent();
      const revAgent = new ScriptedReviewerAgent(async () => {
        return { text: "REVIEW_STATUS: PASS\nAGENT_STATUS: DONE" };
      });

      const engine = new ProjectEngine({
        baseDir: tempBaseDir,
        codexAgent: devAgent,
        geminiAgent: revAgent,
      });

      const project = await engine.createProject({ name: "Legacy Project", workspace: testRepoDir });
      const task = await engine.createTask({
        projectId: project.id,
        title: "Legacy Resumed Task",
        description: "Task from older engine version without baseline",
        testCommand: "node test.js",
      });

      // Simulate a legacy pending task resumed at REVIEW phase without a baseline
      task.status = "REVIEW";
      task.worktree = testRepoDir;
      task.branch = "master";
      task.currentRound = 1;
      task.baseline = undefined; // Legacy task with no baseline
      task.pendingAgentTurn = {
        sessionId: "old-rev-session",
        startStepIndex: 5,
        requestTime: new Date().toISOString(),
        actor: "gemini",
        phase: "REVIEW",
      };
      await engine.getStore().saveTask(task);

      const result = await engine.runTask(task.id);

      // Must transition to NEED_USER and NEVER return DONE
      expect(result.status).toBe("NEED_USER");
      expect(result.status).not.toBe("DONE");
      expect(result.nextAction).toContain("baseline");
      expect(result.baseline).toBeUndefined(); // Did not silently recapture
    });
  });
});
