# guardrails/：Orca 侧防护脚本

> 状态：早期、实验性。作者在本机用 Codex 担任“主控”、通过 Orca 的终端编排驱动 OpenCode 等编码 agent 作为 worker 时写的一组**防护与对账脚本**（Python/Node，独立于根目录的 TypeScript 包）。
> 本目录是仓库的一部分，许可证见仓库根目录 LICENSE。

## 这是什么（按代码实际行为描述）

本目录是围绕 Orca 桌面应用的公开 `orca` CLI（`terminal show/read`、`orchestration run-show/send/dispatch-show/request-show` 等子命令）写的一层“少做、可验证、不重发”的安全工具，外加离线可测试的协作原语：

| 文件 | 作用 |
|---|---|
| `scripts/orca-observer-notify.py` | 一次性“终端变化 → 本地持久 outbox → 一条 Orca status 消息”。`validate` 只校验配置；`prepare` 读取三方终端身份（handle / worktreePath / leafId / ptyId）和被观察终端尾部文本的 SHA-256 基线；`watch` 轮询直到文本摘要变化（可选要求出现指定触发行），然后**最多发送一条** `orchestration send --type status`。发送前必须有一个绑定配置哈希的授权文件 `{"version":1,"configSha256":...,"authorizeOneStatusMessage":true}`；SQLite outbox 在发送前先记 `sending`，进程崩溃后**永不自动重发**；`recover` 只按原始 request id 调 `request-show` 查询；`outbox` 只读列出记录。 |
| `scripts/orca-notify-acceptance.py` | 上面通知链路的单次人工验收步骤（`setup` / `receiver-preflight` / `verify` / `ack` / `report`），目标集合固定（默认是合成占位值，可用 `AIHUB_ACCEPTANCE_TARGETS` 指向审阅过的 JSON）。 |
| `scripts/orca-business-receipt-audit.py` | 离线审计：把保存下来的 `dispatch-show`（和可选 `terminal-show`）JSON 与预期映射逐字段比对；明确输出“匹配不等于认证、不代表当前运行状态”。 |
| `scripts/orca-receipt-observer.mjs` | 离线合同演练（无子进程、无网络）：注入 `read/clock/sleep` 的观察器，绑定校验、文本摘要变化检测，事件以“临时文件 + hard link、不覆盖”方式写入日志目录；`demo` / `replay` 只用合成样本。 |
| `scripts/collaboration_phase1.py` | 离线原语：重复派发预检（只给决策建议，`canDispatch` 恒为 false）、任务文件字节快照（O_NOFOLLOW、读前读后 stat 比对）、一次性 SQLite 历史对账账本原型（源文件哈希 CAS、精确决策包、outbox 投影）。 |
| `scripts/orca-current-window-readonly.py` | 在普通终端手动运行：只调 Orca 公开的 status/show/read，读取指定终端（`AIHUB_TARGET_TERMINAL`），结果写入新的私有目录。 |
| `scripts/agenthub-runtime-inventory.py` | macOS：用 `ps` / `lsof` 列出 node/bun/deno/tsx 进程的 cwd 与 TCP 监听端口，并标记 cwd 是否等于 `AIHUB_AGENTHUB_ROOT`；只读，结果写入 `outputs/` 下新目录。 |

`docs/` 中两份中文文档是方法说明：多模型协作搭建方案、主控命令五级权限（L0–L4）草案。

## 安全模型

- **默认不动手**：大部分脚本默认只校验/规划，真正的外部动作需要显式参数和授权文件。
- **一次授权一次动作**：通知最多一条；结果不明时记录为 unknown，交给人工对账，绝不自动重试或重发。
- **身份钉死**：运行时 id、Run、consumer generation、终端 handle/leafId/ptyId 每次都重新核对，漂移即停。
- **拒绝在沙箱/模型会话里跑 live 命令**：检测到 `CODEX_SANDBOX`、`ORCA_AGENT_SESSION_ID` 或远程配对变量即退出；live 命令只能在发送方自己的 Orca shell 中由人运行。
- **文件安全**：`O_NOFOLLOW` / `O_EXCL`、0600/0700 权限、fsync、不覆盖已有记录。
- 这些是应用层约束，**不是 OS 沙箱**。

## 运行

依赖：Python 3（仅标准库）、Node.js 22+（仅内置 `node:test`）。live 功能还需要 macOS 上的 Orca 及其 CLI；测试不需要。

```bash
./run-tests.sh            # 离线测试；可用 NODE=/path/to/node 指定 node
```

live 使用前设置环境变量（全部可选，未设置时用占位默认值，会按设计校验失败）：

| 变量 | 含义 | 默认 |
|---|---|---|
| `AIHUB_ORCA_CLI` | Orca CLI 绝对路径 | `/Applications/Orca.app/Contents/Resources/bin/orca` |
| `AIHUB_WORKSPACE` | Orca 中该机制所在 worktree 绝对路径（必须与配置中 `workspace` 一致） | `/path/to/orca-workspace` |
| `AIHUB_ORCA_PROFILE` | Orca 用户数据目录 | `~/Library/Application Support/orca` |
| `AIHUB_HOME` | 本目录（读 `config/`，写 `outputs/`） | `guardrails/` |
| `AIHUB_TARGET_TERMINAL` | 只读脚本要读取的终端 handle | 无（必填） |
| `AIHUB_AGENTHUB_ROOT` | 进程盘点时比对的 agent-orchestrator（AgentHub 核心）目录 | 仓库根目录 |
| `AIHUB_ACCEPTANCE_TARGETS` | 验收目标 JSON | 合成占位值 |

`config/orca-observer-notify.test.json` 只含合成占位 id，用于测试和作为配置模板。`outputs/` 为运行证据目录，已在 `.gitignore` 中排除，请勿提交。

---

## English (short)

Early, experimental Python/Node guardrail scripts (independent of the root TypeScript package) written while using Codex as a "controller" that drives other coding agents (e.g. OpenCode) as workers through the Orca desktop app's public `orca` CLI. It contains: a one-shot terminal-change observer that sends at most one Orca status message, gated by an explicit grant bound to the config hash and a durable SQLite outbox that never auto-resends; offline audits of retained dispatch/terminal receipts; an offline, dependency-injected observer rehearsal; and offline primitives for duplicate-dispatch preflight, byte-stable task snapshots and an isolated reconciliation ledger prototype. Python stdlib + Node 22 only; run `./run-tests.sh` (offline, no model calls). Local paths are configured via the `AIHUB_*` environment variables above. See the repository root for the license.
