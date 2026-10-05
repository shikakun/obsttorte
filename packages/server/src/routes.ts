import {
  ACCESS_TOKEN_WARNING_MS,
  API_VERSION,
  apiError,
  COMMIT_MAX_CHANGES,
  EXISTS_MAX_SHA256S,
  type FileChange,
  INDEX_PAGE_SIZE,
  isSha256,
  isValidPath,
  type LogHighlight,
  MIN_SUPPORTED_API_VERSION,
  PURGE_TOKEN_TTL_MS,
  sha256Hex,
  toHex,
} from "@obsttorte/shared";
import type { Context, Hono } from "hono";
import { commitChanges } from "./commit";
import { chunks, many, one, placeholders, run } from "./db";
import type { AppEnv, Env } from "./env";
import {
  completeUpload,
  createUpload,
  getObject,
  headObject,
  objectKey,
  putObject,
  uploadPart,
  verifiedShaSet,
} from "./objects";
import {
  listSnapshots,
  readSnapshot,
  removeFromSnapshots,
  SNAPSHOT_ID_PATTERN,
  snapshotKey,
} from "./snapshots";

type PurgeTarget = { paths: string[]; sha256s: string[]; directSha256s?: string[] };

export function registerContentRoutes(app: Hono<AppEnv>): void {
  app.get("/api/health", async (c) => {
    const reports = await many<{ kind: string; ran_at: number; ok: number; result: string }>(
      c,
      c.env.DB.prepare("SELECT kind, ran_at, ok, result FROM maintenance_reports"),
    );
    const expiresAt = c.env.ACCESS_TOKEN_EXPIRES_AT || null;
    const expiresMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    return c.json({
      api: { min: MIN_SUPPORTED_API_VERSION, max: API_VERSION },
      reports: reports.map((row) => ({
        kind: row.kind,
        ranAt: row.ran_at,
        ok: row.ok === 1,
        result: parseReport(row.result),
      })),
      accessTokenExpiresAt: expiresAt,
      accessTokenWarning:
        Number.isFinite(expiresMs) && expiresMs - Date.now() < ACCESS_TOKEN_WARNING_MS,
      deviceId: c.get("device").id,
      deviceName: c.get("device").name,
    });
  });

  app.get("/api/devices", async (c) => {
    const rows = await many<{
      id: string;
      name: string;
      created_at: number;
      revoked_at: number | null;
      last_seen_at: number | null;
      last_api_version: number | null;
    }>(
      c,
      c.env.DB.prepare(
        "SELECT id, name, created_at, revoked_at, last_seen_at, last_api_version FROM devices WHERE revoked_at IS NULL ORDER BY created_at",
      ),
    );
    return c.json(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
        lastSeenAt: row.last_seen_at,
        lastApiVersion: row.last_api_version,
      })),
    );
  });

  app.get("/api/index", async (c) => {
    const since = Number(c.req.query("since") ?? "0");
    if (!Number.isInteger(since)) return invalidRequest(c, "since is invalid");
    const rows = await many<{
      path: string;
      sha256: string | null;
      size: number;
      rev: number;
      seq: number;
      deleted: number;
      updated_at: number;
    }>(
      c,
      c.env.DB.prepare(
        "SELECT path, sha256, size, rev, seq, deleted, updated_at FROM files WHERE seq > ? ORDER BY seq ASC LIMIT ?",
      ).bind(since, INDEX_PAGE_SIZE + 1),
    );
    return c.json({
      seq: await currentSeq(c),
      truncated: rows.length > INDEX_PAGE_SIZE,
      entries: rows.slice(0, INDEX_PAGE_SIZE).map((row) => ({
        path: row.path,
        sha256: row.sha256,
        size: row.size,
        rev: row.rev,
        seq: row.seq,
        deleted: row.deleted === 1,
        updatedAt: row.updated_at,
      })),
    });
  });

  app.post("/api/objects/exists", async (c) => {
    const body = await readJson<{ sha256s?: string[] }>(c);
    if (body instanceof Response) return body;
    const sha256s = body.sha256s ?? [];
    if (sha256s.length === 0 || sha256s.length > EXISTS_MAX_SHA256S || !sha256s.every(isSha256)) {
      return invalidRequest(c, "sha256s is invalid");
    }
    const found = await verifiedShaSet(c, sha256s);
    return c.json({ sha256s: sha256s.filter((sha) => found.has(sha)) });
  });

  app.on("HEAD", "/api/objects/:sha256", (c) => headObject(c, c.req.param("sha256")));
  app.get("/api/objects/:sha256", (c) => getObject(c, c.req.param("sha256")));
  app.put("/api/objects/:sha256", (c) => putObject(c, c.req.param("sha256")));
  app.post("/api/uploads", async (c) => {
    const body = await readJson<{ sha256?: string; size?: number }>(c);
    if (body instanceof Response) return body;
    return createUpload(c, body.sha256 ?? "", body.size ?? Number.NaN);
  });
  app.put("/api/uploads/:uploadId/parts/:partNumber", (c) =>
    uploadPart(c, c.req.param("uploadId"), Number(c.req.param("partNumber"))),
  );
  app.post("/api/uploads/:uploadId/complete", (c) => completeUpload(c, c.req.param("uploadId")));

  app.post("/api/commit", async (c) => {
    const body = await readJson<Parameters<typeof commitChanges>[1]>(c);
    if (body instanceof Response) return body;
    const result = await commitChanges(c, body);
    return c.json(result.body, result.status);
  });

  app.post("/api/history", async (c) => {
    const body = await readJson<{ path?: string; limit?: number }>(c);
    if (body instanceof Response) return body;
    const limit = body.limit ?? 0;
    if (typeof body.path !== "string" || !Number.isInteger(limit) || limit <= 0 || limit > 200) {
      return invalidRequest(c, "history request is invalid");
    }
    if (!isValidPath(body.path)) return invalidPath(c);
    const rows = await many<HistoryRow>(
      c,
      c.env.DB.prepare(`${HISTORY_SELECT} WHERE h.path = ? ORDER BY h.rev DESC LIMIT ?`).bind(
        body.path,
        limit,
      ),
    );
    return c.json(rows.map(toHistoryEntry));
  });

  app.get("/api/log", async (c) => {
    const since = Number(c.req.query("since") ?? "0");
    const limit = Number(c.req.query("limit") ?? "100");
    if (!Number.isInteger(since) || !Number.isInteger(limit) || limit <= 0 || limit > 500) {
      return invalidRequest(c, "log query is invalid");
    }
    const rows = await many<HistoryRow>(
      c,
      c.env.DB.prepare(`${HISTORY_SELECT} WHERE h.seq > ? ORDER BY h.seq ASC LIMIT ?`).bind(
        since,
        limit + 1,
      ),
    );
    const page = rows.slice(0, limit);
    const flags = highlights(page);
    return c.json({
      truncated: rows.length > limit,
      entries: page.map((row, index) => ({
        ...toHistoryEntry(row),
        highlight: flags[index] ?? [],
      })),
    });
  });

  app.get("/api/snapshots", async (c) => c.json(await listSnapshots(c.env)));
  app.get("/api/snapshots/:id", async (c) => {
    const id = c.req.param("id");
    if (!SNAPSHOT_ID_PATTERN.test(id)) return invalidRequest(c, "Snapshot id is invalid");
    const document = await readSnapshot(c.env, id);
    if (!document) return c.json(apiError("invalid_request", "Snapshot was not found"), 404);
    return c.json(document);
  });
  app.post("/api/snapshots", async (c) => {
    const body = await readJson<{ files?: Record<string, { sha256?: string; size?: number }> }>(c);
    if (body instanceof Response) return body;
    const files = body.files ?? {};
    const entries = Object.entries(files);
    for (const [path, file] of entries) {
      if (!isValidPath(path)) return invalidPath(c);
      if (!file || !isSha256(file.sha256 ?? "") || !Number.isInteger(file.size)) {
        return invalidRequest(c, "Snapshot file is invalid");
      }
    }
    const sha256s = entries.map(([, file]) => file.sha256 ?? "");
    const found = await verifiedShaSet(c, sha256s);
    if (!sha256s.every((sha) => found.has(sha))) {
      return invalidRequest(c, "Snapshot references a missing object");
    }
    const id = `${Date.now()}-device-${c.get("device").id}`;
    await c.env.BUCKET.put(snapshotKey(id), JSON.stringify({ files }));
    return c.json({ id });
  });
  app.post("/api/restore", async (c) => {
    const body = await readJson<{ snapshotId?: string; paths?: string[] }>(c);
    if (body instanceof Response) return body;
    if (!body.snapshotId || !SNAPSHOT_ID_PATTERN.test(body.snapshotId)) {
      return invalidRequest(c, "snapshotId is invalid");
    }
    if (body.paths && !body.paths.every(isValidPath)) return invalidPath(c);
    const document = await readSnapshot(c.env, body.snapshotId);
    if (!document) return c.json(apiError("invalid_request", "Snapshot was not found"), 404);
    const selected = body.paths ? new Set(body.paths) : null;
    const current = await many<{ path: string; rev: number; deleted: number }>(
      c,
      c.env.DB.prepare("SELECT path, rev, deleted FROM files"),
    );
    const revByPath = new Map(current.map((row) => [row.path, row.rev]));
    const changes: FileChange[] = [];
    for (const [path, file] of Object.entries(document.files)) {
      if (selected && !selected.has(path)) continue;
      changes.push({
        path,
        sha256: file.sha256,
        size: file.size,
        expectedRev: revByPath.get(path) ?? 0,
      });
    }
    if (!selected) {
      for (const row of current) {
        if (row.deleted === 0 && !document.files[row.path]) {
          changes.push({ path: row.path, deleted: true, expectedRev: row.rev });
        }
      }
    }
    const applied = [];
    const rejected = [];
    let seq = 0;
    for (const chunk of chunks(changes, COMMIT_MAX_CHANGES)) {
      const result = await commitChanges(c, { requestId: crypto.randomUUID(), changes: chunk });
      if (result.status !== 200 || !("applied" in result.body)) {
        return c.json(result.body, result.status);
      }
      applied.push(...result.body.applied);
      rejected.push(...result.body.rejected);
      seq = result.body.seq;
    }
    return c.json({ seq, applied, rejected });
  });

  app.get("/api/conflicts", async (c) => {
    const rows = await many<ConflictRow>(
      c,
      c.env.DB.prepare(
        `SELECT c.id, c.path, c.base_sha, c.local_sha, c.remote_sha, c.device, c.created_at, c.resolved_at, c.resolved_sha, d.name AS device_name,
                COALESCE(
                  (SELECT MAX(h.changed_at) FROM history h WHERE h.path = c.path AND h.sha256 = c.local_sha),
                  lo.created_at
                ) AS local_updated_at,
                COALESCE(
                  (SELECT MAX(h.changed_at) FROM history h WHERE h.path = c.path AND h.sha256 = c.remote_sha),
                  f.updated_at
                ) AS remote_updated_at
             FROM conflicts c
             LEFT JOIN devices d ON d.id = c.device
             LEFT JOIN objects lo ON lo.sha256 = c.local_sha
             LEFT JOIN files f ON f.path = c.path
            WHERE c.resolved_at IS NULL ORDER BY c.created_at ASC`,
      ),
    );
    return c.json(rows.map(toConflict));
  });
  app.post("/api/conflicts", async (c) => {
    const body = await readJson<{
      path?: string;
      baseSha?: string | null;
      localSha?: string;
      remoteSha?: string;
    }>(c);
    if (body instanceof Response) return body;
    const baseSha = body.baseSha ?? null;
    if (
      !body.path ||
      !isSha256(body.localSha ?? "") ||
      !isSha256(body.remoteSha ?? "") ||
      (baseSha !== null && !isSha256(baseSha))
    ) {
      return invalidRequest(c, "Conflict is invalid");
    }
    if (!isValidPath(body.path)) return invalidPath(c);
    const device = c.get("device");
    const conflict = {
      id: crypto.randomUUID(),
      path: body.path,
      baseSha,
      localSha: body.localSha ?? "",
      remoteSha: body.remoteSha ?? "",
      deviceId: device.id,
      deviceName: device.name,
      createdAt: Date.now(),
      resolvedAt: null,
      resolvedSha: null,
    };
    await run(
      c,
      c.env.DB.prepare(
        "INSERT INTO conflicts (id, path, base_sha, local_sha, remote_sha, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        conflict.id,
        conflict.path,
        conflict.baseSha,
        conflict.localSha,
        conflict.remoteSha,
        conflict.deviceId,
        conflict.createdAt,
      ),
    );
    return c.json(conflict);
  });
  app.post("/api/conflicts/:id/resolve", async (c) => {
    const body = await readJson<{ sha256?: string; size?: number }>(c);
    if (body instanceof Response) return body;
    if (!body.sha256 || !isSha256(body.sha256) || !Number.isInteger(body.size)) {
      return invalidRequest(c, "Resolution is invalid");
    }
    const id = c.req.param("id");
    const conflict = await one<{ path: string; resolved_at: number | null }>(
      c,
      c.env.DB.prepare("SELECT path, resolved_at FROM conflicts WHERE id = ?").bind(id),
    );
    if (!conflict) return c.json(apiError("invalid_request", "Conflict was not found"), 404);
    if (conflict.resolved_at !== null) {
      return c.json(apiError("conflict", "Conflict is already resolved"), 409);
    }
    const current = await one<{ rev: number }>(
      c,
      c.env.DB.prepare("SELECT rev FROM files WHERE path = ?").bind(conflict.path),
    );
    const result = await commitChanges(c, {
      requestId: crypto.randomUUID(),
      changes: [
        {
          path: conflict.path,
          sha256: body.sha256,
          size: body.size ?? 0,
          expectedRev: current?.rev ?? 0,
        },
      ],
    });
    if (result.status !== 200 || !("applied" in result.body) || result.body.applied.length === 0) {
      return c.json(result.body, result.status === 200 ? 409 : result.status);
    }
    await run(
      c,
      c.env.DB.prepare("UPDATE conflicts SET resolved_at = ?, resolved_sha = ? WHERE id = ?").bind(
        Date.now(),
        body.sha256,
        id,
      ),
    );
    return c.json(result.body);
  });

  app.post("/api/purge/prepare", async (c) => {
    const body = await readJson<{ paths?: string[]; sha256s?: string[] }>(c);
    if (body instanceof Response) return body;
    const paths = body.paths ?? [];
    const directSha256s = body.sha256s ?? [];
    if (paths.length === 0 && directSha256s.length === 0) {
      return invalidRequest(c, "Purge target is empty");
    }
    if (!paths.every(isValidPath)) return invalidPath(c);
    if (!directSha256s.every(isSha256)) return invalidRequest(c, "sha256 is invalid");
    const sha256s = new Set(directSha256s);
    for (const chunk of chunks(paths)) {
      for (const table of ["files", "history"] as const) {
        const rows = await many<{ sha256: string }>(
          c,
          c.env.DB.prepare(
            `SELECT sha256 FROM ${table} WHERE path IN (${placeholders(chunk.length)}) AND sha256 IS NOT NULL`,
          ).bind(...chunk),
        );
        for (const row of rows) sha256s.add(row.sha256);
      }
    }
    const targetPaths = new Set(paths);
    for (const chunk of chunks(directSha256s)) {
      const rows = await many<{ path: string }>(
        c,
        c.env.DB.prepare(
          `SELECT path FROM files WHERE deleted = 0 AND sha256 IN (${placeholders(chunk.length)})`,
        ).bind(...chunk),
      );
      for (const row of rows) targetPaths.add(row.path);
    }
    const exclusive = await exclusiveSha256s(
      c.env,
      [...sha256s],
      new Set(paths),
      new Set(directSha256s),
    );
    let bytes = 0;
    for (const chunk of chunks(exclusive)) {
      const rows = await many<{ size: number }>(
        c,
        c.env.DB.prepare(
          `SELECT size FROM objects WHERE sha256 IN (${placeholders(chunk.length)}) AND status = 'verified'`,
        ).bind(...chunk),
      );
      bytes += rows.reduce((sum, row) => sum + row.size, 0);
    }
    const confirmToken = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const target: PurgeTarget = { paths: [...targetPaths], sha256s: [...sha256s], directSha256s };
    await run(
      c,
      c.env.DB.prepare(
        "INSERT INTO purge_tokens (token_hash, device, target, expires_at) VALUES (?, ?, ?, ?)",
      ).bind(
        await sha256Hex(confirmToken),
        c.get("device").id,
        JSON.stringify(target),
        Date.now() + PURGE_TOKEN_TTL_MS,
      ),
    );
    return c.json({
      confirmToken,
      fileCount: targetPaths.size,
      objectCount: exclusive.length,
      bytes,
    });
  });

  app.post("/api/purge", async (c) => {
    const body = await readJson<{ confirmToken?: string }>(c);
    if (body instanceof Response) return body;
    if (!body.confirmToken) return invalidRequest(c, "confirmToken is required");
    const tokenHash = await sha256Hex(body.confirmToken);
    const token = await one<{ device: string; target: string; expires_at: number }>(
      c,
      c.env.DB.prepare(
        "SELECT device, target, expires_at FROM purge_tokens WHERE token_hash = ?",
      ).bind(tokenHash),
    );
    if (!token || token.device !== c.get("device").id || token.expires_at < Date.now()) {
      return invalidRequest(c, "Confirmation token is invalid");
    }
    const target = JSON.parse(token.target) as PurgeTarget;
    return c.json(await purgeTarget(c.env, target, tokenHash));
  });
}

