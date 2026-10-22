import fs from "node:fs";
import path from "node:path";
import { AcpAgent, AcpAgentConfig } from "./acp-agent.js";

export class CodexAgent extends AcpAgent {
  public static readonly ROLE = "Developer / Implementer";

  constructor(customConfig?: Partial<AcpAgentConfig>) {
    const { command, args } = CodexAgent.resolveCommand();
    super({
      name: "codex",
      command: customConfig?.command || command,
      args: customConfig?.args || args,
      env: customConfig?.env,
      maxRestarts: customConfig?.maxRestarts ?? 2,
      reviewOnly: customConfig?.reviewOnly,
    });
  }

  public static resolveCommand(): { command: string; args: string[] } {
    // 1. Check local node_modules in current or parent directories
    const localBin = path.resolve(process.cwd(), "node_modules/.bin/codex-acp");
    if (fs.existsSync(localBin)) {
      return { command: localBin, args: [] };
    }

    // 2. Check project local node_modules
    const scriptDir = path.dirname(new URL(import.meta.url).pathname);
    const projBin = path.resolve(scriptDir, "../../node_modules/.bin/codex-acp");
    if (fs.existsSync(projBin)) {
      return { command: projBin, args: [] };
    }

    // 3. Fallback to npx
    return {
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp@2.0.1"],
    };
  }
}
