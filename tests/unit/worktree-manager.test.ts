import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WorktreeManager } from "../../src/git/worktree-manager.js";
import { GitService } from "../../src/git/git-service.js";

describe("WorktreeManager Unit Tests", () => {
  let testRepoDir: string;

  beforeEach(async () => {
    testRepoDir = path.join(os.tmpdir(), `agenthub-git-test-${Date.now()}`);
    fs.mkdirSync(testRepoDir, { recursive: true });

    // Initialize temporary git repo for testing
    await GitService.exec(["init"], testRepoDir);
    await GitService.exec(["config", "user.name", "Test User"], testRepoDir);
    await GitService.exec(["config", "user.email", "test@example.com"], testRepoDir);

    // Create initial commit
    fs.writeFileSync(path.join(testRepoDir, "README.md"), "# Initial Commit", "utf-8");
    await GitService.exec(["add", "README.md"], testRepoDir);
    await GitService.exec(["commit", "-m", "Initial commit"], testRepoDir);
  });

  afterEach(() => {
    if (fs.existsSync(testRepoDir)) {
      try {
        fs.rmSync(testRepoDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("slugifies titles into clean branch slugs", () => {
    expect(WorktreeManager.slugify("Improve login validation")).toBe("improve-login-validation");
    expect(WorktreeManager.slugify("Fix: Bug #123 (Critical!)")).toBe("fix-bug-123-critical");
    expect(WorktreeManager.slugify("修复计算器边界错误")).toBe("修复计算器边界错误");
    expect(WorktreeManager.slugify("")).toBe("task");
  });

  it("strictly fails if workspace is not a Git repository", async () => {
    const nonGitDir = path.join(os.tmpdir(), `non-git-${Date.now()}`);
    fs.mkdirSync(nonGitDir, { recursive: true });

    try {
      await expect(
        WorktreeManager.createWorktree("T1", "Non Git Task", nonGitDir)
      ).rejects.toThrow(/not a Git repository/i);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("creates a git worktree and dedicated branch", async () => {
    const wt = await WorktreeManager.createWorktree("TASK-TEST-101", "Add login feature", testRepoDir);

    expect(wt.branch).toBe("agent/TASK-TEST-101-add-login-feature");
    expect(fs.existsSync(wt.worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(wt.worktreePath, "README.md"))).toBe(true);

    // Verify branch exists in git repo
    const bExists = await GitService.branchExists(wt.branch, testRepoDir);
    expect(bExists).toBe(true);

    // Clean up
    await WorktreeManager.removeWorktree(wt.worktreePath, wt.branch, testRepoDir);
    expect(fs.existsSync(wt.worktreePath)).toBe(false);
  });

  it("strictly rejects when branch or worktree already exists to prevent overwrite", async () => {
    const wt = await WorktreeManager.createWorktree("TASK-DUP", "Duplicate Test", testRepoDir);

    // Attempt to create again with same task ID / branch must fail
    await expect(
      WorktreeManager.createWorktree("TASK-DUP", "Duplicate Test", testRepoDir)
    ).rejects.toThrow(/Branch already exists/i);

    await WorktreeManager.removeWorktree(wt.worktreePath, wt.branch, testRepoDir);
  });
});
