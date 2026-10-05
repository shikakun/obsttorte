import {
  deepEqual,
  detectJsonStyle,
  isPlainObject,
  type JsonMergeResult,
  mergeJson,
  parseVersions,
  stringifyJsonLike,
} from "./json";

type Identified = { id: string };

export type StructuredMergeResult = { kind: "merged"; text: string } | { kind: "conflict" };

function mergeById(
  base: unknown,
  local: unknown,
  remote: unknown,
  pointer: string,
): JsonMergeResult {
  if (!isIdentifiedArray(base) || !isIdentifiedArray(local) || !isIdentifiedArray(remote)) {
    return mergeJson(base, local, remote);
  }
  const baseMap = new Map(base.map((item) => [item.id, item]));
  const localMap = new Map(local.map((item) => [item.id, item]));
  const remoteMap = new Map(remote.map((item) => [item.id, item]));
  const ids: string[] = [];
  for (const id of [...localMap.keys(), ...remoteMap.keys(), ...baseMap.keys()]) {
    if (!ids.includes(id)) ids.push(id);
  }
  const merged: Identified[] = [];
  const conflicts: string[] = [];
  for (const id of ids) {
    const result = mergeJson(baseMap.get(id), localMap.get(id), remoteMap.get(id));
    if (result.kind === "ambiguous") {
      conflicts.push(`${pointer}[${id}]`);
      continue;
    }
    if (isIdentified(result.value)) merged.push(result.value);
  }
  if (conflicts.length > 0) return { kind: "ambiguous", conflictingPaths: conflicts };
  const ordered: Identified[] = [];
  for (const item of local) {
    const next = merged.find((candidate) => candidate.id === item.id);
    if (next) ordered.push(next);
  }
  for (const item of merged) {
    if (!ordered.some((candidate) => candidate.id === item.id)) ordered.push(item);
  }
  return { kind: "merged", value: ordered };
}

function isIdentified(value: unknown): value is Identified {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

function isIdentifiedArray(value: unknown): value is Identified[] {
  return Array.isArray(value) && value.every((item) => isIdentified(item));
}

export function mergeCanvas(
  baseText: string,
  localText: string,
  remoteText: string,
): StructuredMergeResult {
  const parsed = parseVersions(JSON.parse, baseText, localText, remoteText);
  if (!parsed) return { kind: "conflict" };
  const [base, local, remote] = parsed;
  if (!isPlainObject(base) || !isPlainObject(local) || !isPlainObject(remote)) {
    return { kind: "conflict" };
  }
  const nodes = mergeById(base.nodes ?? [], local.nodes ?? [], remote.nodes ?? [], "$.nodes");
  const edges = mergeById(base.edges ?? [], local.edges ?? [], remote.edges ?? [], "$.edges");
  if (nodes.kind === "ambiguous" || edges.kind === "ambiguous") return { kind: "conflict" };
  const rest = mergeJson(withoutGraph(base), withoutGraph(local), withoutGraph(remote));
  if (rest.kind === "ambiguous" || !isPlainObject(rest.value)) return { kind: "conflict" };
  const merged = { ...rest.value, nodes: nodes.value, edges: edges.value };
  if (deepEqual(merged, local))
    return { kind: "merged", text: localText.endsWith("\n") ? localText : `${localText}\n` };
  return { kind: "merged", text: stringifyJsonLike(merged, detectJsonStyle(localText)) };
}

function withoutGraph({
  nodes: _nodes,
  edges: _edges,
  ...rest
}: Record<string, unknown>): Record<string, unknown> {
  return rest;
}
