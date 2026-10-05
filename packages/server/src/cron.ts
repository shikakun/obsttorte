import {
  D1_NOTICE_BYTES,
  D1_WARNING_BYTES,
  GC_MIN_AGE_MS,
  HISTORY_MIN_REVISIONS,
  HISTORY_RETENTION_MS,
  R2_NOTICE_BYTES,
  REQUEST_RETENTION_MS,
  RESOLVED_CONFLICT_RETENTION_MS,
} from "@obsttorte/shared";
import { chunks, placeholders } from "./db";
import type { Env } from "./env";
import { objectKey, STAGING_PREFIX } from "./objects";
import { listSnapshots, readRetention, snapshotKey, snapshotSha256s } from "./snapshots";

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_BUDGET_MS = 12 * 60 * 1000;
const INTEGRITY_BUDGET_MS = 12 * 60 * 1000;
const STAGING_MAX_AGE_MS = DAY_MS;
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

export async function createServerSnapshot(env: Env, now = Date.now()): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT path, sha256, size FROM files WHERE deleted = 0 AND sha256 IS NOT NULL",
  ).all<{
    path: string;
    sha256: string;
    size: number;
  }>();
  const files: Record<string, { sha256: string; size: number }> = {};
  for (const row of rows.results) files[row.path] = { sha256: row.sha256, size: row.size };
  await env.BUCKET.put(snapshotKey(`${now}-server`), JSON.stringify({ files }));
  await writeReport(env, "snapshot", true, { count: Object.keys(files).length }, now);
}

export async function expireShortLivedRows(env: Env, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM requests WHERE created_at < ?").bind(now - REQUEST_RETENTION_MS),
    env.DB.prepare("DELETE FROM purge_tokens WHERE expires_at < ?").bind(now),
  ]);
}

export async function applyRetentionPolicy(env: Env, now = Date.now()): Promise<void> {
  const retention = await readRetention(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM conflicts WHERE resolved_at IS NOT NULL AND resolved_at < ?").bind(
      now - RESOLVED_CONFLICT_RETENTION_MS,
    ),
    env.DB.prepare(
      `DELETE FROM history
        WHERE changed_at < ?
          AND id NOT IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (PARTITION BY path ORDER BY rev DESC) AS n FROM history
            ) WHERE n <= ?
          )`,
    ).bind(now - HISTORY_RETENTION_MS, HISTORY_MIN_REVISIONS),
  ]);
  if (!retention) {
    await writeReport(env, "retention", false, { reason: "shared-settings-unreadable" }, now);
    return;
  }
  const snapshots = await listSnapshots(env);
  const monthlyKept = new Set<string>();
  let deleted = 0;
  for (const snapshot of snapshots) {
    const age = now - snapshot.createdAt;
    const keep =
      snapshot.origin === "device"
        ? age <= retention.deviceDays * DAY_MS
        : age <= retention.dailyDays * DAY_MS ||
          keepMonthly(snapshot.createdAt, retention.monthlyMonths, now, monthlyKept);
    if (keep) continue;
    await env.BUCKET.delete(snapshotKey(snapshot.id));
    deleted += 1;
  }
  await writeReport(env, "retention", true, { deletedSnapshots: deleted }, now);
}

export type MaintenanceStep = { kind: string; run: (env: Env) => Promise<void> };

export async function runMaintenance(env: Env, steps: MaintenanceStep[]): Promise<void> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.run(env);
    } catch (error) {
      failed.push(step.kind);
      const name = error instanceof Error ? error.name : "unknown";
      console.log(JSON.stringify({ message: "maintenance", kind: step.kind, name }));
      try {
        await writeReport(env, step.kind, false, { reason: "failed", error: name }, Date.now());
      } catch {}
    }
  }
  if (failed.length > 0) throw new Error(`Maintenance failed: ${failed.join(", ")}`);
}

