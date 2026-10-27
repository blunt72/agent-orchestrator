# 安装与第一次使用

本文只描述当前仓库里实际存在的路径。CLI 命令名是 `agenthub`。npm 包名是 `agent-orchestrator`，且 `package.json` 里是 `"private": true`：不发布到 npm。registry 上的 `agent-orchestrator` 与 `agenthub` 都不是本仓库。

从零到离线冒烟不需要 Codex 账号，也不需要 Google Antigravity。那两样只在第 6 节的真实模型流程里才用到。

## 1. 前置条件

| 需要 | 用途 |
|---|---|
| Node.js 20 或更高 | `agenthub doctor` 把主版本号 ≥ 20 记为通过。本仓库 CI（`.github/workflows/ci.yml`）和当前开发使用 **Node.js 22**。 |
| npm | 锁定安装用 `npm ci`（CI 同样如此）。 |
| git，且在 `PATH` 上 | 只有 `task run` 创建 worktree 时会 `spawn("git")`。`--help`、`status`、`task create` 不调用 git。 |
| Unix shell（Linux 或 macOS） | `doctor` 用 `which` 查找 `codex`。CI 跑在 `ubuntu-latest`。macOS 另有一处 Antigravity.app 路径（第 6 节）。仓库没有 Windows 专用安装路径。 |
| Python 3（仅标准库） | 只跑 `guardrails/` 的测试时需要。CLI 本身不用 Python。CI 使用 Python 3.13；`guardrails/run-tests.sh` 调用 `python3 -m unittest`。 |

没有必须预先设置的环境变量。`data/`、`logs/`、`.agenthub/` 会在相应命令第一次写入时自己创建，不必事先建好（第 7 节）。

## 2. 克隆、安装依赖、构建

```bash
git clone https://github.com/blunt72/agent-orchestrator.git
cd agent-orchestrator
npm ci
npm run build
```

`npm run build` 执行 `tsc`，输出 `dist/`（已在 `.gitignore` 中，克隆下来是没有的）。`package.json` 的 `bin` 指向 `dist/index.js`，所以要先构建再按下面的方式调用。

`npm ci` 不会把 `agenthub` 放进 `node_modules/.bin`，也不会改全局 `PATH`。

依赖装好之后，`node_modules/.bin/codex-acp` 存在（直接依赖 `@agentclientprotocol/codex-acp`）。同目录下的 `codex` 是该包带进来的 `@openai/codex`，**不在默认 `PATH` 上**。`doctor` 如何看到它，见第 5 节。

## 3. 如何运行 CLI

在仓库根目录、且已经 `npm run build` 之后，下面三条都不需要全局安装。

```bash
node dist/index.js --version
npx agenthub --version
npm run agenthub -- --version
```

三条都应打印 `0.3.1` 并以退出码 0 结束。

| 方式 | 何时可用 | 进程的当前目录 |
|---|---|---|
| `node dist/index.js …` | 构建之后。文件带有 `#!/usr/bin/env node`，但构建产物本身没有可执行权限，用 `node` 调用。 | 你的 shell 当前目录。可以从别的目录写绝对路径：`node /path/to/agent-orchestrator/dist/index.js …`。 |
| `npx agenthub …`（或 `npm exec agenthub -- …`） | 构建之后，且当前目录在本仓库内（含子目录）。npm 读取本包的 `bin`。 | 你的 shell 当前目录。 |
| `npm run agenthub -- …` 或 `npm start -- …` | `npm ci` 之后即可。这两条脚本都是 `tsx src/index.ts`，不读 `dist/`。 | **仓库根目录**。`npm run` 会把当前目录改到 `package.json` 所在处，即使你在子目录里执行。 |

在本仓库之外执行 `npx agenthub` 会向 registry 请求名为 `agenthub` 的包，得到 404。那不是安装失败，是包没有发布。

不带任何参数时，程序把帮助打到 stderr，退出码是 **1**。确认安装请用 `--help` 或 `--version`（退出码 0）。

`npm start` 不会启动 HTTP 服务。启动服务是 `npm start -- server`（第 8 节）。

可选：构建之后把命令放进 `PATH`。

```bash
npm link
agenthub --version
```

全局包名是 `agent-orchestrator`，命令名是 `agenthub`。`npm link` 要能写入 npm 的全局前缀（`npm prefix -g`）；没有写权限时会 `EACCES`。卸下：

```bash
npm unlink -g agent-orchestrator
```

