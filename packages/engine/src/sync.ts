import type { SharedSettings } from "@obsttorte/shared";
import {
  DESKTOP_BYTE_BUDGET,
  type FileChange,
  type IndexEntry,
  isPortablePath,
  isSha256,
  isValidPath,
  MAX_FILE_BYTES,
  MULTIPART_PART_BYTES,
  parentPath,
  pathBasename,
  RANGE_CHUNK_BYTES,
  SINGLE_PUT_MAX_BYTES,
  type SyncMode,
  sha256Hex,
  TRANSFER_CONCURRENCY,
  type UploadCreateResponse,
} from "@obsttorte/shared";
import { type ApiClient, type ApiFailureKind, ApiRequestError, readFullIndex } from "./api-client";
import { isExcluded } from "./exclusions";
import { classifyJournal, type JournalEntry } from "./journal";
import type { IndexStore, JournalStore, LocalIndexEntry } from "./memory";
import { isBinaryPath, mergeFile } from "./merge";
import { isSameMTime } from "./mtime";
import {
  buildSyncPlan,
  evaluateGuard,
  type GuardResult,
  type PlanInput,
  type PlanItem,
  previewInitialSync,
  type SkipReason,
  type SyncPlan,
} from "./plan";
import { createQuarantineMatcher, isUnderConfig } from "./quarantine";
import { groupByBudget } from "./transfer";
import type { LocalFileStat, VaultPort } from "./vault-port";

export type InitialStrategy = "merge" | "server" | "device";

export type SyncStatus =
  | "ok"
  | "paused"
  | "aborted"
  | "needs-initial-choice"
  | "needs-guard-confirm"
  | "auth-stopped"
  | "version-stopped"
  | "failed";

export type Rejection = { path: string; reason: string; detail?: string };

export type SyncRunResult = {
  status: SyncStatus;
  plan: SyncPlan | null;
  preview: ReturnType<typeof previewInitialSync> | null;
  guard: GuardResult | null;
  applied: string[];
  conflicts: string[];
  quarantined: string[];
  reloadPending: string[];
  rejected: Rejection[];
  /** この実行で1件以上の変更がサーバーに確定したか */
  serverConfirmed: boolean;
  /** 失敗の原因。APIの失敗でなければkindとstatusはnull */
  error?: SyncFailure;
};

export type SyncFailure = {
  kind: ApiFailureKind | null;
  status: number | null;
  message: string;
};

export type SyncRequest = {
  vault: VaultPort;
  api: ApiClient;
  index: IndexStore;
  journal: JournalStore;
  settings: SharedSettings;
  mode: SyncMode;
  configDir: string;
  selfId: string;
  deviceName: string;
  full: boolean;
  forceRehash: boolean;
  dirtyPaths: readonly string[];
  reloadPending: readonly string[];
  unresolvedConflicts: readonly string[];
  approved: ReadonlyArray<{ path: string; sha256: string }>;
  knownPluginIds: readonly string[];
  acknowledgeGuard?: boolean;
  strategy?: InitialStrategy;
  dryRun?: boolean;
  onProgress?: (done: number, total: number) => void;
  onSelfWrite?: (path: string) => void;
  concurrency?: number;
  byteBudget?: number;
  now?: () => number;
};

