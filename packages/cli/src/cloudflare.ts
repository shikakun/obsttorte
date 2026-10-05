import { CliError } from "./errors";
import type { D1LocationHint } from "./state";
import { parseWranglerJson, type WranglerRunner } from "./wrangler";

export type CloudflareClient = {
  whoami(): Promise<{ email: string | null } | null>;
  login(): Promise<void>;
  workerExists(name: string): Promise<boolean>;
  findDatabase(name: string): Promise<{ id: string } | null>;
  createDatabase(name: string, location: D1LocationHint | null): Promise<{ id: string }>;
  bucketExists(name: string): Promise<boolean>;
  createBucket(name: string): Promise<void>;
  applyMigrations(configPath: string): Promise<void>;
  deploy(configPath: string): Promise<string>;
  execute(configPath: string, sql: string): Promise<unknown>;
};

export function createCloudflareClient(runner: WranglerRunner): CloudflareClient {
  const client: CloudflareClient = {
    async whoami() {
      const result = await runner(["whoami", "--json"], "pipe");
      if (result.code !== 0) return null;
      const parsed = parseWranglerJson(result.stdout);
      if (!isRecord(parsed) || parsed.loggedIn !== true) return null;
      return { email: typeof parsed.email === "string" ? parsed.email : null };
    },
    async login() {
      const result = await runner(["login"], "inherit");
      if (result.code !== 0) throw new CliError("wrangler login failed.", result.stderr);
    },
    async workerExists(name) {
      const result = await runner(["deployments", "status", "--name", name], "pipe");
      if (result.code === 0) return true;
      if (isMissing(result.stderr + result.stdout)) return false;
      throw new CliError(
        "Could not check whether the Worker exists. Stopped instead of assuming it does not.",
        result.stderr || result.stdout,
      );
    },
    async findDatabase(name) {
      const result = await runner(["d1", "list", "--json"], "pipe");
      if (result.code !== 0) {
        throw new CliError(
          "Could not list the D1 databases. Stopped instead of assuming the database does not exist.",
          result.stderr || result.stdout,
        );
      }
      const rows = parseWranglerJson(result.stdout);
      if (!Array.isArray(rows)) throw new CliError("Could not read the list of D1 databases.");
      const found = rows.find((row) => isRecord(row) && row.name === name);
      if (!found || !isRecord(found)) return null;
      const id = found.uuid ?? found.database_id;
      if (typeof id !== "string") throw new CliError("Could not read the D1 database ID.");
      return { id };
    },
    async createDatabase(name, location) {
      const args = ["d1", "create", name];
      if (location) args.push("--location", location);
      const result = await runner(args, "pipe");
      if (result.code !== 0)
        throw new CliError("Could not create the D1 database.", result.stderr || result.stdout);
      const created = await client.findDatabase(name);
      if (!created) throw new CliError("Could not find the new D1 database in the list.");
      return created;
    },
    async bucketExists(name) {
      const result = await runner(["r2", "bucket", "info", name], "pipe");
      if (result.code === 0) return true;
      if (isMissing(result.stderr + result.stdout)) return false;
      throw new CliError(
        "Could not check whether the R2 bucket exists. Stopped instead of assuming it does not.",
        result.stderr || result.stdout,
      );
    },
    async createBucket(name) {
      const result = await runner(["r2", "bucket", "create", name], "pipe");
      if (result.code !== 0)
        throw new CliError("Could not create the R2 bucket.", result.stderr || result.stdout);
    },
    async applyMigrations(configPath) {
      const result = await runner(
        ["d1", "migrations", "apply", "DB", "--remote", "-c", configPath],
        "tee",
      );
      if (result.code !== 0)
        throw new CliError("The database migration failed.", result.stderr || result.stdout);
    },
    async deploy(configPath) {
      const result = await runner(["deploy", "-c", configPath], "tee");
      if (result.code !== 0)
        throw new CliError("The deployment failed.", result.stderr || result.stdout);
      return `${result.stdout}\n${result.stderr}`;
    },
    async execute(configPath, sql) {
      const result = await runner(
        ["d1", "execute", "DB", "--remote", "--json", "-c", configPath, "--command", sql],
        "pipe",
      );
      if (result.code !== 0) {
        const details = result.stderr || result.stdout;
        if (details.includes("no such column")) {
          throw new CliError(
            "The database is missing a column that this CLI needs. Run obsttorte update first.",
            details,
          );
        }
        throw new CliError("Could not run SQL on the D1 database.", details);
      }
      return parseWranglerJson(result.stdout);
    },
  };
  return client;
}

function isMissing(output: string): boolean {
  return /not found|does not exist|doesn't exist|No such|10007|10006/i.test(output);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function resultRows(output: unknown): Array<Record<string, unknown>> {
  const results = Array.isArray(output) ? output : [output];
  return results.flatMap((result) =>
    isRecord(result) && Array.isArray(result.results) ? result.results.filter(isRecord) : [],
  );
}
