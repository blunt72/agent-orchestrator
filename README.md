# agent-orchestrator（开源候选版）

> 状态：早期、个人维护、实验性。许可证：Apache-2.0（见 LICENSE）。

agent-orchestrator 是一个**本地运行**的 TypeScript 工具（内部核心模块沿用 AgentHub 这个名字，CLI 命令仍为 `agenthub`）：默认让 Codex 当开发者、Gemini（通过 Google Antigravity 的本地 `agentapi`）当审查者（任务设 `reviewerId: "codex"` 时两者互换），围绕一个正式的 Task 跑“隔离开发 → 独立测试门禁 → 审查 → 返工”的流程，并提供项目/史诗/任务的管理、REST API 与本地 Web 看板。仓库另附 `guardrails/`：用 Codex 当主控、经 Orca 桌面应用的 `orca` CLI 管理编码 agent worker 时写的 Python/Node 防护脚本。

下面只写代码里实际有的东西。

## 代码实际做什么

**Agent 层（`src/agents/`）**
- `CodexAgent`：经 Agent Client Protocol（`@agentclientprotocol/sdk`）启动 `codex-acp` 子进程并进行会话；优先用本地 `node_modules/.bin/codex-acp`，否则 `npx -y @agentclientprotocol/codex-acp@2.0.1`。
- `AntigravityAgent`：调用本机 Antigravity 的 `agentapi`（查找 `~/.gemini/antigravity*/bin/agentapi`、`ANTIGRAVITY_AGENTAPI_EXE`、`/Applications/Antigravity.app/...`），读取其 transcript 作为审查输出。
- `CodexExecReviewAgent`：以 `codex exec --ignore-user-config --ignore-rules --ephemeral --sandbox read-only -c approval_policy="never"` 做只读审查；输出格式通过 `--output-schema` 交给 codex CLI 约束，本地代码只校验 codex 的 JSONL 事件流（线程 / 回合开始与完成、失败事件），不按 schema 再校验输出内容。

**对话编排（`src/core/`）**：`chat` / `run` 命令让 Codex 与 Gemini 轮流发言，由 router 和状态机决定下一位，`--max-rounds` 限制轮数；日志经 `sanitizeLog` 脱敏（API key、Bearer token 等）。

**Task Engine（`src/tasks/`、`src/git/`、`src/testing/`）**
- 状态机（`src/tasks/task-state-machine.ts`）：主流程 `TODO → DOING → TESTING → REVIEW → DONE`，测试失败或审查要求修改时进入 `REWORK` 再回到 `DOING`；另有 `BLOCKED`（依赖未完成，完成后回到 `TODO`）、`NEED_USER`、`FAILED`、`CANCELLED`。状态机也允许 `DOING → DONE`（人工任务直接完成）。不在允许表中的跳转会被拒绝，完整表见 `TASK_ENGINE.md`。
- 每个任务新建分支 `agent/<taskId>-<slug>` 与 worktree `.agenthub/worktrees/<taskId>`；目标已存在则拒绝覆盖；不会自动 merge。
- 独立测试门禁：自动识别 `npm test` / `pytest` / `cargo test` / `go test ./...` / `mvn test` / Gradle，或用 `--test-command`；以退出码为准，不信任 agent 的文字自报。
- 测试失败或审查 `REQUEST_CHANGES` 进入返工，`maxRounds` 防止死循环。任务数据写到 `data/tasks/*.json`，事件写到 JSONL；带文件锁、修订号快照、claim/执行锁与重启恢复。

**Project Engine（`src/projects/`）**：项目 / 史诗 / 任务层级，Actor（AGENT / HUMAN）归属，依赖解析与环检测、阻塞自动解除，按状态加权的进度计算，并发队列，`NEED_USER` 人工交接。

**服务与看板（`src/server/`）**：Fastify，默认只监听 `127.0.0.1:3000`；`/api/tasks`（create / run / start / claim / assign / block / unblock / respond / resume / cancel / complete / events / tree / traceability）、`/api/projects`（epics / tree / progress / events 以及 SSE `events/stream`）、`/dashboard` 单页看板。**没有身份认证**，请勿暴露到网络。