export async function runSync(request: SyncRequest): Promise<SyncRunResult> {
  const now = request.now ?? Date.now;
  const empty = emptyResult();
  if (request.mode === "paused") return { ...empty, status: "paused" };
  try {
    const repairPull = await repairJournal(request);
    const scanned = await scanLocal(request);
    const remote = await fetchIndex(request);
    const initialized = await request.index.isInitialized();
    const indexEntries = await request.index.list();
    const baseEntries = indexEntries.filter(
      (entry) => entry.baseRev > 0 || entry.baseSha256 !== null,
    );
    const held = indexEntries.flatMap((entry) =>
      entry.heldRemoteSha256 ? [{ path: entry.path, sha256: entry.heldRemoteSha256 }] : [],
    );
    const planInput: PlanInput = {
      local: scanned.files,
      remote: remote.entries,
      base: baseEntries.map((entry) => ({
        path: entry.path,
        sha256: entry.baseSha256,
        rev: entry.baseRev,
      })),
      undetermined: [...scanned.undetermined, ...remote.invalid],
      mode: request.mode,
      thresholds: request.settings.bulkGuard,
      indexedCount: scanned.indexedCount,
      fullScan: request.full,
      fullIndex: remote.full,
      hasBase: baseEntries.length > 0,
      configDir: request.configDir,
      selfId: request.selfId,
      exclusionPatterns: request.settings.exclusions,
      knownPluginIds: request.knownPluginIds,
      codeConfiguredPluginIds: request.settings.codeConfiguredPluginIds,
      approved: request.approved,
      pluginDataSync: request.settings.pluginDataSync,
      reloadPending: request.reloadPending,
      unresolvedConflicts: request.unresolvedConflicts,
      repairPull,
      held,
    };
    const plan = buildSyncPlan(planInput);
    await forgetExcludedBases(request, plan);
    if (!initialized && !request.strategy) {
      await recordQuarantine(request, plan, remote.entries, scanned.stats, scanned.hashes);
      return {
        ...empty,
        status: "needs-initial-choice",
        plan,
        preview: previewInitialSync({
          ...planInput,
          indexedCount: 0,
          fullScan: true,
          fullIndex: true,
          approved: [],
          reloadPending: [],
          unresolvedConflicts: [],
          repairPull: [],
          held: [],
        }),
        guard: plan.guard,
      };
    }
    const invalidRemote = new Set(
      plan.skipped.filter((item) => item.reason === "invalid-remote").map((item) => item.path),
    );
    const items = shapeInitial(plan.items, scanned.files, remote.entries, request.strategy).filter(
      (item) =>
        isPortablePath(item.path) &&
        !invalidRemote.has(item.path) &&
        !isExcluded(item.path, request.configDir, request.selfId, request.settings.exclusions),
    );
    const guard =
      request.strategy && request.strategy !== "merge"
        ? evaluateGuard({
            items,
            localCount: scanned.files.length,
            indexedCount: scanned.indexedCount,
            remoteCount: remote.entries.filter((entry) => !entry.deleted).length,
            fullScan: request.full,
            fullIndex: remote.full,
            hasBase: baseEntries.length > 0,
            thresholds: request.settings.bulkGuard,
            vaultFileCount: Math.max(
              new Set([
                ...scanned.files.map((file) => file.path),
                ...remote.entries.filter((entry) => !entry.deleted).map((entry) => entry.path),
              ]).size,
              1,
            ),
          })
        : plan.guard;
    const shaped = { ...plan, items, guard };
    await recordQuarantine(request, shaped, remote.entries, scanned.stats, scanned.hashes);
    if (plan.guard.kind === "abort") {
      return { ...empty, status: "aborted", plan: shaped, guard: plan.guard };
    }
    if (guard.kind === "confirm" && !request.acknowledgeGuard) {
      return { ...empty, status: "needs-guard-confirm", plan: shaped, guard };
    }
    if (request.dryRun) return { ...empty, status: "ok", plan: shaped, guard };
    const corrected = new Map<string, string>();
    const applied = await applyPlan({ ...request, now }, shaped, scanned.stats, corrected);
    for (const path of applied.oversized) {
      if (!shaped.skipped.some((item) => item.path === path)) {
        shaped.skipped.push({ path, reason: "oversize" });
      }
    }
    await clearHeld(request, applied.done);
    await persistCaches(request, scanned.stats, scanned.hashes, corrected);
    await stashUnapplied(request, remote.entries, applied.done);
    const previous = await request.index.getCursor();
    await request.index.setCursor(
      nextCursor(previous, remote.seq, remote.entries, applied.done, shaped.skipped),
    );
    await request.index.setInitialized(true);
    return {
      status: "ok",
      plan: shaped,
      preview: null,
      guard,
      applied: [...applied.done],
      conflicts: applied.conflicts,
      quarantined: plan.skipped
        .filter((item) => item.reason === "quarantine")
        .map((item) => item.path),
      reloadPending: applied.reloadPending,
      rejected: applied.rejected,
      serverConfirmed: applied.serverConfirmed,
    };
  } catch (error) {
    return {
      ...empty,
      status: fatalStatus(error) ?? "failed",
      error:
        error instanceof ApiRequestError
          ? { kind: error.kind, status: error.status, message: error.message }
          : {
              kind: null,
              status: null,
              message: error instanceof Error ? error.message : "Sync failed",
            },
    };
  }
}

function emptyResult(): SyncRunResult {
  return {
    status: "failed",
    plan: null,
    preview: null,
    guard: null,
    applied: [],
    conflicts: [],
    quarantined: [],
    reloadPending: [],
    rejected: [],
    serverConfirmed: false,
  };
}

function fatalStatus(error: unknown): SyncStatus | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.kind === "unauthorized" || error.kind === "forbidden") return "auth-stopped";
  if (error.kind === "version") return "version-stopped";
  return null;
}

async function repairJournal(request: SyncRequest): Promise<string[]> {
  const entries = await request.journal.list();
  if (entries.length === 0) return [];
  const repair: string[] = [];
  const remain: JournalEntry[] = [];
  for (const entry of entries) {
    let actual: string | null = null;
    try {
      const stat = await request.vault.stat(entry.path);
      actual = stat ? await sha256Hex(await request.vault.readBinary(entry.path)) : null;
    } catch {
      repair.push(entry.path);
      remain.push(entry);
      continue;
    }
    const state = classifyJournal(entry, actual);
    if (state === "complete" || state === "unchanged") continue;
    repair.push(entry.path);
    remain.push(entry);
  }
  await request.journal.replace(remain);
  return repair;
}

