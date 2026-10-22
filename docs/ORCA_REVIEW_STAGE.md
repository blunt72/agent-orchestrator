# Same-Attempt Independent Review Stage

reviewOrcaDelivery in src/integrations/orca-review.ts is an operator-only API.
There is no automatic CLI, route or listener. It records an independent adapter
review for a tested imported delivery, but does not mark the task DONE, set a
TaskResult PASS, perform a rework dispatch or acknowledge the Orca inbox.

## Preconditions

The task must still match its validated binding, original developer/claim and
independent reviewer, with REVIEW status and PROJECTED delivery event. Approval
must confirm the current task revision, generation, delivery digest, workspace
fingerprint and full normalized test receipt hash (hashOrcaTestRun).

Only a strict completed PASS test receipt is eligible: expected schema, UUID,
delivery identity, matching before/after fingerprint, zero exit code, current
configured command hash, output hash, ordered valid times, checkpoint revision,
LOCAL_TEST_PROCESS provenance and NOT_RUN review status. Changed or malformed
test evidence rejects before contacting an Agent.

The current workspace fingerprint must match both the test receipt and operator
approval. The actual imported event is durably written/verified, not inferred
from the PROJECTED marker alone.

## Adapter And Checkpoint

The operator supplies a dedicated trusted Agent adapter with name matching the
bound independent reviewer, never the developer. A RUNNING review record is
CAS-saved before initializing the adapter, creating a session or prompting it.
Any existing review record prevents automatic redispatch, even after failure.

The API owns that adapter's lifecycle for the turn: close is called in finally
after initialization/session/prompt, including failures. Do not pass a shared
coordinator adapter. An empty or malformed session rejects before prompting.

The prompt instructs the reviewer to inspect actual files/requirements/changes,
not trust developer claims or test PASS alone, and avoid edits, installations,
new workers and production data. It includes structured task context, selected
test metadata and exact response identities. Repository/task content is
explicitly untrusted evidence, not instructions. These prompt restrictions are
not an OS sandbox or proof of actual reviewer behavior.

## Response Protocol

Only bounded JSON is accepted, with duplicate keys rejected. Exact keys:

```text
reviewId, taskId, digest, generation, workspaceHash, testRunId, testRunHash, verdict
```

Every identity must exactly match the pending request. verdict must be PASS or
REQUEST_CHANGES. Plain prose, Markdown-wrapped responses, extra fields, ambiguous
duplicate keys, stale attempts and substring PASS matches reject.

The adapter response must declare end_turn and the matching provider, adapter
and nonempty session identity: codex/openai/codex-acp or
gemini/google/antigravity-agentapi. These are local adapter claims, not provider
attestation, binary verification or Google authentication evidence.

After the adapter is closed, the workspace fingerprint is recomputed. Drift
records INVALIDATED even if the response says PASS. Only responseHash and
selected fixed provider/adapter labels are stored; no raw response, endpoint,
model string, credential or session identifier is added to the task record.

Final save uses the checkpoint revision. Concurrent cancellation/administrative
changes cannot be overwritten. Task remains REVIEW for recorded PASS or
REQUEST_CHANGES; final acceptance and rework policy are not implemented here.

## Failure And Remaining Gates

A provider error, pending-turn exception, malformed response, close failure,
post-run fingerprint error or final-save failure may leave RUNNING. Do not
automatically dispatch again or delete that record. Operator reconciliation is
required; persisted provider-turn reattachment is not implemented in this API.
The existing adapter may carry its own pending-turn behavior, but this API does
not claim restart recovery of remote sessions.

The execution lock does not freeze workspace editors or automatically stop a
remote turn on administrative cancellation. The M3a fingerprint exclusions
remain: ignored inputs/dependencies, external services, submodule and symlink
target contents, and intermediate modify/restore races. Use a quiescent workspace.

Local tests use synthetic reviewer/collector adapters with real temporary Git,
storage and test processes. They are not real provider review, pilot-project
development, task writeback or E2E acceptance. A same-attempt final validator and
explicit real-provider delivery/test/review run remain required before exposing
business-task completion. No self-signoff or full G1-G8 PASS is implied.
