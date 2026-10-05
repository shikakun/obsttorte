import type { D1Migration } from "@cloudflare/vitest-plugin";

export type DeviceRow = {
  id: string;
  name: string;
  last_seen_at: number | null;
  last_api_version: number | null;
};

export type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  AUTH_FAILURE_LIMITER: RateLimit;
  ACCESS_AUD: string;
  ACCESS_TOKEN_EXPIRES_AT: string;
  TEST_MIGRATIONS?: D1Migration[];
};

export type AppEnv = {
  Bindings: Env;
  Variables: {
    device: DeviceRow;
    rowsRead: number;
    rowsWritten: number;
  };
};

export type AccessExecutionContext = ExecutionContext & {
  access?: { aud?: string };
};