const HISTORY_SELECT = `SELECT h.path, h.sha256, h.size, h.rev, h.seq, h.deleted, h.changed_at, h.device, h.request_id, d.name AS device_name
       FROM history h LEFT JOIN devices d ON d.id = h.device`;

type HistoryRow = {
  path: string;
  sha256: string | null;
  size: number;
  rev: number;
  seq: number;
  deleted: number;
  changed_at: number;
  device: string;
  request_id: string;
  device_name: string | null;
};

type ConflictRow = {
  id: string;
  path: string;
  base_sha: string | null;
  local_sha: string;
  remote_sha: string;
  device: string;
  created_at: number;
  resolved_at: number | null;
  resolved_sha: string | null;
  device_name: string | null;
  local_updated_at: number | null;
  remote_updated_at: number | null;
};

function toHistoryEntry(row: HistoryRow) {
  return {
    path: row.path,
    sha256: row.sha256,
    size: row.size,
    rev: row.rev,
    seq: row.seq,
    deleted: row.deleted === 1,
    changedAt: row.changed_at,
    deviceId: row.device,
    deviceName: row.device_name ?? "",
    requestId: row.request_id,
  };
}

function toConflict(row: ConflictRow) {
  return {
    id: row.id,
    path: row.path,
    baseSha: row.base_sha,
    localSha: row.local_sha,
    remoteSha: row.remote_sha,
    deviceId: row.device,
    deviceName: row.device_name ?? "",
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedSha: row.resolved_sha,
    localUpdatedAt: row.local_updated_at,
    remoteUpdatedAt: row.remote_updated_at,
  };
}

