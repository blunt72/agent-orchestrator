import fs from "node:fs";
import path from "node:path";
import { GitService } from "./git-service.js";

export interface WorktreeInfo {
  branch: string;
  worktreePath: string;
}

export class WorktreeManager {
  public static slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
      .replace(/--+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task";
  }

  public static async createWorktree(
    taskId: string,
    title: string,
    workspace: string
  ): Promise<WorktreeInfo> {
    const isRepo = await GitService.isGitRepo(workspace);
    if (!isRepo) {
      throw new Error(`Git safety error: Workspace is not a Git repository: ${workspace}`);
    }

    const gitRoot = await GitService.getGitRoot(workspace);
    const slug = this.slugify(title);
    const branch = `agent/${taskId}-${slug}`;
    const worktreePath = path.resolve(gitRoot, ".agenthub/worktrees", taskId);

    // 1. Check if branch exists
    const bExists = await GitService.branchExists(branch, gitRoot);
    if (bExists) {
      throw new Error(`Git safety error: Branch already exists: ${branch}. Will not overwrite.`);
    }

    // 2. Check if worktree exists in git
    const wtExists = await GitService.worktreeExists(worktreePath, gitRoot);
    if (wtExists) {
      throw new Error(`Git safety error: Worktree already registered in Git: ${worktreePath}. Will not overwrite.`);
    }

    // 3. Check if directory exists on disk
    if (fs.existsSync(worktreePath)) {
      throw new Error(`Git safety error: Target worktree directory already exists on disk: ${worktreePath}. Will not overwrite.`);
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(worktreePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // 4. Create worktree
    const addRes = await GitService.exec(["worktree", "add", worktreePath, "-b", branch], gitRoot);
    if (addRes.exitCode !== 0) {
      throw new Error(`Failed to create git worktree: ${addRes.stderr || addRes.stdout}`);
    }

    return {
      branch,
      worktreePath,
    };
  }

  public static async removeWorktree(worktreePath: string, branch?: string, cwd?: string): Promise<void> {
    const targetCwd = cwd || path.dirname(path.dirname(worktreePath));
    try {
      await GitService.exec(["worktree", "remove", "--force", worktreePath], targetCwd);
    } catch {}

    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch {}
    }

    if (branch) {
      try {
        await GitService.exec(["branch", "-D", branch], targetCwd);
      } catch {}
    }
  }
}