**Orca 集成（`src/integrations/orca-*` 及 `src/cli/orca-projection.ts`，约 5.9k 行）**：把经 Orca 派发、在外部执行的任务的证据（回执、交付信封、测试 / 审查记录、生命周期）以哈希钉死、比对修订号与 generation 的方式导入和核验；审批、完成就绪检查、受限完成事务和 relay 日志都设计为 fail-closed。已逐项核对的写入门槛：`task orca-project` 默认只预览，加 `--apply` 时必须同时给出 `--revision`、`--generation`、`--digest`；`inspectOrcaUnifiedPreflight`、`inspectOrcaCompletionReadiness` 等核验函数只读、不写任务，且始终返回 `canCompleteTask=false`。`automation preflight|limited|print` 命令暴露其中另一部分，见 `docs/`。

**CLI（`src/index.ts`，bin 名 `agenthub`）**：`doctor`、`chat`、`run`、`status`、`task create|run|status|events|cancel|orca-project`、`automation preflight|limited|print`、`server`。

**`scripts/`**（6 个 Node 脚本，见 `docs/scripts.md`）：`gemini-transcript-watch.mjs`（Gemini transcript 只读监听）、`gemini-task-event-bridge.mjs`（Gemini transcript → Task 事件桥的观察命令）、`orca-terminal-watch.mjs`（Orca 终端只读等待）、`orca-call-guard.mjs`（Orca 调用预算策略）、`p2b-architecture-rehearsal.mjs`（离线合成演练）、`build-print-runtime.mjs`（打印运行时构建）。

**`guardrails/`**：见 [guardrails/README.md](guardrails/README.md)。

## 安装、构建、测试

需要 Node.js（已在 v22 测试）、git；guardrails 另需 Python 3（仅标准库）。

```bash
npm ci                 # 依赖全部为 MIT / ISC / BSD / Apache-2.0
npm run build          # tsc → dist/
npm test                                       # vitest 离线测试，默认排除 tests/e2e/real-*，不调用模型
node --test tests/local/*.test.mjs             # 脚本的离线测试
./guardrails/run-tests.sh                      # guardrails 离线测试
```

`package.json` 设置了 `"private": true`：目前不发布到 npm（npm 上的 `agent-orchestrator` 包名属于别人，与本项目无关），请从源码使用。

`tests/e2e/real-*.test.ts`（4 个文件，共 7 个用例）会启动真实的 Codex ACP / Antigravity 进程并调用真实模型，需要你自己的已登录账号，也会产生费用，因此**默认被排除**（见 `vitest.config.ts`）。确需运行时显式开启：

```bash
npm run test:real                 # 等价于 AGENTHUB_REAL_TESTS=1 vitest run tests/e2e/real-
```

## 安全模型

- 开发在独立 worktree / 分支中进行，不自动合并到主分支。
- 测试结果以独立进程的退出码为准，不信任 agent 自报。
- 审查的只读程度取决于审查者和接线方式：仓库里有强制只读的 Codex 审查组件（`CodexExecReviewAgent` 的 `--sandbox read-only`，以及 ACP 的 `reviewOnly` 模式：拒绝所有权限请求、不声明文件写入能力，见 `docs/ACP_READ_ONLY_REVIEW.md`），但**默认任务流程目前没有使用它们**：任务设 `reviewerId: "codex"` 时，`TaskRunner`（`src/tasks/task-runner.ts`）创建的是普通的 `CodexAgent()` 会话，未开启 `reviewOnly`，不是只读的；`CodexExecReviewAgent` 目前只有单元测试在用。把只读审查接入默认流程已列入路线图。默认的 Gemini / Antigravity 审查者**只靠提示词**要求不改文件，没有沙箱。
- 任务存储写入有文件锁、修订号 CAS 和防覆盖检查；保存结果不明、锁被占用或修订号冲突时停止并报错，不自动重试，遗留的锁也不会自动删除。
- 例外：开发用的 `CodexAgent` 在发送 prompt 前若发现 ACP 子进程已退出，会自动重启子进程并继续发送这一条 prompt，默认最多 2 次（`maxRestarts`，见 `src/agents/acp-agent.ts`）；`reviewOnly` 审查会话不重启。
- Orca 相关：`task orca-project` 默认只预览，写入必须加 `--apply` 并给出 `--revision`、`--generation`、`--digest`；统一预检与完成就绪检查只读，`canCompleteTask` 始终为 false。其他 Orca 入口的行为见 `docs/` 中对应文档，README 不作统一承诺。
- REST 服务只绑定本机、没有认证；运行数据在 `data/`、`logs/`、`.agenthub/`，已在 `.gitignore` 中排除，**不要提交**。
- 这些是应用层约束，不是 OS 沙箱；真实 agent 在你的账号权限下运行。

