import type { BulkGuardThresholds, IndexEntry, SyncMode } from "@obsttorte/shared";
import {
  EMPTY_FILE_GUARD_BYTES,
  isPortablePath,
  MAX_FILE_BYTES,
  sha256Hex,
  toPathKey,
} from "@obsttorte/shared";
import { decideAction, type SyncAction } from "./decide";
import { isExcluded } from "./exclusions";
import {
  createQuarantineMatcher,
  findNewPluginIds,
  isNewPluginPath,
  isStyleChange,
  pluginIdFromPath,
} from "./quarantine";

export type SkipReason =
  | "excluded"
  | "oversize"
  | "read-failed"
  | "quarantine"
  | "reload-pending"
  | "unresolved-conflict"
  | "plugin-data-unconfirmed"
  | "path-collision"
  | "unportable-name"
  | "invalid-remote"
  | "repair";

export type LocalVersion = {
  path: string;
  sha256: string;
  size: number;
};

export type BaseVersion = {
  path: string;
  sha256: string | null;
  rev: number;
};

export type PlanItem = {
  path: string;
  action: SyncAction;
  localSha256: string | null;
  remoteSha256: string | null;
  baseSha256: string | null;
  localSize: number | null;
  remoteSize: number | null;
  expectedRev: number;
  remoteRev: number | null;
};

export type GuardResult =
  | { kind: "ok" }
  | { kind: "abort"; reason: "local-shrunk" | "empty-remote" }
  | {
      kind: "confirm";
      deletions: number;
      deletionRatio: number;
      changes: number;
      changeRatio: number;
      shrinkToZero: number;
      samples: string[];
    };

export type SyncPlan = {
  items: PlanItem[];
  skipped: Array<{ path: string; reason: SkipReason }>;
  guard: GuardResult;
  newPluginIds: string[];
  stylePaths: string[];
};

export type PlanInput = {
  local: LocalVersion[];
  remote: IndexEntry[];
  base: BaseVersion[];
  undetermined: Array<{ path: string; reason: SkipReason }>;
  mode: SyncMode;
  thresholds: BulkGuardThresholds;
  indexedCount: number;
  fullScan: boolean;
  fullIndex: boolean;
  hasBase: boolean;
  configDir: string;
  selfId: string;
  exclusionPatterns: readonly string[];
  knownPluginIds: readonly string[];
  codeConfiguredPluginIds: readonly string[];
  approved: ReadonlyArray<{ path: string; sha256: string }>;
  pluginDataSync: Readonly<Record<string, boolean>>;
  reloadPending: readonly string[];
  unresolvedConflicts: readonly string[];
  repairPull: readonly string[];
  /** 承認待ちで保留しているリモートの版。これらのパスは未確定として扱う */
  held?: ReadonlyArray<{ path: string; sha256: string }>;
};

