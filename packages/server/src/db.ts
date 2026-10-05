import { BIND_CHUNK } from "@obsttorte/shared/limits";
import type { Context } from "hono";
import type { AppEnv } from "./env";

export function track(c: Context<AppEnv>, result: D1Result | D1Result[]): void {
  const results = Array.isArray(result) ? result : [result];
  let rowsRead = c.get("rowsRead") ?? 0;
  let rowsWritten = c.get("rowsWritten") ?? 0;
  for (const item of results) {
    rowsRead += item.meta?.rows_read ?? 0;
    rowsWritten += item.meta?.rows_written ?? 0;
  }
  c.set("rowsRead", rowsRead);
  c.set("rowsWritten", rowsWritten);
}

export async function run<T>(
  c: Context<AppEnv>,
  statement: D1PreparedStatement,
): Promise<D1Result<T>> {
  const result = await statement.run<T>();
  track(c, result);
  return result;
}

export async function one<T>(
  c: Context<AppEnv>,
  statement: D1PreparedStatement,
): Promise<T | null> {
  const result = await statement.all<T>();
  track(c, result);
  return result.results[0] ?? null;
}

export async function many<T>(c: Context<AppEnv>, statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.all<T>();
  track(c, result);
  return result.results;
}

export function chunks<T>(items: readonly T[], size = BIND_CHUNK): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
