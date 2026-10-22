# Minimal reusable automation path

Use the existing project policy and task/claim/binding/evidence primitives. Do not require a custom Orca application build or diagnosis of a historical worker before starting a separately authorized fresh attempt.

## Available entry point

```sh
npm run build
node dist/index.js automation preflight --policy /absolute/project-policy.json --sha256 EXPECTED_SHA256
```

Supply an independently selected original-byte policy digest. Computing a digest of arbitrary input is not authorization. A successful command means policy syntax and local path checks passed, not that a worker may run. JSON explicitly retains canDispatch=false, canExecute=false, canCompleteTask=false and sourceAuthenticated=false. Exit 1 returns a fixed rejection code without echoing policy bytes or filesystem exception details.

The check reads a bounded regular single-link policy file, rejects symlinks, malformed UTF-8, size/digest mismatch and observed file drift, and delegates project path validation to the existing policy module. No policy code or test configuration is executed. No task store, provider or Orca runtime is instantiated by the check function. Quiescent trusted paths remain required; this is not hostile filesystem isolation or an atomic multi-file snapshot.

Source tsx CLI launch currently encounters an existing type-only import compatibility error in task-store.ts on the observed Node 26 runtime. The compiled CLI works. This change does not repair unrelated module imports.

## Next execution milestones

Explicit v2 policies now support the reversed Codex developer / Antigravity
coordinator with Gemini reviewer and an exact native Node test profile. The
post-review print limited-acceptance path has a reusable configuration-driven
entry and exclusive frozen-runtime builder; see [PRINT_WORKFLOW_CLI.md](PRINT_WORKFLOW_CLI.md).
This does not automate dispatch, review capture or normal managed-worker release.

1. Fresh supervised attempt: select a task not already completed, retain current dirty baseline, start only an explicitly authorized waiting worker through the real Orca coordinator, persist exact claim/runtime/run/task/dispatch/worker/policy binding, and only then release development. Never reuse the historical blocked dispatch.
2. Normal completion: collect original worker result, independently inspect the permitted diff, run only the fixed acceptance argv, obtain independent review, then use the existing validated evidence/writeback path and explicit completion authority. Preserve task/project progress distinctions and cleanup accounting.
3. Safe interruption: persist a checkpoint; on timeout, unknown outcome or identity drift stop and surface action needed. No automatic resend, duplicate worker, orphan-lock stealing or inferred DONE. Automate proven normal transitions first; automatic exceptional recovery is not an MVP prerequisite.

The preflight CLI covers policy preparation only; the separate print CLI packages explicit post-review limited acceptance. Neither is an automatic coordinator. Relay journal/reconciliation functions describe normalized evidence and do not themselves invoke Orca. The ordinary TaskRunner auto-executes agents and worktrees; it must not be used as an unreviewed bypass of the Orca-bound task fences or project policy.

## Reuse criterion

Keep workspace, documentation, read/write whitelist, exact test argv/cwd and budgets in one pinned project policy. Validate a second project's own policy and execute its own fresh low-risk task before claiming cross-project runtime reuse. Synthetic policy tests prove configuration generality, not two real project collaborations.

No real-provider Gate is closed by policy checks, synthetic tests, retained diagnostics or a compiled CLI alone.