async function scanLocal(request: SyncRequest): Promise<{
  files: Array<{ path: string; sha256: string; size: number }>;
  stats: Map<string, LocalFileStat>;
  hashes: Map<string, string>;
  undetermined: Array<{ path: string; reason: "oversize" | "read-failed" }>;
  indexedCount: number;
}> {
  const listed = await request.vault.listFiles();
  const cached = await request.index.list();
  const dirty = new Set(request.dirtyPaths);
  const considered =
    request.full || request.forceRehash
      ? listed
      : listed.filter(
          (file) => dirty.has(file.path) || isUnderConfig(file.path, request.configDir),
        );
  const consideredPaths = new Set(considered.map((file) => file.path));
  const listedPaths = new Set(listed.map((file) => file.path));
  const files: Array<{ path: string; sha256: string; size: number }> = [];
  const stats = new Map<string, LocalFileStat>();
  const hashes = new Map<string, string>();
  const undetermined: Array<{ path: string; reason: "oversize" | "read-failed" }> = [];
  const cacheByPath = new Map(cached.map((entry) => [entry.path, entry]));

  for (const file of considered) {
    stats.set(file.path, file);
    if (file.size > MAX_FILE_BYTES) {
      undetermined.push({ path: file.path, reason: "oversize" });
      continue;
    }
    const previous = cacheByPath.get(file.path);
    try {
      const sha =
        !request.forceRehash &&
        previous &&
        previous.size === file.size &&
        isSameMTime(previous.mtime, file.mtime)
          ? previous.sha256
          : await sha256Hex(await request.vault.readBinary(file.localPath));
      files.push({ path: file.path, sha256: sha, size: file.size });
      hashes.set(file.path, sha);
    } catch {
      undetermined.push({ path: file.path, reason: "read-failed" });
    }
  }

  if (!request.full) {
    for (const entry of cached) {
      if (consideredPaths.has(entry.path) || undetermined.some((item) => item.path === entry.path))
        continue;
      if (isUnderConfig(entry.path, request.configDir) && !listedPaths.has(entry.path)) continue;
      if (dirty.has(entry.path) && !listedPaths.has(entry.path)) continue;
      files.push({ path: entry.path, sha256: entry.sha256, size: entry.size });
      hashes.set(entry.path, entry.sha256);
    }
  }
  return { files, stats, hashes, undetermined, indexedCount: cached.length };
}

async function fetchIndex(request: SyncRequest): Promise<{
  entries: IndexEntry[];
  invalid: Array<{ path: string; reason: SkipReason }>;
  seq: number;
  full: boolean;
}> {
  const cursor = await request.index.getCursor();
  const initialized = await request.index.isInitialized();
  const journalLeft = (await request.journal.list()).length > 0;
  const full = !initialized || cursor === 0 || journalLeft;
  const fetched = await readFullIndex(request.api, full ? undefined : cursor);
  const seq = fetched.seq;
  const entries = fetched.entries.filter(isValidIndexEntry);
  const invalid = fetched.entries
    .filter((entry) => !isValidIndexEntry(entry))
    .map((entry) => ({ path: entry.path, reason: "invalid-remote" as const }));
  const stashes = await request.index.getStashes();
  const seen = new Set(entries.map((entry) => entry.path));
  for (const [path, stash] of stashes) {
    if (seen.has(path)) continue;
    entries.push({
      path,
      sha256: stash.sha256,
      size: stash.size,
      rev: stash.rev,
      seq: stash.seq,
      deleted: stash.deleted,
      updatedAt: stash.seq,
    });
    seen.add(path);
  }
  if (!full) {
    for (const known of await request.index.list()) {
      if (seen.has(known.path) || (known.baseRev <= 0 && known.baseSha256 === null)) continue;
      entries.push({
        path: known.path,
        sha256: known.baseSha256,
        size: known.remoteSize ?? known.size,
        rev: known.baseRev,
        seq: cursor,
        deleted: known.baseSha256 === null,
        updatedAt: 0,
      });
    }
  }
  return { entries, invalid, seq, full };
}

function isValidIndexEntry(entry: IndexEntry): boolean {
  if (!isValidPath(entry.path)) return false;
  if (entry.deleted) return entry.sha256 === null || isSha256(entry.sha256);
  return entry.sha256 !== null && isSha256(entry.sha256);
}

