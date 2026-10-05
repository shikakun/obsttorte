import { applyD1Migrations, env as rawEnv } from "cloudflare:test";
import type { Env } from "../src/env";

const env = rawEnv as unknown as Env;
if (!env.TEST_MIGRATIONS) throw new Error("TEST_MIGRATIONS binding is missing");
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
