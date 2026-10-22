import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { GitService } from "../git/git-service.js";
import type { ProjectStore } from "../projects/project-store.js";
import { TestRunner } from "../testing/test-runner.js";
import { OrcaImportError, validatedOrcaCommit, type OrcaProjectionExpectation } from "./orca-import.js";
import type { OrcaEvidenceRef } from "./orca-evidence.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export interface OrcaTestRun {
  id: string;
  phase: "RUNNING" | "COMPLETED";
  digest: string;
  generation: number;
  workspaceHash: string;
  commandHash: string;
  startedRevision: number;
  startedAt: string;
  completedAt?: string;
  afterWorkspaceHash?: string;
  outcome?: "PASS" | "FAIL" | "INVALIDATED";
  exitCode?: number;
  outputHash?: string;
  outputEvidence?: OrcaEvidenceRef;
  provenance: "LOCAL_TEST_PROCESS";
  reviewStatus: "NOT_RUN";
}

/** HEAD plus tracked/nonignored file contents, modes and symlink targets; not an atomic filesystem snapshot. */
export async function fingerprintOrcaWorkspace(workspace: string): Promise<string> {
  const root = await GitService.getGitRoot(workspace);
  if (await fs.realpath(root) !== await fs.realpath(workspace)) throw new OrcaImportError("WORKSPACE_NOT_ROOT");
  const head = await GitService.exec(["rev-parse", "--verify", "HEAD"], workspace);
  if (head.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(head.stdout)) throw new OrcaImportError("MISSING_HEAD");
  const baseline = await GitService.captureBaseline(workspace);
  return hash(JSON.stringify({ head: head.stdout, files: Object.keys(baseline).sort().map(name => [name, baseline[name]]) }));
}

export interface OrcaTestApproval extends OrcaProjectionExpectation {
  workspaceHash: string;
  command: string;
}

/** Operator-only API, not a route/CLI hook. A saved RUNNING record is never automatically rerun. */
export async function runOrcaDeliveryTests(store: ProjectStore, taskId: string, approval: OrcaTestApproval): Promise<OrcaTestRun> {
  const approved = { ...approval };
  if (!Number.isSafeInteger(approved.revision) || approved.revision < 1 ||
    !Number.isSafeInteger(approved.generation) || approved.generation < 1 ||
    !validHash(approved.digest) || !validHash(approved.workspaceHash) || typeof approved.command !== "string" ||
    !approved.command.trim() || approved.command.length > 4096 || /[\u0000-\u001f]/.test(approved.command))
    throw new OrcaImportError("INVALID_TEST_APPROVAL");
  return store.runTaskExecutionExclusive(taskId, async () => {
    const task = await store.getTask(taskId);
    const commit = validatedOrcaCommit(task);
    const binding = task!.orcaBinding!;
    if (task!.revision !== approved.revision || commit.generation !== approved.generation || commit.digest !== approved.digest)
      throw new OrcaImportError("STALE_TEST_APPROVAL");
    if (task!.orcaTestRun) throw new OrcaImportError("TEST_ALREADY_STARTED");
    if (task!.status !== "REVIEW" || (commit.outbox.event.details as any).to !== "REVIEW" || commit.outbox.state !== "PROJECTED" ||
      task!.ownerType !== "AGENT" || task!.owner !== binding.developer || task!.ownerId !== binding.ownerId ||
      (task!.reviewerId ?? task!.reviewer) !== binding.reviewer || (task!.claim?.id ?? null) !== binding.claimId ||
      task!.testCommand !== approved.command) throw new OrcaImportError("TEST_GATE_NOT_READY");
    if (await fingerprintOrcaWorkspace(binding.workspacePath) !== approved.workspaceHash)
      throw new OrcaImportError("WORKSPACE_CHANGED");
    // Verify actual event durability rather than trusting the PROJECTED marker.
    await store.appendTaskEventOnce(commit.outbox.event);
    const record: OrcaTestRun = { id: randomUUID(), phase: "RUNNING", digest: commit.digest,
      generation: commit.generation, workspaceHash: approved.workspaceHash, commandHash: hash(approved.command),
      startedRevision: task!.revision! + 1, startedAt: new Date().toISOString(),
      provenance: "LOCAL_TEST_PROCESS", reviewStatus: "NOT_RUN" };
    task!.orcaTestRun = record;
    task!.nextAction = "Local test run checkpointed; do not redispatch after interruption";
    task!.updatedAt = record.startedAt;
    await store.saveTask(task!);
    const result = await TestRunner.run(approved.command, binding.workspacePath);
    // Preserve exactly the runner's UTF-8 output representation, before final receipt.
    const outputEvidence = await store.putOrcaEvidence(Buffer.from(result.output,"utf8"));
    const after = await fingerprintOrcaWorkspace(binding.workspacePath);
    record.phase = "COMPLETED";
    record.completedAt = new Date().toISOString();
    record.afterWorkspaceHash = after;
    record.outcome = after !== approved.workspaceHash ? "INVALIDATED" : result.pass && result.exitCode === 0 ? "PASS" : "FAIL";
    record.exitCode = result.exitCode;
    record.outputHash = hash(result.output);
    record.outputEvidence = outputEvidence;
    task!.updatedAt = record.completedAt;
    task!.nextAction = record.outcome === "PASS" ? "Tests passed; independent same-attempt review required"
      : "Test result requires operator reconciliation; no automatic rerun";
    await store.saveTask(task!);
    return record;
  });
}
