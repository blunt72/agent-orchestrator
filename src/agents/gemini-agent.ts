import fs from "node:fs";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { AcpAgent, AcpAgentConfig } from "./acp-agent.js";

export class GeminiAgent extends AcpAgent {
  public static readonly ROLE = "Reviewer / Architect";

  constructor(customConfig?: Partial<AcpAgentConfig>) {
    const { command, args } = GeminiAgent.resolveCommand();
    super({
      name: "gemini",
      command: customConfig?.command || command,
      args: customConfig?.args || args,
      env: {
        GEMINI_CLI_TRUST_WORKSPACE: "true",
        ...customConfig?.env,
      },
      maxRestarts: customConfig?.maxRestarts ?? 2,
    });
  }

  public override async initialize(): Promise<void> {
    await super.initialize();

    // Check if OAuth personal authentication can be attempted if no GEMINI_API_KEY is present
    if (!process.env["GEMINI_API_KEY"] && !process.env["GOOGLE_API_KEY"] && this.connection) {
      try {
        await this.connection.agent.request(acp.methods.agent.authenticate, {
          methodId: "oauth-personal",
        });
      } catch (err: any) {
        // Record auth attempt error in stderr buffer for diagnostics
        this.stderrBuffer.push(`OAuth authentication attempt: ${err.message}`);
      }
    }
  }

  public static resolveCommand(): { command: string; args: string[] } {
    // 1. Check local node_modules in current working directory
    const localBin = path.resolve(process.cwd(), "node_modules/.bin/gemini");
    if (fs.existsSync(localBin)) {
      return { command: localBin, args: ["--acp", "--approval-mode=plan", "--skip-trust"] };
    }

    // 2. Check project local node_modules
    const scriptDir = path.dirname(new URL(import.meta.url).pathname);
    const projBin = path.resolve(scriptDir, "../../node_modules/.bin/gemini");
    if (fs.existsSync(projBin)) {
      return { command: projBin, args: ["--acp", "--approval-mode=plan", "--skip-trust"] };
    }

    // 3. Fallback to global gemini or npx
    return {
      command: "gemini",
      args: ["--acp", "--approval-mode=plan", "--skip-trust"],
    };
  }
}
