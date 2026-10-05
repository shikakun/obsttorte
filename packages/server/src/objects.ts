import { apiError } from "@obsttorte/shared/errors";
import { isSha256 } from "@obsttorte/shared/hash";
import {
  MAINTENANCE_RETRY_AFTER_SECONDS,
  MAINTENANCE_STALE_MS,
  MAX_FILE_BYTES,
  MULTIPART_PART_BYTES,
  SINGLE_PUT_MAX_BYTES,
} from "@obsttorte/shared/limits";
import type { Context } from "hono";
import { chunks, many, one, placeholders, run } from "./db";
import type { AppEnv } from "./env";

type UploadState = {
  uploadId: string;
  key: string;
  size: number;
  parts: Array<{ partNumber: number; etag: string }>;
};

export const STAGING_PREFIX = "staging/";

export function objectKey(sha256: string): string {
  return `objects/${sha256}`;
}

export async function verifiedShaSet(c: Context<AppEnv>, sha256s: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const chunk of chunks(sha256s)) {
    const rows = await many<{ sha256: string }>(
      c,
      c.env.DB.prepare(
        `SELECT sha256 FROM objects WHERE status = 'verified' AND sha256 IN (${placeholders(chunk.length)})`,
      ).bind(...chunk),
    );
    for (const row of rows) found.add(row.sha256);
  }
  return found;
}

export async function verifiedRow(
  c: Context<AppEnv>,
  sha256: string,
): Promise<{ size: number } | null> {
  return one(
    c,
    c.env.DB.prepare("SELECT size FROM objects WHERE sha256 = ? AND status = 'verified'").bind(
      sha256,
    ),
  );
}

export async function putObject(c: Context<AppEnv>, sha256: string): Promise<Response> {
  const paused = await pausedForMaintenance(c);
  if (paused) return paused;
  if (!isSha256(sha256)) return c.json(apiError("invalid_request", "sha256 is invalid"), 400);
  const contentLength = parseContentLength(c);
  if (contentLength === null) return lengthRequired(c);
  if (contentLength > MAX_FILE_BYTES)
    return c.json(apiError("payload_too_large", "File exceeds 100 MB"), 413);
  if (contentLength > SINGLE_PUT_MAX_BYTES) {
    return c.json(apiError("payload_too_large", "Use multipart upload"), 413);
  }
  if (!c.req.raw.body && contentLength !== 0) return lengthRequired(c);
  try {
    await c.env.BUCKET.put(objectKey(sha256), c.req.raw.body ?? new Uint8Array(), { sha256 });
  } catch {
    return c.json(apiError("checksum_mismatch", "Checksum did not match"), 422);
  }
  await markVerified(c, sha256, contentLength);
  return c.body(null, 204);
}

