import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface GitExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FileBaselineEntry {
  type: "file" | "symlink";
  hash: string;
  mode: number;
}

export class GitService {
  public static async exec(args: string[], cwd: string): Promise<GitExecResult> {
    return new Promise((resolve) => {
      const proc = spawn("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d) => {
        stdout += d.toString("utf-8");
      });

      proc.stderr.on("data", (d) => {
        stderr += d.toString("utf-8");
      });

      proc.on("close", (code) => {
        resolve({
          exitCode: code ?? 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      });

      proc.on("error", (err) => {
        resolve({
          exitCode: 1,
          stdout,
          stderr: err.message,
        });
      });
    });
  }

  public static async execRaw(args: string[], cwd: string): Promise<GitExecResult> {
    return new Promise((resolve) => {
      const proc = spawn("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d) => {
        stdout += d.toString("utf-8");
      });

      proc.stderr.on("data", (d) => {
        stderr += d.toString("utf-8");
      });

      proc.on("close", (code) => {
        resolve({
          exitCode: code ?? 0,
          stdout,
          stderr: stderr.trim(),
        });
      });

      proc.on("error", (err) => {
        resolve({
          exitCode: 1,
          stdout,
          stderr: err.message,
        });
      });
    });
  }

  public static async isGitRepo(cwd: string): Promise<boolean> {
    const res = await this.exec(["rev-parse", "--is-inside-work-tree"], cwd);
    return res.exitCode === 0 && res.stdout === "true";
  }

  public static async getGitRoot(cwd: string): Promise<string> {
    const res = await this.exec(["rev-parse", "--show-toplevel"], cwd);
    if (res.exitCode !== 0) {
      throw new Error(`Directory is not a Git repository: ${cwd}`);
    }
    return res.stdout;
  }

  public static async branchExists(branch: string, cwd: string): Promise<boolean> {
    const res = await this.exec(["rev-parse", "--verify", `refs/heads/${branch}`], cwd);
    return res.exitCode === 0;
  }

  public static async worktreeExists(worktreePath: string, cwd: string): Promise<boolean> {
    const res = await this.exec(["worktree", "list", "--porcelain"], cwd);
    if (res.exitCode !== 0) return false;
    const lines = res.stdout.split("\n");
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        const wt = line.substring("worktree ".length).trim();
        if (pathEquals(wt, worktreePath)) {
          return true;
        }
      }
    }
    return false;
  }

  public static async listRepositoryFiles(cwd: string): Promise<string[]> {
    const res = await this.execRaw(["ls-files", "-c", "-o", "--exclude-standard", "-z"], cwd);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to list repository files in ${cwd}: ${res.stderr || res.stdout}`);
    }
    return res.stdout.split("\0").filter((p) => p.length > 0);
  }

  public static async getFileFingerprint(cwd: string, relPath: string): Promise<FileBaselineEntry | null> {
    const fullPath = path.resolve(cwd, relPath);
    let stats: fs.Stats;
    try {
      stats = await fs.promises.lstat(fullPath);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return null;
      }
      throw err;
    }

    if (stats.isSymbolicLink()) {
      const linkTarget = await fs.promises.readlink(fullPath);
      const hash = crypto.createHash("sha256").update(linkTarget).digest("hex");
      return {
        type: "symlink",
        hash,
        mode: stats.mode,
      };
    }

    if (stats.isFile()) {
      const content = await fs.promises.readFile(fullPath);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      return {
        type: "file",
        hash,
        mode: stats.mode,
      };
    }

    return null;
  }

  public static async captureBaseline(cwd: string): Promise<Record<string, FileBaselineEntry>> {
    const files = await this.listRepositoryFiles(cwd);
    const baseline: Record<string, FileBaselineEntry> = Object.create(null);
    for (const relPath of files) {
      const entry = await this.getFileFingerprint(cwd, relPath);
      if (entry) {
        Object.defineProperty(baseline, relPath, {
          value: entry,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    return baseline;
  }

  public static async deriveChangedFiles(
    cwd: string,
    baseline: Record<string, FileBaselineEntry>
  ): Promise<string[]> {
    const currentFiles = await this.listRepositoryFiles(cwd);
    const currentMap = new Map<string, FileBaselineEntry>();
    for (const relPath of currentFiles) {
      const entry = await this.getFileFingerprint(cwd, relPath);
      if (entry) {
        currentMap.set(relPath, entry);
      }
    }

    const changed = new Set<string>();

    for (const [relPath, currentEntry] of currentMap.entries()) {
      const baseEntry = Object.hasOwn(baseline, relPath)
        ? (Object.getOwnPropertyDescriptor(baseline, relPath)?.value ?? (baseline as any)[relPath])
        : undefined;
      if (!baseEntry) {
        changed.add(relPath);
      } else if (
        baseEntry.type !== currentEntry.type ||
        baseEntry.hash !== currentEntry.hash ||
        (baseEntry.mode & 0o777) !== (currentEntry.mode & 0o777)
      ) {
        changed.add(relPath);
      }
    }

    for (const relPath of Object.keys(baseline)) {
      if (!currentMap.has(relPath)) {
        changed.add(relPath);
      }
    }

    return Array.from(changed).sort();
  }

  public static async getChangedFiles(cwd: string): Promise<string[]> {
    const diffRes = await this.exec(["diff", "--name-only", "HEAD"], cwd);
    const untrackedRes = await this.exec(["status", "--porcelain"], cwd);

    const files = new Set<string>();

    if (diffRes.exitCode === 0 && diffRes.stdout) {
      for (const line of diffRes.stdout.split("\n")) {
        if (line.trim()) files.add(line.trim());
      }
    }

    if (untrackedRes.exitCode === 0 && untrackedRes.stdout) {
      for (const line of untrackedRes.stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) {
          // e.g. " M src/foo.ts" or "?? src/bar.ts"
          const filePath = trimmed.substring(2).trim();
          if (filePath) files.add(filePath);
        }
      }
    }

    return Array.from(files);
  }

  public static async getDiff(cwd: string): Promise<string> {
    const res = await this.exec(["diff", "HEAD"], cwd);
    const statusRes = await this.exec(["status", "--short"], cwd);
    let diff = res.stdout;
    if (statusRes.stdout) {
      diff = diff ? `${diff}\n\n[Working tree status]:\n${statusRes.stdout}` : `[Working tree status]:\n${statusRes.stdout}`;
    }
    return diff;
  }
}

function pathEquals(p1: string, p2: string): boolean {
  const norm1 = p1.replace(/\\/g, "/").replace(/\/$/, "");
  const norm2 = p2.replace(/\\/g, "/").replace(/\/$/, "");
  return norm1 === norm2;
}