const LATE_NIGHT_BULK = 50;

function highlights(rows: readonly HistoryRow[]): LogHighlight[][] {
  const nightCounts = new Map<string, number>();
  for (const row of rows) {
    if (!isLateNight(row.changed_at)) continue;
    const key = nightKey(row);
    nightCounts.set(key, (nightCounts.get(key) ?? 0) + 1);
  }
  return rows.map((row) => {
    const flags: LogHighlight[] = [];
    if (isLateNight(row.changed_at) && (nightCounts.get(nightKey(row)) ?? 0) >= LATE_NIGHT_BULK) {
      flags.push("late-night");
    }
    if (row.path.includes("/plugins/") || row.path.endsWith("community-plugins.json")) {
      flags.push("plugin-path");
    }
    if (!row.device_name) flags.push("unknown-device");
    return flags;
  });
}

function isLateNight(changedAt: number): boolean {
  return new Date(changedAt).getUTCHours() < 5;
}

function nightKey(row: HistoryRow): string {
  return `${row.device}:${new Date(row.changed_at).toISOString().slice(0, 10)}`;
}

async function readJson<T>(c: Context<AppEnv>): Promise<T | Response> {
  try {
    return await c.req.json<T>();
  } catch {
    return invalidRequest(c, "Request body must be JSON");
  }
}

