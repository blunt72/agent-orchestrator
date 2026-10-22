# Codex × Gemini AgentHub Task Engine (V0.2)

## 一、概述 (Overview)

`TaskEngine` 是 AgentHub V0.2 的核心任务调度引擎，将 AgentHub 从 V0.1 的“两 Agent 自由对话协作”正式升级为**“围绕正式 Task 进行自动化开发、独立测试门禁、审查与返工流转”**的企业级生产链路。

```text
               +------------------------------------------------------+
               |                  Create Task (TODO)                  |
               +------------------------------------------------------+
                                          |
                                          v
               +------------------------------------------------------+
               |           WorktreeManager: Dedicated Worktree        |
               |           (agent/<task-id>-<slug> & .agenthub/...)   |
               +------------------------------------------------------+
                                          |
                                          v
               +------------------------------------------------------+
               |                  Codex Dev (DOING)                   |
               +------------------------------------------------------+
                                          |
                                          v
    +----------------------------------------------------------------------------+
    |                         Independent Test Gate (TESTING)                    |
    |                         (TestRunner independently runs command)             |
    +----------------------------------------------------------------------------+
                 | (Failed)                                        | (Passed)
                 v                                                 v
    +-------------------------+                   +-------------------------------+
    |         REWORK          |                   |     Gemini Review (REVIEW)    |
    | (Test failure feedback) |                   +-------------------------------+
    +-------------------------+                              |                 |
                 |                               (REQUEST_CHANGES)          (PASS)
                 +<------------------------------------------+                 |
                 |                                                             v
                 v                                                +-----------------------+
        Back to Codex (DOING)                                     |      Task DONE        |
                                                                  |  (TaskResult recorded)|
                                                                  +-----------------------+
```

---

## 二、状态机与流转规范 (Task State Machine)

任务状态定义在 `src/tasks/task.ts`，由 `TaskStateMachine` (`src/tasks/task-state-machine.ts`) 实施严格流转校验，杜绝非法跨状态跃迁（例如禁止 `TODO -> DONE`）：

### 状态集合
- `TODO`: 初始状态，任务已创建。
- `BLOCKED`: 存在未完成的依赖任务（Project Engine 创建任务时判定），依赖完成后自动解除回到 `TODO`。
- `DOING`: 开发者 agent（默认 Codex）正在开发/修改代码。
- `TESTING`: 独立测试门禁执行中。
- `REVIEW`: 审查者 agent（默认 Gemini）正在审查工作区代码与 Git Diff。
- `REWORK`: 测试未通过或审查要求修改，准备转交返工。
- `NEED_USER`: 达到最大轮数 (`maxRounds`)、遇到无法决定的问题或无法自动探测测试命令。
- `DONE`: 任务完成并固化结果（自动流程需测试与审查都通过；人工任务可经 complete 接口直接完成）。
- `FAILED`: 遇到不可恢复的系统/环境异常。
- `CANCELLED`: 用户主动取消。

### 合法流转矩阵

与 `src/tasks/task-state-machine.ts` 中的 `VALID_TRANSITIONS` 一致；不在表中的转移会抛出 `TaskStateMachineError`。

| 当前状态 | 允许转移至 | 说明 |
|---|---|---|
| `TODO` | `DOING`, `BLOCKED`, `NEED_USER`, `FAILED`, `CANCELLED` | 任务启动、因依赖阻塞、请求用户输入或取消 |
| `BLOCKED` | `TODO`, `CANCELLED` | 依赖完成后解除阻塞，或取消 |
| `DOING` | `TESTING`, `REWORK`, `DONE`, `BLOCKED`, `NEED_USER`, `FAILED`, `CANCELLED` | 开发完成进入测试；`DOING → DONE` 允许直接完成（用于人工任务） |
| `TESTING` | `REVIEW`, `REWORK`, `NEED_USER`, `FAILED`, `CANCELLED` | 测试通过进入审查；测试失败触发返工 |
| `REVIEW` | `DONE`, `REWORK`, `NEED_USER`, `FAILED`, `CANCELLED` | 审查通过进入完成；提出修改意见触发返工 |
| `REWORK` | `DOING`, `TESTING`, `NEED_USER`, `FAILED`, `CANCELLED` | 返工交回开发者开始新一轮修改 |
| `NEED_USER` | `DOING`, `REWORK`, `TESTING`, `REVIEW`, `CANCELLED`, `FAILED` | 用户回复后恢复到相应阶段，或取消 |
| `DONE` / `FAILED` / `CANCELLED` | （无） | 终态 |

