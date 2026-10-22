import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectAutomationPolicyFile } from "../../src/cli/automation-preflight.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture(projectId = "project-one") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "automation-policy-")));
  roots.push(root);
  await fs.mkdir(path.join(root, "test"));
  await fs.writeFile(path.join(root, "README.md"), "documentation");
  await fs.writeFile(path.join(root, "vitest.pure.config.ts"), "configuration");
  const policy = { version: 1, projectId, workspace: root, documentation: ["README.md"],
    readFiles: ["vitest.pure.config.ts"], writeFiles: ["test/pure.test.ts"], developer: "gemini", reviewer: "codex",
    command: { executable: "./node_modules/.bin/vitest", args: ["run", "--config", "vitest.pure.config.ts", "test/pure.test.ts"], cwd: root },
    limits: { timeoutMs: 60000, maxReworks: 1, maxDispatches: 2 } };
  const raw = JSON.stringify(policy), file = path.join(root, "policy.json");
  await fs.writeFile(file, raw);
  return { root, file, raw, digest: createHash("sha256").update(raw).digest("hex") };
}
describe("automation preflight (synthetic filesystem, no providers)", () => {
  it.each(["project-one", "project-two"])("reuses policy checks for %s without starting execution", async id => {
    const f = await fixture(id), before = await fs.readdir(f.root);
    expect(await inspectAutomationPolicyFile(f.file, f.digest)).toMatchObject({ projectId: id, policyChecked: true,
      canDispatch: false, canExecute: false, canCompleteTask: false, sourceAuthenticated: false });
    expect(await fs.readdir(f.root)).toEqual(before);
    expect(await fs.readFile(f.file, "utf8")).toBe(f.raw);
    await expect(fs.stat(path.join(f.root, "test/pure.test.ts"))).rejects.toThrow();
  });
  it("rejects an incorrect pin", async () => {
    const f = await fixture();
    await expect(inspectAutomationPolicyFile(f.file, "0".repeat(64))).rejects.toThrow();
  });
  it("rejects symlink and hardlink policy files", async () => {
    const f = await fixture(), alias = path.join(f.root, "alias.json");
    await fs.symlink(f.file, alias);
    await expect(inspectAutomationPolicyFile(alias, f.digest)).rejects.toThrow();
    await fs.unlink(alias); await fs.link(f.file, alias);
    await expect(inspectAutomationPolicyFile(f.file, f.digest)).rejects.toThrow();
  });
  it("rejects oversized files before parsing", async () => {
    const f = await fixture(); await fs.writeFile(f.file, " ".repeat(32769));
    await expect(inspectAutomationPolicyFile(f.file, f.digest)).rejects.toThrow();
  });
  it("rejects relative and directory inputs", async () => {
    const f = await fixture();
    await expect(inspectAutomationPolicyFile("policy.json", f.digest)).rejects.toThrow();
    await expect(inspectAutomationPolicyFile(f.root, f.digest)).rejects.toThrow();
  });
  it("reports v2 reversed roles and an exact native test command without running it", async () => {
    const f = await fixture();
    const policy = { ...JSON.parse(f.raw), version: 2, developer: "codex", reviewer: "gemini", coordinator: "antigravity",
      writeFiles: ["test/native.test.mjs"],
      command: { profile: "node-test", executable: await fs.realpath(process.execPath), args: ["--test", "test/native.test.mjs"], cwd: f.root } };
    const raw = JSON.stringify(policy); await fs.writeFile(f.file, raw);
    expect(await inspectAutomationPolicyFile(f.file, createHash("sha256").update(raw).digest("hex"))).toMatchObject({
      policyVersion: 2, coordinator: "antigravity", developer: "codex", reviewer: "gemini", canExecute: false,
      testCommand: `${policy.command.executable} --test test/native.test.mjs` });
    await expect(fs.stat(path.join(f.root, "test/native.test.mjs"))).rejects.toThrow();
  });
});