function shapeInitial(
  items: PlanItem[],
  local: Array<{ path: string; sha256: string; size: number }>,
  remote: IndexEntry[],
  strategy: InitialStrategy | undefined,
): PlanItem[] {
  if (!strategy || strategy === "merge") return items;
  const localMap = new Map(local.map((file) => [file.path, file]));
  const remoteMap = new Map(remote.map((entry) => [entry.path, entry]));
  const paths = new Set([...localMap.keys(), ...remoteMap.keys()]);
  const shaped: PlanItem[] = [];
  for (const path of paths) {
    const localFile = localMap.get(path) ?? null;
    const remoteFile = remoteMap.get(path) ?? null;
    const remoteSha = remoteFile && !remoteFile.deleted ? remoteFile.sha256 : null;
    const localSha = localFile?.sha256 ?? null;
    if (localSha === remoteSha) {
      if (remoteFile) shaped.push(item(path, "adoptBase", localFile, remoteFile));
      continue;
    }
    if (strategy === "server") {
      if (remoteSha && remoteSha !== localSha) {
        shaped.push(item(path, "pull", localFile, remoteFile));
      } else if (!remoteSha && localSha) {
        shaped.push(item(path, "deleteLocal", localFile, remoteFile));
      }
    } else if (localSha && localSha !== remoteSha) {
      shaped.push(item(path, "push", localFile, remoteFile));
    } else if (remoteSha && !localSha) {
      shaped.push(item(path, "deleteRemote", localFile, remoteFile));
    }
  }
  return shaped;
}

function item(
  path: string,
  action: PlanItem["action"],
  localFile: { sha256: string; size: number } | null,
  remoteFile: IndexEntry | null,
): PlanItem {
  const remoteSha = remoteFile && !remoteFile.deleted ? remoteFile.sha256 : null;
  return {
    path,
    action,
    localSha256: localFile?.sha256 ?? null,
    remoteSha256: remoteSha,
    baseSha256: null,
    localSize: localFile?.size ?? null,
    remoteSize: remoteFile && !remoteFile.deleted ? remoteFile.size : null,
    expectedRev: remoteFile?.rev ?? 0,
    remoteRev: remoteFile?.rev ?? null,
  };
}

async function applyPlan(
  request: SyncRequest & { now: () => number },
  plan: SyncPlan,
  stats: Map<string, LocalFileStat>,
  corrected: Map<string, string>,
): Promise<{
  done: Set<string>;
  conflicts: string[];
  reloadPending: string[];
  rejected: Rejection[];
  oversized: string[];
  serverConfirmed: boolean;
}> {
  const done = new Set<string>();
  const conflicts: string[] = [];
  const reloadPending: string[] = [];
  const rejected: Rejection[] = [];
  const oversized: string[] = [];
  let serverConfirmed = false;
  const total = plan.items.length;
  const report = () => request.onProgress?.(done.size, total);
  if (request.strategy === "server") await snapshotLocal(request);

  for (const planItem of plan.items) {
    if (planItem.action === "noop" || planItem.action === "adoptBase") {
      await rememberBase(request, planItem, stats);
      done.add(planItem.path);
    }
  }
  report();
  const exclusive = createLock();
  const concurrency = request.concurrency ?? TRANSFER_CONCURRENCY;
  const budget = request.byteBudget ?? DESKTOP_BYTE_BUDGET;
  const localEdits = plan.items.filter(
    (entry) => entry.action === "pull" || entry.action === "deleteLocal",
  );
  for (const group of groupByBudget(
    localEdits,
    concurrency,
    budget,
    (item) => item.remoteSize ?? item.localSize ?? 0,
  )) {
    const applied = await Promise.all(
      group.map((planItem) =>
        skipFailedWrite(
          applyLocal(request, planItem, stats, reloadPending, exclusive),
          planItem.path,
          rejected,
        ),
      ),
    );
    for (const [index, ok] of applied.entries()) {
      const planItem = group[index];
      if (ok && planItem) done.add(planItem.path);
    }
    report();
  }
  const pushes: FileChange[] = [];
  for (const planItem of plan.items) {
    if (planItem.action === "deleteRemote") {
      pushes.push({
        path: planItem.path,
        deleted: true,
        expectedRev: planItem.remoteRev ?? planItem.expectedRev,
      });
    }
  }
  for (const planItem of plan.items.filter((entry) => entry.action === "conflict")) {
    const resolved = await skipFailedWrite(
      resolveConflict(request, planItem, stats, conflicts, pushes, reloadPending),
      planItem.path,
      rejected,
    );
    if (resolved) done.add(planItem.path);
  }
  const pushItems = plan.items.filter((entry) => entry.action === "push");
  for (const group of groupByBudget(
    pushItems,
    concurrency,
    budget,
    (item) => item.localSize ?? 0,
  )) {
    const uploaded = await Promise.all(
      group.map(async (planItem) => {
        const bytes = await currentBytes(request, planItem, stats);
        if (!bytes) return null;
        const sha = await sha256Hex(bytes);
        if (sha !== planItem.localSha256) {
          corrected.set(planItem.path, sha);
          return null;
        }
        const stored = await storeIfMissing(request.api, sha, bytes, () =>
          request.vault.readBinary(localPathOf(planItem.path, stats)),
        );
        if (!stored) {
          oversized.push(planItem.path);
          return null;
        }
        return {
          path: planItem.path,
          ...stored,
          expectedRev: planItem.remoteRev ?? planItem.expectedRev,
        };
      }),
    );
    for (const change of uploaded) if (change) pushes.push(change);
    report();
  }
  pushes.sort((left, right) => Number(!("deleted" in left)) - Number(!("deleted" in right)));
  for (let index = 0; index < pushes.length; index += 200) {
    const changes = pushes.slice(index, index + 200);
    const response = await request.api.commit({ requestId: crypto.randomUUID(), changes });
    if (response.applied.length > 0) serverConfirmed = true;
    for (const applied of response.applied) {
      done.add(applied.path);
      const change = changes.find((entry) => entry.path === applied.path);
      const sha256 = change && "sha256" in change ? change.sha256 : null;
      const current = await existingOrEmpty(request, applied.path, stats);
      await request.index.put({
        ...current,
        sha256: sha256 ?? current.sha256,
        size: change && "size" in change ? change.size : current.size,
        baseSha256: sha256,
        baseRev: applied.rev,
        remoteSize: change && "size" in change ? change.size : 0,
      });
    }
    for (const rejection of response.rejected) {
      rejected.push({ path: rejection.path, reason: rejection.reason });
    }
    report();
  }
  return { done, conflicts, reloadPending, rejected, oversized, serverConfirmed };
}

