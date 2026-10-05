import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { CliError } from "./errors";

export type WranglerMode = "pipe" | "inherit" | "tee";

export type WranglerResult = { code: number; stdout: string; stderr: string };

export type WranglerRunner = (args: string[], mode?: WranglerMode) => Promise<WranglerResult>;

export function createWranglerRunner(execPath = process.execPath): WranglerRunner {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("wrangler/package.json");
  const bin = packageJson.replace(/package\.json$/, "bin/wrangler.js");
  return (args, mode = "pipe") => runProcess(execPath, [bin, ...args], mode);
}

export function runProcess(
  command: string,
  args: string[],
  mode: WranglerMode,
): Promise<WranglerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: mode === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (mode === "tee") process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (mode === "tee") process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function parseWranglerJson(output: string): unknown {
  const arrayStart = output.indexOf("[");
  if (arrayStart !== -1) {
    try {
      return JSON.parse(output.slice(arrayStart));
    } catch {
      // オブジェクトの中に [ を含むことがあるので、オブジェクトとして読み直す
    }
  }
  const objectStart = output.indexOf("{");
  if (objectStart === -1) throw new CliError("Could not read the JSON output of wrangler.", output);
  try {
    return JSON.parse(output.slice(objectStart));
  } catch (error) {
    throw new CliError(
      "Could not read the JSON output of wrangler.",
      error instanceof Error ? error.message : output,
    );
  }
}
