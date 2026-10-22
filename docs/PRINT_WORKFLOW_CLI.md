# Reusable supervised print acceptance

`automation print` packages the post-review acceptance stages previously run by
task-specific scripts. It is not a scheduler or an unattended coordinator. No
action starts a worker, captures a model response, runs tests, issues approval,
consumes messages, operates terminals, installs dependencies or retries failures.
Review preparation/capture/finalization remain separate existing operator APIs;
they are prerequisites, not silently executed by this CLI.

## Project policies

Version 1 is unchanged: Gemini developer, Codex reviewer, test-only TypeScript
writes and exact Vitest arguments. Version 2 adds an explicit coordinator:
`codex` for a Codex reviewer, or `antigravity` for a Gemini reviewer. Developer
and reviewer must be distinct Codex/Gemini identities. No Claude is accepted.

V2 `command.profile` is either `vitest` (same test-only restriction as V1), or
`node-test`. The latter allows explicitly listed `src/**/*.mjs` and
`test/**/*.test.mjs`/`tests/**/*.test.mjs` files. At least one test is required.
Arguments must be exactly `["--test", ...listedWriteTests]`: no globs, flags,
shell fragments or extra files. The executable must be the canonical absolute
path of the current Node interpreter at path preflight. Read/documentation and
write scopes cannot overlap. Limits are validated configuration, not an active
execution budget until a scheduler explicitly enforces them.

`automation preflight --policy /absolute/policy.json --sha256 ORIGINAL_DIGEST`
checks these policies without executing project/config code. Its `testCommand`
is the exact quoted legacy command string to persist for a future bound task.
Do not retroactively edit a completed task's command to match a new policy.

## Actions and inputs

Normal compiled CLI:

```text
node /absolute/agenthub/dist/index.js automation print status --input /absolute/status.json --sha256 ORIGINAL_DIGEST
node /absolute/agenthub/dist/index.js automation print preflight --input /absolute/preflight.json --sha256 ORIGINAL_DIGEST
```

All actions require a bounded, canonical regular single-link UTF-8 JSON input,
owned by the operator and not group/world writable. Original-byte pins are
operator-selected expectations, not authentication. Duplicate JSON keys and
unknown fields are rejected. Each input's `action` must match the chosen action.

`status` input has exactly `version: 1`, `action: "status"`, `projectRoot`,
`taskId`, `expectedRevision`. It reads persisted state and verifies a PROJECTED
completion event if present; it does not reapprove acceptance, inspect current
worker liveness, reopen a task or validate every historical approval field.

`preflight` input has exactly these fields:

```json
{
  "version": 1,
  "action": "preflight",
  "projectRoot": "/absolute/agenthub",
  "sessionsRoot": "/absolute/trusted-sessions",
  "taskId": "EXACT_BOUND_TASK",
  "projectPolicy": { "path": "/absolute/project-policy.json", "sha256": "ORIGINAL_DIGEST" },
  "settlement": { "path": "/absolute/original-settlement.json", "sha256": "ORIGINAL_DIGEST" },
  "release": { "path": "/absolute/original-retained-receipt.json", "sha256": "ORIGINAL_DIGEST" },
  "expectation": {
    "revision": 15,
    "attempt": "initial",
    "finalizationHash": "EXACT_FINALIZATION_DIGEST",
    "enrollmentDigest": "EXACT_ENROLLMENT_DIGEST",
    "settlementSha256": "ORIGINAL_SETTLEMENT_DIGEST",
    "releaseSha256": "ORIGINAL_RETAINED_RECEIPT_DIGEST",
    "workerIncarnation": "EXACT_UUID"
  }
}
```

Digests/UUIDs above are placeholders, not runnable values. Settlement/release
files must contain the original Orca response objects, not a wrapper, summary or
reformatted reconstruction. Pins in references and expectations must agree.
Recovery is explicit `attempt: "recovery"`, never inferred or retried.

The print path currently requires Codex development/Gemini review, a persisted
matching project/workspace binding, exactly matching baseline write whitelist,
the exact policy test command, successful finalized review, private enrollment
and historical user-owned retained-terminal evidence. All preparation checks
remain `canCompleteTask: false`, `approvalIssued: false`,
`sourceAuthenticated: false`, `globalGateApproved: false`.

## Frozen entry and exact approval

Build an exclusive new artifact using existing local dependencies:

```text
node /absolute/agenthub/scripts/build-print-runtime.mjs --output /absolute/new-runtime
```

The builder does not modify `dist`, an existing artifact or the installed Orca.
It compiles current source, hashes generated code/entry, pins Node/path/version,
applies read-only modes and probes the real standalone entry. Existing external
dependencies/toolchain must remain trusted and quiescent; neither their content
nor arbitrary same-user filesystem writers are authenticated/isolated.

Only this frozen entry can run `request`, `complete`, `reconcile`:

```text
node /absolute/new-runtime/print-completion-entry.mjs request --input /absolute/request-input.json --sha256 ORIGINAL_DIGEST --output /absolute/new-approval-request.json
node /absolute/new-runtime/print-completion-entry.mjs complete --input /absolute/complete-input.json --sha256 ORIGINAL_DIGEST
node /absolute/new-runtime/print-completion-entry.mjs reconcile --input /absolute/reconcile-input.json --sha256 ORIGINAL_DIGEST
```

`request` uses the preflight schema with `action: "request"` and one additional
field `runtimeArtifactDigest` (from the independently checked artifact). Output
is exclusive 0600 `NOT_APPROVED` with exact subjects. The policy digest is a
preparation trace, not an additional completion permission. Subject approval
binds the original task snapshot, including its command, binding and evidence.
There is no automatic approval installation or `--approve` option.

`complete`/`reconcile` inputs have exactly `version: 1`, `action`, `projectRoot`,
`sessionsRoot`, `taskId`, original `settlement` and `release` references,
`approvalSha256`, `implementationSha256`, `runtimeArtifactDigest`. They call
the existing dedicated transaction once with an already installed exact private
human approval. `complete` commits DONE/PENDING; only a separately chosen
`reconcile` projects that same completion event. No implicit chaining occurs.
Previously approved pins may not be reused for a new task or changed artifact.

## Failure and reuse boundaries

Parser failures emit fixed JSON to stderr. Action failures emit fixed JSON to
stdout and exit nonzero with `automaticRetry: false`,
`outcome: "UNKNOWN_OR_REJECTED"`. A write or directory sync may already have
happened: inspect actual persisted state before another action. Never infer
rollback, steal a lock, retry development, create a duplicate worker or resend
worker_done. Partial runtime builds and request files are retained for diagnosis.

This is the retained-terminal limited route only. A normally released managed
worker is not covered by substituting a retained receipt; it needs its own
completion contract. Unit tests use explicitly synthetic dependencies. A real
frozen-entry probe or two real project path checks are not fresh two-project
collaboration, source authentication or a global automation Gate.
