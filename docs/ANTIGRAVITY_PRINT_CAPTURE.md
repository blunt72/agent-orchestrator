# Independent Print Process Capture

`captureAntigravityPrint` is an operator-only explicit model invocation API, not
a task/worker dispatcher. It is not exported through production routes. The host
must trust the configured canonical executable, cwd, evidence root and ancestors.
Only POSIX hosts are supported. ORCA_* environment variables are removed from the
child environment; ordinary provider configuration remains inherited, not copied
to retained files. This is not a credential sandbox or child tool-access sandbox.

An exclusive request-ID directory consumes the launch slot before any spawn.
It retains exact request bytes and a launch intent, opens private stdout/stderr
files, launches fixed argv without a shell, bounds both streams and waits for
process close. Timeout/overflow kills only the newly created process group; no
retry occurs. Raw output is retained before the result protocol is parsed.
process.json records exit code/signal, failure, retained byte counts and hashes.
Overflow files contain a bounded prefix and are explicitly failed evidence.

Any filesystem failure propagates; partial intent/files must be preserved and
inspected, not deleted to enable a retry. This marker is not a formal task CAS
checkpoint or approval. Startup crash durability, hostile directory mutation,
executable substitution and descendants escaping the process group remain outside
this first implementation's guarantees. No formal cancellation API is integrated.

CAPTURED means local process output satisfied the narrow print parser. It does
not establish model identity, provider authentication, Orca terminal ownership or
business task acceptance. All finalization/completion flags remain false.
Local fixture processes are synthetic transport tests, never provider E2E.

Explicit readOnlyPaths selects view-file-v1 and version-two intent/process files,
with the normalized profile pinned in both. Omitted readOnlyPaths remains the
original version-one no-tool path; no fallback or historical relabelling occurs.
Validation happens after execution and is not runtime permission enforcement.
