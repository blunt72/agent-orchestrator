# Unified read-only preflight

`inspectOrcaUnifiedPreflight(store, taskId, rawApproval, rawManifest, enrolled)`
connects current task receipts to approval, attribution, manifest and source-byte
matching. It derives test/review source expectations from the persistent task,
not caller-provided independent hash bundles. The caller is responsible for a
trusted human-managed enrollment list; the function does not enroll anyone.

Stages: APPROVAL, CURRENT_TASK, LOCAL_ACCEPTANCE, FILE_ATTRIBUTION,
MANIFEST_INTEGRITY, DELIVERY_SOURCE, REVIEW_TEST_SOURCE, FINAL_SNAPSHOT.
Success includes the passed stages. A failed stage yields a sanitized
STAGE_FAILED blocker, not arbitrary exception text or raw evidence. Prior stages
remain diagnostic observations, not an atomic snapshot or capabilities.

The approval must exactly match current binding/attempt/revision/receipt hashes,
and its whitelist must equal the saved pre-development whitelist. Missing
baseline rejects rather than inferring historical attribution. Manifest test
output must equal the saved output reference; review bytes match the saved
response hash. Worker source label must match imported message ID. Sources are
re-read for semantic checks; task/workspace and manifest integrity are checked
again at the end. Quiescent trusted roots remain required; no system-wide lock,
hostile modify/restore defense or atomic multi-file snapshot is claimed.

All paths return canCompleteTask=false and sourceAuthenticated=false. Fixed
blockers remain even when local checks pass: trusted source extraction missing,
startup/binding/cleanup semantics missing, completion writeback disabled. A
matching synthetic bundle may pass local checks but can never close a real Gate.
No provider calls, dispatches, task/event writes, enrollment or cleanup occur.

DELIVERY_SOURCE accepts either direct message/settlement JSON or strict original
exec-wrapper evidence through inspectOrcaDeliveryEvidenceBytes. The wrapper
path verifies original hashes before decoding, validates the bound singleton
delivery envelope, and returns deliveryEvidence with distinct original,
decoded and derived hashes. Mixed formats, nested wrappers and malformed inputs
reject without fallback. This is local lineage, not source authentication.

Standalone partial lifecycle and observed chronology diagnostics are documented
in ORCA_LIFECYCLE_DIAGNOSTICS.md. They do not remove the fixed lifecycle blocker
or bypass the approval-first preflight.

Tests separate mocked orchestration from an actual local-store legacy-baseline
rejection check. No successful real-provider acceptance is claimed. Original
session JSONL extraction still needs an exact trusted record selector and
bounded file/line handling; no summary-to-source conversion is implemented.
