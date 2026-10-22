# Orca Same-Attempt Local Test Stage

The operator-only runOrcaDeliveryTests API in src/integrations/orca-tests.ts
executes a configured local test command for an already imported delivery. It
has no registered CLI, HTTP route or listener. It does not approve delivery,
invoke a reviewer or acknowledge the Orca inbox. Business-task use is not yet
enabled; independent review and real-provider E2E are separate remaining gates.

## Preconditions

- The validated durable delivery belongs to the current task/project/workspace
  and generation. It proposes REVIEW and has a PROJECTED outbox.
- The task is still REVIEW, with the original developer, claim and independent
  reviewer. No pending agent turn or earlier orcaTestRun is allowed.
- Operator approval explicitly names the current task revision, delivery
  generation/digest, workspace fingerprint and exact preconfigured testCommand.
- The workspace is the Git root, has a valid HEAD, and its fingerprint matches
  approval. No test command is taken from the worker message or receipt.
- The actual imported event is written/verified durably before execution.

The command is trusted operator input, executed through the existing shell-based
TestRunner. This API does not sandbox it. Tests may perform whatever side effects
the approved command permits. No auto-detection, installation or network access
is initiated by this API itself; a command could still do any of those things.

## Checkpoint And Result

A separate orcaTestRun record is CAS-saved with phase RUNNING before invoking
the command. It includes the delivery digest/generation, commandHash,
workspaceHash, attempt ID, start time and checkpoint revision.

After execution, the workspace fingerprint is recomputed. A matching workspace
and successful non-null zero exit code yields outcome PASS. Nonzero/signal
termination yields FAIL. Any fingerprint change yields INVALIDATED, even when
the command exits zero. Only hashes of command/output are recorded here; raw
output, including error text or credentials, is not added to task metadata.

The result is CAS-saved with phase COMPLETED. An intervening administrative
write, including cancellation, cannot be overwritten. No lifecycle transition
to DONE, no TaskResult PASS and no reviewer approval is produced. Import-time
orcaDelivery.testStatus/reviewStatus remain NOT_RUN: they describe the original
delivery record, not this separate local test receipt. Existing task status CLI
does not yet render this separate receipt as accepted test/review evidence.

## Interruption

Any existing orcaTestRun prevents another execution, whether RUNNING or
COMPLETED. There is deliberately no automatic retry or resume command.

Start-save failure or lost acknowledgement stops before command invocation.
If execution or post-run fingerprinting fails, or the final save fails, RUNNING
may remain durable even though the command ran. Inspect the process, workspace
and task before reconciling. Do not delete the receipt and blindly rerun.

The execution lock serializes participating bridge operations, not arbitrary
external workspace editors. It does not cancel an already running child when
an administrator cancels the task; the final CAS prevents approval afterward.

## Fingerprint Boundary

fingerprintOrcaWorkspace hashes HEAD plus a sorted inventory from the existing
GitService: tracked files and nonignored untracked files, including content,
file modes and symlink targets. Missing HEAD or a nested non-root workspace
rejects. This is not an atomic filesystem snapshot or full environment digest.

Ignored inputs, dependencies, environment variables, external services, symlink
target contents, submodule contents and intermediate modify/restore races are
not covered. Tests must run in a quiescent, operator-controlled workspace; a
future independent reviewer must recheck the same fingerprint and determine
whether these exclusions are acceptable for that task. No claim of an immutable
code snapshot or supply-chain attestation is made.

TestRunner currently buffers output in memory and does not guarantee termination
of all descendant processes. Timeout/failure must not be treated as a safe
automatic retry point. These limits must be addressed or constrained before
enabling unattended business-task execution.

## Evidence Boundary

Local tests use synthetic imported Orca messages/receipts and real temporary Git
repositories, filesystem writes and test processes. They prove local gating,
checkpointing and CAS behavior, not Google authentication, Gemini development,
Orca task provenance, actual power/process-crash recovery or production E2E.
