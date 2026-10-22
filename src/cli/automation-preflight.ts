import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { inspectOrcaProjectPolicyPaths, formatOrcaPolicyTestCommand } from "../integrations/orca-project-policy.js";

const MAX_BYTES = 32768;

export async function inspectAutomationPolicyFile(file: string, digest: string) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) throw Error("INVALID_POLICY_FILE");
  const entry = await fs.lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size < 1 || entry.size > MAX_BYTES) {
    throw Error("INVALID_POLICY_FILE");
  }
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: string;
  try {
    const before = await handle.stat();
    if (before.dev !== entry.dev || before.ino !== entry.ino || before.size !== entry.size) throw Error("POLICY_DRIFT");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await handle.stat();
    if (total !== before.size || total > MAX_BYTES || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error("POLICY_DRIFT");
    raw = bytes.subarray(0, total).toString("utf8");
    if (!Buffer.from(raw).equals(bytes.subarray(0, total))) throw Error("INVALID_POLICY_FILE");
  } finally {
    await handle.close();
  }
  const checked = await inspectOrcaProjectPolicyPaths(raw, digest);
  const final = await fs.lstat(file);
  if (final.dev !== entry.dev || final.ino !== entry.ino || final.size !== entry.size ||
    final.mtimeMs !== entry.mtimeMs || final.ctimeMs !== entry.ctimeMs) throw Error("POLICY_DRIFT");
  return {
    version: 1,
    policyVersion: checked.policy.version,
    policyChecked: true,
    projectId: checked.policy.projectId,
    policyDigest: checked.digest,
    workspace: checked.policy.workspace,
    developer: checked.policy.developer,
    reviewer: checked.policy.reviewer,
    ...(checked.policy.version === 2 ? { coordinator: checked.policy.coordinator } : {}),
    writeFiles: checked.policy.writeFiles,
    command: checked.policy.command,
    testCommand: formatOrcaPolicyTestCommand(checked.policy),
    limits: checked.policy.limits,
    canDispatch: false,
    canExecute: false,
    canCompleteTask: false,
    sourceAuthenticated: false,
    blockers: ["FRESH_ATTEMPT_BINDING_REQUIRED", "SUPERVISED_EXECUTION_NOT_STARTED"],
  };
}

export async function runAutomationPreflightCli(options: { policy: string; sha256: string }) {
  try {
    const report = await inspectAutomationPolicyFile(options.policy, options.sha256);
    console.log(JSON.stringify({ ok: true, report }));
  } catch {
    console.log(JSON.stringify({ ok: false, code: "AUTOMATION_PREFLIGHT_REJECTED" }));
    process.exitCode = 1;
  }
}
