# Antigravity local transcript extraction

A pure extractor for a pinned request/response pair from Antigravity native transcript JSONL, and a confined local reader that feeds it.

## Pinned Local Antigravity Transcript Pair

`extractAntigravityTranscriptPair` is a pure bounded native-log extractor, not a file reader, live collector, provider authenticator or finalization API.

The record format was derived by inspecting a third-party transcript parser and its fixtures. Known records contain source, type, content and created_at. Request roles are USER_EXPLICIT/USER with USER_INPUT/REQUEST; response is MODEL/PLANNER_RESPONSE. Other metadata fields remain inert. It has not been confirmed by a real-provider transcript test.

Inputs are Buffer transcript bytes (1..8 MiB, complete LF-delimited JSONL) and strict selector JSON (at most 4096 bytes): sourceSha256, requestLine, responseLine, requestSha256, responseSha256. Lines are 1-based and pinned; each row is bounded to 262144 bytes, strict UTF-8/JSON with duplicate-key rejection, typed native fields and a parseable timestamp. Up to 100000 rows are allowed. The entire source is validated, including rows after the selected response.

The response must follow the selected request with no intervening recognized user request or planner response. The selected response timestamp cannot predate the request. Tool records may intervene. No session/turn association is inferred from filesystem names, partial output, titles or silence.

A whole-content USER_REQUEST wrapper is removed only when it is complete and unnested. A request starting with its opening tag but incomplete or nested is rejected. Content not starting with that opening tag remains literal. No whitespace trimming, regex extraction, metadata unwrapping or synthetic JSON rewriting is used. Selected decoded content must round-trip UTF-8 without surrogate replacement and match explicit content hashes. Original selected JSONL row bytes, including LF, are retained separately from derived decoded content bytes and hashes.

Caller-provided pins and native role labels do not authenticate authorship. The native format inspected does not itself establish cwd, Orca runtime/terminal incarnation or completed provider turn. Output always has sourceAuthenticated=false, terminalIdentityVerified=false, turnCompletionVerified=false, canFinalizeReview=false and canCompleteTask=false. Do not construct the missing CLI transport claims from this result or treat PLANNER_RESPONSE as end_turn.

Remaining gate: trusted confined file/source selection and a real mapping to the reviewer runtime/terminal/turn completion. Until that exists, review prepare/finalize must remain disabled rather than silently using model-generated handoff files. Tests are synthetic bytes only, not runtime/provider E2E. No installed app, user credentials, mailbox, worker or existing task data are touched.

## Local Transcript Snapshot Reader

`readAntigravityTranscriptPair(root, relativePath, selector)` explicitly reads one caller-selected source. No directory discovery, credentials, mailbox operations, provider calls or task writes occur. The caller supplies a separately established trusted absolute root, not a path taken from a model answer.

Paths must be canonical and confined. Traversal, symbolic links, non-regular or multiply linked files, foreign ownership and group/world writable selected roots, intermediate directories and files are rejected. The file is opened read-only with O_NOFOLLOW and O_NONBLOCK, bounded before allocation and checked for an extra byte. Descriptor/path metadata and directory snapshots are compared after parsing. The pure extractor still verifies exact source and selected content hashes.

This POSIX local snapshot check is not an OS sandbox or openat-based adversarial filesystem isolation. A malicious same-user process able to rename directories or mutate files can defeat snapshot assumptions; trust in the root and its ancestors must come from the host integration. Live append/drift rejects rather than retrying. Native filesystem errors propagate without an automatic retry.

`localFileSnapshotVerified` means only that these checks passed for this read. Provider authentication, terminal identity, turn completion, review finalization and task completion remain false. This reader is not wired into production acceptance. POSIX mode checks do not inspect ACLs.
