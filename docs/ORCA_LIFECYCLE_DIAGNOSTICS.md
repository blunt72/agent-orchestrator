# Partial lifecycle diagnostics

These pure, standalone APIs inspect local records without provider calls, task
writes, enrollment, cleanup or completion. They are not integrated completion
gates and do not remove fixed blockers from inspectOrcaUnifiedPreflight.

## Identity and state

inspectOrcaLifecycleSourceBytes in src/integrations/orca-lifecycle-source.ts
accepts exact original startup/cleanup exec blocks, the local binding
confirmation bytes, a canonical binding and bounded JSON expectations containing
startupSha256, confirmationSha256, cleanupSha256 and questionId. It verifies
each original hash, strictly decodes wrappers, and matches question, binding
and release identities/state. It returns separate original/decoded hashes.

The result explicitly has chronologyVerified=false, sourceAuthenticated=false
and canCompleteTask=false. Matching closed/captured archive metadata does not
prove retained archive content, provider execution, absence of arbitrary
external resource reuse or an authenticated timestamp.

## Observed chronology

inspectOrcaLifecycleChronology in src/integrations/orca-lifecycle-chronology.ts
accepts a bounded complete local session JSONL, canonical binding, original
baseline bytes and exact JSON selection metadata. Selection has baselineSha256,
deliveryDigest, messageId and selectors. The six selector roles are waiting,
prebinding, execution_reply, worker_done, settlement and cleanup. Each uses the
existing exact custom-tool session selector with full-source/record-block pins.

The checker requires strictly increasing role ordinals and nondecreasing valid
UTC record times. It matches prebinding terminal/provider/workspace ownership,
baseline capture before answer, answer/question IDs, thread, body equality and
timestamps, answer before worker creation, worker creation before dispatch
completion, and completed/reclaimable settlement before the release observation.
Record timestamps are local observations, not authenticated wall-clock time.

Success is localChronologyConsistent=true, but trustedClock=false,
durableBindingTimestampProven=false, permissionDigestBound=false,
sourceAuthenticated=false and canCompleteTask=false. Baseline capture is not
durable binding acknowledgement; a textual permission body is not structured
revision/digest-bound authority. The checker never executes the body or treats
it as instructions. Same-session time ordering cannot establish cross-host
causality or prevent a hostile local owner rewriting a journal and its pins.

## Limits and use

Original record inputs are at most 262144 bytes; identity/state expectations
at most 4096 bytes. Chronology source uses the existing 32 MiB session and
per-record limits, baseline at most 262144 bytes and selection at most 32768
bytes. Caller types and byte limits are checked before buffer conversion;
strict JSON rejects duplicate keys, invalid UTF-8, depth/node excess and BOM.
No invalid format fallback or implicit normalization is performed.

These diagnostics can support an operator evidence audit. They do not grant
trusted roots or enrolled identities, alter the exact approval schema, permit
generic bound DONE/result writes, or implement the dedicated completion
CAS/outbox/reconciliation (policy document not included in the open-source release).