function invalidRequest(c: Context<AppEnv>, message: string): Response {
  return c.json(apiError("invalid_request", message), 400);
}

function invalidPath(c: Context<AppEnv>): Response {
  return c.json(apiError("invalid_path", "Path is invalid"), 400);
}

async function currentSeq(c: Context<AppEnv>): Promise<number> {
  const row = await one<{ value: number }>(
    c,
    c.env.DB.prepare("SELECT value FROM counters WHERE name = 'seq'"),
  );
  return row?.value ?? 0;
}

function parseReport(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function exclusiveSha256s(
  env: Env,
  sha256s: string[],
  userPaths: Set<string>,
  directSha256s: Set<string>,
): Promise<string[]> {
  const shared = new Set<string>();
  for (const chunk of chunks(sha256s)) {
    for (const table of ["files", "history"] as const) {
      const rows = await env.DB.prepare(
        `SELECT sha256, path FROM ${table} WHERE sha256 IN (${placeholders(chunk.length)})`,
      )
        .bind(...chunk)
        .all<{ sha256: string; path: string }>();
      for (const row of rows.results) {
        if (!userPaths.has(row.path) && !directSha256s.has(row.sha256)) shared.add(row.sha256);
      }
    }
  }
  return sha256s.filter((sha256) => !shared.has(sha256));
}

async function purgeTarget(env: Env, target: PurgeTarget, tokenHash: string) {
  const db = env.DB;
  const statements: D1PreparedStatement[] = [];
  for (const chunk of chunks(target.paths)) {
    const marks = placeholders(chunk.length);
    statements.push(
      db
        .prepare(`DELETE FROM history WHERE sha256 IS NOT NULL AND path IN (${marks})`)
        .bind(...chunk),
      db
        .prepare(`DELETE FROM files WHERE sha256 IS NOT NULL AND path IN (${marks})`)
        .bind(...chunk),
      db.prepare(`DELETE FROM conflicts WHERE path IN (${marks})`).bind(...chunk),
    );
  }
  for (const chunk of chunks(target.directSha256s ?? [])) {
    const marks = placeholders(chunk.length);
    statements.push(
      db.prepare(`DELETE FROM history WHERE sha256 IN (${marks})`).bind(...chunk),
      db.prepare(`DELETE FROM files WHERE sha256 IN (${marks})`).bind(...chunk),
    );
  }
  const sizes = new Map<string, number>();
  for (const chunk of chunks(target.sha256s)) {
    const marks = placeholders(chunk.length);
    const rows = await db
      .prepare(`SELECT sha256, size FROM objects WHERE sha256 IN (${marks})`)
      .bind(...chunk)
      .all<{ sha256: string; size: number }>();
    for (const row of rows.results) sizes.set(row.sha256, row.size);
    statements.push(
      db.prepare(`DELETE FROM gc_candidates WHERE sha256 IN (${marks})`).bind(...chunk),
      db
        .prepare(
          `UPDATE conflicts SET base_sha = NULL WHERE resolved_at IS NULL AND base_sha IN (${marks})`,
        )
        .bind(...chunk),
      db
        .prepare(`DELETE FROM conflicts WHERE resolved_at IS NULL AND local_sha IN (${marks})`)
        .bind(...chunk),
      db
        .prepare(`DELETE FROM conflicts WHERE resolved_at IS NULL AND remote_sha IN (${marks})`)
        .bind(...chunk),
    );
  }
  const objectStart = statements.length;
  for (const sha256 of target.sha256s) {
    statements.push(
      db
        .prepare(
          `DELETE FROM objects
            WHERE sha256 = ?1
              AND NOT EXISTS (SELECT 1 FROM files WHERE sha256 = ?1)
              AND NOT EXISTS (SELECT 1 FROM history WHERE sha256 = ?1)
              AND NOT EXISTS (
                SELECT 1 FROM conflicts
                 WHERE resolved_at IS NULL AND ?1 IN (base_sha, local_sha, remote_sha)
              )`,
        )
        .bind(sha256),
    );
  }
  statements.push(db.prepare("DELETE FROM purge_tokens WHERE token_hash = ?").bind(tokenHash));
  const results = await db.batch(statements);
  const removed = target.sha256s.filter(
    (_, index) => results[objectStart + index]?.meta?.changes === 1,
  );
  if (removed.length > 0) await env.BUCKET.delete(removed.map(objectKey));
  await removeFromSnapshots(env, new Set(target.paths), new Set(removed));
  return {
    deletedObjects: removed.length,
    deletedBytes: removed.reduce((sum, sha256) => sum + (sizes.get(sha256) ?? 0), 0),
  };
}
