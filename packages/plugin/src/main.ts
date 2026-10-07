import {
  type ApiClient,
  diffSnapshot,
  exportPlan,
  type InitialStrategy,
  readFullIndex,
  runSync,
  type SyncPlan,
  type SyncRunResult,
} from "@obsttorte/engine";
import {
  type ConflictRecord,
  DESKTOP_BYTE_BUDGET,
  type LogEntry,
  MOBILE_BYTE_BUDGET,
  parseSharedSettings,
  type SharedSettings,
} from "@obsttorte/shared";
import {
  type ButtonComponent,
  Events,
  Menu,
  type MenuPositionDef,
  Modal,
  Notice,
  Platform,
  Plugin,
  Setting,
  setTooltip,
} from "obsidian";
import {
  approveQuarantine,
  describeQuarantine,
  loadConflictTexts,
  rejectQuarantine,
  resolveAll,
  resolveConflict,
} from "./actions";
import { formatBytes, formatList, formatRelative, setLanguage, t } from "./i18n";
import { ObsidianVaultPort } from "./obsidian-vault-port";
import { describeFailure, failureOf } from "./problems";
import {
  type DeviceListing,
  emptyDeviceSettings,
  isAllowedServerUrl,
  loadDeviceSettings,
  ObsttorteSettingTab,
  type PluginData,
  readSharedSettings,
  writeSharedSettings,
} from "./settings";
import { DiskJournal, IndexedDbIndex } from "./storage";
import { createApiClient } from "./transport";
import {
  CONFLICT_VIEW_TYPE,
  ConflictView,
  LOG_VIEW_TYPE,
  QUARANTINE_VIEW_TYPE,
  QuarantineView,
  SNAPSHOT_VIEW_TYPE,
  SnapshotView,
  type SyncLogSnapshot,
  SyncLogView,
  type SyncSignal,
} from "./views";

function storageConcern(result: Record<string, unknown>): boolean {
  return [result.d1Level, result.r2Level].some(
    (level) => level === "notice" || level === "warning",
  );
}

function byteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emphasizeUnfamiliar(entry: LogEntry, familiar: ReadonlySet<string>): LogEntry {
  if (familiar.has(entry.deviceId) || entry.highlight.includes("unknown-device")) return entry;
  return { ...entry, highlight: [...entry.highlight, "unknown-device"] };
}

const INITIAL_COUNTS = ["push", "pull", "conflict", "deleteLocal", "deleteRemote"] as const;

function describeCounts(counts: Record<(typeof INITIAL_COUNTS)[number], number>): string {
  const parts = INITIAL_COUNTS.filter((key) => counts[key] > 0).map((key) =>
    t(`initial.${key}`, { count: counts[key] }),
  );
  return parts.length > 0 ? formatList(parts) : t("initial.none");
}

/** 判断を求めない知らせは、読める程度の時間で消す */
const INFO_NOTICE_MS = 10_000;
const STOP_NOTICES = ["setup", "auth", "version", "auto-paused", "aborted"];

const FULL_REHASH_DESKTOP_MS = 24 * 60 * 60 * 1000;
const FULL_REHASH_MOBILE_MS = 7 * 24 * 60 * 60 * 1000;

/** 書きかけの版を履歴に積みすぎないように、編集が止まってから送る */
const EDIT_IDLE_MS = 30_000;
/** 設計書のコストの見積もりは、自動の同期が1分に1回までであることを前提にしている */
const AUTO_SYNC_GAP_MS = 60_000;

const SYNC_STRENGTH = { push: 0, partial: 1, full: 2 } as const;
type SyncKind = keyof typeof SYNC_STRENGTH;

function stronger(current: SyncKind | null, next: SyncKind): SyncKind {
  return current && SYNC_STRENGTH[current] >= SYNC_STRENGTH[next] ? current : next;
}

