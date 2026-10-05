import { sha256Hex } from "@obsttorte/shared/hash";
import { generateDeviceToken } from "@obsttorte/shared/token";
import { type CloudflareClient, resultRows } from "../cloudflare";
import { CliError } from "../errors";

const DEVICE_NAME_MAX_LENGTH = 100;

export function validateDeviceName(name: string): string | null {
  if (name.length === 0) return "Enter a name.";
  if (name.length > DEVICE_NAME_MAX_LENGTH)
    return `Use ${DEVICE_NAME_MAX_LENGTH} characters or fewer.`;
  const hasControlCharacter = [...name].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
  return hasControlCharacter ? "Remove control characters from the name." : null;
}

const toSqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export async function addDevice(
  cloudflare: CloudflareClient,
  configPath: string,
  deviceName: string,
): Promise<string> {
  const problem = validateDeviceName(deviceName);
  if (problem) throw new CliError(problem);
  const token = generateDeviceToken();
  const tokenHash = await sha256Hex(token);
  await cloudflare.execute(
    configPath,
    `INSERT INTO devices (id, name, token_hash, created_at)
     VALUES (${toSqlString(crypto.randomUUID())}, ${toSqlString(deviceName)}, ${toSqlString(tokenHash)}, ${Date.now()})`,
  );
  return token;
}

export async function listDevices(
  cloudflare: CloudflareClient,
  configPath: string,
): Promise<DeviceRow[]> {
  const output = await cloudflare.execute(
    configPath,
    "SELECT id, name, created_at, last_seen_at, last_api_version, revoked_at FROM devices ORDER BY created_at",
  );
  return resultRows(output) as DeviceRow[];
}

export async function revokeDevice(
  cloudflare: CloudflareClient,
  configPath: string,
  id: string,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new CliError("The device ID is invalid.");
  await cloudflare.execute(
    configPath,
    `UPDATE devices SET revoked_at = ${Date.now()} WHERE id = ${toSqlString(id)}`,
  );
}

export type DeviceRow = {
  id: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  last_api_version: number | null;
  revoked_at: number | null;
};