链接的是 `dist/index.js`。先构建再 `npm link`；之后重新构建不需要再次 link。

## 4. 离线冒烟

以下命令不启动 Codex / Antigravity，也不调用模型。在仓库根目录执行。先完成第 2 节。

```bash
node dist/index.js --version
node dist/index.js --help
node dist/index.js status
```

预期：

- `--version` 打印 `0.3.1`，退出码 0。
- `--help` 列出 `doctor`、`chat`、`run`、`status`、`task`、`automation`、`server`，退出码 0。
- `status` 在没有 `data/sessions.json` 时打印 `No active or past sessions found.`，退出码 0。已有会话则打印最近一条，退出码仍是 0。这条命令会在**当前目录**确保存在 `data/` 和 `logs/`（仓库里这两个目录已在 `.gitignore` 中）。

再写一条不进仓库的任务，证明 `task` 子命令可用。`task create` 不创建 git 分支，也不要求目标目录已经是 git 仓库：

```bash
STORE=$(mktemp -d)
AGENTHUB_STORE="$STORE" node dist/index.js task create \
  -t "install smoke" -d "offline" -w "$STORE" --priority LOW
AGENTHUB_STORE="$STORE" node dist/index.js task status TASK-...
```

把 `TASK-...` 换成上一条输出里的 `Task:` id（形如 `TASK-MVQ2XSIO-A883`）。预期：创建时打印 `Task Created Successfully`，状态为 `TODO`，`Branch` / `Worktree` 为 `(not created yet)`；`task status` 退出码 0。文件在 `$STORE/data/tasks/` 与 `$STORE/logs/tasks/`，不在仓库里。

然后跑离线测试（与 CI 相同，且必须在 `npm run build` 之后，因为有测试会执行 `dist/index.js`）：

```bash
npm test
node --test tests/local/*.test.mjs
./guardrails/run-tests.sh
```

`npm test` 是 `vitest run`。`tests/e2e/real-*` 默认排除。guardrails 那条需要 Python 3，不需要 Orca。

不要把下面的命令当成冒烟：`chat`、`run`、`task run`、`npm run test:real`。它们会启动真实的 Codex ACP 与 Antigravity 进程并调用模型。`task run` 还要求任务的 workspace 已经是 git 仓库，并会创建分支 `agent/<taskId>-<slug>` 和 worktree `.agenthub/worktrees/<taskId>`，且不会自动 merge。

## 5. `doctor` 在查什么

```bash
node dist/index.js doctor
node dist/index.js doctor --workspace /path/to/dir
```

退出码 **0 表示每一项都通过**，包括下表第 8 项对真实模型的探测。一台没有安装 Antigravity 的机器上退出码为 1，是预期结果，不表示 CLI 没装好。第 4 节的 `--version` / `status` 才是安装是否成功的标准。

帮助文案写的是 “Gemini ACP”。代码实际检查的是下面这些项（`src/cli/doctor.ts`）：

| # | 项 | 通过条件 |
|---|---|---|
| 1 | Node.js Environment | `process.version` 主版本 ≥ 20 |
| 2 | Codex CLI | `which codex` 有结果，且 `codex --version` 成功 |
| 3 | Codex Authentication | 仅当第 2 项找到 CLI。存在 `~/.codex/config.toml` 或 `~/.codex/sessions` 时报告本地会话；两者都没有时**仍然记为通过**，并说明留到会话启动时再验证。这里不执行登录。 |
| 4 | Codex ACP Adapter | 能解析出启动命令即通过，不运行该进程。顺序：当前目录的 `node_modules/.bin/codex-acp`，然后是本仓库 `dist/agents` 相对的 `node_modules/.bin/codex-acp`，否则记为 `npx -y @agentclientprotocol/codex-acp@2.0.1`。`npm ci` 之后本仓库这条会通过。 |
| 5 | Google Reviewer Provider Executable | 按第 6 节的顺序找到可执行的 `agentapi`，SHA256 不是内置的 fake-agy 指纹，且 `agentapi --help` 输出同时含有 `new-conversation` 和 `send-message` |
| 6 | Google Reviewer Provider Type | 第 5 项找到了可执行文件 |
| 7 | Google Reviewer Authentication | 第 5 项找到了可执行文件就记为通过。若 `~/.gemini/google_accounts.json` 能解析出 `active`，消息里带上账号名；没有这个文件时消息仍写成已认证。这里不执行登录。 |
| 8 | Google Reviewer Real Model Ability | 第 5、7 项都通过时，**真正执行** `agentapi new-conversation --model=flash`，并最多等约 10 秒，在 `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript.jsonl` 里查找探针字符串。这会调用模型，可能产生费用。前提不满足时这一项失败，但不会发请求。 |
| 9 | Shared Workspace | `--workspace` 或当前目录存在且是目录 |