export default class ObsttortePlugin extends Plugin {
  private data: PluginData = emptyDeviceSettings("");
  private status = this.addStatusBarItem();
  private running = false;
  private queued: SyncKind | null = null;
  private selfWrites = new Set<string>();
  private dirty = new Set<string>();
  private stopped: "ok" | "setup" | "auth" | "version" | "error" | "paused" = "ok";
  private problem: string | null = null;
  private conflicts = 0;
  private quarantine: string[] = [];
  private undetermined = 0;
  private writeFailed = 0;
  private notices = new Map<string, { notice: Notice; text: HTMLElement | null }>();
  private pluginDataModalOpen = false;
  private shared: SharedSettings = parseSharedSettings({});
  private acknowledgeGuard = false;
  private pendingStrategy: InitialStrategy | undefined;
  private lastPlan: SyncPlan | null = null;
  private progress: { done: number; total: number } | null = null;
  private deviceName = "this device";
  private deviceId = "";
  private newPluginIds: string[] = [];
  /** 設定画面は同期的に項目を組み立てるので、最後に見たプラグインの一覧を持っておく */
  private pluginIds: string[] = [];
  private timer = 0;
  private armedMinutes = 0;
  private failureStreak = 0;
  private scheduled: SyncKind | null = null;
  private scheduleTimer = 0;
  private lastSyncAt = 0;
  private events = new Events();
  private onSynced: SyncSignal = (listener) => {
    const ref = this.events.on("synced", listener);
    return () => this.events.offref(ref);
  };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.pluginIds = await this.knownPluginIds();
    this.data.reloadPending = [];
    setLanguage(this.data.languageOverride);
    this.registerViews();
    this.addSettingTab(
      new ObsttorteSettingTab(
        this.app,
        this,
        () => this.data,
        (data) => this.persist(data),
        (settings) => this.persistShared(settings),
        () => this.checkConnection(),
        () => this.shared,
        () => this.deviceListing(),
        () => this.pluginIds,
        {
          syncNow: () => void this.requestSync("full"),
          exportPlan: () => void this.copyPlan(false),
          openSnapshots: () => void this.openView(SNAPSHOT_VIEW_TYPE),
          rebuildIndex: () => this.rebuildIndex(),
        },
      ),
    );
    this.addCommand({
      id: "sync",
      name: t("commands.syncNow"),
      callback: () => void this.requestSync("full"),
    });
    this.addCommand({
      id: "export-plan",
      name: t("commands.exportPlan"),
      callback: () => void this.copyPlan(false),
    });
    this.addCommand({
      id: "export-plan-redacted",
      name: t("commands.exportPlanRedacted"),
      callback: () => void this.copyPlan(true),
    });
    this.addCommand({
      id: "open-status",
      name: t("commands.openStatus"),
      callback: () => this.openStatusMenu(),
    });
    this.addCommand({
      id: "purge",
      name: t("commands.purge"),
      callback: () => void this.askPurge(),
    });
    const views: Array<[string, string]> = [
      ["open-conflicts", CONFLICT_VIEW_TYPE],
      ["open-approvals", QUARANTINE_VIEW_TYPE],
      ["open-snapshots", SNAPSHOT_VIEW_TYPE],
      ["open-log", LOG_VIEW_TYPE],
    ];
    for (const [id, type] of views) {
      this.addCommand({
        id,
        name: t(`commands.${id}`),
        callback: () => void this.openView(type),
      });
    }
    this.addRibbonIcon("refresh-cw", t("commands.syncNow"), () => void this.requestSync("full"));
    this.status.setAttribute("role", "button");
    this.status.setAttribute("aria-haspopup", "menu");
    this.status.tabIndex = 0;
    this.status.addEventListener("click", (event) => this.openMenu(event));
    this.status.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.openStatusMenu();
    });
    this.armTimer();
    // 「3分前」のような相対時刻が古くならないように描き直す
    this.registerInterval(window.setInterval(() => this.renderStatus(), 60_000));
    document.addEventListener("visibilitychange", this.onVisible);
    this.registerDomEvent(window, "online", () => this.scheduleSync("full", 0));
    this.status.addClass("obsttorte-status", "mod-clickable");
    this.renderStatus();
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", (file) => this.markDirty(file.path)));
      this.registerEvent(this.app.vault.on("modify", (file) => this.markDirty(file.path)));
      this.registerEvent(this.app.vault.on("delete", (file) => this.markDirty(file.path)));
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          this.markDirty(oldPath);
          this.markDirty(file.path);
        }),
      );
      void this.requestSync("full");
    });
  }

  onunload(): void {
    document.removeEventListener("visibilitychange", this.onVisible);
    this.cancelScheduled();
    void Promise.race([
      this.requestSync("push"),
      new Promise((resolve) => window.setTimeout(resolve, 5000)),
    ]);
  }

  private async loadSettings(): Promise<void> {
    const stored: unknown = await this.loadData();
    const storedId =
      stored && typeof stored === "object" && "installId" in stored ? stored.installId : null;
    const hasId = typeof storedId === "string" && storedId.length > 0;
    this.data = loadDeviceSettings(stored, hasId ? storedId : crypto.randomUUID());
    if (!hasId) await this.persist(this.data);
    setLanguage(this.data.languageOverride);
    try {
      this.shared = await readSharedSettings(this.app);
    } catch (error) {
      this.onceNotice(
        "shared-settings",
        t("notice.sharedSettings", {
          path: `${this.app.vault.configDir}/obsttorte.json`,
          message: error instanceof Error ? error.message : "",
        }),
        true,
      );
      throw error;
    }
  }

  private registerViews(): void {
    const vault = () => new ObsidianVaultPort(this.app, this.selfWrites);
    this.registerView(
      CONFLICT_VIEW_TYPE,
      (leaf) =>
        new ConflictView(leaf, this.onSynced, {
          load: async () => (await this.api()?.conflicts()) ?? [],
          texts: async (conflict) => {
            const api = this.api();
            if (!api) return { base: "", local: "", remote: "" };
            return loadConflictTexts(api, vault(), conflict);
          },
          resolve: async (conflict, choice, text) => {
            const api = this.api();
            if (!api) return;
            await resolveConflict(api, vault(), conflict, choice, text);
            await this.markConfirmed();
            await this.requestSync("full");
          },
          resolveAll: async (choice) => {
            const api = this.api();
            if (!api) return;
            const result = await resolveAll(api, vault(), await api.conflicts(), choice);
            new Notice(t("bulk.result", result));
            if (result.resolved > 0) await this.markConfirmed();
            await this.requestSync("full");
          },
          takeOver: async (strategy) => {
            const api = this.api();
            if (!api) return;
            const result = await this.sync("full", { strategy, acknowledgeGuard: true });
            if (result?.status !== "ok") return;
            const conflicts = await api.conflicts();
            const side = strategy === "device" ? "local" : "remote";
            const { resolved, failed } = await resolveAll(api, vault(), conflicts, side);
            if (conflicts.length > 0) new Notice(t("bulk.result", { resolved, failed }));
            if (resolved > 0) {
              await this.markConfirmed();
              await this.requestSync("full");
            }
          },
        }),
    );
    this.registerView(
      QUARANTINE_VIEW_TYPE,
      (leaf) =>
        new QuarantineView(leaf, this.onSynced, {
          paths: () => this.quarantine,
          newPluginIds: () => this.newPluginIds,
          detail: async (path) => {
            const api = this.api();
            if (!api) {
              return {
                path,
                sha256: "",
                size: 0,
                files: [],
                manifest: null,
                previousManifest: null,
                newPlugin: false,
              };
            }
            return describeQuarantine(api, vault(), path, this.newPluginIds);
          },
          approve: async (path, sha256) => {
            const api = this.api();
            if (!api) return false;
            const approved = await approveQuarantine(api, path, sha256);
            if (!approved) return false;
            await new IndexedDbIndex(this.data.installId).approve(path, approved);
            this.quarantine = this.quarantine.filter((item) => item !== path);
            await this.requestSync("full");
            return true;
          },
          reject: async (path) => {
            const api = this.api();
            if (!api) return;
            await rejectQuarantine(api, vault(), path);
            this.quarantine = this.quarantine.filter((item) => item !== path);
            await this.requestSync("full");
          },
        }),
    );
    this.registerView(
      SNAPSHOT_VIEW_TYPE,
      (leaf) =>
        new SnapshotView(
          leaf,
          this.onSynced,
          async () => (await this.api()?.snapshots()) ?? [],
          async (id) => {
            const api = this.api();
            if (!api) return { added: [], changed: [], removed: [] };
            const document = await api.snapshot(id);
            return diffSnapshot((await readFullIndex(api)).entries, document.files);
          },
          async (id, paths) => {
            const api = this.api();
            if (!api) return;
            const result = await api.restore({ snapshotId: id, ...(paths ? { paths } : {}) });
            const count = result.applied.length;
            new Notice(
              result.rejected.length > 0
                ? t("snapshots.restoredPartly", { count, rejected: result.rejected.length })
                : t("snapshots.restored", { count }),
            );
            await this.requestSync("full");
          },
        ),
    );
    this.registerView(
      LOG_VIEW_TYPE,
      (leaf) =>
        new SyncLogView(
          leaf,
          this.onSynced,
          () => this.syncLog(),
          () => this.copyPlan(true),
        ),
    );
  }

  private onVisible = (): void => {
    if (!Platform.isMobile) return;
    if (document.visibilityState === "visible") {
      void this.requestSync("full");
      return;
    }
    // モバイルは裏に回るとすぐ止められるので、止められる前に書いた分だけ送っておく
    if (this.dirty.size === 0 || this.stopped === "auth" || this.stopped === "version") return;
    if (this.data.autoSyncPaused) return;
    this.cancelScheduled();
    void this.requestSync("push");
  };

  private markDirty(path: string): void {
    if (this.selfWrites.has(path)) {
      this.selfWrites.delete(path);
      return;
    }
    this.dirty.add(path);
    this.scheduleSync("partial", EDIT_IDLE_MS);
  }

  private scheduleSync(kind: SyncKind, waitMs: number): void {
    this.scheduled = stronger(this.scheduled, kind);
    window.clearTimeout(this.scheduleTimer);
    const wait = Math.max(waitMs, this.lastSyncAt + AUTO_SYNC_GAP_MS - Date.now());
    this.scheduleTimer = window.setTimeout(() => {
      const next = this.scheduled;
      this.scheduled = null;
      this.scheduleTimer = 0;
      if (next) void this.requestSync(next);
    }, wait);
  }

  private cancelScheduled(): void {
    window.clearTimeout(this.scheduleTimer);
    this.scheduleTimer = 0;
    this.scheduled = null;
  }

  private async requestSync(kind: SyncKind): Promise<void> {
    // Vaultを読み込み終えるまではファイルの一覧が欠けていて、消していないファイルを削除と取り違える
    if (!this.app.workspace.layoutReady) return;
    if (this.data.syncMode === "paused") {
      this.stopped = "paused";
      this.renderStatus();
      return;
    }
    if (
      kind === "partial" &&
      (this.data.autoSyncPaused || this.stopped === "auth" || this.stopped === "version")
    ) {
      return;
    }
    if (this.running) {
      this.queued = stronger(this.queued, kind);
      return;
    }
    this.running = true;
    try {
      do {
        const next = this.queued ?? kind;
        this.queued = null;
        kind = next;
        await this.sync(next);
      } while (this.queued);
    } finally {
      this.running = false;
    }
  }

  private async sync(
    kind: SyncKind,
    options: {
      dryRun?: boolean;
      strategy?: InitialStrategy;
      acknowledgeGuard?: boolean;
      present?: boolean;
    } = {},
  ): Promise<SyncRunResult | null> {
    const api = this.api();
    if (!api) {
      this.stopped = "setup";
      this.problem = this.missingConnection();
      this.onceNotice("setup", this.problem);
      this.renderStatus();
      return null;
    }
    if (this.stopped === "setup") this.stopped = "ok";
    this.dismiss("setup");
    if (!options.dryRun) this.lastSyncAt = Date.now();
    await this.readHealth(api);
    const dirtyBefore = new Set(this.dirty);
    let openConflicts: ConflictRecord[] | null = null;
    if (!options.strategy) {
      try {
        openConflicts = await api.conflicts();
      } catch {
        openConflicts = null;
      }
    }
    const index = new IndexedDbIndex(this.data.installId);
    const journal = this.journal();
    const forceRehash = !options.dryRun && this.rehashDue();
    this.pluginIds = await this.knownPluginIds();
    this.progress = { done: 0, total: 0 };
    this.renderStatus();
    try {
      const result = await runSync({
        vault: new ObsidianVaultPort(this.app, this.selfWrites),
        api,
        index,
        journal,
        settings: this.shared,
        mode: kind === "push" ? "push-only" : this.data.syncMode,
        configDir: this.app.vault.configDir,
        selfId: this.manifest.id,
        deviceName: this.deviceName,
        full: kind === "full" || options.strategy !== undefined,
        forceRehash,
        dirtyPaths: options.strategy ? [] : [...this.dirty],
        reloadPending: options.strategy ? [] : this.data.reloadPending,
        unresolvedConflicts: openConflicts?.map((conflict) => conflict.path) ?? [],
        approved: await index.approvals(),
        knownPluginIds: this.pluginIds,
        onSelfWrite: (path) => this.selfWrites.add(path),
        byteBudget: Platform.isMobile ? MOBILE_BYTE_BUDGET : DESKTOP_BYTE_BUDGET,
        acknowledgeGuard: options.acknowledgeGuard ?? this.acknowledgeGuard,
        strategy: options.strategy,
        dryRun: options.dryRun,
        onProgress: (done, total) => {
          this.progress = { done, total };
          this.renderStatus();
        },
      });
      if (!options.dryRun) {
        this.acknowledgeGuard = false;
        if (result.status === "ok") this.settleDirty(dirtyBefore, result);
        if (forceRehash && result.status === "ok") this.data.lastRehashAt = Date.now();
        if (result.status === "ok" || result.status === "aborted") this.pendingStrategy = undefined;
      }
      if (openConflicts) {
        const known = new Set(openConflicts.map((conflict) => conflict.path));
        this.conflicts =
          openConflicts.length + result.conflicts.filter((path) => !known.has(path)).length;
      } else if (result.conflicts.length > 0) {
        this.conflicts += result.conflicts.length;
      }
      if (options.present !== false) {
        await this.present(result);
        this.events.trigger("synced");
      }
      return result;
    } finally {
      this.progress = null;
      this.renderStatus();
    }
  }

  private async present(result: SyncRunResult): Promise<void> {
    this.problem = null;
    const stoppedNow = ["auth-stopped", "version-stopped", "failed", "aborted"];
    if (!stoppedNow.includes(result.status)) this.dismiss(...STOP_NOTICES);
    if (result.status !== "needs-guard-confirm") this.dismiss("guard");
    if (result.status === "auth-stopped" || result.status === "version-stopped") {
      this.stopped = result.status === "auth-stopped" ? "auth" : "version";
      this.problem = describeFailure(result.error);
      this.onceNotice(this.stopped, t("notice.stopped", { reason: this.problem }), true);
    } else if (result.status === "needs-initial-choice" && result.preview) {
      this.askInitial(result);
    } else if (result.status === "needs-guard-confirm") {
      const guard = result.guard?.kind === "confirm" ? result.guard : null;
      this.actionNotice(
        "guard",
        t("notice.guard", {
          deletions: guard?.deletions ?? 0,
          changes: guard?.changes ?? 0,
        }),
        () => this.askGuard(result),
        t("notice.review"),
      );
    } else if (result.status === "failed") {
      this.failureStreak += 1;
      this.stopped = "error";
      this.problem = describeFailure(result.error);
      if (this.failureStreak >= 2 && !this.data.autoSyncPaused) {
        this.data.autoSyncPaused = true;
        this.onceNotice("auto-paused", t("notice.autoPaused", { reason: this.problem }), true);
      }
      await this.persist(this.data);
    } else if (result.status === "aborted") {
      this.stopped = "error";
      this.problem =
        result.guard?.kind === "abort"
          ? t(`problem.${result.guard.reason}`)
          : describeFailure(result.error);
      this.onceNotice("aborted", t("notice.stopped", { reason: this.problem }), true);
    } else {
      this.failureStreak = 0;
      this.stopped = "ok";
      if (result.serverConfirmed) this.data.lastConfirmedAt = Date.now();
      this.data.reloadPending = result.reloadPending;
      this.data.autoSyncPaused = false;
      await this.persist(this.data);
    }
    this.quarantine = result.quarantined;
    this.newPluginIds = result.plan?.newPluginIds ?? [];
    const skipped = result.plan?.skipped ?? [];
    const unreadable = skipped.filter(
      (item) => item.reason === "oversize" || item.reason === "read-failed",
    ).length;
    const unportable = skipped.filter((item) => item.reason === "unportable-name").length;
    this.undetermined =
      unreadable +
      unportable +
      skipped.filter((item) => item.reason === "plugin-data-unconfirmed").length;
    this.lastPlan = result.plan;
    if (result.plan) await this.rememberPlan(result.plan, result.rejected);
    const collisions = result.rejected.filter((item) => item.reason === "pathCollision");
    if (collisions.length > 0) {
      this.onceNotice("path-collision", t("notice.pathCollision", { count: collisions.length }));
    }
    if (unreadable > 0) {
      this.onceNotice("undetermined", t("notice.undetermined", { count: unreadable }));
    }
    if (unportable > 0) {
      this.onceNotice("unportable-name", t("notice.unportableName", { count: unportable }));
    }
    const invalidRemote = skipped.filter((item) => item.reason === "invalid-remote").length;
    if (invalidRemote > 0) {
      this.onceNotice("invalid-remote", t("notice.invalidRemote", { count: invalidRemote }));
    }
    if (result.status === "ok") {
      this.writeFailed = result.rejected.filter((item) => item.reason === "writeFailed").length;
    }
    if (this.writeFailed > 0)
      this.actionNotice(
        "write-failed",
        t("notice.writeFailed", { count: this.writeFailed }),
        () => void this.openView(LOG_VIEW_TYPE),
        t("menu.openLog"),
      );
    else this.dismiss("write-failed");
    if (this.conflicts > 0)
      this.actionNotice(
        "conflict",
        t("notice.conflict", { count: this.conflicts }),
        () => void this.openView(CONFLICT_VIEW_TYPE),
      );
    else this.dismiss("conflict");
    if (this.quarantine.length > 0)
      this.actionNotice(
        "quarantine",
        t("notice.quarantine", { count: this.quarantine.length }),
        () => void this.openView(QUARANTINE_VIEW_TYPE),
        t("notice.review"),
      );
    else this.dismiss("quarantine");
    if (result.reloadPending.length > 0)
      this.actionNotice(
        "reload",
        t("notice.reload"),
        () => window.location.reload(),
        t("notice.reloadButton"),
      );
    else this.dismiss("reload");
    const unconfirmed =
      result.plan?.skipped.filter((item) => item.reason === "plugin-data-unconfirmed") ?? [];
    if (unconfirmed.length > 0) {
      this.onceNotice("plugin-data", t("notice.pluginData", { count: unconfirmed.length }));
      this.askPluginData(unconfirmed.map((item) => item.path));
    }
    const styles = result.plan?.stylePaths.length ?? 0;
    if (styles > 0) this.onceNotice("style", t("notice.style", { count: styles }));
    this.renderStatus();
  }

  private askInitial(result: SyncRunResult): void {
    const modal = new Modal(this.app);
    modal.setTitle(t("initial.title"));
    modal.contentEl.createEl("p", { text: t("initial.intro") });
    const choices: InitialStrategy[] = ["merge", "server", "device"];
    for (const choice of choices) {
      const counts = result.preview?.[choice];
      const deletes = (counts?.deleteLocal ?? 0) + (counts?.deleteRemote ?? 0);
      new Setting(modal.contentEl)
        .setName(t(`initial.${choice}`))
        .setDesc(
          createFragment((fragment) => {
            fragment.createDiv({ text: t(`initial.${choice}Desc`) });
            if (counts) fragment.createDiv({ text: describeCounts(counts) });
          }),
        )
        .addButton((button) => {
          button.setButtonText(t("initial.choose")).onClick(() => {
            modal.close();
            this.pendingStrategy = choice;
            void this.sync("full", { strategy: choice });
          });
          if (choice === "merge") button.setCta();
          else if (deletes > 0) button.setDestructive();
        });
    }
    modal.open();
  }

  private askPluginData(paths: string[]): void {
    const ids = [
      ...new Set(
        paths.flatMap((path) => {
          const match = /\/plugins\/([^/]+)\/data\.json$/.exec(path);
          return match?.[1] ? [match[1]] : [];
        }),
      ),
    ];
    if (ids.length === 0 || this.pluginDataModalOpen) return;
    this.pluginDataModalOpen = true;
    const modal = new Modal(this.app);
    modal.setTitle(t("pluginData.title"));
    modal.contentEl.createEl("p", { text: t("pluginData.intro") });
    const chosen = new Set<string>();
    for (const id of ids) {
      const setting = new Setting(modal.contentEl).setName(id).setDesc(t("pluginData.ask"));
      const choose = (sync: boolean) => {
        setting.setDesc(t(sync ? "pluginData.chosenSync" : "pluginData.chosenSkip"));
        chosen.add(id);
        void this.choosePluginData(id, sync);
        if (chosen.size === ids.length) modal.close();
      };
      setting
        .addButton((button) =>
          button.setButtonText(t("pluginData.sync")).onClick(() => choose(true)),
        )
        .addButton((button) =>
          button.setButtonText(t("pluginData.skip")).onClick(() => choose(false)),
        );
    }
    modal.onClose = () => {
      this.pluginDataModalOpen = false;
    };
    modal.open();
  }

  private async choosePluginData(id: string, sync: boolean): Promise<void> {
    await this.persistShared({
      ...this.shared,
      pluginDataSync: { ...this.shared.pluginDataSync, [id]: sync },
    });
    await this.requestSync("full");
  }

  private askGuard(result: SyncRunResult): void {
    if (result.guard?.kind !== "confirm") return;
    const guard = result.guard;
    const modal = new Modal(this.app);
    modal.setTitle(t("guard.title"));
    modal.contentEl.createEl("p", { text: t("guard.intro") });
    modal.contentEl.createEl("p", {
      text: t("guard.summary", {
        deletions: guard.deletions,
        changes: guard.changes,
        deletionRatio: Math.round(guard.deletionRatio * 100),
        changeRatio: Math.round(guard.changeRatio * 100),
      }),
    });
    if (guard.shrinkToZero > 0) {
      modal.contentEl.createEl("p", {
        text: t("guard.shrinkToZero", { count: guard.shrinkToZero }),
      });
    }
    if (guard.samples.length > 0) {
      modal.contentEl.createEl("p", { text: t("guard.samples", { count: guard.samples.length }) });
      const list = modal.contentEl.createEl("ul");
      for (const sample of guard.samples) list.createEl("li", { text: sample });
    }
    new Setting(modal.contentEl)
      .addButton((button) =>
        button
          .setButtonText(t("guard.apply"))
          .setDestructive()
          .onClick(() => {
            this.acknowledgeGuard = true;
            const strategy = this.pendingStrategy;
            modal.close();
            if (strategy) void this.sync("full", { strategy, acknowledgeGuard: true });
            else void this.requestSync("full");
          }),
      )
      .addButton((button) => button.setButtonText(t("guard.skip")).onClick(() => modal.close()))
      .addButton((button) =>
        button.setButtonText(t("guard.pause")).onClick(() => {
          modal.close();
          void this.persist({ ...this.data, syncMode: "paused" });
        }),
      );
    modal.open();
  }

  private async copyPlan(redacted: boolean): Promise<void> {
    const result = await this.sync("full", { dryRun: true, present: false });
    const plan = result?.plan ?? this.lastPlan;
    if (!plan) {
      new Notice(t("commands.exportPlanEmpty"));
      return;
    }
    const json = await exportPlan(plan, redacted);
    try {
      await navigator.clipboard.writeText(json);
    } catch {
      this.actionNotice(
        "export-plan",
        t("commands.exportPlanReady"),
        () =>
          void navigator.clipboard.writeText(json).then(
            () => new Notice(t("commands.exportPlanCopied")),
            () => new Notice(t("commands.exportPlanCopyFailed")),
          ),
        t("commands.exportPlanCopy"),
      );
      return;
    }
    new Notice(t("commands.exportPlanCopied"));
  }

  private async askPurge(): Promise<void> {
    const api = this.api();
    if (!api) {
      new Notice(this.missingConnection());
      return;
    }
    let device: string;
    try {
      device = (await api.health()).deviceName;
    } catch (error) {
      new Notice(describeFailure(failureOf(error), "action"));
      return;
    }
    let path = "";
    let name = "";
    let prepared: { confirmToken: string } | null = null;
    const modal = new Modal(this.app);
    modal.setTitle(t("purge.title"));
    modal.contentEl.createEl("p", { text: t("purge.intro") });
    const pathSetting = new Setting(modal.contentEl)
      .setName(t("purge.path"))
      .setDesc(t("purge.pathDesc"));
    const summary = modal.contentEl.createEl("p", { attr: { role: "status" } });
    let purgeButton: ButtonComponent | null = null;
    const update = () => purgeButton?.setDisabled(!(prepared && name === device));
    pathSetting
      .addText((text) =>
        text.setPlaceholder("notes/secret.md").onChange((value) => {
          path = value.trim();
          prepared = null;
          summary.setText("");
          update();
        }),
      )
      .addButton((button) =>
        button.setButtonText(t("purge.preview")).onClick(() => {
          if (!path) return;
          summary.setText(t("view.loading"));
          void api.preparePurge({ paths: [path] }).then(
            (result) => {
              prepared = result;
              summary.setText(
                t("purge.summary", {
                  files: result.fileCount,
                  objects: result.objectCount,
                  bytes: formatBytes(result.bytes),
                }),
              );
              update();
            },
            (error: unknown) => summary.setText(describeFailure(failureOf(error), "action")),
          );
        }),
      );
    new Setting(modal.contentEl).setName(t("purge.confirmName", { device })).addText((text) =>
      text.onChange((value) => {
        name = value;
        update();
      }),
    );
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText(t("bulk.cancel")).onClick(() => modal.close()))
      .addButton((button) => {
        purgeButton = button
          .setButtonText(t("purge.title"))
          .setDestructive()
          .setCta()
          .setDisabled(true)
          .onClick(() => {
            if (!prepared || name !== device) return;
            void api.purge({ confirmToken: prepared.confirmToken }).then(
              (result) => {
                new Notice(
                  t("purge.done", {
                    objects: result.deletedObjects,
                    bytes: formatBytes(result.deletedBytes),
                  }),
                );
                modal.close();
                void this.requestSync("full");
              },
              (error: unknown) => new Notice(describeFailure(failureOf(error), "action")),
            );
          });
      });
    modal.open();
  }

  private async deviceListing(): Promise<DeviceListing> {
    const api = this.api();
    if (!api) return { problem: this.missingConnection() };
    try {
      const devices = await api.devices();
      await this.rememberDevices(devices.map((device) => device.id));
      return { devices };
    } catch (error) {
      return { problem: describeFailure(failureOf(error), "action") };
    }
  }

  private async knownPluginIds(): Promise<string[]> {
    const dir = `${this.app.vault.configDir}/plugins`;
    if (!(await this.app.vault.adapter.exists(dir))) return [];
    const listed = await this.app.vault.adapter.list(dir);
    return listed.folders.map((folder) => folder.slice(dir.length + 1));
  }

  private api(): ApiClient | null {
    const token = this.secret(this.data.deviceTokenName);
    const secret = this.secret(this.data.accessClientSecretName);
    if (!isAllowedServerUrl(this.data.serverUrl) || !token || !secret || !this.data.accessClientId)
      return null;
    return createApiClient(this.data.serverUrl, {
      Authorization: `Bearer ${token}`,
      "CF-Access-Client-Id": this.data.accessClientId,
      "CF-Access-Client-Secret": secret,
    });
  }

  private secret(name: string): string | null {
    return name ? this.app.secretStorage.getSecret(name) : null;
  }

  private async checkConnection(): Promise<string> {
    const api = this.api();
    let text = this.missingConnection();
    if (api) {
      try {
        await api.health();
        text = t("connection.ok");
        if (this.stopped !== "ok" && this.stopped !== "paused") {
          this.stopped = "ok";
          void this.requestSync("full");
        }
      } catch (error) {
        text = describeFailure(failureOf(error));
      }
    }
    new Notice(text);
    return text;
  }

  private missingConnection(): string {
    if (this.data.serverUrl && !isAllowedServerUrl(this.data.serverUrl)) {
      return t("problem.insecureUrl");
    }
    const fields = [
      this.data.serverUrl ? null : t("field.serverUrl"),
      this.data.accessClientId ? null : t("field.accessClientId"),
      this.secret(this.data.accessClientSecretName) ? null : t("field.accessClientSecret"),
      this.secret(this.data.deviceTokenName) ? null : t("field.deviceToken"),
    ].filter((field): field is string => field !== null);
    return t("problem.missing", { fields: formatList(fields) });
  }

  private rehashDue(): boolean {
    const interval = Platform.isMobile ? FULL_REHASH_MOBILE_MS : FULL_REHASH_DESKTOP_MS;
    return Date.now() - (this.data.lastRehashAt ?? 0) > interval;
  }

  private renderStatus(): void {
    this.status.classList.toggle(
      "is-warning",
      this.conflicts > 0 ||
        this.quarantine.length > 0 ||
        this.undetermined > 0 ||
        this.writeFailed > 0 ||
        this.data.reloadPending.length > 0,
    );
    this.status.classList.toggle(
      "is-error",
      this.stopped === "setup" ||
        this.stopped === "auth" ||
        this.stopped === "error" ||
        this.stopped === "version",
    );
    const text = this.statusText();
    this.status.setText(text);
    // ツールチップはaria-labelも兼ねるので、読み上げでも状態と理由が伝わるようにする
    setTooltip(this.status, [`Obsttorte: ${text}`, this.problem].filter(Boolean).join("\n"), {
      placement: "top",
    });
  }

  private statusText(): string {
    if (this.progress) {
      return t("status.syncing", { done: this.progress.done, total: this.progress.total });
    }
    if (this.stopped === "paused" || this.data.syncMode === "paused" || this.data.autoSyncPaused) {
      return this.data.autoSyncPaused && this.data.syncMode !== "paused"
        ? t("status.error")
        : t("status.paused");
    }
    if (this.stopped === "setup") return t("status.setup");
    if (this.stopped === "auth") return t("status.signIn");
    if (this.stopped === "version") return t("status.version");
    if (this.stopped === "error") return t("status.error");
    if (this.conflicts > 0) return t("status.conflicts", { count: this.conflicts });
    if (this.quarantine.length > 0) {
      return t("status.approval", { count: this.quarantine.length });
    }
    if (this.undetermined > 0) return t("status.undetermined", { count: this.undetermined });
    if (this.writeFailed > 0) return t("status.writeFailed", { count: this.writeFailed });
    if (this.data.reloadPending.length > 0) {
      return t("status.reload", { count: this.data.reloadPending.length });
    }
    return t("status.synced", { time: formatRelative(this.data.lastConfirmedAt) });
  }

  private openStatusMenu(): void {
    const rect = this.status.getBoundingClientRect();
    this.openMenu({ x: rect.left, y: rect.top });
  }

  private openMenu(at: MouseEvent | MenuPositionDef): void {
    const menu = new Menu();
    const problem = this.problem;
    if (problem) {
      menu.addItem((item) => item.setTitle(problem).setDisabled(true));
      menu.addSeparator();
    }
    menu.addItem((item) =>
      item
        .setTitle(t("menu.confirmed", { time: formatRelative(this.data.lastConfirmedAt) }))
        .setDisabled(true),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("menu.snapshot", { time: formatRelative(this.data.lastSnapshotAt) }))
        .setDisabled(true),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("menu.conflicts", { count: this.conflicts }))
        .onClick(() => void this.openView(CONFLICT_VIEW_TYPE)),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("menu.quarantine", { count: this.quarantine.length }))
        .onClick(() => void this.openView(QUARANTINE_VIEW_TYPE)),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("menu.undetermined", { count: this.undetermined }))
        .onClick(() => void this.openView(LOG_VIEW_TYPE)),
    );
    menu.addItem((item) =>
      item.setTitle(t("menu.reload", { count: this.data.reloadPending.length })).onClick(() => {
        if (this.data.reloadPending.length > 0) window.location.reload();
      }),
    );
    menu.addItem((item) =>
      item.setTitle(t("menu.syncNow")).onClick(() => void this.requestSync("full")),
    );
    menu.addItem((item) =>
      item.setTitle(t("menu.openLog")).onClick(() => void this.openView(LOG_VIEW_TYPE)),
    );
    menu.addItem((item) =>
      item
        .setTitle(
          this.data.syncMode === "paused" || this.data.autoSyncPaused
            ? t("menu.resume")
            : t("menu.pause"),
        )
        .onClick(() => {
          if (this.data.syncMode === "paused" || this.data.autoSyncPaused) {
            this.failureStreak = 0;
            this.stopped = "ok";
            void this.persist({
              ...this.data,
              autoSyncPaused: false,
              syncMode: this.data.syncMode === "paused" ? "bidirectional" : this.data.syncMode,
            }).then(() => this.requestSync("full"));
            return;
          }
          void this.persist({ ...this.data, syncMode: "paused" });
        }),
    );
    if (at instanceof MouseEvent) menu.showAtMouseEvent(at);
    else menu.showAtPosition(at);
  }

  private async openView(type: string): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf?.setViewState({ type, active: true });
    if (leaf) await this.app.workspace.revealLeaf(leaf);
  }

  /**
   * 同じ種類はセッションで1回だけ出す。
   * persistentなら閉じるまで残し、閉じたあとや解消したあとは再び出せる
   */
  private onceNotice(kind: string, message: string, persistent = false): void {
    if (this.notices.has(kind)) return;
    const notice = new Notice(message, persistent ? 0 : INFO_NOTICE_MS);
    this.notices.set(kind, { notice, text: null });
    if (persistent) notice.messageEl.addEventListener("click", () => this.notices.delete(kind));
  }

  /** 判断を求める知らせ。閉じるまで残し、出ているあいだは件数などの文言を差し替える */
  private actionNotice(
    kind: string,
    message: string,
    action: () => void,
    buttonText = t("notice.open"),
  ): void {
    const shown = this.notices.get(kind);
    if (shown) {
      shown.text?.setText(message);
      return;
    }
    const notice = new Notice("", 0);
    const text = notice.messageEl.createSpan({ text: message });
    const button = notice.messageEl.createEl("button", { text: buttonText });
    this.notices.set(kind, { notice, text });
    notice.messageEl.addEventListener("click", () => this.notices.delete(kind));
    button.addEventListener("click", () => {
      this.dismiss(kind);
      action();
    });
  }

  private dismiss(...kinds: string[]): void {
    for (const kind of kinds) {
      this.notices.get(kind)?.notice.hide();
      this.notices.delete(kind);
    }
  }

  private settleDirty(dirtyBefore: ReadonlySet<string>, result: SyncRunResult): void {
    const finished = new Set(result.applied);
    for (const item of result.plan?.items ?? []) {
      if (item.action === "noop" || item.action === "adoptBase") finished.add(item.path);
    }
    for (const item of result.plan?.skipped ?? []) {
      if (item.reason === "excluded") finished.add(item.path);
    }
    for (const path of dirtyBefore) {
      if (finished.has(path)) this.dirty.delete(path);
    }
  }

  private async markConfirmed(): Promise<void> {
    this.data.lastConfirmedAt = Date.now();
    await this.persist(this.data);
  }

  private async persist(data: PluginData): Promise<void> {
    this.data = data;
    setLanguage(data.languageOverride);
    await this.saveData(data);
    this.armTimer();
    this.renderStatus();
  }

  private armTimer(): void {
    const minutes = Math.max(1, this.data.syncIntervalMinutes);
    if (this.timer !== 0 && this.armedMinutes === minutes) return;
    window.clearInterval(this.timer);
    this.armedMinutes = minutes;
    this.timer = window.setInterval(() => void this.requestSync("partial"), minutes * 60_000);
    this.registerInterval(this.timer);
  }

  private journal(): DiskJournal {
    const journalPath = `${this.app.vault.configDir}/plugins/${this.manifest.id}/journal.json`;
    return new DiskJournal(
      async () =>
        (await this.app.vault.adapter.exists(journalPath))
          ? this.app.vault.adapter.read(journalPath)
          : null,
      async (value) => {
        await this.app.vault.adapter.write(journalPath, value);
      },
    );
  }

  private async readHealth(api: ApiClient): Promise<void> {
    try {
      const health = await api.health();
      if (health.deviceName) this.deviceName = health.deviceName;
      if (health.deviceId) {
        this.deviceId = health.deviceId;
        await this.rememberDevices([health.deviceId]);
      }
      if (health.accessTokenWarning) this.onceNotice("access-expiry", t("notice.accessExpiry"));
      const failed = health.reports.filter(
        (report) => !report.ok && report.kind !== "integrity" && report.kind !== "storage",
      );
      if (failed.length > 0) {
        this.onceNotice(
          "maintenance-failed",
          t("notice.maintenanceFailed", { kinds: failed.map((report) => report.kind).join(", ") }),
        );
      }
      const concerning = health.reports.some(
        (report) =>
          storageConcern(report.result) ||
          (!report.ok && (report.kind === "integrity" || report.kind === "storage")),
      );
      if (concerning) {
        const storage = health.reports.find((report) => report.kind === "storage");
        this.onceNotice(
          "maintenance",
          t("notice.maintenance", {
            snapshotBytes: formatBytes(byteCount(storage?.result.snapshotOnlyBytes)),
            historyBytes: formatBytes(byteCount(storage?.result.historyOnlyBytes)),
          }),
        );
      }
      const snapshots = await api.snapshots();
      const latest = snapshots[0]?.createdAt ?? null;
      if (latest !== this.data.lastSnapshotAt) {
        this.data.lastSnapshotAt = latest;
        await this.persist(this.data);
      }
    } catch {
      // 同じ失敗は続く同期で報告される
    }
  }

  private async rememberPlan(plan: SyncPlan, rejected: SyncRunResult["rejected"]): Promise<void> {
    try {
      const index = new IndexedDbIndex(this.data.installId);
      const next = [{ at: Date.now(), plan, rejected }, ...(await index.syncPlans())].slice(0, 20);
      await index.saveSyncPlans(next);
    } catch {
      // 同期ログはキャッシュなので、保存に失敗しても終わった同期は取り消さない
    }
  }

  private async rememberDevices(ids: readonly string[]): Promise<void> {
    try {
      await new IndexedDbIndex(this.data.installId).rememberDevices(ids);
    } catch {
      // 見慣れたデバイスかどうかは、ログの強調表示にしか影響しない
    }
  }

  private async syncLog(): Promise<SyncLogSnapshot> {
    const index = new IndexedDbIndex(this.data.installId);
    let familiar = new Set<string>();
    let plans: SyncLogSnapshot["plans"] = [];
    try {
      familiar = new Set(await index.familiarDevices());
      plans = await index.syncPlans();
    } catch {
      familiar = new Set();
      plans = [];
    }
    if (this.deviceId) familiar.add(this.deviceId);
    const entries = (await this.api()?.log(0, 200))?.entries ?? [];
    return {
      problem: this.problem,
      entries: entries.map((entry) => emphasizeUnfamiliar(entry, familiar)),
      plans,
      verbose: this.data.logVerbosity === "verbose",
    };
  }

  private async rebuildIndex(): Promise<void> {
    await new IndexedDbIndex(this.data.installId).reset();
    await this.persist({ ...this.data, lastRehashAt: null });
    new Notice(t("settings.rebuilt"));
  }

  private async persistShared(settings: SharedSettings): Promise<void> {
    this.shared = settings;
    await writeSharedSettings(this.app, settings);
  }
}