class LocalWriteError extends Error {
  constructor(path: string, options: ErrorOptions) {
    super(`Could not write ${path}`, options);
    this.name = "LocalWriteError";
  }
}

async function localWrite(path: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    throw new LocalWriteError(path, { cause: error });
  }
}

async function skipFailedWrite(
  applying: Promise<boolean>,
  path: string,
  rejected: Rejection[],
): Promise<boolean> {
  try {
    return await applying;
  } catch (error) {
    if (!(error instanceof LocalWriteError)) throw error;
    rejected.push({ path, reason: "writeFailed", detail: describeCause(error.cause) });
    return false;
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name;
  return String(cause);
}

async function applyLocal(
  request: SyncRequest & { now: () => number },
  planItem: PlanItem,
  stats: Map<string, LocalFileStat>,
  reloadPending: string[],
  exclusive: Exclusive,
): Promise<boolean> {
  if (!(await unchangedSinceScan(request, planItem, stats))) return false;
  request.onSelfWrite?.(planItem.path);
  const ioPath = localPathOf(planItem.path, stats);
  if (planItem.action === "deleteLocal") {
    await exclusive(async () => {
      await localWrite(planItem.path, () => request.vault.remove(ioPath));
      await removeEmptyParents(request.vault, planItem.path, request.configDir);
      await request.index.put({
        ...(await existingOrEmpty(request, planItem.path, stats)),
        baseSha256: null,
        baseRev: planItem.remoteRev ?? planItem.expectedRev,
        remoteSize: 0,
      });
    });
    return true;
  }
  if (!planItem.remoteSha256) return false;
  const bytes = await downloadVerified(
    request.api,
    planItem.remoteSha256,
    planItem.remoteSize ?? 0,
  );
  return exclusive(async () => {
    if (!(await unchangedSinceScan(request, planItem, stats))) return false;
    const written = await writeJournaled(
      request,
      planItem.path,
      ioPath,
      bytes,
      planItem.remoteSha256 ?? "",
    );
    if (!written) return false;
    await request.index.put({
      path: planItem.path,
      localPath: ioPath,
      mtime: request.now(),
      size: bytes.byteLength,
      sha256: planItem.remoteSha256 ?? "",
      baseSha256: planItem.remoteSha256,
      baseRev: planItem.remoteRev ?? 0,
      remoteSize: bytes.byteLength,
    });
    if (waitsForReload(request, planItem.path)) reloadPending.push(planItem.path);
    return true;
  });
}

async function writeJournaled(
  request: SyncRequest & { now: () => number },
  path: string,
  ioPath: string,
  bytes: ArrayBuffer,
  expectedSha256: string,
): Promise<boolean> {
  const previous = await request.index.get(path);
  const journal = await request.journal.list();
  journal.push({
    path,
    expectedSha256,
    previousSha256: previous?.sha256 ?? null,
    startedAt: request.now(),
  });
  await request.journal.replace(journal);
  request.onSelfWrite?.(path);
  await localWrite(path, () => request.vault.writeBinary(ioPath, bytes));
  const written = await sha256Hex(await request.vault.readBinary(ioPath));
  if (written !== expectedSha256) return false;
  await request.journal.replace(
    (await request.journal.list()).filter((entry) => entry.path !== path),
  );
  return true;
}

function waitsForReload(request: SyncRequest, path: string): boolean {
  if (!isUnderConfig(path, request.configDir)) return false;
  const quarantined = createQuarantineMatcher({
    configDir: request.configDir,
    codeConfiguredPluginIds: request.settings.codeConfiguredPluginIds,
  });
  return !quarantined(path);
}

type Exclusive = <T>(fn: () => Promise<T>) => Promise<T>;

function createLock(): Exclusive {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

async function resolveConflict(
  request: SyncRequest & { now: () => number },
  planItem: PlanItem,
  stats: Map<string, LocalFileStat>,
  conflicts: string[],
  pushes: FileChange[],
  reloadPending: string[],
): Promise<boolean> {
  if (!planItem.localSha256 || !planItem.remoteSha256) return false;
  const ioPath = localPathOf(planItem.path, stats);
  const localBytes = await request.vault.readBinary(ioPath);
  if (isBinaryPath(planItem.path)) {
    const copy = conflictCopyPath(planItem.path, request.deviceName, new Date(request.now()));
    const copySha = await sha256Hex(localBytes);
    if (!(await writeJournaled(request, copy, copy, localBytes, copySha))) return false;
    const remoteBytes = await downloadVerified(
      request.api,
      planItem.remoteSha256,
      planItem.remoteSize ?? 0,
    );
    if (!(await writeJournaled(request, planItem.path, ioPath, remoteBytes, planItem.remoteSha256)))
      return false;
    if (waitsForReload(request, planItem.path)) reloadPending.push(planItem.path);
    if (waitsForReload(request, copy)) reloadPending.push(copy);
    const stored = await storeIfMissing(request.api, copySha, localBytes, () =>
      request.vault.readBinary(copy),
    );
    if (!stored) return false;
    pushes.push({ path: copy, ...stored, expectedRev: 0 });
    await request.index.put({
      path: planItem.path,
      localPath: ioPath,
      mtime: request.now(),
      size: remoteBytes.byteLength,
      sha256: planItem.remoteSha256,
      baseSha256: planItem.remoteSha256,
      baseRev: planItem.remoteRev ?? 0,
      remoteSize: remoteBytes.byteLength,
    });
    return true;
  }
  const baseBytes = planItem.baseSha256
    ? await downloadVerified(request.api, planItem.baseSha256, 0)
    : new ArrayBuffer(0);
  const remoteBytes = await downloadVerified(
    request.api,
    planItem.remoteSha256,
    planItem.remoteSize ?? 0,
  );
  const merged = mergeFile({
    path: planItem.path,
    configDir: request.configDir,
    baseText: new TextDecoder().decode(baseBytes),
    localText: new TextDecoder().decode(localBytes),
    remoteText: new TextDecoder().decode(remoteBytes),
    autoMerge: request.settings.autoMerge,
  });
  if (merged.kind === "merged") {
    const bytes = new TextEncoder().encode(merged.text).buffer;
    const sha = await sha256Hex(bytes);
    if (!(await writeJournaled(request, planItem.path, ioPath, bytes, sha))) return false;
    if (waitsForReload(request, planItem.path)) reloadPending.push(planItem.path);
    const stored = await storeIfMissing(request.api, sha, bytes, () =>
      request.vault.readBinary(ioPath),
    );
    if (!stored) return false;
    pushes.push({
      path: planItem.path,
      ...stored,
      expectedRev: planItem.remoteRev ?? planItem.expectedRev,
    });
    return true;
  }
  const storedLocal = await storeIfMissing(request.api, planItem.localSha256, localBytes, () =>
    request.vault.readBinary(ioPath),
  );
  if (!storedLocal) return false;
  await request.api.createConflict({
    path: planItem.path,
    baseSha: planItem.baseSha256,
    localSha: storedLocal.sha256,
    remoteSha: planItem.remoteSha256,
  });
  conflicts.push(planItem.path);
  return true;
}

async function snapshotLocal(request: SyncRequest): Promise<void> {
  const files = await request.vault.listFiles();
  const document: Record<string, { sha256: string; size: number }> = {};
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) continue;
    const bytes = await request.vault.readBinary(file.localPath);
    const stored = await storeIfMissing(request.api, await sha256Hex(bytes), bytes, () =>
      request.vault.readBinary(file.localPath),
    );
    if (stored) document[file.path] = stored;
  }
  await request.api.createSnapshot({ files: document });
}