export function buildSyncPlan(input: PlanInput): SyncPlan {
  const skipped: Array<{ path: string; reason: SkipReason }> = [];
  const skip = (path: string, reason: SkipReason) => {
    if (!skipped.some((item) => item.path === path)) skipped.push({ path, reason });
  };

  const local = new Map(input.local.map((file) => [file.path, file]));
  const remote = new Map(input.remote.map((entry) => [entry.path, entry]));
  const base = new Map(input.base.map((entry) => [entry.path, entry]));
  const excluded = (path: string) =>
    isExcluded(path, input.configDir, input.selfId, input.exclusionPatterns);
  const exclude = (path: string) => {
    skip(path, "excluded");
    local.delete(path);
    remote.delete(path);
    base.delete(path);
  };
  const undetermined = new Map(input.undetermined.map((item) => [item.path, item.reason]));
  for (const path of input.reloadPending) undetermined.set(path, "reload-pending");
  for (const path of input.unresolvedConflicts) undetermined.set(path, "unresolved-conflict");

  for (const path of remote.keys()) if (excluded(path)) exclude(path);
  for (const [path, file] of local) {
    if (excluded(path)) {
      exclude(path);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      skip(path, "oversize");
      undetermined.set(path, "oversize");
    }
    const pluginId = pluginIdFromPath(path, input.configDir);
    if (!pluginId || !path.endsWith("/data.json")) continue;
    const syncData = input.pluginDataSync[pluginId];
    if (syncData === undefined) {
      skip(path, "plugin-data-unconfirmed");
      undetermined.set(path, "plugin-data-unconfirmed");
    } else if (!syncData) {
      exclude(path);
    }
  }
  for (const path of base.keys()) if (excluded(path)) exclude(path);

  const paths = new Set<string>([...local.keys(), ...remote.keys(), ...base.keys()]);
  for (const path of paths) if (!isPortablePath(path)) undetermined.set(path, "unportable-name");
  for (const [path, reason] of undetermined) {
    paths.delete(path);
    skip(path, reason);
  }

  const quarantined = createQuarantineMatcher({
    configDir: input.configDir,
    codeConfiguredPluginIds: input.codeConfiguredPluginIds,
  });
  const approved = new Set(input.approved.map((item) => `${item.path}\0${item.sha256}`));
  const held = new Map((input.held ?? []).map((item) => [item.path, item.sha256]));
  const items: PlanItem[] = [];
  const incoming: string[] = [];
  const heldIncoming: string[] = [];
  const repairing = new Set(input.repairPull);
  for (const path of paths) {
    const localFile = local.get(path) ?? null;
    const remoteFile = remote.get(path) ?? null;
    const baseFile = base.get(path) ?? null;
    const remoteSha = remoteFile && !remoteFile.deleted ? remoteFile.sha256 : null;
    const baseSha = baseFile?.sha256 ?? null;
    let action = decideAction({
      local: localFile?.sha256 ?? null,
      base: baseSha,
      remote: remoteSha,
    });
    if (repairing.has(path)) {
      if (remoteSha) action = "pull";
      else if (remoteFile?.deleted) action = "deleteLocal";
      else {
        skip(path, "repair");
        continue;
      }
    }
    const heldSha = held.get(path);
    if (
      !repairing.has(path) &&
      heldSha &&
      !approved.has(`${path}\0${heldSha}`) &&
      (remoteSha === heldSha || remoteSha === null) &&
      action !== "noop" &&
      action !== "adoptBase"
    ) {
      skip(path, "quarantine");
      heldIncoming.push(path);
      continue;
    }
    const item: PlanItem = {
      path,
      action,
      localSha256: localFile?.sha256 ?? null,
      remoteSha256: remoteSha,
      baseSha256: baseSha,
      localSize: localFile?.size ?? null,
      remoteSize: remoteFile && !remoteFile.deleted ? remoteFile.size : null,
      expectedRev: baseFile?.rev ?? remoteFile?.rev ?? 0,
      remoteRev: remoteFile?.rev ?? null,
    };
    if (action === "pull" || action === "conflict") incoming.push(path);
    if (
      (action === "pull" || action === "conflict") &&
      remoteSha &&
      quarantined(path) &&
      !approved.has(`${path}\0${remoteSha}`)
    ) {
      skip(path, "quarantine");
      continue;
    }
    items.push(item);
  }

  const newPluginIds = findNewPluginIds(
    [...incoming, ...heldIncoming],
    input.configDir,
    input.knownPluginIds,
  );
  const filtered = items.filter((item) => {
    if (!isNewPluginPath(item.path, input.configDir, newPluginIds)) return true;
    if (item.action !== "pull" && item.action !== "conflict") return true;
    skip(item.path, "quarantine");
    return false;
  });

  const collided = collidingPaths(filtered);
  const withoutCollisions = filtered.filter((item) => {
    if (!collided.has(item.path)) return true;
    skip(item.path, "path-collision");
    return false;
  });
  const directed = applyDirection(withoutCollisions, input.mode);
  const stylePaths = directed
    .filter((item) => item.action === "pull" && isStyleChange(item.path, input.configDir))
    .map((item) => item.path);
  const vaultFileCount = Math.max(new Set([...local.keys(), ...liveRemotePaths(remote)]).size, 1);
  return {
    items: directed,
    skipped,
    guard: evaluateGuard({
      items: directed,
      localCount: input.local.length,
      indexedCount: input.indexedCount,
      remoteCount: input.remote.filter((entry) => !entry.deleted).length,
      fullScan: input.fullScan,
      fullIndex: input.fullIndex,
      hasBase: input.hasBase,
      thresholds: input.thresholds,
      vaultFileCount,
    }),
    newPluginIds,
    stylePaths,
  };
}

function liveRemotePaths(remote: Map<string, IndexEntry>): string[] {
  return [...remote.values()].filter((entry) => !entry.deleted).map((entry) => entry.path);
}

function applyDirection(items: PlanItem[], mode: SyncMode): PlanItem[] {
  if (mode === "bidirectional") return items;
  if (mode === "push-only") {
    return items.filter((item) => item.action !== "pull" && item.action !== "deleteLocal");
  }
  return items.filter((item) => item.action !== "push" && item.action !== "deleteRemote");
}

function collidingPaths(items: PlanItem[]): Set<string> {
  const live = new Map<string, string>();
  const collisions = new Set<string>();
  const deleted = new Set(
    items
      .filter((item) => item.action === "deleteRemote" || item.action === "deleteLocal")
      .map((item) => item.path),
  );
  for (const item of items) {
    if (deleted.has(item.path)) continue;
    const sha =
      item.action === "pull" ? item.remoteSha256 : (item.localSha256 ?? item.remoteSha256);
    if (!sha) continue;
    const key = toPathKey(item.path);
    const owner = live.get(key);
    if (owner && owner !== item.path) {
      collisions.add(owner);
      collisions.add(item.path);
    } else {
      live.set(key, item.path);
    }
  }
  return collisions;
}

