# Evidence Registration Without Task Mutation

`registerOrcaEvidence` is an explicit local operator API, not a CLI, listener,
review importer, approval issuer or completion operation. It does not launch agents.

Input is bounded strict JSON with exactly taskId, revision, generation,
bindingDigest, recordedAt and refs. refs contains 1..32 entries sorted by unique
label, each with exactly label and an existing Orca evidence reference. Labels
are identifiers, not executable commands or filesystem paths.

The execution lock protects participating execution writers. The API verifies
the expected task/binding, reads retained evidence bytes through the evidence
store, and checks the task again before append and after durable verification.
It never calls saveTask: task bytes, revision, status, binding and baseline remain
unchanged. Administrative writes may proceed independently; detected drift fails
closed without overwriting those writes.

Registration appends TASK_PROPOSAL with scope EVIDENCE_REGISTRATION_ONLY.
The shared event writer bounds existing journal reads and checks the resulting
journal against the same 8 MiB budget as verification before publishing under
the journal lock. Exact replay at the limit remains allowed. Over-budget logs
are rejected without rewriting or truncating their contents.
Writer and verifier share strict row decoding and schema checks, including the
262144-byte record limit, duplicate keys/IDs and blank-row rejection. Invalid
existing rows or invalid new events reject before publication; no repair occurs.
The full normalized request determines the event ID; recordedAt is an explicit
request subject and must be preserved on retry. Identical requests replay the
same event; different evidence sets create distinct registration events, not
conflicting task transitions. After an uncertain append, retry only the exact
request. An error does not prove no event was written. There is no atomic
task-plus-event snapshot, no protection against arbitrary modify/restore races,
and no automatic repair or retry.

Registration confirms retained byte integrity only. It cannot authenticate a
provider, import worker_done, grant development permission, manufacture a formal
test/review receipt, or set DONE. Existing stale binding checks remain unchanged.
The historical education task revision mismatch is not repaired by this API.

## Next Integration Gates

Antigravity CLI review needs a separate retained-source contract identifying the
request, exact task/dispatch/test/workspace subjects and original response source.
It must not be relabeled antigravity-agentapi. Historical prose review summaries
remain evidence-only; an exact future response protocol cannot retroactively
prove those subjects were supplied or reviewed.

Normal completion needs its own task-scoped approval and transaction, including
current delivery/test/review evidence, whitelist attribution, fresh settlement,
released terminal ownership, durable completion outbox and explicit reconciliation.
Do not reuse approvals requiring metadata or retained-user-terminal exceptions.
No such normal completion mutation is enabled by this document or registration API.

Focused tests use synthetic inputs and actual local storage. They are regression
tests, not real provider E2E. Independent review is required before live use.