async function rememberBase(
  request: SyncRequest,
  planItem: PlanItem,
  stats: Map<string, LocalFileStat>,
): Promise<void> {
  const sha =
    planItem.action === "adoptBase"
      ? (planItem.localSha256 ?? planItem.remoteSha256)
      : planItem.action === "noop"
        ? (planItem.remoteSha256 ?? planItem.baseSha256)
        : planItem.baseSha256;
  const rev = planItem.remoteRev ?? planItem.expectedRev;
  const current = await existingOrEmpty(request, planItem.path, stats);
  if (planItem.action === "noop" && current.baseRev === rev && current.baseSha256 === sha) {
    return;
  }
  await request.index.put({
    ...current,
    baseSha256: sha,
    baseRev: rev,
    remoteSize: planItem.remoteSize ?? current.remoteSize,
  });
}

async function unchangedSinceScan(
  request: SyncRequest,
  planItem: PlanItem,
  stats: Map<string, LocalFileStat>,
): Promise<boolean> {
  const scanned = stats.get(planItem.path);
  if (!scanned) return planItem.localSha256 === null;
  const again = await request.vault.stat(scanned.localPath);
  if (!again) return false;
  if (again.size === scanned.size && isSameMTime(again.mtime, scanned.mtime)) return true;
  const sha = await sha256Hex(await request.vault.readBinary(again.localPath));
  return sha === planItem.localSha256;
}

