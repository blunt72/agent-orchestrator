# Orca review evidence

Review response format, retention, recovery and byte matching used around the review stage. The stage itself is described in [ORCA_REVIEW_STAGE.md](ORCA_REVIEW_STAGE.md).

## Review response framing

The machine receipt remains an exact-key JSON object with same-attempt identity and verdict validation. Unknown JSON fields, duplicate keys and arbitrary prose remain rejected. No markdown fences are accepted.

An optional final oai-mem-citation block is permitted as inert metadata, separated from JSON by a newline. It must contain citation_entries followed by rollout_ids, with no additional sections, markup or trailing prose. Limits: total response 262144 UTF-8 bytes, trailer 16384 bytes, 1-32 citation entries, 0-32 UUID rollout IDs. Paths must be relative without dot/traversal segments, line ranges positive and ordered, notes 1-512 characters without brackets, markup or control bytes. No cited path is opened, executed, or used as identity/provenance evidence.

responseHash always hashes the complete original response including metadata. Provider/session verification, workspace fingerprint and task revision checks are unchanged. Previously rejected responses are not retroactively approved. Existing RUNNING checkpoints remain untouched. Recovery requires explicit stopped-execution evidence and archives the old checkpoint before contacting the reviewer for a new attempt. No DONE writeback or automatic retry is enabled.

## Review response retention

New review attempts retain the exact adapter response.text as bounded UTF-8 evidence before strict response/provenance validation and before adapter close. Limit: 262144 bytes, checked before Buffer allocation. The content-addressed reference is checkpointed as orcaReviewRun.responseEvidence; raw text is not embedded in task JSON or printed to logs.

This is the adapter-returned text representation, not original provider wire bytes or authenticated final-answer provenance. It may contain untrusted text and sensitive project content; use the existing trusted evidence root/access protections. Raw ACP events and the discarded pre-trim representation are not captured.

On validation or close failure, the run remains an unresolved RUNNING checkpoint with its evidence reference and no verdict. This label does not assert that a provider process is still running. No automatic retry, replay, task completion or response salvage is enabled. Existing completed runs without responseEvidence remain legacy-compatible; when the optional field exists, acceptance validates it, requires its SHA256 to match responseHash, and reads the retained bytes.

Explicit stopped-review recovery validates and reads the old reference before preserving the full old run in history. Legacy checkpoints lacking original response bytes are not backfilled from summaries or session-final text.

Mixed commentary plus JSON remains rejected by decodeOrcaReviewResponse. The installed codex-acp 2.0.1 implementation offers phase metadata only behind its particular client capability conditions. The decoder does not impersonate that client, alter installed dependencies, choose arbitrary JSON substrings or accept the last JSON-looking message. A reliable final-answer channel remains separate transport work; changing the prompt alone is not a parser safety boundary.

Synthetic tests cover rejected mixed text with exact retained bytes/no verdict, provenance rejection retention, explicit preserved-history recovery, retention before close failure, valid response hashes and malformed/mismatched references. They are not real-provider recovery acceptance.

## Explicit Interrupted Review Recovery

`recoverOrcaReview` is an operator-only API, not a listener, CLI route or automatic retry. The normal `reviewOrcaDelivery` entry still rejects an existing attempt.

Supply the current revision, generation, delivery digest, workspace fingerprint and test receipt hash, plus recovery approval containing reviewId, reviewHash, executionStopped=true, evidenceSha256 and confirmedAt. reviewHash uses the same sorted-field hashing as hashOrcaReviewRun. ConfirmedAt must be finite, no earlier than the prior start and no later than the current clock.

The operator must positively establish that the prior execution stopped. The API records that assertion and evidence hash; it does not observe a process, parse a provider transcript or provide process attestation. A stale RUNNING marker, timeout or unavailable connection alone is not evidence of stopped execution.

Only a matching unfinished RUNNING checkpoint may be recovered. Completed reviews, changed identities/workspaces/test receipts and stale task revisions are rejected before provider contact. At most eight interruptions may be archived. The unchanged old checkpoint and recovery approval are appended to orcaReviewHistory in the same CAS save as the fresh RUNNING checkpoint. Failure to confirm that save prevents the provider call. No history deletion or task completion occurs. A later provider failure retains the new checkpoint and the old history; never call recovery again merely because a timeout elapsed.