export async function runGarbageCollection(env: Env, now = Date.now()): Promise<void> {
  const existing = await env.DB.prepare(
    "SELECT sha256, marked_at FROM gc_candidates LIMIT 1000",
  ).all<{
    sha256: string;
    marked_at: number;
  }>();
  if (existing.results.length > 0) {
    const started = Date.now();
    await env.DB.prepare("UPDATE counters SET value = ? WHERE name = 'maintenance'")
      .bind(now)
      .run();
    const referenced = await snapshotSha256s(env);
    const deleting: string[] = [];
    for (const candidate of existing.results) {
      if (Date.now() - started > SWEEP_BUDGET_MS) break;
      if (referenced.has(candidate.sha256)) {
        await env.DB.prepare("DELETE FROM gc_candidates WHERE sha256 = ?")
          .bind(candidate.sha256)
          .run();
        continue;
      }
      const removed = await env.DB.prepare(
        `DELETE FROM objects
            WHERE sha256 = ?1
              AND last_referenced_at < ?2
              AND NOT EXISTS (SELECT 1 FROM files WHERE sha256 = ?1)
              AND NOT EXISTS (SELECT 1 FROM history WHERE sha256 = ?1)
              AND NOT EXISTS (
                SELECT 1 FROM conflicts
                 WHERE resolved_at IS NULL AND ?1 IN (base_sha, local_sha, remote_sha)
              )`,
      )
        .bind(candidate.sha256, candidate.marked_at)
        .run();
      await env.DB.prepare("DELETE FROM gc_candidates WHERE sha256 = ?")
        .bind(candidate.sha256)
        .run();
      if ((removed.meta?.changes ?? 0) === 1) deleting.push(objectKey(candidate.sha256));
    }
    for (let index = 0; index < deleting.length; index += 1000) {
      await env.BUCKET.delete(deleting.slice(index, index + 1000));
    }
    const remaining = await count(env, "SELECT COUNT(*) AS n FROM gc_candidates");
    const orphans = await deleteOrphanObjects(env, now);
    if (remaining === 0) {
      await env.DB.prepare("UPDATE counters SET value = 0 WHERE name = 'maintenance'").run();
    }
    const result = { deleted: deleting.length + orphans, remaining, complete: remaining === 0 };
    await writeReport(env, "gc", true, result, now);
    return;
  }
  const cutoff = now - GC_MIN_AGE_MS;
  await env.DB.prepare(
    `INSERT INTO gc_candidates (sha256, marked_at)
       SELECT sha256, ?1 FROM objects o
        WHERE o.created_at < ?2
          AND o.last_referenced_at < ?2
          AND NOT EXISTS (SELECT 1 FROM files WHERE sha256 = o.sha256)
          AND NOT EXISTS (SELECT 1 FROM history WHERE sha256 = o.sha256)
          AND NOT EXISTS (
            SELECT 1 FROM conflicts
             WHERE resolved_at IS NULL AND o.sha256 IN (base_sha, local_sha, remote_sha)
          )`,
  )
    .bind(now, cutoff)
    .run();
  await forgetSnapshotCandidates(env);
  await deleteStaleStaging(env, now);
  await env.DB.prepare("UPDATE counters SET value = ? WHERE name = 'maintenance'").bind(now).run();
  let orphans = 0;
  try {
    orphans = await deleteOrphanObjects(env, now);
  } finally {
    await env.DB.prepare("UPDATE counters SET value = 0 WHERE name = 'maintenance'").run();
  }
  const marked = await count(env, "SELECT COUNT(*) AS n FROM gc_candidates");
  await writeReport(env, "gc", true, { phase: "mark", orphans, marked }, now);
}

