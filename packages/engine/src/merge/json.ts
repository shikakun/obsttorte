export function parseVersions(
  parse: (text: string) => unknown,
  base: string,
  local: string,
  remote: string,
): [unknown, unknown, unknown] | null {
  try {
    return [parse(base), parse(local), parse(remote)];
  } catch {
    return null;
  }
}

export type JsonMergeResult =
  | { kind: "merged"; value: unknown }
  | { kind: "ambiguous"; conflictingPaths: string[] };

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeJson(base: unknown, local: unknown, remote: unknown): JsonMergeResult {
  return mergeValue(base, local, remote, "$");
}

function mergeValue(
  base: unknown,
  local: unknown,
  remote: unknown,
  pointer: string,
): JsonMergeResult {
  if (deepEqual(local, remote) || deepEqual(local, base)) return { kind: "merged", value: remote };
  if (deepEqual(remote, base)) return { kind: "merged", value: local };
  if (isPlainObject(base) && isPlainObject(local) && isPlainObject(remote)) {
    return mergeObjects(base, local, remote, pointer);
  }
  return { kind: "ambiguous", conflictingPaths: [pointer] };
}

function mergeObjects(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  pointer: string,
): JsonMergeResult {
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  const merged: Record<string, unknown> = {};
  const conflicts: string[] = [];
  for (const key of keys) {
    const result = mergeValue(
      Object.hasOwn(base, key) ? base[key] : undefined,
      Object.hasOwn(local, key) ? local[key] : undefined,
      Object.hasOwn(remote, key) ? remote[key] : undefined,
      `${pointer}.${key}`,
    );
    if (result.kind === "ambiguous") {
      conflicts.push(...result.conflictingPaths);
      continue;
    }
    if (result.value !== undefined) merged[key] = result.value;
  }
  if (conflicts.length > 0) return { kind: "ambiguous", conflictingPaths: conflicts };
  return { kind: "merged", value: merged };
}

export function mergeCommunityPlugins(
  base: unknown,
  local: unknown,
  remote: unknown,
): JsonMergeResult {
  if (!isStringArray(base) || !isStringArray(local) || !isStringArray(remote)) {
    return mergeJson(base, local, remote);
  }
  const baseSet = new Set(base);
  const removed = new Set<string>([
    ...base.filter((id) => !local.includes(id)),
    ...base.filter((id) => !remote.includes(id)),
  ]);
  const merged: string[] = [];
  for (const id of local) {
    if (!removed.has(id)) merged.push(id);
  }
  for (const id of remote) {
    if (!baseSet.has(id) && !removed.has(id) && !merged.includes(id)) merged.push(id);
  }
  return { kind: "merged", value: merged };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export type JsonStyle = { indent: string | number; trailingNewline: boolean };

export function detectJsonStyle(text: string): JsonStyle {
  const trailingNewline = text.endsWith("\n");
  const match = /\n(\t+| +)/.exec(text);
  const whitespace = match?.[1];
  if (!whitespace) return { indent: 2, trailingNewline };
  if (whitespace.startsWith("\t")) return { indent: "\t", trailingNewline };
  return { indent: whitespace.length, trailingNewline };
}

export function stringifyJsonLike(value: unknown, style: JsonStyle): string {
  const json = JSON.stringify(value, null, style.indent) ?? "null";
  return style.trailingNewline || json.endsWith("\n") ? `${json.replace(/\n$/, "")}\n` : json;
}

export type JsonPreference = "local" | "remote" | "local-first" | "remote-first";

export function mergeJsonWithPreference(
  base: unknown,
  local: unknown,
  remote: unknown,
  preference: JsonPreference,
): unknown {
  if (preference === "local") return local;
  if (preference === "remote") return remote;
  return prefer(base, local, remote, preference === "local-first");
}

function prefer(base: unknown, local: unknown, remote: unknown, preferLocal: boolean): unknown {
  if (deepEqual(local, remote)) return local;
  if (deepEqual(local, base)) return remote;
  if (deepEqual(remote, base)) return local;
  if (isPlainObject(local) && isPlainObject(remote)) {
    const baseObject = isPlainObject(base) ? base : {};
    const keys = new Set([
      ...Object.keys(baseObject),
      ...Object.keys(local),
      ...Object.keys(remote),
    ]);
    const merged: Record<string, unknown> = {};
    for (const key of keys) {
      const value = prefer(
        Object.hasOwn(baseObject, key) ? baseObject[key] : undefined,
        Object.hasOwn(local, key) ? local[key] : undefined,
        Object.hasOwn(remote, key) ? remote[key] : undefined,
        preferLocal,
      );
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  return preferLocal ? local : remote;
}