## 文档

`ARCHITECTURE.md`、`TASK_ENGINE.md`、`PROJECT_ENGINE.md`、`API.md`（REST 接口）、`DASHBOARD.md`，以及 `docs/` 下的组件说明（Orca 相关按主题合并为 `docs/orca-*.md`，Antigravity 相关为 `docs/antigravity-*.md`，脚本说明为 `docs/scripts.md`；另有按单个组件拆分的专题文档，如 `docs/ORCA_*.md`、`docs/ACP_READ_ONLY_REVIEW.md`、`docs/AUTOMATION_FAST_PATH.md`、`docs/PRINT_WORKFLOW_CLI.md`、`docs/ANTIGRAVITY_PRINT_CAPTURE.md`）。部分文档写于早期版本（V0.2 / V0.3），以代码为准。

---

## English (short)

agent-orchestrator is a **local** TypeScript tool (its core is internally called AgentHub; the CLI command is still `agenthub`) in which, by default, Codex (via the Agent Client Protocol, `codex-acp`) acts as the developer and Gemini (via Google Antigravity's local `agentapi`) acts as the reviewer (setting `reviewerId: "codex"` swaps the roles). Each formal Task runs through a dedicated git branch and worktree (never auto-merged), an independent test gate (auto-detects npm / pytest / cargo / go / mvn / gradle; the exit code decides), review, and a rework loop bounded by `maxRounds`; task states are TODO, BLOCKED, DOING, TESTING, REVIEW, REWORK, NEED_USER, DONE, FAILED and CANCELLED, with illegal transitions rejected (see `TASK_ENGINE.md`). Read-only Codex review components exist (`CodexExecReviewAgent` using `codex exec --sandbox read-only`, and the ACP `reviewOnly` mode; see `docs/ACP_READ_ONLY_REVIEW.md`), but the default task flow does not use them yet: when a task sets `reviewerId: "codex"`, `TaskRunner` creates a normal `CodexAgent()` session without `reviewOnly`, which is not read-only (wiring the read-only reviewer into the default flow is on the roadmap). The default Gemini/Antigravity reviewer is constrained by its prompt only. The Codex review output format is delegated to `codex exec --output-schema`; it is not re-validated locally. Task store writes use file locks and revision CAS and stop without retrying on an uncertain result, but if the developer `CodexAgent`'s ACP process has exited, it is restarted before the next prompt is sent (up to 2 times by default; never for `reviewOnly` sessions). It also provides a project / epic / task engine (actors, dependency resolution with cycle detection, weighted progress, human handoff), a Fastify REST API and dashboard bound to 127.0.0.1 with **no authentication**, a CLI (`doctor`, `chat`, `run`, `task …`, `automation …`, `server`), and fail-closed, hash-pinned import and verification of evidence for tasks dispatched through Orca (~5.9k lines; `task orca-project` only previews unless `--apply` is given together with `--revision`, `--generation` and `--digest`). `scripts/` holds six Node helper scripts (`gemini-transcript-watch`, `gemini-task-event-bridge`, `orca-terminal-watch`, `orca-call-guard`, `p2b-architecture-rehearsal`, `build-print-runtime`; see `docs/scripts.md`). `guardrails/` contains companion Python/Node scripts for Orca-managed workers. Offline tests: `npm test` (real-model `tests/e2e/real-*` are excluded by default), `node --test tests/local/*.test.mjs`, `./guardrails/run-tests.sh`. Opt in to the real-model e2e tests with `npm run test:real` (sets `AGENTHUB_REAL_TESTS=1`); they use your own accounts and may incur cost. Not published to npm (`"private": true`; the npm name `agent-orchestrator` belongs to an unrelated package) — use it from source. Early and experimental. License: Apache-2.0.