export async function runIntegrityCheck(
  env: Env,
  now = Date.now(),
  budgetMs = INTEGRITY_BUDGET_MS,
): Promise<void> {
  const missingLedger = await count(
    env,
    `SELECT COUNT(*) AS n FROM (
       SELECT sha256 FROM files WHERE sha256 IS NOT NULL
       UNION SELECT sha256 FROM history WHERE sha256 IS NOT NULL
     ) refs
     WHERE NOT EXISTS (SELECT 1 FROM objects o WHERE o.sha256 = refs.sha256 AND o.status = 'verified')`,
  );
  const duplicateKeys = await count(
    env,
    "SELECT COUNT(*) AS n FROM (SELECT path_key FROM files WHERE deleted = 0 GROUP BY path_key HAVING COUNT(*) > 1)",
  );
  const duplicateSeq = await count(
    env,
    "SELECT COUNT(*) AS n FROM (SELECT seq FROM files GROUP BY seq HAVING COUNT(*) > 1)",
  );
  const missingHistory = await count(
    env,
    `SELECT COUNT(*) AS n FROM files f
      WHERE NOT EXISTS (SELECT 1 FROM history h WHERE h.path = f.path AND h.rev = f.rev)`,
  );
  const seqRegression = await count(
    env,
    `SELECT COUNT(*) AS n FROM files newer
      WHERE EXISTS (
        SELECT 1 FROM files older
         WHERE older.updated_at < newer.updated_at
           AND older.seq > newer.seq
      )`,
  );
  const ledger = await env.DB.prepare("SELECT sha256, size, status FROM objects").all<{
    sha256: string;
    size: number;
    status: string;
  }>();
  const ledgerKeys = new Set(ledger.results.map((row) => objectKey(row.sha256)));
  const verifiedKeys = new Set(
    ledger.results.filter((row) => row.status === "verified").map((row) => objectKey(row.sha256)),
  );
  const progress = await readIntegrityProgress(env);
  let cursor = progress?.r2Cursor;
  let matchedLedger = progress?.matchedLedger ?? 0;
  let orphanInR2 = progress?.orphanInR2 ?? 0;
  let r2Bytes = progress?.r2Bytes ?? 0;
  const started = Date.now();
  let finished = false;
  for (;;) {
    if (Date.now() - started >= budgetMs) break;
    const page = await env.BUCKET.list({ cursor, limit: 1000 });
    for (const object of page.objects) {
      r2Bytes += object.size;
      if (!object.key.startsWith("objects/")) continue;
      if (verifiedKeys.has(object.key)) matchedLedger += 1;
      else if (!ledgerKeys.has(object.key)) orphanInR2 += 1;
    }
    if (!page.truncated) {
      finished = true;
      break;
    }
    cursor = page.cursor;
  }
  if (!finished) {
    await writeReport(
      env,
      "integrity",
      true,
      { complete: false, r2Cursor: cursor, matchedLedger, orphanInR2, r2Bytes },
      now,
    );
    return;
  }
  const missingInR2 = Math.max(verifiedKeys.size - matchedLedger, 0);
  const sizeRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM files").all();
  const d1Bytes = sizeRow.meta?.size_after ?? 0;
  const ownership = await referenceBytes(env);
  const ok =
    missingLedger +
      duplicateKeys +
      duplicateSeq +
      seqRegression +
      missingHistory +
      missingInR2 +
      orphanInR2 ===
    0;
  const result = {
    missingInLedger: missingLedger,
    missingInR2,
    orphanInR2,
    duplicatePathKeys: duplicateKeys,
    duplicateSeq,
    seqRegression,
    missingHistory,
    snapshotOnlyBytes: ownership.snapshotOnlyBytes,
    historyOnlyBytes: ownership.historyOnlyBytes,
    d1Bytes,
    r2Bytes,
    d1Level: d1Bytes >= D1_WARNING_BYTES ? "warning" : d1Bytes >= D1_NOTICE_BYTES ? "notice" : "ok",
    r2Level: r2Bytes >= R2_NOTICE_BYTES ? "notice" : "ok",
    complete: true,
  };
  await writeReport(env, "integrity", ok, result, now);
  await writeReport(
    env,
    "storage",
    true,
    {
      d1Bytes,
      r2Bytes,
      d1Level: result.d1Level,
      r2Level: result.r2Level,
      snapshotOnlyBytes: ownership.snapshotOnlyBytes,
      historyOnlyBytes: ownership.historyOnlyBytes,
    },
    now,
  );
}

async function deleteOrphanObjects(env: Env, now: number): Promise<number> {
  const rows = await env.DB.prepare("SELECT sha256 FROM objects").all<{ sha256: string }>();
  const ledger = new Set(rows.results.map((row) => objectKey(row.sha256)));
  const orphans: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: "objects/", cursor, limit: 1000 });
    for (const object of page.objects) {
      if (ledger.has(object.key)) continue;
      if (now - object.uploaded.getTime() < ORPHAN_MIN_AGE_MS) continue;
      orphans.push(object.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let index = 0; index < orphans.length; index += 1000) {
    await env.BUCKET.delete(orphans.slice(index, index + 1000));
  }
  return orphans.length;
}