export function evaluateGuard(input: {
  items: PlanItem[];
  localCount: number;
  indexedCount: number;
  remoteCount: number;
  fullScan: boolean;
  fullIndex: boolean;
  hasBase: boolean;
  thresholds: BulkGuardThresholds;
  vaultFileCount: number;
}): GuardResult {
  if (input.fullScan && input.indexedCount > 0 && input.localCount * 2 < input.indexedCount) {
    return { kind: "abort", reason: "local-shrunk" };
  }
  if (input.fullIndex && input.remoteCount === 0 && input.hasBase) {
    return { kind: "abort", reason: "empty-remote" };
  }
  const created = new Set<string>();
  for (const item of input.items) {
    if (item.action === "push" && item.localSha256) created.add(item.localSha256);
    if (item.action === "pull" && item.remoteSha256) created.add(item.remoteSha256);
  }
  const deletions = input.items.filter((item) => {
    if (item.action !== "deleteLocal" && item.action !== "deleteRemote") return false;
    const sha = item.action === "deleteLocal" ? item.localSha256 : item.remoteSha256;
    return sha === null || !created.has(sha);
  });
  const changes = input.items.filter(
    (item) => item.action !== "noop" && item.action !== "adoptBase",
  );
  const shrinkToZero = input.items.filter((item) => {
    if (item.action === "pull") {
      return (item.localSize ?? 0) >= EMPTY_FILE_GUARD_BYTES && item.remoteSize === 0;
    }
    if (item.action === "push") {
      return (item.remoteSize ?? 0) >= EMPTY_FILE_GUARD_BYTES && item.localSize === 0;
    }
    return false;
  });
  const deletionRatio = deletions.length / input.vaultFileCount;
  const changeRatio = changes.length / input.vaultFileCount;
  const exceeded =
    deletions.length > input.thresholds.maxDeletions ||
    deletionRatio > input.thresholds.maxDeletionRatio ||
    changeRatio > input.thresholds.maxChangeRatio ||
    shrinkToZero.length > input.thresholds.maxShrinkToZero;
  if (!exceeded) return { kind: "ok" };
  return {
    kind: "confirm",
    deletions: deletions.length,
    deletionRatio,
    changes: changes.length,
    changeRatio,
    shrinkToZero: shrinkToZero.length,
    samples: changes.slice(0, 20).map((item) => item.path),
  };
}

export type ActionCounts = {
  push: number;
  pull: number;
  conflict: number;
  deleteLocal: number;
  deleteRemote: number;
};

function countActions(items: PlanItem[]): ActionCounts {
  const counts: ActionCounts = { push: 0, pull: 0, conflict: 0, deleteLocal: 0, deleteRemote: 0 };
  for (const item of items) {
    if (item.action in counts) counts[item.action as keyof ActionCounts] += 1;
  }
  return counts;
}

const PREVIEW_BLOCKING_REASONS = new Set<SkipReason>([
  "oversize",
  "read-failed",
  "plugin-data-unconfirmed",
  "quarantine",
  "excluded",
  "unportable-name",
  "invalid-remote",
]);

export function previewInitialSync(input: PlanInput): {
  merge: ActionCounts;
  server: ActionCounts;
  device: ActionCounts;
} {
  const merge = buildSyncPlan({ ...input, base: [], mode: "bidirectional", hasBase: false });
  const local = new Map(input.local.map((file) => [file.path, file]));
  const remote = input.remote.filter((entry) => !entry.deleted);
  const remoteMap = new Map(remote.map((entry) => [entry.path, entry]));
  const blocked = new Set(input.undetermined.map((item) => item.path));
  for (const skipped of merge.skipped) {
    if (PREVIEW_BLOCKING_REASONS.has(skipped.reason)) blocked.add(skipped.path);
  }
  let pull = 0;
  let deleteLocal = 0;
  let push = 0;
  let deleteRemote = 0;
  const paths = new Set([...local.keys(), ...remoteMap.keys()]);
  for (const path of paths) {
    if (blocked.has(path)) continue;
    const localSha = local.get(path)?.sha256 ?? null;
    const remoteSha = remoteMap.get(path)?.sha256 ?? null;
    if (localSha !== remoteSha && remoteSha !== null) pull += 1;
    if (localSha !== null && remoteSha === null) deleteLocal += 1;
    if (localSha !== remoteSha && localSha !== null) push += 1;
    if (remoteSha !== null && localSha === null) deleteRemote += 1;
  }
  return {
    merge: countActions(merge.items),
    server: { push: 0, pull, conflict: 0, deleteLocal, deleteRemote: 0 },
    device: { push, pull: 0, conflict: 0, deleteLocal: 0, deleteRemote },
  };
}

export async function exportPlan(plan: SyncPlan, redact: boolean): Promise<string> {
  if (!redact) return JSON.stringify(plan, null, 2);
  const hashPaths = <T extends { path: string }>(items: T[]) =>
    Promise.all(items.map(async (item) => ({ ...item, path: await sha256Hex(item.path) })));
  const redacted = {
    ...plan,
    items: await hashPaths(plan.items),
    skipped: await hashPaths(plan.skipped),
  };
  return JSON.stringify(redacted, null, 2);
}