---

## 三、Git 分支与 Worktree 严格物理隔离 (Git Worktree Isolation)

为了保证主分支安全，任务绝不在工作区根目录主分支上直接操作，全部在独立的 Git Worktree 中执行：

1. **Dedicated Branch 命名规则**:
   ```text
   agent/<taskId>-<slug>
   ```
   例如：`agent/TASK-C7B840-完善-percentage-函数边界校验与测试-c7b840`
2. **Worktree 路径规约**:
   ```text
   <gitRoot>/.agenthub/worktrees/<taskId>
   ```
3. **防覆盖安全防护**:
   - 如果目标分支已存在，禁止覆盖并报错；
   - 如果 Worktree 已在 Git 中注册，禁止覆盖并报错；
   - 如果目标目录已在磁盘存在，禁止覆盖并报错。
4. **持久化保留**:
   - 任务达到 `DONE` 后，Worktree 与分支必须永久保留，供用户复核、发起 PR 或手工 Merge，严禁自动合并到 main。

---

## 四、独立测试门禁 (Independent Test Gate)

系统遵循**“不信任 Agent 文本自报测试通过”**原则：

1. **自动探测 (`TestDetector`)**:
   - Node.js: `package.json` 中的 `scripts.test` (优先执行 `npm test`)
   - Python: `pytest.ini` / `pyproject.toml` (`pytest`)
   - Rust: `Cargo.toml` (`cargo test`)
   - Go: `go.mod` (`go test ./...`)
   - Java: `pom.xml` (`mvn test`) / `build.gradle` (`./gradlew test`)
   - 自定义命令: 允许在创建任务时显式传入 `testCommand`。
2. **独立执行 (`TestRunner`)**:
   - 独立在 Worktree 目录下拉起子进程执行；
   - 设置严格超时控制（默认 60s）；
   - 以进程退出码 `exitCode === 0` 作为唯一通过标准；
   - 捕获完整 stdout/stderr。
3. **门禁逻辑**:
   - **测试失败**: 状态转移为 `TESTING -> REWORK`，将失败退出码及输出装载为上下文回传给 Codex，**严禁进入 REVIEW**；
   - **测试通过**: 状态转移为 `TESTING -> REVIEW`，触发 Gemini 审查。

---

## 五、Gemini 审查与自动返工闭环 (Review & Rework Loop)

1. **真实审查上下文**:
   - Gemini 读取 Worktree 实际代码文件；
   - Gemini 读取 `git diff HEAD` 与工作区修改状态；
   - Gemini 读取测试用例与测试结果。
2. **审查决策判定**:
   - `REVIEW_STATUS: REQUEST_CHANGES`: 审查意见包含具体缺陷或需补充的边界单测，流转至 `REWORK`，进入下一轮由 Codex 修正；
   - `REVIEW_STATUS: PASS`: 审查确认符合所有要求，流转至 `DONE`，生成 `TaskResult`。
3. **Loop Guard 防死循环保护**:
   - 每次循环递增 `currentRound`；
   - 达到 `maxRounds` 时，安全停机并转移为 `NEED_USER`，等待用户介入。

---

## 六、事件日志与审计溯源 (Task Event Log & Traceability)

所有生命周期动作均追加至 `logs/tasks/<taskId>.jsonl`：
- 事件类型涵盖：`TASK_CREATED`, `WORKTREE_CREATED`, `TASK_STARTED`, `STATUS_CHANGED`, `AGENT_STARTED`, `AGENT_COMPLETED`, `TEST_STARTED`, `TEST_PASSED`, `TEST_FAILED`, `REVIEW_STARTED`, `REVIEW_PASSED`, `REVIEW_FAILED`, `REWORK_STARTED`, `NEED_USER`, `TASK_COMPLETED`, `TASK_FAILED`。
- 具备父子任务溯源能力 (`parentTaskId`)，可通过 `TaskStore.getTree(taskId)` 提取完整层次树。