async function deleteStaleStaging(env: Env, now: number): Promise<void> {
  const stale: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: STAGING_PREFIX, cursor, limit: 1000 });
    for (const object of page.objects) {
      if (now - object.uploaded.getTime() >= STAGING_MAX_AGE_MS) stale.push(object.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let index = 0; index < stale.length; index += 1000) {
    await env.BUCKET.delete(stale.slice(index, index + 1000));
  }
}

async function forgetSnapshotCandidates(env: Env): Promise<void> {
  for (const chunk of chunks([...(await snapshotSha256s(env))])) {
    await env.DB.prepare(
      `DELETE FROM gc_candidates WHERE sha256 IN (${placeholders(chunk.length)})`,
    )
      .bind(...chunk)
      .run();
  }
}

async function referenceBytes(
  env: Env,
): Promise<{ snapshotOnlyBytes: number; historyOnlyBytes: number }> {
  const files = await env.DB.prepare(
    "SELECT DISTINCT sha256 FROM files WHERE sha256 IS NOT NULL",
  ).all<{ sha256: string }>();
  const history = await env.DB.prepare(
    "SELECT DISTINCT sha256 FROM history WHERE sha256 IS NOT NULL",
  ).all<{ sha256: string }>();
  const objects = await env.DB.prepare(
    "SELECT sha256, size FROM objects WHERE status = 'verified'",
  ).all<{ sha256: string; size: number }>();
  const snapshots = await snapshotSha256s(env);
  const fileSet = new Set(files.results.map((row) => row.sha256));
  const historySet = new Set(history.results.map((row) => row.sha256));
  let snapshotOnlyBytes = 0;
  let historyOnlyBytes = 0;
  for (const row of objects.results) {
    const inFiles = fileSet.has(row.sha256);
    const inHistory = historySet.has(row.sha256);
    const inSnapshots = snapshots.has(row.sha256);
    if (inSnapshots && !inFiles && !inHistory) snapshotOnlyBytes += row.size;
    if (inHistory && !inFiles && !inSnapshots) historyOnlyBytes += row.size;
  }
  return { snapshotOnlyBytes, historyOnlyBytes };
}

async function readIntegrityProgress(env: Env): Promise<{
  r2Cursor?: string;
  matchedLedger: number;
  orphanInR2: number;
  r2Bytes: number;
} | null> {
  const row = await env.DB.prepare(
    "SELECT result FROM maintenance_reports WHERE kind = 'integrity'",
  ).first<{ result: string }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.result) as {
      complete?: boolean;
      r2Cursor?: string;
      matchedLedger?: number;
      orphanInR2?: number;
      r2Bytes?: number;
    };
    if (parsed.complete !== false) return null;
    return {
      ...(parsed.r2Cursor ? { r2Cursor: parsed.r2Cursor } : {}),
      matchedLedger: parsed.matchedLedger ?? 0,
      orphanInR2: parsed.orphanInR2 ?? 0,
      r2Bytes: parsed.r2Bytes ?? 0,
    };
  } catch {
    return null;
  }
}

function keepMonthly(createdAt: number, months: number, now: number, kept: Set<string>): boolean {
  const created = new Date(createdAt);
  const limit = new Date(now);
  limit.setUTCMonth(limit.getUTCMonth() - months);
  if (created < limit) return false;
  const key = `${created.getUTCFullYear()}-${created.getUTCMonth()}`;
  if (kept.has(key)) return false;
  kept.add(key);
  return true;
}

async function count(env: Env, sql: string): Promise<number> {
  const row = await env.DB.prepare(sql).first<{ n: number }>();
  return row?.n ?? 0;
}

async function writeReport(
  env: Env,
  kind: string,
  ok: boolean,
  result: Record<string, unknown>,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO maintenance_reports (kind, ran_at, ok, result) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind) DO UPDATE SET ran_at = excluded.ran_at, ok = excluded.ok, result = excluded.result`,
  )
    .bind(kind, now, ok ? 1 : 0, JSON.stringify(result))
    .run();
}