All review attempts request static inspection only, prohibit test/build/cache writes and escalation, and use the linked test receipt for execution evidence. They must still inspect actual assertions and production logic, not trust PASS alone. Dedicated reviewOnly adapters remain required by the operator deployment.

Synthetic recovery tests reside in tests/unit/orca-import.test.ts. Real-provider success and final completion remain distinct acceptance boundaries.

## Review and test byte matching

`inspectOrcaReviewSourceBytes` is a synchronous pure check of supplied original review bytes, supplied normalized TestRunner output bytes and exact bounded raw expectation JSON. It requires matching response/test-output SHA256 and byte count, strict UTF-8 review text, exact response identities and PASS verdict. It reuses the review decoder's restricted inert citation trailer rules; the hash includes the entire original trailer. Empty test output is valid, matching the runner.

Limits: review 1..262144 bytes; output 0..4MiB; expectation 32768 UTF-8 bytes. Output is compared as opaque exact bytes, not interpreted or executed. These are the runner's normalized combined output bytes, not separate raw OS stdout/stderr.

Expectation binds review ID, task ID, delivery digest, generation, workspace hash, test run ID and test receipt hash, plus original response/output digests. The expectation is caller asserted; this helper does not prove that output hash belongs to the supplied test receipt hash, validate the actual test receipt, provider/adapter provenance, current task or elapsed-time relationships.

Success always returns sourceAuthenticated=false and canCompleteTask=false. No trusted session extraction, registry, approval/manifest linkage, live provider call, task write or completion exception is implemented. Synthetic matching JSON can pass. Future consumers must derive expectations from validated current test/review receipts and trusted original records and revalidate under the completion lock. This layer alone does not satisfy the completion policy.

## Supplied Antigravity CLI Review Evidence

`inspectOrcaCliReviewSourceBytes` is a pure operator-facing matching function. It performs no filesystem, process, network, inbox, provider or task operations. No existing acceptance validator is widened and no CLI command is registered.

Inputs are original request/response Buffers (1..262144 bytes each), a transport Buffer (1..32768), raw test output (0..4 MiB), and exact-key expectation JSON (up to 32768 UTF-8 bytes). Limits and Buffer types are checked before decoding. JSON is strict UTF-8, duplicate-free, bounded and exact-key; BOM/prose/metadata trailers are not accepted by this distinct CLI protocol.

The expected subjects fix review/task/test UUIDs and digests, revision, generation, binding digest, runtime/host/run/dispatch, separate developer/reviewer terminals, reviewer process incarnation and turn identity. Developer is codex; independent reviewer is gemini through antigravity-cli. Both terminal handles must differ. These subjects are caller-supplied pins, not authority derived from a live task.

The request has exactly version=1, purpose=INDEPENDENT_STATIC_REVIEW, subjects, requirements, testOutputSha256 and testOutputBytes. Requirements must be nonempty and match an explicit digest. Response uses the existing seven identity fields plus verdict=PASS or REQUEST_CHANGES. A rejected review remains REQUEST_CHANGES.

Transport has version=1, provider=google, adapter=antigravity-cli, sourceKind=original-provider-turn, status=completed, endTurn=true, request/response hashes and matching runtime/host/run/dispatch/reviewer-terminal/incarnation/turn. agentapi labels, terminal-tail sources and partial/unknown/interrupted turns reject. All four byte streams must match expected hashes/count before semantic matching.

#### Trust Floor

Transport values, including sourceKind and endTurn, remain untrusted assertions. This validator cannot prove that bytes are original, that a Google turn occurred, or that the reviewer read requirements. Matching fabricated inputs is not provider E2E. Results always return sourceAuthenticated=false, trustedExtractionVerified=false, canFinalizeReview=false and canCompleteTask=false, even for verdict PASS.

Before production review finalization, a trusted collector must extract attributable original sources; prepare/finalize must validate live task/binding/test/attribution, source and workspace under checkpoints/locks/CAS. Hash matching is insufficient. Historical handoff/review summaries must not be relabeled to fill those gaps. The normal released-worker completion transaction remains a separate gate.

Regression tests use synthetic byte fixtures only, not real-provider evidence.
