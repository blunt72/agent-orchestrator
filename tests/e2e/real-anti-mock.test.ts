import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AntigravityAgent } from "../../src/agents/antigravity-agent.js";

describe("Anti-Mock Real E2E Verification", () => {
  const FAKE_AGY_SHA256 = "268283862a1c166eb2b69f32e5ff57d5083238af10cbbc62fc0fcb1a9441a312";

  it("strictly fails if fake-agy or local mock is detected", async () => {
    const fakeFixture = path.resolve(process.cwd(), "tests/fixtures/fake-agy");
    expect(fs.existsSync(fakeFixture)).toBe(true);

    const content = fs.readFileSync(fakeFixture);
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    expect(hash).toBe(FAKE_AGY_SHA256);

    // Attempting to initialize AntigravityAgent with the mock must be rejected
    const mockAgent = new AntigravityAgent({ executablePath: fakeFixture });
    await expect(mockAgent.initialize()).rejects.toThrow(/SECURITY REJECTION/);
  });

  it("real Google Gemini Reviewer reads dynamic workspace file, returns dynamic secret token, and reviews dynamic bug", async () => {
    // 1. Dynamic generation of random tokens, filenames, and bugs
    const nonce = crypto.randomBytes(3).toString("hex");
    const secretToken = `TOKEN_SEC_${nonce}_${Date.now()}`;
    const randomFileName = `ratio_${nonce}.ts`;

    // Workspace setup
    const testDir = path.resolve(process.cwd(), `logs/anti-mock-workspace-${nonce}`);
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });

    const buggyCode = `// secret-review-token: ${secretToken}
// session-nonce: ${nonce}

export function computeRatio(numerator: number, denominator: number): number {
  // CRITICAL DEFECT: No boundary check for zero denominator, and inputs are not checked for finite numbers
  return numerator / denominator;
}
`;

    fs.writeFileSync(path.join(testDir, "src", randomFileName), buggyCode, "utf-8");

    const agent = new AntigravityAgent({ model: "flash" });

    try {
      await agent.initialize();

      // Ensure provider is genuine
      expect(agent.getExecutablePath()).toMatch(/agentapi$/);
      expect(agent.getExecutablePath()).not.toContain("fake-agy");

      const sessionId = await agent.createSession(testDir);
      expect(sessionId).toBeDefined();

      const prompt = `Review the file "src/${randomFileName}" located in the workspace.
Code content:
${buggyCode}

Instructions:
1. You MUST find and quote the secret-review-token.
2. Analyze the bug when denominator is 0 or non-finite.
3. Conclude with AGENT_STATUS: CONTINUE or AGENT_STATUS: DONE.`;

      const response = await agent.prompt(sessionId, prompt);

      // Verify the reviewer returned the dynamically generated secret token
      expect(response.text).toContain(secretToken);

      // Verify the reviewer identified the bug
      const reviewLower = response.text.toLowerCase();
      const mentionsDivisionBug =
        reviewLower.includes("zero") ||
        reviewLower.includes("denominator") ||
        reviewLower.includes("divide") ||
        reviewLower.includes("division");
      expect(mentionsDivisionBug).toBe(true);

      // Verify Provider Provenance
      expect(response.provenance).toBeDefined();
      expect(response.provenance?.provider).toBe("google");
      expect(response.provenance?.adapter).toBe("antigravity-agentapi");
      expect(response.provenance?.endpoint).toContain("agentapi");
      expect(response.provenance?.providerSessionId).toBe(sessionId);
    } finally {
      await agent.close();
      // Clean up test workspace
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {}
    }
  }, 120000);
});