async function currentBytes(
  request: SyncRequest,
  planItem: PlanItem,
  stats: Map<string, LocalFileStat>,
): Promise<ArrayBuffer | null> {
  if (!(await unchangedSinceScan(request, planItem, stats))) return null;
  return request.vault.readBinary(localPathOf(planItem.path, stats));
}

async function existingOrEmpty(
  request: SyncRequest,
  path: string,
  stats: Map<string, LocalFileStat>,
): Promise<LocalIndexEntry> {
  const current = await request.index.get(path);
  if (current) return current;
  const stat = stats.get(path);
  return {
    path,
    localPath: stat?.localPath ?? path,
    mtime: stat?.mtime ?? 0,
    size: stat?.size ?? 0,
    sha256: "",
    baseSha256: null,
    baseRev: 0,
  };
}

async function persistCaches(
  request: SyncRequest,
  stats: Map<string, LocalFileStat>,
  hashes: Map<string, string>,
  corrected: Map<string, string>,
): Promise<void> {
  for (const [path, stat] of stats) {
    const sha256 = corrected.get(path) ?? hashes.get(path);
    if (!sha256) continue;
    await request.index.put({
      baseSha256: null,
      baseRev: 0,
      ...(await request.index.get(path)),
      path,
      localPath: stat.localPath,
      mtime: stat.mtime,
      size: stat.size,
      sha256,
    });
  }
}

async function stashUnapplied(
  request: SyncRequest,
  remote: IndexEntry[],
  done: Set<string>,
): Promise<void> {
  const stashes = await request.index.getStashes();
  for (const entry of remote) {
    if (done.has(entry.path)) stashes.delete(entry.path);
    else {
      stashes.set(entry.path, {
        sha256: entry.sha256,
        size: entry.size,
        rev: entry.rev,
        seq: entry.seq,
        deleted: entry.deleted,
      });
    }
  }
  await request.index.setStashes(stashes);
}

async function downloadVerified(
  api: ApiClient,
  sha256: string,
  size: number,
): Promise<ArrayBuffer> {
  const bytes =
    size > RANGE_CHUNK_BYTES ? await downloadRange(api, sha256, size) : await api.getObject(sha256);
  if ((await sha256Hex(bytes)) !== sha256) {
    throw new ApiRequestError("checksum", 422, null, "Downloaded object did not match its hash");
  }
  return bytes;
}

async function downloadRange(api: ApiClient, sha256: string, size: number): Promise<ArrayBuffer> {
  const parts: ArrayBuffer[] = [];
  for (let start = 0; start < size; start += RANGE_CHUNK_BYTES) {
    const end = Math.min(start + RANGE_CHUNK_BYTES, size) - 1;
    parts.push(await api.getObject(sha256, { start, end }));
  }
  return new Blob(parts).arrayBuffer();
}

async function storeIfMissing(
  api: ApiClient,
  sha256: string,
  bytes: ArrayBuffer,
  reread: () => Promise<ArrayBuffer>,
): Promise<{ sha256: string; size: number } | null> {
  if ((await api.existingObjects([sha256])).has(sha256)) return { sha256, size: bytes.byteLength };
  try {
    return await uploadBytes(api, sha256, bytes, reread);
  } catch (error) {
    if (isApiFailure(error, "too-large")) return null;
    throw error;
  }
}

async function uploadBytes(
  api: ApiClient,
  sha256: string,
  bytes: ArrayBuffer,
  reread: () => Promise<ArrayBuffer>,
): Promise<{ sha256: string; size: number }> {
  try {
    await sendObject(api, sha256, bytes);
    return { sha256, size: bytes.byteLength };
  } catch (error) {
    if (!isApiFailure(error, "checksum")) throw error;
    const again = await reread();
    const next = await sha256Hex(again);
    await sendObject(api, next, again);
    return { sha256: next, size: again.byteLength };
  }
}

