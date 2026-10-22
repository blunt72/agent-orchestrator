import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TaskEngine } from "../../src/tasks/task-engine.js";
import { CodexAgent } from "../../src/agents/codex-agent.js";
import { AntigravityAgent } from "../../src/agents/antigravity-agent.js";
import { GitService } from "../../src/git/git-service.js";
import { TestRunner } from "../../src/testing/test-runner.js";

describe("Codex x Gemini AgentHub V0.2 Real Task Flow E2E", () => {
  it(
    "executes full autonomous lifecycle: worktree isolation -> Codex dev -> independent test gate -> Gemini review (REQUEST_CHANGES) -> rework -> independent test gate -> Gemini review (PASS) -> DONE",
    async () => {
      // 1. Dynamic nonces, IDs, and tokens to guarantee anti-mock execution
      const nonce = crypto.randomBytes(3).toString("hex");
      const taskId = `TASK-${nonce.toUpperCase()}`;
      const secretToken = `TOKEN_SEC_${nonce}_${Date.now()}`;
      const repoDir = path.resolve(process.cwd(), `logs/real-e2e-repo-${nonce}`);

      fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, "tests"), { recursive: true });

      // 2. Initialize genuine Git repository for strict worktree isolation
      await GitService.exec(["init"], repoDir);
      await GitService.exec(["config", "user.name", "AgentHub E2E"], repoDir);
      await GitService.exec(["config", "user.email", "e2e@agenthub.local"], repoDir);

      // 3. Write baseline package.json with pure Node.js test runner
      const packageJson = {
        name: `percentage-e2e-${nonce}`,
        version: "1.0.0",
        type: "module",
        scripts: {
          test: "node --test tests/percentage.test.js",
        },
      };
      fs.writeFileSync(
        path.join(repoDir, "package.json"),
        JSON.stringify(packageJson, null, 2),
        "utf-8"
      );

      // 4. Write initial defective implementation
      const initialCode = `// Anti-Mock Dynamic Token: ${secretToken}
// Nonce: ${nonce}

export function percentage(part, total) {
  // CRITICAL DEFECT: No check for total === 0, negative zero, or non-finite inputs
  return (part / total) * 100;
}
`;
      fs.writeFileSync(path.join(repoDir, "src", "percentage.js"), initialCode, "utf-8");

      // 5. Write baseline initial test
      const initialTest = `import test from "node:test";
import assert from "node:assert/strict";
import { percentage } from "../src/percentage.js";

test("calculates baseline percentage correctly", () => {
  assert.equal(percentage(50, 100), 50);
  assert.equal(percentage(1, 4), 25);
});
`;
      fs.writeFileSync(path.join(repoDir, "tests", "percentage.test.js"), initialTest, "utf-8");

      // 6. Commit initial baseline to main/master
      await GitService.exec(["add", "."], repoDir);
      await GitService.exec(["commit", "-m", "Initial baseline commit"], repoDir);

      // 7. Initialize TaskEngine with REAL Codex ACP and REAL Antigravity AgentAPI
      const codexAgent = new CodexAgent();
      const geminiAgent = new AntigravityAgent({ model: "flash" });

      const engine = new TaskEngine({
        codexAgent,
        geminiAgent,
      });

      // 8. Create formal Task
      const task = await engine.createTask({
        id: taskId,
        projectId: `proj-${nonce}`,
        title: `完善 percentage 函数边界校验与测试 ${nonce}`,
        description: `在 src/percentage.js 中完善 percentage(part, total) 函数：
1. 包含防伪标记 ${secretToken}
2. 当 total === 0 或 total 为 -0 时抛出 RangeError("Total cannot be zero")
3. 当 part 或 total 为非有限数值 (NaN, Infinity, -Infinity) 或非 number 类型时抛出 TypeError("Operands must be finite numbers")
4. 在 tests/percentage.test.js 中添加对应边界与异常测试，确保测试全部通过`,
        workspace: repoDir,
        maxRounds: 6,
      });

      console.log(`[E2E] Created Task: ${task.id} (${task.title})`);
      expect(task.id).toBe(taskId);
      expect(task.status).toBe("TODO");

      // 9. Run Task through complete autonomous lifecycle
      console.log(`[E2E] Running Task ${taskId}...`);
      const completedTask = await engine.runTask(taskId);

      console.log(`[E2E] Task ${taskId} finished with status: ${completedTask.status}`);
      console.log(`[E2E] Worktree: ${completedTask.worktree}`);
      console.log(`[E2E] Branch: ${completedTask.branch}`);
      console.log(`[E2E] Rounds: ${completedTask.currentRound}`);
      console.log(`[E2E] Result:`, JSON.stringify(completedTask.result, null, 2));

      // 10. Comprehensive Verification of Requirements

      // A. State & Result verification
      expect(completedTask.status).toBe("DONE");
      expect(completedTask.result).toBeDefined();
      expect(completedTask.result?.status).toBe("PASS");
      expect(completedTask.result?.testStatus).toBe("PASS");
      expect(completedTask.result?.reviewStatus).toBe("PASS");
      expect(completedTask.currentRound).toBeGreaterThanOrEqual(2); // At least 2 rounds (Dev -> Review REQUEST_CHANGES -> Rework -> Review PASS)

      // B. Git Worktree & Dedicated Branch verification
      expect(completedTask.branch).toBeDefined();
      expect(completedTask.branch).toMatch(/^agent\/TASK-/);
      expect(completedTask.worktree).toBeDefined();
      expect(fs.existsSync(completedTask.worktree!)).toBe(true);
      expect(fs.existsSync(path.join(completedTask.worktree!, ".git"))).toBe(true);

      // Verify branch exists in git
      const branchExists = await GitService.branchExists(completedTask.branch!, repoDir);
      expect(branchExists).toBe(true);

      // C. Independent Test Gate execution verification
      expect(completedTask.result?.testCommand).toBe("npm test");

      // D. Verify Task Events Log (JSONL)
      const events = await engine.getStore().getEvents(taskId);
      console.log(`[E2E] Recorded ${events.length} events for ${taskId}`);

      const eventTypes = events.map((e) => e.type);
      console.log(`[E2E] Event sequence: ${eventTypes.join(" -> ")}`);

      expect(eventTypes).toContain("TASK_CREATED");
      expect(eventTypes).toContain("WORKTREE_CREATED");
      expect(eventTypes).toContain("TASK_STARTED");
      expect(eventTypes).toContain("AGENT_STARTED"); // Codex
      expect(eventTypes).toContain("TEST_STARTED");
      expect(eventTypes).toContain("TEST_PASSED");
      expect(eventTypes).toContain("REVIEW_STARTED"); // Gemini
      expect(eventTypes).toContain("REWORK_STARTED"); // Round 1 REQUEST_CHANGES
      expect(eventTypes).toContain("REVIEW_PASSED");  // Round 2 PASS
      expect(eventTypes).toContain("TASK_COMPLETED");

      // E. Verify file modification in worktree
      const changedFiles = await GitService.getChangedFiles(completedTask.worktree!);
      console.log(`[E2E] Changed files in worktree:`, changedFiles);
      expect(changedFiles.length).toBeGreaterThan(0);

      const modifiedPercentageCode = fs.readFileSync(
        path.join(completedTask.worktree!, "src/percentage.js"),
        "utf-8"
      );
      console.log(`[E2E] Modified Code:\n${modifiedPercentageCode}`);
      expect(modifiedPercentageCode).not.toBe(initialCode);

      // F. Run independent test directly in worktree to re-verify 100% test pass
      const postTestRun = await TestRunner.run("npm test", completedTask.worktree!);
      console.log(`[E2E] Post-run Test Verification Output:\n${postTestRun.output}`);
      expect(postTestRun.pass).toBe(true);
      expect(postTestRun.exitCode).toBe(0);

      // G. Verify persistence files exist
      const taskJsonPath = path.resolve(process.cwd(), `data/tasks/${taskId}.json`);
      const taskEventsPath = path.resolve(process.cwd(), `logs/tasks/${taskId}.jsonl`);
      expect(fs.existsSync(taskJsonPath)).toBe(true);
      expect(fs.existsSync(taskEventsPath)).toBe(true);

      const persistedJson = JSON.parse(fs.readFileSync(taskJsonPath, "utf-8"));
      expect(persistedJson.status).toBe("DONE");
      expect(persistedJson.id).toBe(taskId);
    },
    360000 // 6 minute timeout for real multi-round LLM network calls
  );
});
