import { type ApiErrorBody, apiError } from "@obsttorte/shared/errors";
import { isSha256 } from "@obsttorte/shared/hash";
import { COMMIT_MAX_CHANGES } from "@obsttorte/shared/limits";
import { isValidPath, toPathKey } from "@obsttorte/shared/path";
import {
  type CommitRejection,
  type CommitRequest,
  type CommitResponse,
  type FileChange,
  isContentChange,
} from "@obsttorte/shared/types";
import type { Context } from "hono";
import { chunks, many, one, placeholders, run, track } from "./db";
import type { AppEnv } from "./env";
import { verifiedRow } from "./objects";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CommitResult = { status: 200 | 400 | 409; body: CommitResponse | ApiErrorBody };

type StoredRequest = { device: string; response: string | null };

export async function commitChanges(
  c: Context<AppEnv>,
  request: CommitRequest,
  now = Date.now(),
): Promise<CommitResult> {
  const invalid = validateCommit(request);
  if (invalid) return { status: 400, body: invalid };
  const deviceId = c.get("device").id;
  const existing = await readStoredRequest(c, request.requestId);
  if (existing) return storedResult(c, existing, request, deviceId);

  const prepared = await prepareChanges(c, request.changes);
  if (prepared.included.length === 0) {
    const seq = await currentSeq(c);
    const body: CommitResponse = { seq, applied: [], rejected: prepared.rejected };
    try {
      const saved = await c.env.DB.batch([
        c.env.DB.prepare("INSERT INTO requests (id, device, created_at) VALUES (?, ?, ?)").bind(
          request.requestId,
          deviceId,
          now,
        ),
        c.env.DB.prepare("UPDATE requests SET response = ? WHERE id = ?").bind(
          JSON.stringify(body),
          request.requestId,
        ),
      ]);
      track(c, saved);
    } catch {
      return afterRace(c, request, deviceId);
    }
    return { status: 200, body };
  }

  const statements = buildStatements(c, prepared.included, deviceId, request.requestId, now);
  let results: D1Result[];
  try {
    results = await c.env.DB.batch(statements);
  } catch {
    return afterRace(c, request, deviceId);
  }
  track(c, results);

  const appliedFlags = prepared.included.map((_, index) => {
    const update = results[1 + index * 4 + 1];
    const insert = results[1 + index * 4 + 2];
    return (update?.meta?.changes ?? 0) > 0 || (insert?.meta?.changes ?? 0) > 0;
  });
  const appliedRows = await many<{ path: string; rev: number; seq: number }>(
    c,
    c.env.DB.prepare("SELECT path, rev, seq FROM files WHERE request_id = ?").bind(
      request.requestId,
    ),
  );
  const appliedByPath = new Map(appliedRows.map((row) => [row.path, row]));
  const applied = prepared.included.flatMap((change, index) => {
    if (!appliedFlags[index]) return [];
    const row = appliedByPath.get(change.path);
    return row ? [{ path: row.path, rev: row.rev, seq: row.seq }] : [];
  });
  const rejected = [...prepared.rejected];
  for (const [index, change] of prepared.included.entries()) {
    if (!appliedFlags[index]) rejected.push(await rejectionFor(c, change));
  }
  const body: CommitResponse = { seq: await currentSeq(c), applied, rejected };
  await run(
    c,
    c.env.DB.prepare("UPDATE requests SET response = ? WHERE id = ?").bind(
      JSON.stringify(body),
      request.requestId,
    ),
  );
  return { status: 200, body };
}

function validateCommit(request: CommitRequest): ApiErrorBody | null {
  if (!request || !UUID_PATTERN.test(request.requestId ?? "")) {
    return apiError("invalid_request", "requestId must be a UUID");
  }
  if (
    !Array.isArray(request.changes) ||
    request.changes.length === 0 ||
    request.changes.length > COMMIT_MAX_CHANGES
  ) {
    return apiError("invalid_request", "changes must contain 1 to 200 items");
  }
  const paths = new Set<string>();
  for (const change of request.changes) {
    if (!change || typeof change.path !== "string" || paths.has(change.path)) {
      return apiError("invalid_request", "changes contain a duplicate or missing path");
    }
    paths.add(change.path);
    if (!Number.isInteger(change.expectedRev) || change.expectedRev < 0) {
      return apiError("invalid_request", "expectedRev is invalid");
    }
    if (
      isContentChange(change) &&
      (!isSha256(change.sha256) || !Number.isInteger(change.size) || change.size < 0)
    ) {
      return apiError("invalid_request", "sha256 or size is invalid");
    }
    if (!isContentChange(change) && change.deleted !== true) {
      return apiError("invalid_request", "change must include content or deleted");
    }
  }
  return null;
}

