import { env as rawEnv } from "cloudflare:test";
import { sha256Hex } from "@obsttorte/shared/hash";
import { app } from "../src/app";
import type { Env } from "../src/env";

export const env = rawEnv as unknown as Env;

export const TOKEN = "device-token";
export const SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
export const DAY = 24 * 60 * 60 * 1000;

const TABLES = [
  "history",
  "files",
  "objects",
  "conflicts",
  "requests",
  "gc_candidates",
  "purge_tokens",
  "devices",
  "maintenance_reports",
];

export async function resetStorage(): Promise<void> {
  await env.DB.batch([
    ...TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
    env.DB.prepare("UPDATE counters SET value = 0"),
  ]);
  const listed = await env.BUCKET.list();
  if (listed.objects.length > 0) {
    await env.BUCKET.delete(listed.objects.map((object) => object.key));
  }
}

export async function seedDevice(token = TOKEN, name = "laptop"): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, name, await sha256Hex(token), Date.now())
    .run();
  return id;
}

export async function seedObject(
  sha = SHA,
  bytes = new TextEncoder().encode("abc"),
  at = Date.now(),
): Promise<void> {
  await env.BUCKET.put(`objects/${sha}`, bytes);
  await env.DB.prepare(
    "INSERT INTO objects (sha256, size, status, created_at, last_referenced_at) VALUES (?, ?, 'verified', ?, ?)",
  )
    .bind(sha, bytes.byteLength, at, at)
    .run();
}

export async function insertFile(
  path: string,
  sha: string,
  { rev = 1, seq = 1, updatedAt = Date.now() } = {},
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO files (path, path_key, sha256, size, rev, seq, deleted, updated_at, device, request_id) VALUES (?, ?, ?, 1, ?, ?, 0, ?, 'device', 'req')",
  )
    .bind(path, path.toLowerCase(), sha, rev, seq, updatedAt)
    .run();
}

export async function insertHistory(
  path: string,
  sha: string,
  options: {
    rev?: number;
    seq?: number;
    changedAt?: number;
    device?: string;
    requestId?: string;
  } = {},
): Promise<void> {
  const { rev = 1, changedAt = Date.now(), device = "device", requestId = "req" } = options;
  const seq = options.seq ?? rev;
  await env.DB.prepare(
    "INSERT INTO history (path, sha256, size, rev, seq, deleted, changed_at, device, request_id) VALUES (?, ?, 1, ?, ?, 0, ?, ?, ?)",
  )
    .bind(path, sha, rev, seq, changedAt, device, requestId)
    .run();
}

const pending: Promise<unknown>[] = [];

type CallInit = RequestInit & { token?: string; api?: string; access?: boolean };

export async function call(path: string, init: CallInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token !== "") headers.set("Authorization", `Bearer ${init.token ?? TOKEN}`);
  if (init.api !== "") headers.set("X-Obsttorte-Api", init.api ?? "1");
  const context = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
    ...(init.access === false ? {} : { access: { aud: "local-development-only" } }),
  } as ExecutionContext;
  const response = await app.fetch(
    new Request(`https://obsttorte.test${path}`, { ...init, headers }),
    env,
    context,
  );
  await Promise.all(pending.splice(0));
  return response;
}

export function post(path: string, body: unknown, init: CallInit = {}): Promise<Response> {
  return call(path, { ...init, method: "POST", body: JSON.stringify(body) });
}

export function commit(
  changes: unknown[],
  requestId: string = crypto.randomUUID(),
  init: CallInit = {},
): Promise<Response> {
  return post("/api/commit", { requestId, changes }, init);
}
