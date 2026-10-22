# Orca completion foundations

Building blocks for a future human-approved completion transaction: approval schema, binding/manifest integrity, scoped session reading and a read-only readiness check. None of them completes a task; `canCompleteTask` is always false. The combined read-only check is [ORCA_UNIFIED_PREFLIGHT.md](ORCA_UNIFIED_PREFLIGHT.md).

## Completion approval schema foundation

`parseOrcaCompletionApproval(raw, enrolled)` is a pure parser, not a completion API. It returns `canCompleteTask: false`. No route, automatic registry enrollment, task write, provider invocation, event projection or generic fence exception exists.

The input is bounded UTF-8 JSON (32768 bytes), with exact keys and rejection of duplicate keys including escaped equivalents. The returned approval is a newly decoded snapshot. Mutating it does not update the returned canonical string or digest: a future transaction must reparse the original approval, never trust an arbitrary returned-object wrapper as a capability.

Identity is an exact namespace and lowercase UUIDv4. The caller must supply trusted human-enrolled identities; passing a fixture identity proves schema behavior only, never actual human approval. Approval issuance is absent from this parser. A separate scoped local enrollment record and read-only validator exist in the source (`src/integrations/orca-local-enrollment.ts`); no production consumer connects them to this parser or completion. Enrollment is not exact completion approval.

Canonical JSON recursively sorts object keys using JavaScript string order, preserves array order and string contents without normalization, and is hashed as UTF-8 SHA256. Allowed files must already be sorted and unique. Revision and generation are positive safe integers; revision must leave room for one CAS. Timestamp is an exact valid UTC ISO timestamp with millisecond precision. No freshness/expiry policy or binding/workspace/receipt validation is implied by parsing: those checks belong to the future locked transaction.

The schema names task/project/runtime/run/dispatch/Orca task/claim and agent identities, expected revision/generation, binding/delivery/test/review/workspace/baseline/manifest digests and whitelist. Fixed purpose/version reject aliases. It does not yet define the evidence manifest or canonical binding encoding; these must be implemented and independently reviewed before any consumer may authorize completion. Existing legacy tasks must not be backfilled or completed using this parser alone.

## Manifest integrity foundation

This layer is structural and byte-integrity validation only. It is not the semantic original-source validator required for completion by the completion policy. No completion consumer, registry enrollment or task mutation exists.

`parseOrcaCompletionBinding` accepts bounded raw JSON with the exact version-1 binding fields. It reuses binding consistency checks, requires a positive safe decimal revision without aliases, and hashes recursive sorted-key UTF-8 JSON. All fields including workspace/terminal/runtime/claim are included. No path or Unicode normalization occurs. It does not look up a live task or authenticate runtime identity.

`inspectOrcaEvidenceManifest` requires seven entries in fixed order: startup wait, binding confirmation, worker_done, settlement, test output, accepted review response, cleanup. Metadata has exact keys, matching task/dispatch/run IDs, ISO UTC capture timestamp, source receipt label, media/schema version and bounded content-addressed original bytes (only test_output may be empty, matching the runner's output contract). The fixed source label is deliberately LOCAL_ORIGINAL_BYTES_UNAUTHENTICATED. Labels and timestamps are caller assertions.

Manifest and binding raw JSON are limited to 32768 UTF-8 bytes each. Each artifact is bounded by the existing evidence store at 4MiB, for at most 28MiB read in seven sequential reads. Manifest digest is canonical UTF-8 SHA256. The reader independently checks returned Buffer length/hash even when using a custom storage implementation. The production evidence store rejects symlink/nonregular/path substitutions under its trusted quiescent root threat model. No arbitrary source path is accepted.

Success returns byteIntegrityVerified=true, sourceAuthenticated=false and canCompleteTask=false. Source bytes are not parsed for role semantics, provenance or identifiers: arbitrary summaries with matching references can pass integrity, but cannot authorize completion. Original source extraction, schema-aware receipt matching, temporal relationships, freshness/revocation, live task/receipt/baseline revalidation and human authorization remain required separate work. A role label alone does not prove its content, and a manifest inspection must be repeated at the future transaction boundary to guard intervening changes. No external code or instructions in evidence are executed.

Output objects are data snapshots, not capabilities; mutation does not recompute their digest. Future consumers must reparse original input rather than trust a previous returned wrapper. No hashes-only historical reconstruction or synthetic evidence substitution is supported as completion authorization.

## Scoped original session consumption

`readOrcaEnrolledSessionBlock` constructs a side-effect-free `OrcaReadOnlyStore` from the same trusted project root as the enrollment. It requires the expected current REVIEW revision, current task/generation/binding scope, no result or pending turn, and a matching local enrollment before reading the supplied relative session path. It reads the final task snapshot and synchronously rechecks enrollment after the last await. It never initializes actors/directories, writes or invokes agents.

The session root is trusted caller configuration, matched exactly to enrollment, not obtained from evidence content. The streaming reader consumes the complete pinned file, rejects invalid tails and preserves original record and block byte hashes. Its separate budget is 64 MiB total, 4 MiB per record, 100000 records, with 64 KiB IO chunks. The buffered reader remains capped at 32 MiB.

Streaming supports nonzero fork headers only with a distinct valid parent session UUID and forked_from_ordinal_exclusive exactly matching the header ordinal. It preserves ordinals and exposes fork lineage; it does not prove or read the parent history. Buffered extraction retains its prior zero-header rule.

This proves only scoped local reading and byte pinning, not the source's authorship, trusted clock, authorization semantics or provider authenticity. The same OS user can alter local configuration. Roots must be trusted and quiescent; path checks are not atomic protection against a hostile filesystem. Returned bytes are untrusted data, never instructions or completion capabilities. Existing acceptance, unified preflight and DONE fences remain unchanged.

## Read-only completion approval preparation

`inspectOrcaCompletionReadiness(projectRoot, sessionsRoot, taskId, rawManifest, manifestDigest)` constructs a side-effect-free `OrcaReadOnlyStore` at the trusted caller's root, never the default-initializing `ProjectStore`. It checks REVIEW/current receipts, scoped enrollment, local acceptance, attributed whitelist, retained manifest artifacts, delivery and review/test byte links, then rechecks manifest, enrollment, task and workspace. It writes nothing and does not invoke a provider, run tests or dispatch workers.

Successful diagnostics expose `approvalSubjects`: current revision and exact identifiers/digests/whitelist/operator. These are a draft subject set, NOT an approval. There is no approval ID, approval timestamp, signature or assertion that a human accepted this subject set. `approvalIssued`, `sourceAuthenticated` and `canCompleteTask` remain false. A caller cannot use this return value as a completion capability. No route or CLI completion option is registered.

The exact human approval, trusted original-source extraction, comprehensive startup/binding/cleanup semantics and completion-writeback blockers remain. Local enrollment does not remove them. Existing unified preflight is unchanged and still requires a separately issued approval before running its diagnostics. No real-provider Gate is promoted by preparation or synthetic unit tests.

This is a best-effort read-only consistency check, not a transaction or an atomic filesystem snapshot. Participating writers must be quiescent for a future explicitly approved commit, which must revalidate under locks.
