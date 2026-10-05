import { app } from "./app";
import type { Env } from "./env";

const DAILY_SNAPSHOT_CRON = "17 3 * * *";
const WEEKLY_MAINTENANCE_CRON = "41 4 * * 1";

export default {
  fetch: app.fetch,
  async scheduled(controller, env) {
    const maintenance = await import("./cron");
    if (controller.cron === DAILY_SNAPSHOT_CRON) {
      await maintenance.runMaintenance(env, [
        { kind: "snapshot", run: (env) => maintenance.createServerSnapshot(env) },
        { kind: "expire", run: (env) => maintenance.expireShortLivedRows(env) },
      ]);
      return;
    }
    if (controller.cron === WEEKLY_MAINTENANCE_CRON) {
      await maintenance.runMaintenance(env, [
        { kind: "retention", run: (env) => maintenance.applyRetentionPolicy(env) },
        { kind: "gc", run: (env) => maintenance.runGarbageCollection(env) },
        { kind: "integrity", run: (env) => maintenance.runIntegrityCheck(env) },
      ]);
    }
  },
} satisfies ExportedHandler<Env>;
