import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseOrcaProjectPolicy, inspectOrcaProjectPolicyPaths, formatOrcaPolicyTestCommand } from "../../src/integrations/orca-project-policy.js";
const base = { version: 1, projectId: "project", workspace: "/project", documentation: ["README.md"],
  readFiles: ["src/pure.ts", "vitest.agenthub-pure.config.ts"], writeFiles: ["test/pure.test.ts"], developer: "gemini", reviewer: "codex",
  command: { executable: "./node_modules/.bin/vitest", args: ["run", "--config", "vitest.agenthub-pure.config.ts", "test/pure.test.ts"], cwd: "/project" },
  limits: { timeoutMs: 60000, maxReworks: 1, maxDispatches: 2 } };
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
const run = (v: unknown = base) => { const raw = JSON.stringify(v); return parseOrcaProjectPolicy(raw, digest(raw)); };
describe("operator-pinned test-only policy; no dispatch", () => {
  it("accepts scoped policy without granting execution", () => expect(run()).toMatchObject({ policy: base, canDispatch: false, sourceAuthenticated: false }));
  it("supports nested test-only paths without baking in a project root", () => {
    const files = ["tests/unit/pure.test.ts"];
    expect(run({ ...base, writeFiles: files, command: { ...base.command, args: ["run", "--config", "vitest.agenthub-pure.config.ts", ...files] } }).canDispatch).toBe(false);
  });
  it.each([
    { ...base, extra: true }, { ...base, developer: "claude" }, { ...base, reviewer: "gemini" },
    { ...base, writeFiles: ["src/pure.ts"] }, { ...base, writeFiles: ["test/../secret.test.ts"] },
    { ...base, readFiles: [".env"] }, { ...base, documentation: ["../README.md"] },
    { ...base, command: { ...base.command, executable: "sh" } },
    { ...base, command: { ...base.command, cwd: "/other" } },
    { ...base, command: { ...base.command, args: ["run"] } },
    { ...base, limits: { ...base.limits, timeoutMs: 0 } },
    { ...base, limits: { ...base.limits, maxDispatches: 99 } },
    { ...base, limits: { ...base.limits, maxDispatches: 1 } },
    { ...base, workspace: "/a/../project" }, { ...base, readFiles: ["src/pure.ts", "src/pure.ts"] },
  ])("rejects unsafe or malformed policy %#", v => expect(() => run(v)).toThrow());
  it("rejects incorrect pin and duplicate keys", () => {
    expect(() => parseOrcaProjectPolicy(JSON.stringify(base), "0".repeat(64))).toThrow();
    const raw = '{"version":1,"version":1}'; expect(() => parseOrcaProjectPolicy(raw, digest(raw))).toThrow();
  });
  it("checks existing read paths, permits absent test leaf, rejects symlink ancestor", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "policy-")));
    try {
      await fs.mkdir(path.join(root, "src")); await fs.mkdir(path.join(root, "test"));
      for (const f of [...base.readFiles, ...base.documentation]) await fs.writeFile(path.join(root, f), "");
      const raw = JSON.stringify({ ...base, workspace: root, command: { ...base.command, cwd: root } });
      expect(await inspectOrcaProjectPolicyPaths(raw, digest(raw))).toMatchObject({ localPathsChecked: true, canExecute: false });
      await fs.rmdir(path.join(root, "test")); await fs.symlink(path.join(root, "src"), path.join(root, "test"));
      await expect(inspectOrcaProjectPolicyPaths(raw, digest(raw))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("rejects hardlink overlap between read and write scopes", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "policy-alias-")));
    try {
      await fs.mkdir(path.join(root, "src")); await fs.mkdir(path.join(root, "test"));
      for (const f of [...base.readFiles, ...base.documentation]) await fs.writeFile(path.join(root, f), "");
      await fs.link(path.join(root, "src/pure.ts"), path.join(root, "test/pure.test.ts"));
      const raw = JSON.stringify({ ...base, workspace: root, command: { ...base.command, cwd: root } });
      await expect(inspectOrcaProjectPolicyPaths(raw, digest(raw))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("rejects case-folded read/write aliases where the filesystem supports them", async ctx => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "policy-case-")));
    try {
      await fs.mkdir(path.join(root, "src")); await fs.mkdir(path.join(root, "test"));
      for (const f of [...base.readFiles, ...base.documentation, ...base.writeFiles]) await fs.writeFile(path.join(root, f), "");
      const alias = "Test/pure.test.ts";
      if (!(await fs.stat(path.join(root, alias)).catch(() => null))) { ctx.skip(); return; }
      const raw = JSON.stringify({ ...base, workspace: root, readFiles: [...base.readFiles, alias], command: { ...base.command, cwd: root } });
      await expect(inspectOrcaProjectPolicyPaths(raw, digest(raw))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

const education = { ...base, version: 2, coordinator: "antigravity", developer: "codex", reviewer: "gemini",
  readFiles: ["src/catalog.mjs"], writeFiles: ["src/tutor.mjs", "test/tutor.test.mjs"],
  command: { profile: "node-test", executable: "/usr/local/bin/node", args: ["--test", "test/tutor.test.mjs"], cwd: "/project" } };
describe("explicit v2 roles and native Node profile (preparation only)", () => {
  it("accepts the reversed independent roles and exact source/test scope", () => {
    const r = run(education);
    expect(r).toMatchObject({ policy: education, canDispatch: false, sourceAuthenticated: false });
    expect(formatOrcaPolicyTestCommand(r.policy)).toBe("/usr/local/bin/node --test test/tutor.test.mjs");
  });
  it("supports the original Vitest workflow in v2 without changing v1", () => {
    expect(run({ ...base, version: 2, coordinator: "codex", command: { ...base.command, profile: "vitest" } }).policy.version).toBe(2);
    expect(run().policy).toEqual(base);
  });
  it("quotes an operator path with spaces and apostrophes as one token", () => {
    const p = run({ ...education, command: { ...education.command, executable: "/opt/Node's runtime/node" } }).policy;
    expect(formatOrcaPolicyTestCommand(p)).toBe("'/opt/Node'\\''s runtime/node' --test test/tutor.test.mjs");
  });
  it.each([
    { ...education, version: 3 }, { ...education, coordinator: "gemini" },
    { ...education, coordinator: "codex" }, { ...education, developer: "gemini" },
    { ...education, reviewer: "codex" }, { ...education, developer: "claude" },
    { ...education, writeFiles: ["src/tutor.mjs"] },
    { ...education, writeFiles: ["package.json", "test/tutor.test.mjs"] },
    { ...education, writeFiles: ["src/../secret.mjs", "test/tutor.test.mjs"] },
    { ...education, writeFiles: ["src/.secret.mjs", "test/tutor.test.mjs"] },
    { ...education, writeFiles: ["test/tutor.test.mjs", "test/tutor.test.mjs"] },
    { ...education, readFiles: ["src/tutor.mjs"] },
    { ...education, command: { ...education.command, executable: "node" } },
    { ...education, command: { ...education.command, profile: "shell" } },
    { ...education, command: { ...education.command, args: ["--test", "test/*.test.mjs"] } },
    { ...education, command: { ...education.command, args: ["--import", "evil.mjs", "--test", "test/tutor.test.mjs"] } },
    { ...education, command: { ...education.command, args: ["--test", "test/other.test.mjs"] } },
    { ...education, command: { ...education.command, args: ["--test", "src/tutor.mjs", "test/tutor.test.mjs"] } },
    { ...education, command: { ...education.command, shell: true } },
    { ...education, command: { ...education.command, cwd: "/other" } },
    { ...base, version: 1, coordinator: "codex" },
  ])("rejects scope, role, command or version expansion %#", v => expect(() => run(v)).toThrow());
  it("rejects nonstring and terminated pins before coercion", () => {
    const raw = JSON.stringify(education);
    for (const pin of [null, {}, digest(raw) + "\n", digest(raw) + "\r"]) expect(() => parseOrcaProjectPolicy(raw, pin as string)).toThrow();
  });
  it("checks real native-runner identity and permits missing source/test leaves", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "policy-node-")));
    try {
      await fs.mkdir(path.join(root, "src")); await fs.mkdir(path.join(root, "test"));
      await fs.writeFile(path.join(root, "README.md"), ""); await fs.writeFile(path.join(root, "src/catalog.mjs"), "");
      const c = { ...education, workspace: root, command: { ...education.command, executable: await fs.realpath(process.execPath), cwd: root } };
      const raw = JSON.stringify(c);
      expect(await inspectOrcaProjectPolicyPaths(raw, digest(raw))).toMatchObject({ canExecute: false, localPathsChecked: true });
      const wrong = JSON.stringify({ ...c, command: { ...c.command, executable: "/bin/sh" } });
      await expect(inspectOrcaProjectPolicyPaths(wrong, digest(wrong))).rejects.toThrow();
      await fs.symlink(path.join(root, "src/catalog.mjs"), path.join(root, "src/tutor.mjs"));
      await expect(inspectOrcaProjectPolicyPaths(raw, digest(raw))).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
