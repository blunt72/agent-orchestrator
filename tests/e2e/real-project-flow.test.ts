import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ProjectEngine } from "../../src/projects/project-engine.js";
import { CodexAgent } from "../../src/agents/codex-agent.js";
import { AntigravityAgent } from "../../src/agents/antigravity-agent.js";
import { GitService } from "../../src/git/git-service.js";
import { TestRunner } from "../../src/testing/test-runner.js";

describe("Item 1 & Item 10: Real Project Flow E2E (No Mock) + Main Branch Protection", () => {
  it(
    "orchestrates real Project -> Epic -> Task A (Real Codex + Test Gate + Real Gemini) -> Auto-unblock Task B -> Human Task C via API -> 100% Progress while protecting main branch",
    async () => {
      // 1. Dynamic nonces, IDs, and tokens to ensure anti-mock uniqueness
      const nonce = crypto.randomBytes(3).toString("hex");
      const secretToken = `SEC_TOKEN_${nonce.toUpperCase()}_${Date.now()}`;
      const repoDir = path.resolve(process.cwd(), `logs/real-proj-repo-${nonce}`);
      const dataDir = path.resolve(process.cwd(), `logs/real-proj-data-${nonce}`);

      fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, "tests"), { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true });

      // 2. Initialize genuine Git repository for main branch & worktree isolation
      await GitService.exec(["init"], repoDir);
      await GitService.exec(["config", "user.name", "Real Project E2E"], repoDir);
      await GitService.exec(["config", "user.email", "realproject@agenthub.local"], repoDir);

      // 3. Write package.json with standard Node.js test runner
      const packageJson = {
        name: `real-project-${nonce}`,
        version: "1.0.0",
        type: "module",
        scripts: {
          test: "node --test tests/*.test.js",
        },
      };
      fs.writeFileSync(
        path.join(repoDir, "package.json"),
        JSON.stringify(packageJson, null, 2),
        "utf-8"
      );
      fs.writeFileSync(path.join(repoDir, ".gitignore"), ".agenthub\nnode_modules\n", "utf-8");

      // 4. Initial defective clamp function
      const initialClampCode = `// Anti-Mock Token: ${secretToken}
export function clamp(val, min, max) {
  // CRITICAL DEFECT: No check for min > max or non-finite inputs
  if (val < min) return min;
  if (val > max) return max;
  return val;
}
`;
      fs.writeFileSync(path.join(repoDir, "src", "clamp.js"), initialClampCode, "utf-8");

      // 5. Baseline test file
      const initialTestCode = `import test from "node:test";
import assert from "node:assert/strict";
import { clamp } from "../src/clamp.js";

test("clamps values within normal bounds", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(15, 0, 10), 10);
});
`;
      fs.writeFileSync(path.join(repoDir, "tests", "clamp.test.js"), initialTestCode, "utf-8");

      // 6. Commit initial baseline to main branch
      await GitService.exec(["add", "."], repoDir);
      await GitService.exec(["commit", "-m", "Initial baseline commit on main"], repoDir);

      // Record initial main branch HEAD commit hash
      const headRevBefore = await GitService.exec(["rev-parse", "HEAD"], repoDir);
      const initialHeadHash = headRevBefore.stdout.trim();
      expect(initialHeadHash).toBeTruthy();

      // 7. Instantiate REAL CodexAgent and REAL AntigravityAgent (NO MOCK)
      const codexAgent = new CodexAgent();
      const geminiAgent = new AntigravityAgent({ model: "flash" });

      expect(codexAgent.provider).toBe("acp");
      expect(geminiAgent.provider).toBe("antigravity");

      // 8. Single ProjectEngine instance for the entire flow
      const engine = new ProjectEngine({
        baseDir: dataDir,
        codexAgent,
        geminiAgent,
      });

      // 9. Create Project & Epic
      const projectId = `PROJ-REAL-${nonce.toUpperCase()}`;
      const project = await engine.createProject({
        id: projectId,
        name: "Enterprise Core Math Utilities",
        description: "Autonomous AI & Human collaboration flow",
        workspace: repoDir,
      });
      expect(project.id).toBe(projectId);
      expect(project.status).toBe("PLANNING");

      const epicId = `EPIC-REAL-${nonce.toUpperCase()}`;
      const epic = await engine.createEpic({
        id: epicId,
        projectId,
        title: "EPIC-001: Robust Math Operations",
        priority: "HIGH",
      });
      expect(epic.id).toBe(epicId);

      // 10. Create Task A (AI task: Codex + Gemini)
      const taskAId = `TASK-A-${nonce.toUpperCase()}`;
      const taskA = await engine.createTask({
        id: taskAId,
        projectId,
        epicId,
        title: `完善 clamp 函数边界校验与测试 ${nonce}`,
        description: `在 src/clamp.js 中完善 clamp(val, min, max) 函数：
1. 包含防伪标记 ${secretToken}
2. 当 min > max 时抛出 RangeError("min cannot be greater than max")
3. 当任何参数为非有限数值 (NaN, Infinity, -Infinity) 或非 number 类型时抛出 TypeError("Arguments must be finite numbers")
4. 在 tests/clamp.test.js 中增加对应异常与边界测试，确保 npm test 全部通过`,
        workspace: repoDir,
        testCommand: "npm test",
        estimatedWeight: 1,
        maxRounds: 6,
      });

      // 11. Create Task B (dependsOn Task A -> must be BLOCKED initially)
      const taskBId = `TASK-B-${nonce.toUpperCase()}`;
      const taskB = await engine.createTask({
        id: taskBId,
        projectId,
        epicId,
        title: `集成回归测试与文档校验 ${nonce}`,
        description: `验证 clamp 与其它工具库的兼容性`,
        workspace: repoDir,
        dependsOn: [taskAId],
        estimatedWeight: 1,
      });

      // 12. Create Task C (Human Task)
      const taskCId = `TASK-C-${nonce.toUpperCase()}`;
      const taskC = await engine.createTask({
        id: taskCId,
        projectId,
        epicId,
        title: `技术负责人最终发布审核 ${nonce}`,
        description: `由技术负责人人工复核上线`,
        ownerType: "HUMAN",
        ownerId: "tech-lead-zhang",
        workspace: repoDir,
        estimatedWeight: 1,
      });

      // 13. Verify initial states
      expect(taskA.status).toBe("TODO");
      expect(taskB.status).toBe("BLOCKED");
      expect(taskB.blockedBy).toContain(taskAId);
      expect(taskC.status).toBe("TODO");

      let currentProgress = await engine.refreshProjectProgress(projectId);
      expect(currentProgress).toBe(0);

      // 14. Execute Task A through Real Codex -> Real Test Gate -> Real Gemini
      console.log(`[Real E2E] Running Task A (${taskAId}) with Real Codex ACP and Real Gemini...`);
      const completedTaskA = await engine.runTask(taskAId);
      console.log(`[Real E2E] Task A completed with status: ${completedTaskA.status}`);

      // Verify Task A completion
      expect(completedTaskA.status).toBe("DONE");
      expect(completedTaskA.result).toBeDefined();
      expect(completedTaskA.result?.status).toBe("PASS");
      expect(completedTaskA.result?.testStatus).toBe("PASS");
      expect(completedTaskA.result?.reviewStatus).toBe("PASS");
      expect(completedTaskA.currentRound).toBeGreaterThanOrEqual(1);

      // 15. Verify Task B was automatically unblocked (BLOCKED -> TODO)
      const unblockedTaskB = await engine.getTask(taskBId);
      expect(unblockedTaskB?.status).toBe("TODO");
      expect(unblockedTaskB?.blockedBy).toEqual([]);

      // 16. Verify Project Progress automatically updated
      const intermediateProgress = await engine.refreshProjectProgress(projectId);
      expect(intermediateProgress).toBeGreaterThan(0);
      expect(intermediateProgress).toBeLessThan(100);

      // 17. Complete Task B via API
      console.log(`[Real E2E] Completing unblocked Task B (${taskBId}) via API...`);
      const completedTaskB = await engine.completeHumanTask(
        taskBId,
        "system",
        "Automated regression verified after Task A completed."
      );
      expect(completedTaskB.status).toBe("DONE");

      // 18. Complete Human Task C via API
      console.log(`[Real E2E] Completing Human Task C (${taskCId}) via API...`);
      const completedTaskC = await engine.completeHumanTask(
        taskCId,
        "tech-lead-zhang",
        "Signoff approved for release."
      );
      expect(completedTaskC.status).toBe("DONE");

      // 19. Verify final Project Progress reaches 100%!
      const finalProgress = await engine.refreshProjectProgress(projectId);
      expect(finalProgress).toBe(100);

      const finalProject = await engine.getProject(projectId);
      expect(finalProject?.status).toBe("DONE");
      expect(finalProject?.progress).toBe(100);

      const finalEpic = await engine.getEpic(epicId);
      expect(finalEpic?.status).toBe("DONE");
      expect(finalEpic?.progress).toBe(100);

      // 20. Item 10: Strict Main Branch Protection Verification
      // Verify HEAD commit on main is completely unchanged
      const headRevAfter = await GitService.exec(["rev-parse", "HEAD"], repoDir);
      const finalHeadHash = headRevAfter.stdout.trim();
      expect(finalHeadHash).toBe(initialHeadHash);

      // Verify main branch working tree is 100% clean
      const gitStatusResult = await GitService.exec(["status", "--porcelain"], repoDir);
      expect(gitStatusResult.stdout.trim()).toBe("");

      // Verify modifications occurred strictly inside the dedicated worktree
      expect(completedTaskA.worktree).toBeDefined();
      expect(fs.existsSync(completedTaskA.worktree!)).toBe(true);
      const modifiedClampPath = path.join(completedTaskA.worktree!, "src/clamp.js");
      const modifiedClampContent = fs.readFileSync(modifiedClampPath, "utf-8");
      expect(modifiedClampContent).not.toBe(initialClampCode);

      // Run independent test gate in worktree
      const testCheck = await TestRunner.run("npm test", completedTaskA.worktree!);
      expect(testCheck.pass).toBe(true);

      // 21. Verify Event Log Audit Stream
      const events = await engine.getStore().getProjectEvents(projectId);
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("project.created");
      expect(eventTypes).toContain("epic.created");
      expect(eventTypes).toContain("task.created");
      expect(eventTypes).toContain("task.blocked");
      expect(eventTypes).toContain("task.started");
      expect(eventTypes).toContain("task.unblocked");
      expect(eventTypes).toContain("task.done");
      expect(eventTypes).toContain("project.progress_changed");

      console.log(`[Real E2E] All verifications passed successfully! Project progress = 100%`);
    },
    360000 // 6 minute timeout for live multi-turn LLM calls
  );
});
