# Orca print review (prepare → capture → finalize)

Operator-only, three-checkpoint flow for an independent review run through the Antigravity print collector. Finalization records a review result only; it never completes a task.

## Operator Print Review Preparation

`prepareOrcaPrintReview` performs only the first checkpoint. It does not launch agy, consume Orca messages or record a verdict. No production route is enabled. It accepts an explicit revision/generation/delivery/test/workspace approval and a retained requirements reference. First-review Codex developer / Gemini reviewer tasks only; historical review repair and existing review context are rejected.

Under the task execution lock it validates projected REVIEW delivery, binding, owner/claim, retained passed tests, requirements, baseline, whitelist attribution and workspace. Exact request bytes are retained before the CAS task save. Individual evidence and final prompt limits reflect the print launch budget. The immutable preparation pins exact response subjects, client request ID, requirements/test/baseline references, binding hash and its own saved revision.

Once preparation exists, participating generic task writers may not remove or change it; cancellation remains permitted. The old adapter review path refuses to start another review. CAS conflict or an uncertain save requires inspection of the original record, never automatic retry. An orphan request evidence blob may remain after a rejected prepare; it grants no launch authority.

Task revision storage fences participating writers only. This is not filesystem isolation, provider identity authentication or protection from hostile direct task-file edits. Workspace must be checked again before capture and finalization. Capture/finalize operations are not implemented here; no completion authority is enabled. Do not apply this preparer directly to an external worker_done summary before formal delivery import and retained test execution exist.

## Prepared Print Capture

`capturePreparedOrcaPrintReview` is an explicit operator-only process invocation, not a route or coordinator impersonation. It requires the exact prepared revision, request ID/hash, unchanged binding, passed retained tests, attribution and owner. It persists an immutable capture intent before launch. Uncertain intent save, capture exception, cancellation or conflicting save consumes the attempt; no automatic retry is supported. The configured executable/evidence root and their ancestors must be trusted; process configuration is not taken from model output.

The capture uses the independent local print collector. Five fixed files are read with bounded O_NOFOLLOW regular/single-link/owner/mode/metadata checks and retained in the evidence store before any task-result save. Supplied success bundles are also checked with the print source matcher. Failure files remain diagnostic evidence only. If task revision/ownership/status changed, no stale task save occurs; original files and any retained blobs remain for reconciliation.

The execution lock is held through capture. Generic administrative writers can still cancel via CAS; this implementation does not yet terminate a running print process on task cancellation. Timeout still applies. Capture success does not check or grant a review verdict; finalization must revalidate current workspace, task, requirements, tests and attribution. No DONE or completion authority exists.

This is local trusted-host snapshot checking, not adversarial filesystem isolation. Root/ancestor races, ACLs, provider authentication, child tool-access isolation and crash recovery remain limited as in the underlying collector. No real task should use this operation before independent review and the final confirmation integration are ready. Tests use synthetic transport processes and collector fixtures, not provider E2E.

Compatibility: default remains the no-tool profile. Explicit readOnlyPaths enables view-file-v1 with version-two process metadata. Its exact path set must match attributed changed files; deletions, nonregular/symlink/multilink/shared-writable paths and files above 1 MiB reject before launch. Only view_file events on those paths pass post-execution validation. This is not runtime permission enforcement: the prompt/sandbox flag does not prove other tools cannot execute. Unknown events remain failed raw evidence; there is no automatic profile fallback.

## Independent Print Review Finalization

`finalizeOrcaPrintReview` is an explicit operator-only review-result operation, not task completion. It requires exact capture revision, request ID and capture hash, immutable preparation/intent/result, a view-file-v1 capture, current bound ownership, projected delivery, retained passed tests and evidence-store hashes.

It rechecks the original five capture artifacts with the source matcher, requires an exact seven-subject plus verdict JSON response, and revalidates attribution, workspace and task snapshot before CAS save. PASS and REQUEST_CHANGES are review results only; task status remains REVIEW. Drift and administrative cancellation reject instead of overwriting the task. Response bytes are retained before the final task CAS. Unknown save outcome is reconciled by identical replay, not a new provider call. Successful replay must preserve its original revision/subjects.

The finalization record is immutable to participating generic task writers. Existing orcaReviewRun and acceptance validators are not relabelled or widened. There is no production route, automatic completion policy or DONE permission. Stored local evidence does not authenticate the provider, establish a system read-only sandbox or cryptographically prove tool file contents. Source and task completion authority flags remain false. Direct hostile task-file modification, filesystem races outside participating locks and provenance attestation remain outside this local trusted-host scope.

Tests use synthetic provider/collector records and actual temporary local storage/processes. They do not constitute a new real business-task E2E or approve historical coordinator summaries. Do not apply it to a task whose formal delivery, retained test run or prepared capture records are missing.
