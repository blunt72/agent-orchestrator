# Pinned local JSONL extraction

`extractOrcaSessionToolOutput` and its read-only file adapter select a paired
function_call/function_call_output from a pinned complete local session journal.
Selector JSON has exact fields: sessionId, callId, toolName, ordinal (output
record ordinal), sourceSha256 (entire original file hash). Pins are caller
assertions, not authenticated human/provider identity.

Limits: file 32MiB, each line excluding LF 4MiB, at most 100000 records,
selector 4096 UTF-8 bytes. Original records use a separate fixed parser budget;
CLI JSON remains limited to 262144 bytes. Both retain 20000 nodes and depth 24.
String scanning is iterative to avoid regex stack growth on large strings.
All lines must be valid bounded duplicate-free JSON
objects with increasing safe ordinals and object payloads. First record must be
session_meta ordinal 0 with matching id (and matching session_id if present);
later headers reject. Complete final LF is required. BOM/invalid UTF-8, partial
records, duplicate calls/outputs, wrong tool, non-string output, unsupported
custom call formats and unpaired output surrogates reject rather than guessing.

Returns a copied exact original output record line including its original LF or
CRLF framing, plus UTF-8 bytes of the decoded output string. Those are different
representations and have separate hashes. The latter is derived JSON string
content, not a slice of the journal's escaped source text. Arguments, output,
source instructions and embedded JSON are never executed. Output may contain
sensitive information: callers must not log/export raw buffers indiscriminately.

The adapter confines a relative path under a canonical operator-trusted root,
checks file/ancestor symlink resolution, nonregular files and hardlinks, opens
nonblocking with O_NOFOLLOW, reads at most original size+1, checks handle/path
identity and size/timestamps before extraction. A quiescent trusted filesystem
is required; this is not a hostile ancestor-swap/modify-restore defense or an
atomic live-journal snapshot. Concurrent append fails rather than retrying.

sourceAuthenticated=false and canCompleteTask=false always. Matching a locally
pinned journal does not prove it was not fabricated or edited before pinning.
No enrollment, approval, provider calls, task writes or completion exception.
The extractor is NOT yet wired into unified preflight: that blocker remains
until role-specific trusted selectors/attestations and source transformations
are defined and independently reviewed. Exec tool output wrappers are opaque;
no summary stripping or worker_done discovery by keyword is performed. An
oversized/malformed unrelated record rejects the whole source deliberately.

## Explicit custom text blocks

`extractOrcaSessionTextBlock` and `readOrcaSessionTextBlock` are separate APIs
for paired custom_tool_call/custom_tool_call_output records. Their selector has
the same exact fields plus blockIndex (nonnegative safe integer) and blockSha256
(expected lowercase SHA-256 of decoded selected text UTF-8). Every output block
must have exactly type/text keys, type input_text, and valid Unicode string text.
Unknown, image, extra-field or malformed unselected blocks reject too. Mixed
ordinary/custom pairs reject. The ordinary API remains string-only.

Only the selected block is returned as outputBytes, alongside the copied original
whole record line. Blocks are never joined, wrappers never removed. A block pin
does not establish that its text is an original receipt rather than a quote.
These APIs are not connected to unified preflight and grant no authority.
