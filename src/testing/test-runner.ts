import { spawn } from "node:child_process";

export interface TestRunResult {
  pass: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
  command: string;
}

export class TestRunner {
  public static async run(
    command: string,
    cwd: string,
    timeoutMs: number = 180000,
    signal?: AbortSignal
  ): Promise<TestRunResult> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve({
          pass: false,
          exitCode: 130,
          output: "[TestRunner]: Aborted before execution",
          durationMs: 0,
          command,
        });
        return;
      }

      const proc = spawn(command, {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let finished = false;

      const onAbort = () => {
        if (!finished) {
          finished = true;
          try {
            proc.kill("SIGKILL");
          } catch {}
          resolve({
            pass: false,
            exitCode: 130,
            output: `${stdout}\n${stderr}\n[TestRunner]: Aborted by user`.trim(),
            durationMs: Date.now() - startTime,
            command,
          });
        }
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        if (!finished) {
          finished = true;
          try {
            proc.kill("SIGKILL");
          } catch {}
          resolve({
            pass: false,
            exitCode: 124, // standard timeout code
            output: `${stdout}\n${stderr}\n[TestRunner Error]: Test command timed out after ${timeoutMs}ms`,
            durationMs: Date.now() - startTime,
            command,
          });
        }
      }, timeoutMs);

      proc.stdout.on("data", (d) => {
        stdout += d.toString("utf-8");
      });

      proc.stderr.on("data", (d) => {
        stderr += d.toString("utf-8");
      });

      proc.on("close", (code) => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          const exitCode = code ?? 1;
          resolve({
            pass: exitCode === 0,
            exitCode,
            output: (stdout + (stderr ? `\n${stderr}` : "")).trim(),
            durationMs: Date.now() - startTime,
            command,
          });
        }
      });

      proc.on("error", (err) => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          resolve({
            pass: false,
            exitCode: 1,
            output: `[TestRunner Process Error]: ${err.message}`,
            durationMs: Date.now() - startTime,
            command,
          });
        }
      });
    });
  }
}
