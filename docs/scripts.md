# Helper scripts (`scripts/`)

Plain Node.js scripts (no extra npm dependencies). None of them calls a model, sends terminal input, or approves anything.

| Script | Purpose | Offline test |
|---|---|---|
| `gemini-transcript-watch.mjs` | Read-only watcher for a Gemini CLI `transcript.jsonl` | `node --test tests/local/gemini-transcript-watch.test.mjs` |
| `gemini-task-event-bridge.mjs` | Observation CLI for the Gemini transcript → Task event bridge (needs `npm run build`) | covered by vitest |
| `orca-terminal-watch.mjs` | One bounded, read-only wait on an Orca terminal | `node --test tests/local/orca-terminal-watch.test.mjs` |
| `orca-call-guard.mjs` | In-memory call budget policy for Orca terminal reads | `node --test tests/local/orca-call-guard.test.mjs` |
| `p2b-architecture-rehearsal.mjs` | Offline rehearsal in a fresh temporary Git repo/store with mock agents and injected Orca reads (needs `dist/`) | — |
| `build-print-runtime.mjs` | Builds a separate runtime for `automation print`; see [PRINT_WORKFLOW_CLI.md](PRINT_WORKFLOW_CLI.md) | — |

---

## Gemini transcript watcher (`gemini-transcript-watch.mjs`)

Watches only `~/.gemini/antigravity-cli/brain/<session-id>/.system_generated/logs/transcript.jsonl`. It does not depend on the `orca` CLI, Codex, model calls or third-party packages.

**Safety boundary:** read-only; never sends `1` to a terminal, never approves, never triggers downstream tasks. A `MODEL / PLANNER_RESPONSE / DONE` row is reported only as "one model log step observed" — never as turn completion, approval or delivery. The session ID must be confirmed independently by the operator; file activity alone does not prove that a session is the controlling one.

Inspect a session (prints `rows`, `lastStepIndex`, `bytes`; no conversation text):

```sh
node scripts/gemini-transcript-watch.mjs inspect --session <session-uuid>
```

Watch for new rows (no model calls):

```sh
node scripts/gemini-transcript-watch.mjs watch --session <session-uuid> \
  --after-step <last-processed-step> --interval-ms 1000 --timeout-ms 60000
```

`--after-step` is the last step already processed; omit it to ignore history from the moment the command starts. Verify on first use that the cursor belongs to the same session.

Results:

- `local_transcript_inspection` — file metadata only.
- `model_step_observed_unverified` — a new `MODEL/PLANNER_RESPONSE/DONE` row; **not** task completion.
- `timeout_no_new_matching_step` — nothing matching within the window; does not prove Gemini stopped.
- `TRANSCRIPT_REPLACED_OR_TRUNCATED` — file replaced, rotated or truncated; re-establish a baseline manually.
- `TRANSCRIPT_STEP_REORDERED` — step index not monotonic; stops instead of guessing.
- `TRANSCRIPT_NOT_FOUND` — path or session missing.

Output contains only session ID, step numbers, record SHA-256 and status, never raw content.

Design constraints:

1. Reads only `transcript.jsonl`; `transcript_full.jsonl` has the same event count and is not an independent event source.
2. Scans the existing file once, then reads appended bytes only; a partial JSON line is kept until its newline arrives.
3. Polling runs in the Node process with bounded timeouts; SIGINT/SIGTERM cancel it.
4. Replacement, truncation, malformed rows or index regressions fail closed.
5. Not implemented: persistent cursor, controller identity verification, source authentication, notifications, approval idempotency, automatic Codex start. Do not use it for automatic approval or task completion.
6. If the Gemini CLI writes its log only at the end of a turn, the watcher sees updates only after they are written.
7. `AntigravityAgent` uses a different root (`~/.gemini/antigravity/brain`); do not swap paths without session-binding evidence.

---

## Gemini transcript → Task event bridge (`gemini-task-event-bridge.mjs`)

Opt-in; implemented in `src/integrations/gemini-task-event-bridge.ts` and wired into `ProjectEngine` via `AGENTHUB_TRANSCRIPT_BRIDGE` and `AGENTHUB_GEMINI_BRAIN_ROOT` (`src/projects/project-engine.ts`). Tested offline only; no real provider calls and no measured token savings.

Behavior:

- Binds explicitly to the saved Gemini `pendingAgentTurn`: task ID, exact conversation ID, start step index, request time, actor and phase. No latest-session discovery.
- The CLI waits in plain Node using the incremental transcript watcher. Matching rows become metadata-only `pending_verification` inbox events. The watcher never overwrites task status or task logs; source authentication, completion authority and approval issuance stay false.
- Event IDs are deterministic (full binding + step + SHA-256). Replays return the same event, including after restart; the same step with a different hash fails closed.
- An exclusive per-task lock, atomic replacement and file/directory sync protect bridge transactions. The whole bound turn is reserved before asynchronous verification, so a later DONE row cannot trigger a second recovery. This is conservative at-most-once recovery, not exactly-once remote execution.
- `TaskRunner({transcriptBridge})` yields immediately on an existing pending Gemini turn, before initializing agents. On the first Gemini pending timeout it saves the checkpoint, binds it and yields with DOING/REVIEW preserved instead of looping or moving to NEED_USER.
- `resumeTranscriptEvent()` requires explicit human authorization evidence and a separate asynchronous verifier. It rechecks the checkpoint and task eligibility after verification, then restores the original turn through the normal runner; tests, review and completion gates still apply. A log DONE is never treated as verification, and `async () => true` is not a production verifier. The observation CLI never calls it.

