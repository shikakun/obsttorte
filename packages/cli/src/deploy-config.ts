import { readFileSync } from "node:fs";
import path from "node:path";
import { CliError } from "./errors";
import type { InstallationState } from "./state";

type D1Binding = {
  binding: string;
  database_name: string;
  database_id: string;
  migrations_dir?: string;
};
type R2Binding = { binding: string; bucket_name: string };

export type WranglerConfig = {
  name: string;
  main: string;
  compatibility_date?: string;
  configPath?: string;
  userConfigPath?: string;
  topLevelName?: string;
  d1_databases?: D1Binding[];
  r2_buckets?: R2Binding[];
  routes?: Array<{ pattern: string; custom_domain: boolean }>;
  workers_dev?: boolean;
  preview_urls?: boolean;
  access?: { dev?: { aud: string } };
  vars?: Record<string, string>;
  limits?: { cpu_ms?: number };
  observability?: { enabled?: boolean; head_sampling_rate?: number };
  upload_source_maps?: boolean;
  triggers?: { crons?: string[] };
  ratelimits?: Array<{
    name: string;
    namespace_id: string;
    simple: { limit: number; period: number };
  }>;
};

type PackagePaths = { buildDir: string; migrationsDir: string };

export function readBuiltWranglerConfig(buildDir: string): WranglerConfig {
  const configPath = path.join(buildDir, "wrangler.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new CliError(
      "Could not read wrangler.json in the bundled build.",
      error instanceof Error ? error.message : undefined,
    );
  }
  if (!isWranglerConfig(parsed)) {
    throw new CliError("The bundled build has no D1 or R2 binding.");
  }
  return parsed;
}

function isWranglerConfig(value: unknown): value is WranglerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.main === "string" &&
    Array.isArray(record.d1_databases) &&
    Array.isArray(record.r2_buckets)
  );
}

export function buildDeployConfig(
  built: WranglerConfig,
  state: InstallationState,
  paths: PackagePaths,
): WranglerConfig {
  const [database] = built.d1_databases ?? [];
  const [bucket] = built.r2_buckets ?? [];
  if (!database || !bucket) {
    throw new CliError("The bundled build has no D1 or R2 binding.");
  }

  return {
    ...built,
    configPath: undefined,
    userConfigPath: undefined,
    access: undefined,
    name: state.worker,
    ...(built.topLevelName === undefined ? {} : { topLevelName: state.worker }),
    main: path.resolve(paths.buildDir, built.main),
    d1_databases: [
      {
        ...database,
        database_name: state.database.name,
        database_id: state.database.id,
        migrations_dir: paths.migrationsDir,
      },
    ],
    r2_buckets: [{ ...bucket, bucket_name: state.bucket.name }],
    routes: state.domain ? [{ pattern: state.domain, custom_domain: true }] : undefined,
    workers_dev: state.domain === null,
    preview_urls: false,
    vars: {
      ...built.vars,
      ACCESS_AUD: state.access?.aud ?? "",
      ACCESS_TOKEN_EXPIRES_AT: state.access?.tokenExpiresAt ?? "",
    },
  };
}