第 2 项只看 `PATH` 里的 `which codex`：

- `node dist/index.js doctor` 不会把 `node_modules/.bin` 加进 `PATH`。系统里没有单独安装的 `codex` 时，第 2、3 项失败。这不妨碍第 4 项通过。
- `npm run agenthub -- doctor` 时，npm 会把 `node_modules/.bin` 加进 `PATH`，`which codex` 会找到依赖里的 `@openai/codex`。此时第 2 项可以通过，即便你没有全局安装 Codex。真正跑任务时，`codex-acp` 用的也是这个依赖链上的 CLI，外加你自己的 `~/.codex` 登录状态。

`PATH` 上若已有别的 `codex`，`which` 用先找到的那一个。

## 6. 可选：真实模型流程

`chat`、`run` 和 `task run` 的默认接线（`src/core/orchestrator.ts`、`src/tasks/task-runner.ts`）是：

- 开发者：`CodexAgent`，通过 ACP 启动 `codex-acp`
- 审查者：`AntigravityAgent`，调用本机 `agentapi`

任务把 `reviewerId` 设为 `"codex"` 时两边对调。仓库里另有 `GeminiAgent`（ACP 的 `gemini` CLI，会看 `GEMINI_API_KEY` / `GOOGLE_API_KEY`），**当前这些 CLI 命令不会构造它**。不需要为默认流程设置 Gemini API key。

这些命令的默认工作区是 `./examples/demo-workspace`（`chat` / `run` 的 `--workspace`）。那只是一个示例目录，不会代替登录。

### Codex

1. `codex` 要能被 `which` 找到，或者接受第 5 节里 `npm run agenthub` 把 `node_modules/.bin/codex` 放进 `PATH` 的行为。
2. 登录由 Codex CLI 自己完成。本仓库没有登录子命令。`doctor` 只检查 `~/.codex/config.toml` 或 `~/.codex/sessions` 在不在。
3. `codex-acp` 随 `npm ci` 装进本仓库的 `node_modules/.bin`。找不到本地文件时，`CodexAgent` 才会退回 `npx -y @agentclientprotocol/codex-acp@2.0.1`（需要网络）。

### Antigravity / Gemini 审查者

`agentapi` 按下面的顺序找第一个**存在且可执行**的路径（`src/agents/antigravity-agent.ts` 与 `doctor` 相同）：

1. `~/.gemini/antigravity/bin/agentapi`
2. `~/.gemini/antigravity-ide/bin/agentapi`
3. 环境变量 `ANTIGRAVITY_AGENTAPI_EXE`，并且值必须以字符串 `agentapi` 结尾，否则被忽略
4. `/Applications/Antigravity.app/Contents/Resources/bin/agentapi`（macOS 应用包）

二进制内容若等于仓库里写死的 fake-agy SHA256，或文件头里含有 `fake-agy` / `STREAM_JSON_STATE_MEMORY`，会被拒绝。

审查输出从 transcript 读取。未单独指定 brain 根目录时，候选是：

- `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`
- `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript.jsonl`

两个候选文件都存在则报 `AMBIGUOUS_ANTIGRAVITY_TRANSCRIPT_SOURCE`。都不存在、且两个 brain 根目录都在（或都不在）时，报 `ANTIGRAVITY_TRANSCRIPT_ROOT_UNRESOLVED`。`doctor` 的现场探针只读 `~/.gemini/antigravity/brain` 那一条，不读 `antigravity-cli`。

账号显示名来自 `~/.gemini/google_accounts.json` 的 `active` 字段。没有这个文件时，`doctor` 的认证项仍会通过（第 5 节）。

### 会调用模型的测试

```bash
npm run test:real
```

等价于 `AGENTHUB_REAL_TESTS=1 vitest run tests/e2e/real-`。会启动真实 Codex ACP / Antigravity 并调用模型，使用你自己的账号，可能产生费用。CI 不设置这个变量。

## 7. 运行时目录与环境变量

不必事先创建目录。下面的路径已在根目录 `.gitignore` 中，不要提交。

