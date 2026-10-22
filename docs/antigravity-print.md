# Antigravity print (`agy`) stream and source checks

Pure, bounded validators for the stdout of a non-interactive Antigravity print run and for a captured print bundle. They never call a provider or write task state; all authority flags stay false. The operator capture API itself is described in [ANTIGRAVITY_PRINT_CAPTURE.md](ANTIGRAVITY_PRINT_CAPTURE.md).

## Observed Print Stream Validation

`inspectAntigravityPrintStream` checks supplied bounded stdout bytes against the single-response, no-tool protocol observed in a real 2026-10-14 agy probe. It requires LF-complete strict JSONL, init with matching cwd, one user-input DONE, response ACTIVE/DONE steps at index 1, matching conversation IDs, final SUCCESS with identical assembled response, and supplied exit code zero. Unknown events, tool steps, missing/extra results, malformed bytes and duplicate keys reject.

This is deliberately a narrow compatibility profile, not the general agy schema. Usage and step duration metadata are not interpreted as authoritative billing or timing evidence. Init tools are available capabilities, not proof of calls. The print result does not expose provider turn ID, Orca identity or model identity.

Supplied exit status and bytes are not authenticated. observedProtocolComplete means only consistent supplied protocol records, not trusted turn completion. sourceAuthenticated, terminalIdentityVerified, canFinalizeReview and canCompleteTask stay false. No provider calls, storage writes or task mutation occur here. Trusted launcher/Orca association remains outstanding.

## Observed View-File Stream Profile

The separate `inspectAntigravityReadStream` recognizes the original sequence observed in a real 2026-10-14 read-only diagnostic: init, user-input DONE, empty planning agent-response DONE, paired view_file ACTIVE/DONE, streamed final agent-response ACTIVE/DONE and result SUCCESS. Step indices must be contiguous; repeat paired view_file calls are allowed up to 32. Up to 16 unique exact absolute caller-allowed file paths must all be observed. No shell or other tool is allowed.

Original stdout is bounded to 4 MiB, records to 262144 bytes and 10000 lines. Strict UTF-8/JSON and exact structural fields reject unknown events, extra tool parameters, mixed conversation IDs, mismatched tool paths, failed/unpaired calls, missing final result, nonzero exit and response inconsistency.

This intentionally narrow observed profile may reject other legitimate provider sequences; it must not silently discard unfamiliar events. No provider calls or filesystem operations occur here. Tool metadata reports paths and summary only, not complete read-file bytes. Supplied protocol consistency is not execution authentication, file-content proof or an OS read-only sandbox. All authorization flags remain false. The no-tool parser and the capture/source paths are separate from this parser. Integration uses explicit view-file-v1 and version-two capture metadata, never automatic fallback from a failed no-tool stream.

## Independent Print Source Contract

`inspectAntigravityPrintSource` accepts original request, intent, stdout, stderr and process-receipt bytes plus explicit expected request ID, cwd, executable and request hash. All inputs are bounded before parsing/copying. Exact JSON schemas, hashes, byte counts, successful close and the observed print protocol must match. Failed/truncated captures, chronology contradictions and extra authority fields reject. Metadata timestamps are consistency claims, not a trusted clock.

The distinct adapter is antigravity-print. No provider turn ID or Orca terminal identity is invented. This pure matcher neither reads disk nor invokes a model. Fully fabricated but internally consistent supplied bundles can pass by design. sourceAuthenticated, trustedExtractionVerified, terminalIdentityVerified, canFinalizeReview and canCompleteTask remain false.

This is not yet a review-verdict parser or trusted storage collector. It is not registered in production acceptance. Final integration requires an exclusive review preparation checkpoint that pins request subjects and source references, bounded confined retained-file verification, final task/workspace CAS checks, and explicit independent-review process attribution. Existing agentapi and Orca terminal contracts remain unchanged.

Explicit expected.profile={kind:"view-file-v1",allowedPaths:[...]} selects version two metadata and the observed view-file stream validator. Intent and process profiles must match the normalized expectation exactly. Without profile, exact version-one schemas still apply. No missing profile is inferred from stdout.