async function prepareChanges(
  c: Context<AppEnv>,
  changes: FileChange[],
): Promise<{ included: FileChange[]; rejected: CommitRejection[] }> {
  const ordered = [...changes].sort(
    (left, right) => Number(isContentChange(left)) - Number(isContentChange(right)),
  );
  const rejected: CommitRejection[] = [];
  const candidates: FileChange[] = [];
  for (const change of ordered) {
    if (isValidPath(change.path)) candidates.push(change);
    else rejected.push(rejection(change.path, "invalidPath"));
  }
  const live = new Map<string, string>();
  const keys = [
    ...new Set(candidates.filter(isContentChange).map((change) => toPathKey(change.path))),
  ];
  for (const chunk of chunks(keys)) {
    const rows = await many<{ path: string; path_key: string }>(
      c,
      c.env.DB.prepare(
        `SELECT path, path_key FROM files WHERE deleted = 0 AND path_key IN (${placeholders(chunk.length)})`,
      ).bind(...chunk),
    );
    for (const row of rows) live.set(row.path_key, row.path);
  }
  const included: FileChange[] = [];
  for (const change of candidates) {
    if (!isContentChange(change)) {
      for (const [key, path] of [...live]) {
        if (path === change.path) live.delete(key);
      }
      included.push(change);
      continue;
    }
    const key = toPathKey(change.path);
    const owner = live.get(key);
    if (owner && owner !== change.path) {
      rejected.push(rejection(change.path, "pathCollision"));
      continue;
    }
    live.set(key, change.path);
    included.push(change);
  }
  return { included, rejected };
}

function buildStatements(
  c: Context<AppEnv>,
  changes: FileChange[],
  deviceId: string,
  requestId: string,
  now: number,
): D1PreparedStatement[] {
  const db = c.env.DB;
  const statements: D1PreparedStatement[] = [
    db
      .prepare("INSERT INTO requests (id, device, created_at) VALUES (?, ?, ?)")
      .bind(requestId, deviceId, now),
  ];
  for (const change of changes) {
    const content = isContentChange(change);
    const sha256 = content ? change.sha256 : null;
    const size = content ? change.size : 0;
    const deleted = content ? 0 : 1;
    const pathKey = toPathKey(change.path);
    statements.push(db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'seq'"));
    statements.push(
      db
        .prepare(
          `UPDATE files
              SET sha256 = ?3, size = ?4, deleted = ?5, rev = rev + 1,
                  seq = (SELECT value FROM counters WHERE name = 'seq'),
                  path_key = ?2, updated_at = ?6, device = ?7, request_id = ?8
            WHERE path = ?1
              AND rev = ?9
              AND (?5 = 1 OR EXISTS (SELECT 1 FROM objects WHERE sha256 = ?3 AND size = ?4 AND status = 'verified'))`,
        )
        .bind(
          change.path,
          pathKey,
          sha256,
          size,
          deleted,
          now,
          deviceId,
          requestId,
          change.expectedRev,
        ),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO files (path, path_key, sha256, size, deleted, rev, seq, updated_at, device, request_id)
           SELECT ?1, ?2, ?3, ?4, 0, 1, (SELECT value FROM counters WHERE name = 'seq'), ?6, ?7, ?8
            WHERE ?9 = 0
              AND ?5 = 0
              AND NOT EXISTS (SELECT 1 FROM files WHERE path = ?1)
              AND EXISTS (SELECT 1 FROM objects WHERE sha256 = ?3 AND size = ?4 AND status = 'verified')`,
        )
        .bind(
          change.path,
          pathKey,
          sha256,
          size,
          deleted,
          now,
          deviceId,
          requestId,
          change.expectedRev,
        ),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO history (path, sha256, size, rev, seq, deleted, changed_at, device, request_id)
           SELECT path, sha256, size, rev, seq, deleted, updated_at, device, request_id
             FROM files
            WHERE path = ?1
              AND request_id = ?2
              AND seq = (SELECT value FROM counters WHERE name = 'seq')`,
        )
        .bind(change.path, requestId),
    );
  }
  const sha256s = [...new Set(changes.filter(isContentChange).map((change) => change.sha256))];
  for (const chunk of chunks(sha256s)) {
    const marks = placeholders(chunk.length);
    statements.push(
      db
        .prepare(
          `UPDATE objects SET last_referenced_at = ? WHERE status = 'verified' AND sha256 IN (${marks})`,
        )
        .bind(now, ...chunk),
      db.prepare(`DELETE FROM gc_candidates WHERE sha256 IN (${marks})`).bind(...chunk),
    );
  }
  return statements;
}

