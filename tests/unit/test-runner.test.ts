import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TestDetector } from "../../src/testing/test-detector.js";
import { TestRunner } from "../../src/testing/test-runner.js";

describe("TestRunner and TestDetector Unit Tests", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `test-detector-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("prioritizes custom command over auto-detection", () => {
    const cmd = TestDetector.detect(tempDir, "npm run test:custom");
    expect(cmd).toBe("npm run test:custom");
  });

  it("detects Node.js test command from package.json", () => {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
      "utf-8"
    );

    const cmd = TestDetector.detect(tempDir);
    expect(cmd).toBe("npm test");
  });

  it("detects Python test command from pytest.ini", () => {
    fs.writeFileSync(path.join(tempDir, "pytest.ini"), "[pytest]\n", "utf-8");
    const cmd = TestDetector.detect(tempDir);
    expect(cmd).toBe("pytest");
  });

  it("detects Rust test command from Cargo.toml", () => {
    fs.writeFileSync(path.join(tempDir, "Cargo.toml"), "[package]\nname = 'demo'", "utf-8");
    const cmd = TestDetector.detect(tempDir);
    expect(cmd).toBe("cargo test");
  });

  it("returns null when no known test framework is detected", () => {
    const cmd = TestDetector.detect(tempDir);
    expect(cmd).toBeNull();
  });

  it("executes a passing command and returns pass: true with exit code 0", async () => {
    const result = await TestRunner.run("node -e 'process.exit(0)'", tempDir);
    expect(result.pass).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("executes a failing command and returns pass: false with non-zero exit code", async () => {
    const result = await TestRunner.run("node -e 'console.error(\"failed!\"); process.exit(2)'", tempDir);
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("failed!");
  });

  it("does not approve a process terminated by a signal", async () => {
    const result = await TestRunner.run("exec node -e 'process.kill(process.pid, \"SIGTERM\")'", tempDir);
    expect(result.pass).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it("terminates and flags timeout if command runs longer than timeout limit", async () => {
    const result = await TestRunner.run("node -e 'setTimeout(() => {}, 5000)'", tempDir, 500);
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.output).toContain("timed out");
  });
});
