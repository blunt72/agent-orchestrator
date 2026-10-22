# Dedicated ACP Review Policy

`new CodexAgent({ command: trustedLocalAdapter, args: [], reviewOnly: true })`
opts into the dedicated review policy. Use an explicitly selected installed
adapter; do not rely on package-installing command resolution for a review.

This policy cancels every ACP permission request without inspecting its options,
advertises no client filesystem write support, and disables automatic process
restarts. Session creation calls `session/set_config_option` with `configId=mode`
and `value=read-only`, requiring exactly one matching select configuration with
that current value. Every prompt reasserts and validates the mode. Failed or
unsupported confirmation prevents the task prompt; there is no writable fallback.

The protocol was checked against the locally installed codex-acp implementation,
whose read-only mode uses a readOnly sandbox, no tool network access, and an
on-request approval policy. Permission requests are still denied by the client.
Provider inference requires its authenticated service connection; disabling tool
network access is not the same as offline inference. Configuration confirmation
is a trusted-adapter claim, not independent operating-system attestation or a
filesystem read allowlist. The adapter can still read files allowed by its
sandbox; never claim this mode restricts reads to a file whitelist.

Omitting reviewOnly preserves the existing developer policy, including its
legacy automatic permission grants. That legacy behavior is not approved for
independent review by this change. A review-only adapter must be dedicated to one
review and closed afterward. Do not share it with a developer or another session
controller. Do not forge adapter provenance from another transport.

Synthetic protocol tests are in tests/unit/acp-review-safety.test.ts. They prove
local control flow, not real-provider connectivity. Real review success still
requires a complete matching response, unchanged workspace fingerprint, and
the same delivery/test linkage. A saved RUNNING review is not automatically
retried after failure or interruption. Final task completion remains a separate
gate and is not authorized by enabling this policy.