async function sendObject(api: ApiClient, sha256: string, bytes: ArrayBuffer): Promise<void> {
  if (bytes.byteLength <= SINGLE_PUT_MAX_BYTES) {
    await api.putObject(sha256, bytes);
    return;
  }
  let upload: UploadCreateResponse;
  try {
    upload = await api.createUpload(sha256, bytes.byteLength);
  } catch (error) {
    if (isApiFailure(error, "conflict") && (await api.headObject(sha256))) return;
    throw error;
  }
  const partCount = Math.ceil(bytes.byteLength / MULTIPART_PART_BYTES);
  for (let part = 1; part <= partCount; part += 1) {
    const start = (part - 1) * MULTIPART_PART_BYTES;
    await api.uploadPart(upload.uploadId, part, bytes.slice(start, start + MULTIPART_PART_BYTES));
  }
  await api.completeUpload(upload.uploadId);
}

function isApiFailure(error: unknown, kind: ApiFailureKind): boolean {
  return error instanceof ApiRequestError && error.kind === kind;
}

async function removeEmptyParents(
  vault: VaultPort,
  path: string,
  configDir: string,
): Promise<void> {
  let parent = parentPath(path);
  while (parent && parent !== configDir) {
    await vault.removeEmptyFolder(parent);
    parent = parentPath(parent);
  }
}

async function forgetExcludedBases(request: SyncRequest, plan: SyncPlan): Promise<void> {
  for (const skipped of plan.skipped) {
    if (skipped.reason !== "excluded") continue;
    const current = await request.index.get(skipped.path);
    if (!current || (current.baseSha256 === null && current.baseRev === 0)) continue;
    await request.index.put({ ...current, baseSha256: null, baseRev: 0 });
  }
}

function nextCursor(
  previous: number,
  remoteSeq: number,
  entries: IndexEntry[],
  done: Set<string>,
  skipped: Array<{ path: string; reason: string }>,
): number {
  const ignored = new Set(
    skipped.filter((item) => item.reason === "excluded").map((item) => item.path),
  );
  const blocking = entries.filter(
    (entry) => entry.seq > previous && !done.has(entry.path) && !ignored.has(entry.path),
  );
  if (blocking.length === 0) return remoteSeq;
  return Math.min(...blocking.map((entry) => entry.seq)) - 1;
}

function localPathOf(path: string, stats: Map<string, LocalFileStat>): string {
  return stats.get(path)?.localPath ?? path;
}

async function recordQuarantine(
  request: SyncRequest,
  plan: SyncPlan,
  remote: IndexEntry[],
  stats: Map<string, LocalFileStat>,
  hashes: Map<string, string>,
): Promise<void> {
  const remoteByPath = new Map(remote.map((entry) => [entry.path, entry]));
  const approved = new Set(request.approved.map((item) => `${item.path}\0${item.sha256}`));
  for (const skipped of plan.skipped) {
    if (skipped.reason !== "quarantine") continue;
    const remoteEntry = remoteByPath.get(skipped.path);
    const remoteSha = remoteEntry && !remoteEntry.deleted ? remoteEntry.sha256 : null;
    if (!remoteSha || approved.has(`${skipped.path}\0${remoteSha}`)) continue;
    const current = await request.index.get(skipped.path);
    const stat = stats.get(skipped.path);
    await request.index.put({
      baseSha256: null,
      baseRev: 0,
      ...current,
      path: skipped.path,
      localPath: stat?.localPath ?? current?.localPath ?? skipped.path,
      mtime: stat?.mtime ?? current?.mtime ?? 0,
      size: stat?.size ?? current?.size ?? 0,
      sha256: hashes.get(skipped.path) ?? current?.sha256 ?? "",
      heldRemoteSha256: remoteSha,
    });
  }
}

async function clearHeld(request: SyncRequest, done: Set<string>): Promise<void> {
  for (const path of done) {
    const current = await request.index.get(path);
    if (!current?.heldRemoteSha256) continue;
    const next = { ...current };
    delete next.heldRemoteSha256;
    await request.index.put(next);
  }
}

function sanitizeDeviceName(deviceName: string): string {
  const safe = [...deviceName].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const unsafe = codePoint < 0x20 || codePoint === 0x7f || /[\\/<>:"|?*]/.test(character);
    return unsafe ? " " : character;
  });
  return safe.join("").trim() || "device";
}

function conflictCopyPath(path: string, deviceName: string, now: Date): string {
  const parent = parentPath(path);
  const base = pathBasename(path);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const extension = dot > 0 ? base.slice(dot) : "";
  const safeDevice = sanitizeDeviceName(deviceName);
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const name = `${stem} (conflict ${safeDevice} ${stamp})${extension}`;
  return parent === null ? name : `${parent}/${name}`;
}