| 路径 | 谁创建 |
|---|---|
| `data/`、`logs/` | `status`（以及 `chat` / `run`）里的 `SessionStore`。会话索引是 `data/sessions.json`，会话日志是 `logs/session-<id>.jsonl`。位置是进程当前目录，**不看** `AGENTHUB_STORE`。 |
| `data/projects`、`data/epics`、`data/tasks`、`data/actors`、`logs/projects`、`logs/tasks` | `task …` 与 `server` 使用的 `ProjectStore`。根目录是 `AGENTHUB_STORE`，未设置时是进程当前目录。第一次构造时会写入默认 actor 文件。 |
| `.agenthub/worktrees/<taskId>` | 仅 `task run`，且 workspace 必须已经是 git 仓库。位于该仓库的 git 根下。 |

`npm run agenthub` / `npm start` 的当前目录是仓库根，所以不带 `AGENTHUB_STORE` 时，任务文件会写进仓库的 `data/`（被忽略，但会留在工作区）。冒烟请用第 4 节的临时目录。

| 变量 | 作用 |
|---|---|
| `AGENTHUB_STORE` | 任务 / 项目 / `server` 的存储根。绝对路径或相对路径都可以（代码里 `path.resolve`）。不影响 `status` 的会话文件。 |
| `ANTIGRAVITY_AGENTAPI_EXE` | 可选的 `agentapi` 绝对路径，必须以 `agentapi` 结尾。 |
| `AGENTHUB_TRANSCRIPT_BRIDGE` | 设为 `1` 时，`TaskEngine` 启用 Gemini transcript 桥。同时必须把 `AGENTHUB_GEMINI_BRAIN_ROOT` 设成绝对路径，否则构造引擎即抛 `EXPLICIT_GEMINI_BRAIN_ROOT_REQUIRED`，`task` 与 `server` 都起不来。日常使用不要设置。 |
| `AGENTHUB_REAL_TESTS` | 设为 `1` 时 vitest 才包含 `tests/e2e/real-*`。用 `npm run test:real`，不要手动打开，除非你要跑真实模型。 |

`guardrails/` 另有一套 `AIHUB_*` 变量，只服务那个目录，见 [guardrails/README.md](../guardrails/README.md)。

## 8. 本地 HTTP 服务

默认只监听 `127.0.0.1:3000`。没有身份认证。

```bash
node dist/index.js server --port 3000 --host 127.0.0.1
```

等价写法：`npm start -- server`，或在仓库内 `npx agenthub server`。`--host` 可以改成别的地址；不要把它暴露到网络上。看板与路由见 [API.md](../API.md) 和 [DASHBOARD.md](../DASHBOARD.md)。

另一个终端：

```bash
curl -s http://127.0.0.1:3000/health
```

返回 JSON，其中 `status` 为 `ok`。这也不会调用模型。服务一直占用进程，用完停掉即可。

## 9. 安全

与 [README](../README.md) 的「安全模型」一致，安装时特别相关的几条：

- REST 默认只绑本机，没有认证。`--host` 能改掉这个默认值。
- 运行数据在 `data/`、`logs/`、`.agenthub/`，另有 `outputs/` 与 `.env`。这些都已忽略，不要提交。
- `doctor` 在 Antigravity 可执行文件存在时会发一次真实模型探针。
- `task orca-project` 默认只预览；写入必须同时给出 `--apply`、`--revision`、`--generation`、`--digest`。
- 真实 agent 跑在你的账号权限下。应用层约束不是操作系统沙箱。

---

## English (short)

The package is private and is not published to npm. The CLI name is `agenthub`; the npm package name is `agent-orchestrator`. From a clone: `npm ci`, `npm run build`, then `node dist/index.js --version`, `node dist/index.js --help`, and `node dist/index.js status` (prints `No active or past sessions found.` and exits 0 when no sessions exist). `npx agenthub` works only inside this repository; outside it, npm looks up an unpublished package named `agenthub` and returns 404. `npm start` runs the CLI via `tsx`; it does not start the server (`npm start -- server` does). Node.js 20+ is what `doctor` accepts; CI uses Node.js 22. git is required only for `task run` worktrees. Python 3 is only for `guardrails/`.

`agenthub doctor` exits 0 only when every check passes, including a live Antigravity model probe that can cost money. Exit code 1 without Antigravity does not mean the install failed. Codex and Antigravity logins are optional and are documented in section 6. Offline tests: `npm test` (after the build), `node --test tests/local/*.test.mjs`, `./guardrails/run-tests.sh`. Real-model tests: `npm run test:real`.
