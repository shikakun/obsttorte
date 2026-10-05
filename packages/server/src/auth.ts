import { apiError } from "@obsttorte/shared/errors";
import { sha256Hex } from "@obsttorte/shared/hash";
import { LAST_SEEN_UPDATE_INTERVAL_MS } from "@obsttorte/shared/limits";
import { apiVersionRange, isSupportedApiVersion } from "@obsttorte/shared/version";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AccessExecutionContext, AppEnv, DeviceRow } from "./env";

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;
const API_VERSION_PATTERN = /^\d{1,6}$/;

function parseBearerToken(header: string | undefined): string | null {
  return BEARER_PATTERN.exec(header?.trim() ?? "")?.[1] ?? null;
}

function parseApiVersion(header: string | undefined): number | null {
  const value = header?.trim() ?? "";
  return API_VERSION_PATTERN.test(value) ? Number(value) : null;
}

async function findActiveDeviceByToken(db: D1Database, token: string): Promise<DeviceRow | null> {
  const tokenHash = await sha256Hex(token);
  return db
    .prepare(
      "SELECT id, name, last_seen_at, last_api_version FROM devices WHERE token_hash = ? AND revoked_at IS NULL",
    )
    .bind(tokenHash)
    .first<DeviceRow>();
}

function shouldTouchDevice(device: DeviceRow, apiVersion: number | null, now: number): boolean {
  if (apiVersion !== null && device.last_api_version !== apiVersion) return true;
  return device.last_seen_at === null || now - device.last_seen_at >= LAST_SEEN_UPDATE_INTERVAL_MS;
}

async function touchDevice(
  db: D1Database,
  deviceId: string,
  apiVersion: number | null,
  now: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE devices SET last_seen_at = ?, last_api_version = COALESCE(?, last_api_version) WHERE id = ?",
    )
    .bind(now, apiVersion, deviceId)
    .run();
}

async function consumeAuthFailure(c: Context<AppEnv>): Promise<boolean> {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.AUTH_FAILURE_LIMITER.limit({ key: ip });
  return success;
}

export const requireAccess = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.env.ACCESS_AUD) {
    return c.json(apiError("internal", "Access is not configured"), 500);
  }
  const access = (c.executionCtx as AccessExecutionContext).access;
  if (!access) {
    return c.json(apiError("access_required", "Access authentication is required"), 403);
  }
  if (access.aud !== c.env.ACCESS_AUD) {
    return c.json(apiError("access_required", "Access audience mismatch"), 403);
  }
  await next();
});

export const requireDevice = createMiddleware<AppEnv>(async (c, next) => {
  const token = parseBearerToken(c.req.header("Authorization"));
  const device = token ? await findActiveDeviceByToken(c.env.DB, token) : null;

  if (!device) {
    const isWithinLimit = await consumeAuthFailure(c);
    if (isWithinLimit) return c.json(apiError("unauthorized", "Invalid token"), 401);
    c.header("Retry-After", "60");
    return c.json(apiError("rate_limited", "Too many failed attempts"), 429);
  }

  const apiVersion = parseApiVersion(c.req.header("X-Obsttorte-Api"));
  const now = Date.now();
  if (shouldTouchDevice(device, apiVersion, now)) {
    c.executionCtx.waitUntil(touchDevice(c.env.DB, device.id, apiVersion, now));
  }

  c.set("device", device);
  await next();
});

export const requireApiVersion = createMiddleware<AppEnv>(async (c, next) => {
  const apiVersion = parseApiVersion(c.req.header("X-Obsttorte-Api"));
  if (apiVersion === null || !isSupportedApiVersion(apiVersion)) {
    c.header("X-Obsttorte-Api-Range", apiVersionRange());
    return c.json(apiError("api_version_unsupported", "API version is not supported"), 426);
  }
  await next();
});
