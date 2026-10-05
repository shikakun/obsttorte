import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors";
import type { InstallationState } from "./state";

export function stateDirectory(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const base = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "obsttorte");
}

export function installationFile(dir: string, worker: string): string {
  return path.join(dir, `${worker}.json`);
}

export async function readInstallations(dir: string): Promise<InstallationState[]> {
  try {
    const names = await readdir(dir);
    const states: InstallationState[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      states.push(await readInstallation(path.join(dir, name)));
    }
    return states.sort((left, right) => left.worker.localeCompare(right.worker));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

export async function readInstallation(file: string): Promise<InstallationState> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as InstallationState;
  if (parsed.version !== 1 || !parsed.worker)
    throw new CliError(`Could not read the installation record: ${file}`);
  return parsed;
}

export async function writeInstallation(dir: string, state: InstallationState): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = installationFile(dir, state.worker);
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