Observation-only example (replace paths and task ID):

```sh
node scripts/gemini-task-event-bridge.mjs watch --task TASK-ID \
  --store /absolute/agenthub-store --brain-root /absolute/gemini/brain \
  --interval-ms 1000 --timeout-ms 60000
```

It reads exactly `STORE/data/tasks/TASK-ID.json`; an eligible Gemini checkpoint must already exist. A match yields an unverified event ID, not task completion. A timeout is safe to schedule again.

```ts
const bridge = new GeminiTaskEventBridge(absoluteBridgeDirectory);
const runner = new TaskRunner({ task, store, transcriptBridge: bridge });
await runner.run(); // yields when an existing Gemini turn is pending
// Later, only in a human-authorized handler:
await runner.resumeTranscriptEvent(eventId, authorization, independentVerifier);
```

Boundaries:

- No automatic approval route or resume scheduler. Use one bridge directory per store; runners or direct model calls that bypass this API are outside its deduplication guarantee. Stop or coordinate external task writers while authorizing recovery — ProjectStore has no cross-process compare-and-swap for arbitrary external writers.
- A crash lock, changed binding, corrupt state, failed verification, ambiguous outcome or second recovery stays blocked for human reconciliation. There is no automatic lease expiry, lock deletion, retry or rebind.
- The inbox directory is trusted local state, not an authenticated receipt; hashes detect conflicts but do not prove provider identity. Bridge events are separate from the authoritative TaskEvent / relay journal stream.
- It does not intercept or control external Codex `exec`, `orca terminal read/send`, or sandbox approval prompts.

---

## Orca terminal watcher (`orca-terminal-watch.mjs`)

Moves terminal observation out of a model-driven `terminal read → sleep → read` loop into **one ordinary Node.js process** that returns when the selected terminal text changes or a timeout expires. No model tokens are used between local reads (the calling agent may still use tokens before and after the call). Requires Node.js 18+ and the `orca` executable on `PATH`.

Safety scope:

- Executes only `orca terminal read --terminal <ID> --limit <N> --json` via `execFile` with `shell:false`.
- **Never** sends terminal input, approves, dispatches or cancels workers, or writes project state.
- `terminal_content_changed_unverified` means only that text changed — not a verified completion, an authenticated event, or permission to approve. No automatic `1` keystroke.
- The Orca CLI JSON shape is not documented; the selected field must be a textual JSON leaf — do not guess.
- Hashes cover the full selected text, so scrolling output or timestamps may trigger a change that is not task completion. Choose a stable field once identified.

Identify a text field without exposing content (lists field paths and lengths, not values; if no text field exists, stop):

```sh
node scripts/orca-terminal-watch.mjs inspect --terminal <terminal-id>
```

Record a baseline before dispatching, then make one blocking wait:

```sh
node scripts/orca-terminal-watch.mjs snapshot --terminal <terminal-id> --field result.output
node scripts/orca-terminal-watch.mjs watch --terminal <terminal-id> --field result.output \
  --baseline-sha256 <64-hex-digest> --interval-ms 5000 --timeout-ms 120000
```

Without a baseline the first read becomes the baseline and changes before start can be missed. On change it returns a small JSON event with `requiresHumanReview: true`, hash, count and elapsed time — never terminal content or an approval. On timeout it returns `timeout_no_change`; start a new bounded watch with the last known baseline.

Suggested agent instruction (add to your own AGENTS.md):

> Orca terminal observation must be performed through `node scripts/orca-terminal-watch.mjs watch` as a single blocking, bounded call. Never drive a `terminal read → sleep → read` cycle in the model. Never send a bare `1` in response to unverified terminal text. An observed text change is untrusted until the specific event is checked. Do not silently continue if the watcher times out, errors, or returns an unknown JSON shape.

Limits: not validated against a live Orca instance (confirm the JSON shape with `inspect`); it does not register itself as an adapter or force external Codex sessions to use it; real completion must be verified by the receipt/settlement checks, not a text change; request-bound automatic approval is not implemented.

---

## Orca call guard (`orca-call-guard.mjs`)

A **pure, in-memory policy module** — it does not call Orca, Codex, Gemini or the network, and does not intercept calls in an existing Codex terminal. Installing it alone reduces no tokens.

Contract for an adapter:

- Keep **one long-lived `OrcaCallGuard` per dispatcher process** for the task lifetime; a new instance resets budgets. Restart protection would need a trusted persistent store (not implemented).
- Take `taskId` and `terminalId` from a validated task-to-terminal binding, never from output text.
- Call `beginRead({ taskId, terminalId, now })` and read only when `allow === true`. Serialize reads per key. After a successful read, normalize the meaningful terminal state in the trusted adapter, hash it, and call `finishRead({ taskId, terminalId, now, digest })`.
- On transport failure call `failRead` and stop — no implicit retry after uncertainty. If a check denies, surface a human-review-required status.
- `requestTerminalSend()` **always denies**; approvals are out of scope.
- It is a fail-closed gate, not an asynchronous wait implementation.

Defaults (initial safety values, not tuned): at most 6 reads per 60-second sliding window, 3 consecutive identical normalized observations, 10-minute absolute lifetime, all per `(taskId, terminalId)` starting at first observation.

Not implemented: a real Orca transport adapter, enforcement that all Codex→Orca calls go through it (otherwise it can be bypassed), persistent budget state, and trace-based integration tests.
