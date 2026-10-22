# Orca delivery evidence

Pure checks for worker delivery evidence received through Orca: wait-stream framing, explicit `worker_done` envelope selection and original delivery byte matching. None of them collects from Orca, writes evidence or grants completion authority.

## Explicit wait-stream framing

`extractOrcaWaitReceipt` accepts a Buffer up to 262144 bytes containing 1-128 LF-terminated JSON heartbeat records followed by a single receipt object. Heartbeat keys are exactly _keepalive, _heartbeat, elapsedMs, deadlineMs. Flags must be true; elapsed/deadline must be safe integers, elapsed nonnegative and strictly increasing, deadline positive and unchanged, elapsed <= deadline. CRLF is accepted as JSON whitespace without altering original bytes.

The remaining receipt must be one bounded duplicate-free JSON object with ok=true, nonempty string id, object result and object _meta, and no heartbeat keys. Receipt semantics, IDs, role and origin are NOT validated by this module. An envelope is not automatically converted into a worker_done message.

Both full stream and exact remaining receipt bytes are copied and hashed. No block concatenation, keyword lookup, generic prefix stripping, argument execution, evidence writes, provider calls, task writes or completion authority. sourceAuthenticated=false and canCompleteTask=false always.

## Explicit worker_done envelope selection

`selectOrcaDeliveryEnvelope(rawBinding, envelopeBytes, rawExpectation)` accepts a single receipt (not a wait stream). The expectation has exactly receiptId, deliveryId, messageId and envelopeSha256. Whole-envelope SHA-256 must match. Strict UTF-8 and duplicate-free bounded JSON apply; envelope max 262144 bytes, expectation max 4096 UTF-8 bytes. Binding uses the existing completion-binding parser. Envelope root has exactly id/ok/result/_meta.

Require ok=true, runtime/run matching binding, one message/count=1, expected delivery, replayed=false, acknowledged=null and false timeout/cancel/lost flags. Message must match expected ID, current_delivery, worker_done, bound run, terminal sender and run receiver, and payload task/dispatch/outcome. Payload string parsing uses the existing strict snapshot helper.

Returns original copied envelope bytes/hash plus a separately hashed JSON serialization of the selected original parsed message. The latter is labeled DERIVED_JSON_MESSAGE, NOT original lexical message bytes. Unknown metadata is preserved in the derived message; envelope semantics do not authorize execution. No provider calls, task/evidence writes or authority: sourceAuthenticated=false, canCompleteTask=false. Not wired to unified preflight or completion writeback.

## Original delivery source matching

`inspectOrcaDeliverySourceBytes` checks two bounded original JSON byte buffers (worker_done and settled worker-show receipt) against explicit raw hashes, message ID and the delivery digest previously recorded by import. The exact expectation JSON is limited to 32768 UTF-8 bytes. Message IDs follow the existing planner's 1..4096 character, no-control-character contract without normalization. Each source is 1..262144 bytes, strict UTF-8 without BOM, comments, trailing data or duplicate JSON keys.

The existing delivery planner performs cross-record identity and settlement matching, including released-provider corroboration. Only successful settlement proposing REVIEW is accepted; coherently failed delivery is not success. The delivery digest is recomputed with the existing import algorithm, preserving compatibility. Raw hashes remain stricter than semantic JSON equality: changes to transport whitespace require different byte hashes even when the delivery digest is unchanged.

This function is synchronous, pure and read-only. It does not collect from Orca, extract a message from a session, check freshness/revocation, inspect current task state, or authenticate how the bytes were obtained. Synthetic JSON matching the schema can pass; output always says sourceAuthenticated=false and canCompleteTask=false. No role label or content hash establishes source origin.

Trusted source extraction and approval/manifest linkage remain unimplemented. Future consumers must connect hashes to the exact manifest role references and trusted original records, revalidate current receipts and workspace under lock, then use a separately reviewed completion transaction. Startup authorization, binding confirmation, test output, original review response and cleanup require their own source-aware semantic checks. This layer does not satisfy the full completion policy or advance real-provider Gates.