function rejection(
  path: string,
  reason: CommitRejection["reason"],
  current: { rev: number | null; sha256: string | null } = { rev: null, sha256: null },
): CommitRejection {
  return { path, reason, currentRev: current.rev, currentSha256: current.sha256 };
}

async function currentFile(
  c: Context<AppEnv>,
  path: string,
): Promise<{ rev: number | null; sha256: string | null }> {
  const row = await one<{ rev: number; sha256: string | null }>(
    c,
    c.env.DB.prepare("SELECT rev, sha256 FROM files WHERE path = ?").bind(path),
  );
  return { rev: row?.rev ?? null, sha256: row?.sha256 ?? null };
}

async function rejectionFor(c: Context<AppEnv>, change: FileChange): Promise<CommitRejection> {
  const current = await currentFile(c, change.path);
  if (current.rev === null) {
    const missing =
      isContentChange(change) &&
      change.expectedRev === 0 &&
      (await verifiedRow(c, change.sha256))?.size !== change.size;
    return rejection(change.path, missing ? "missingObject" : "revMismatch", current);
  }
  const reason = current.rev === change.expectedRev ? "missingObject" : "revMismatch";
  return rejection(change.path, reason, current);
}

async function afterRace(
  c: Context<AppEnv>,
  request: CommitRequest,
  deviceId: string,
): Promise<CommitResult> {
  const raced = await readStoredRequest(c, request.requestId);
  if (raced) return storedResult(c, raced, request, deviceId);
  return { status: 409, body: apiError("conflict", "Commit could not be applied") };
}

async function readStoredRequest(
  c: Context<AppEnv>,
  requestId: string,
): Promise<StoredRequest | null> {
  return one(
    c,
    c.env.DB.prepare("SELECT device, response FROM requests WHERE id = ?").bind(requestId),
  );
}

async function storedResult(
  c: Context<AppEnv>,
  stored: StoredRequest,
  request: CommitRequest,
  deviceId: string,
): Promise<CommitResult> {
  if (stored.device !== deviceId)
    return { status: 409, body: apiError("conflict", "requestId belongs to another device") };
  if (stored.response) return { status: 200, body: JSON.parse(stored.response) as CommitResponse };
  const applied = await many<{ path: string; rev: number; seq: number }>(
    c,
    c.env.DB.prepare(
      "SELECT path, rev, seq FROM history WHERE request_id = ? ORDER BY seq ASC",
    ).bind(request.requestId),
  );
  const appliedPaths = new Set(applied.map((row) => row.path));
  const rejected: CommitRejection[] = [];
  for (const change of request.changes) {
    if (appliedPaths.has(change.path)) continue;
    rejected.push(rejection(change.path, "revMismatch", await currentFile(c, change.path)));
  }
  return { status: 200, body: { seq: await currentSeq(c), applied, rejected } };
}

async function currentSeq(c: Context<AppEnv>): Promise<number> {
  const row = await one<{ value: number }>(
    c,
    c.env.DB.prepare("SELECT value FROM counters WHERE name = 'seq'"),
  );
  return row?.value ?? 0;
}
