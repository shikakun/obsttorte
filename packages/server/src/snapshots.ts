import { parseSharedSettings } from "@obsttorte/shared/settings";
import type { SnapshotDocument, SnapshotListItem } from "@obsttorte/shared/types";
import type { Env } from "./env";
import { objectKey } from "./objects";

export const SNAPSHOT_ID_PATTERN = /^\d+-(?:server|device-[0-9a-f-]{36})$/i;

export function snapshotKey(id: string): string {
  return `snapshots/${id}.json`;
}

export async function readSnapshot(env: Env, id: string): Promise<SnapshotDocument | null> {
  const object = await env.BUCKET.get(snapshotKey(id));
  return object ? object.json<SnapshotDocument>() : null;
}

export async function listSnapshots(env: Env): Promise<SnapshotListItem[]> {
  const items: SnapshotListItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: "snapshots/", cursor, limit: 1000 });
    for (const object of page.objects) {
      const id = object.key.slice("snapshots/".length, -".json".length);
      const match = /^(\d+)-(server|device-(.+))$/.exec(id);
      if (!match) continue;
      const fromServer = match[2] === "server";
      items.push({
        id,
        createdAt: Number(match[1]),
        origin: fromServer ? "server" : "device",
        deviceId: fromServer ? null : (match[3] ?? null),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return items.sort((left, right) => right.createdAt - left.createdAt);
}

export async function snapshotSha256s(env: Env): Promise<Set<string>> {
  const hashes = new Set<string>();
  for (const snapshot of await listSnapshots(env)) {
    const document = await readSnapshot(env, snapshot.id);
    for (const file of Object.values(document?.files ?? {})) hashes.add(file.sha256);
  }
  return hashes;
}

export async function removeFromSnapshots(
  env: Env,
  paths: ReadonlySet<string>,
  sha256s: ReadonlySet<string>,
): Promise<void> {
  for (const snapshot of await listSnapshots(env)) {
    const document = await readSnapshot(env, snapshot.id);
    if (!document) continue;
    const kept = Object.entries(document.files).filter(
      ([path, file]) => !paths.has(path) && !sha256s.has(file.sha256),
    );
    if (kept.length === Object.keys(document.files).length) continue;
    await env.BUCKET.put(
      snapshotKey(snapshot.id),
      JSON.stringify({ files: Object.fromEntries(kept) }),
    );
  }
}

export async function readRetention(env: Env) {
  const row = await env.DB.prepare(
    `SELECT sha256 FROM files
      WHERE deleted = 0
        AND path GLOB '.*/obsttorte.json'
        AND path NOT GLOB '*/*/obsttorte.json'
      ORDER BY path
      LIMIT 1`,
  ).first<{ sha256: string }>();
  if (!row?.sha256) return parseSharedSettings({}).snapshotRetention;
  // 設定ファイルが無い・読めないときは、保持期間を推測で短くしないよう間引きを止める
  try {
    const object = await env.BUCKET.get(objectKey(row.sha256));
    if (!object) return null;
    return parseSharedSettings(await object.json()).snapshotRetention;
  } catch {
    return null;
  }
}