export async function getObject(c: Context<AppEnv>, sha256: string): Promise<Response> {
  if (!isSha256(sha256)) return c.json(apiError("invalid_request", "sha256 is invalid"), 400);
  const row = await verifiedRow(c, sha256);
  if (!row) return c.json(apiError("invalid_request", "Object was not found"), 404);
  const rangeHeader = c.req.header("Range");
  const range = rangeHeader ? parseRange(rangeHeader, row.size) : null;
  if (rangeHeader && !range) return c.body(null, 416);
  const object = await c.env.BUCKET.get(objectKey(sha256), range ? { range } : undefined);
  if (!object) return c.json(apiError("invalid_request", "Object was not found"), 404);
  const headers = new Headers();
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Type", "application/octet-stream");
  headers.set("ETag", sha256);
  if (range && "offset" in range && range.offset !== undefined) {
    const offset = range.offset;
    const end = offset + (range.length ?? row.size - offset) - 1;
    headers.set("Content-Range", `bytes ${offset}-${end}/${row.size}`);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

export async function headObject(c: Context<AppEnv>, sha256: string): Promise<Response> {
  if (!isSha256(sha256)) return c.json(apiError("invalid_request", "sha256 is invalid"), 400);
  const row = await verifiedRow(c, sha256);
  if (!row) return c.body(null, 404);
  return c.body(null, 200, { "Content-Length": String(row.size), ETag: sha256 });
}

export async function createUpload(
  c: Context<AppEnv>,
  sha256: string,
  size: number,
): Promise<Response> {
  const paused = await pausedForMaintenance(c);
  if (paused) return paused;
  if (
    !isSha256(sha256) ||
    !Number.isSafeInteger(size) ||
    size <= SINGLE_PUT_MAX_BYTES ||
    size > MAX_FILE_BYTES
  ) {
    return c.json(apiError("invalid_request", "Multipart upload size is invalid"), 400);
  }
  if (await verifiedRow(c, sha256)) {
    return c.json(apiError("conflict", "Object already exists"), 409);
  }
  const key = `${STAGING_PREFIX}${sha256}/${crypto.randomUUID()}`;
  const upload = await c.env.BUCKET.createMultipartUpload(key);
  const state: UploadState = { uploadId: upload.uploadId, key, size, parts: [] };
  await c.env.BUCKET.put(stateKey(sha256), JSON.stringify(state));
  const now = Date.now();
  await run(
    c,
    c.env.DB.prepare(
      `INSERT INTO objects (sha256, size, status, created_at, last_referenced_at)
         VALUES (?, ?, 'pending', ?, ?)
         ON CONFLICT(sha256) DO UPDATE SET
           last_referenced_at = excluded.last_referenced_at,
           status = CASE WHEN objects.status = 'verified' THEN 'verified' ELSE 'pending' END`,
    ).bind(sha256, size, now, now),
  );
  return c.json({ uploadId: encodeTicket({ sha256, uploadId: upload.uploadId }) });
}

export async function uploadPart(
  c: Context<AppEnv>,
  ticketText: string,
  partNumber: number,
): Promise<Response> {
  const paused = await pausedForMaintenance(c);
  if (paused) return paused;
  const ticket = decodeTicket(ticketText);
  if (!ticket || !Number.isInteger(partNumber) || partNumber < 1) {
    return c.json(apiError("invalid_request", "Upload part is invalid"), 400);
  }
  const state = await readState(c, ticket.sha256);
  if (!state || state.uploadId !== ticket.uploadId)
    return c.json(apiError("conflict", "Upload is already complete"), 409);
  const partCount = Math.ceil(state.size / MULTIPART_PART_BYTES);
  if (partNumber > partCount)
    return c.json(apiError("invalid_request", "partNumber is out of range"), 400);
  const length = parseContentLength(c);
  if (length === null) return lengthRequired(c);
  const expected =
    partNumber === partCount
      ? state.size - (partNumber - 1) * MULTIPART_PART_BYTES
      : MULTIPART_PART_BYTES;
  if (length !== expected) return c.json(apiError("invalid_request", "Part size is invalid"), 400);
  const uploaded = await c.env.BUCKET.resumeMultipartUpload(state.key, ticket.uploadId).uploadPart(
    partNumber,
    c.req.raw.body ?? new Uint8Array(),
  );
  state.parts = [
    ...state.parts.filter((part) => part.partNumber !== partNumber),
    { partNumber, etag: uploaded.etag },
  ];
  await c.env.BUCKET.put(stateKey(ticket.sha256), JSON.stringify(state));
  return c.body(null, 204);
}

export async function completeUpload(c: Context<AppEnv>, ticketText: string): Promise<Response> {
  const paused = await pausedForMaintenance(c);
  if (paused) return paused;
  const ticket = decodeTicket(ticketText);
  if (!ticket) return c.json(apiError("invalid_request", "Upload is invalid"), 400);
  const state = await readState(c, ticket.sha256);
  if (!state || state.uploadId !== ticket.uploadId) {
    return c.json(apiError("conflict", "Upload is already complete"), 409);
  }
  const partCount = Math.ceil(state.size / MULTIPART_PART_BYTES);
  const partNumbers = new Set(state.parts.map((part) => part.partNumber));
  const partsComplete =
    state.parts.length === partCount &&
    Array.from({ length: partCount }, (_, index) => partNumbers.has(index + 1)).every(Boolean);
  if (!partsComplete) return c.json(apiError("invalid_request", "Upload is incomplete"), 400);
  const parts = [...state.parts].sort((left, right) => left.partNumber - right.partNumber);
  await c.env.BUCKET.resumeMultipartUpload(state.key, ticket.uploadId).complete(parts);
  const staged = await c.env.BUCKET.get(state.key);
  if (!staged) return c.json(apiError("internal", "Uploaded object is missing"), 500);
  const { readable, writable } = new FixedLengthStream(staged.size);
  const [stored] = await Promise.allSettled([
    c.env.BUCKET.put(objectKey(ticket.sha256), readable, { sha256: ticket.sha256 }),
    staged.body.pipeTo(writable),
  ]);
  await c.env.BUCKET.delete([state.key, stateKey(ticket.sha256)]);
  if (stored.status === "rejected") {
    await run(
      c,
      c.env.DB.prepare("DELETE FROM objects WHERE sha256 = ? AND status = 'pending'").bind(
        ticket.sha256,
      ),
    );
    return c.json(apiError("checksum_mismatch", "Checksum did not match"), 422);
  }
  await markVerified(c, ticket.sha256, state.size);
  return c.body(null, 204);
}

async function markVerified(c: Context<AppEnv>, sha256: string, size: number): Promise<void> {
  const now = Date.now();
  await run(
    c,
    c.env.DB.prepare(
      `INSERT INTO objects (sha256, size, status, created_at, last_referenced_at)
         VALUES (?, ?, 'verified', ?, ?)
         ON CONFLICT(sha256) DO UPDATE SET
           status = 'verified',
           size = excluded.size,
           last_referenced_at = excluded.last_referenced_at`,
    ).bind(sha256, size, now, now),
  );
  await run(c, c.env.DB.prepare("DELETE FROM gc_candidates WHERE sha256 = ?").bind(sha256));
}

async function pausedForMaintenance(c: Context<AppEnv>): Promise<Response | null> {
  const row = await one<{ value: number }>(
    c,
    c.env.DB.prepare("SELECT value FROM counters WHERE name = 'maintenance'"),
  );
  const startedAt = row?.value ?? 0;
  if (startedAt === 0 || Date.now() - startedAt >= MAINTENANCE_STALE_MS) return null;
  c.header("Retry-After", String(MAINTENANCE_RETRY_AFTER_SECONDS));
  return c.json(apiError("maintenance", "Uploads are paused during maintenance"), 503);
}

function parseContentLength(c: Context<AppEnv>): number | null {
  const header = c.req.header("Content-Length");
  return header !== undefined && /^\d+$/.test(header) ? Number(header) : null;
}

function lengthRequired(c: Context<AppEnv>): Response {
  return c.json(apiError("length_required", "Content-Length is required"), 411);
}

function parseRange(header: string, size: number): R2Range | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") return null;
  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { suffix };
  }
  const start = Number(startText);
  const end = endText === "" ? size - 1 : Number(endText);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null;
  }
  return { offset: start, length: end - start + 1 };
}

function stateKey(sha256: string): string {
  return `uploads/${sha256}.json`;
}

async function readState(c: Context<AppEnv>, sha256: string): Promise<UploadState | null> {
  const object = await c.env.BUCKET.get(stateKey(sha256));
  if (!object) return null;
  const state = JSON.parse(await object.text()) as Partial<UploadState>;
  return typeof state.key === "string" ? (state as UploadState) : null;
}

function encodeTicket(ticket: { sha256: string; uploadId: string }): string {
  const bytes = new TextEncoder().encode(JSON.stringify(ticket));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeTicket(value: string): { sha256: string; uploadId: string } | null {
  try {
    const padded =
      value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      sha256?: unknown;
      uploadId?: unknown;
    };
    if (typeof parsed.sha256 !== "string" || !isSha256(parsed.sha256)) return null;
    if (typeof parsed.uploadId !== "string" || parsed.uploadId === "") return null;
    return { sha256: parsed.sha256, uploadId: parsed.uploadId };
  } catch {
    return null;
  }
}
