import {
  diffLines,
  mergeText,
  type Rejection,
  type SnapshotDelta,
  type SyncPlan,
} from "@obsttorte/engine";
import type { ConflictRecord, LogEntry, SnapshotListItem } from "@obsttorte/shared";
import { ItemView, Notice, setTooltip, type WorkspaceLeaf } from "obsidian";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { QuarantineDetail, ResolveChoice } from "./actions";
import { formatBytes, formatDateTime, label, t } from "./i18n";
import { describeFailure, failureOf } from "./problems";

export const CONFLICT_VIEW_TYPE = "obsttorte-conflicts";
export const QUARANTINE_VIEW_TYPE = "obsttorte-quarantine";
export const SNAPSHOT_VIEW_TYPE = "obsttorte-snapshots";
export const LOG_VIEW_TYPE = "obsttorte-sync-log";

export type SyncSignal = (listener: () => void) => () => void;

const Synced = createContext<SyncSignal>(() => () => {});

abstract class ReactView extends ItemView {
  private root: Root | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly onSynced: SyncSignal,
  ) {
    super(leaf);
  }

  protected abstract content(): ReactNode;

  async onOpen(): Promise<void> {
    this.root = createRoot(this.contentEl);
    this.root.render(<Synced value={this.onSynced}>{this.content()}</Synced>);
  }

  async onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
  }
}

function useLoaded<T>(load: () => Promise<T>): {
  value: T | null;
  error: string | null;
  reload: () => void;
  refresh: () => void;
} {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    void load().then(setValue, (reason: unknown) => {
      setError(describeFailure(failureOf(reason), "action"));
    });
  }, [load]);
  const reload = useCallback(() => {
    setValue(null);
    setError(null);
    refresh();
  }, [refresh]);
  useEffect(reload, [reload]);
  return { value, error, reload, refresh };
}

function useOnSynced(listener: () => void): void {
  const subscribe = useContext(Synced);
  useEffect(() => subscribe(listener), [subscribe, listener]);
}

/** 失敗をNoticeで知らせ、終わるまで同じ画面のボタンを押せなくする */
function useAction(): { busy: boolean; run: (action: () => Promise<unknown>) => Promise<boolean> } {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      return true;
    } catch (error) {
      new Notice(describeFailure(failureOf(error), "action"));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}

function Pending({ error }: { error: string | null }) {
  return error ? <p role="alert">{error}</p> : <p role="status">{t("view.loading")}</p>;
}

function BackButton({ onClick }: { onClick: () => void }) {
  return <ActionButton label={t("view.back")} onClick={onClick} />;
}

function tooltip(label: string) {
  return (element: HTMLElement | null) => {
    if (!element || element.dataset.tip === label) return;
    element.dataset.tip = label;
    setTooltip(element, label);
  };
}

function ActionButton({
  label,
  text,
  disabled,
  warning,
  onClick,
}: {
  label: string;
  text?: string;
  disabled?: boolean;
  /** 取り消しにくい操作を確定するボタン */
  warning?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={warning ? "mod-warning" : undefined}
      aria-label={text === undefined ? undefined : label}
      ref={text === undefined ? undefined : tooltip(label)}
      disabled={disabled}
      onClick={onClick}
    >
      {text ?? label}
    </button>
  );
}

export type ConflictActions = {
  load: () => Promise<ConflictRecord[]>;
  texts: (conflict: ConflictRecord) => Promise<{ base: string; local: string; remote: string }>;
  resolve: (conflict: ConflictRecord, choice: ResolveChoice, text?: string) => Promise<void>;
  resolveAll: (choice: "local" | "remote" | "newer") => Promise<void>;
  takeOver: (strategy: "server" | "device") => Promise<void>;
};

export class ConflictView extends ReactView {
  constructor(
    leaf: WorkspaceLeaf,
    onSynced: SyncSignal,
    private readonly actions: ConflictActions,
  ) {
    super(leaf, onSynced);
  }
  getViewType(): string {
    return CONFLICT_VIEW_TYPE;
  }
  getDisplayText(): string {
    return t("conflicts.viewTitle");
  }
  getIcon(): string {
    return "git-merge";
  }
  protected content(): ReactNode {
    return <ConflictList actions={this.actions} />;
  }
}

type BulkPending =
  | { kind: "choice"; choice: "local" | "remote" | "newer"; label: string }
  | { kind: "takeover"; strategy: "server" | "device"; label: string };

function bulkOptions(): BulkPending[] {
  return [
    { kind: "choice", choice: "local", label: t("bulk.local") },
    { kind: "choice", choice: "remote", label: t("bulk.remote") },
    { kind: "choice", choice: "newer", label: t("bulk.newer") },
    { kind: "takeover", strategy: "device", label: t("bulk.device") },
    { kind: "takeover", strategy: "server", label: t("bulk.server") },
  ];
}

function ConflictList({ actions }: { actions: ConflictActions }) {
  const { value: items, error, reload, refresh } = useLoaded(actions.load);
  useOnSynced(refresh);
  const { busy, run } = useAction();
  const [selected, setSelected] = useState<ConflictRecord | null>(null);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<BulkPending | null>(null);
  const current = items?.some((item) => item.id === selected?.id) ? selected : null;
  const openConflict = (item: ConflictRecord) => {
    setSelected(item);
    setDraft("");
    void run(async () => {
      const texts = await actions.texts(item);
      const merged = mergeText(texts.base, texts.local, texts.remote);
      setDraft(merged.kind === "conflict" ? merged.textWithMarkers : merged.text);
    });
  };
  if (current) {
    const choose = (choice: ResolveChoice) => {
      void run(() => actions.resolve(current, choice, draft)).then((done) => {
        if (!done) return;
        setSelected(null);
        reload();
      });
    };
    const choices: Array<[string, ResolveChoice]> = [
      [t("conflict.local"), "local"],
      [t("conflict.remote"), "remote"],
      [t("conflict.both"), "local-remote"],
      [t("conflict.bothReverse"), "remote-local"],
      [t("conflict.edit"), "edit"],
      ...(current.path.endsWith(".json")
        ? ([
            [t("conflict.jsonLocal"), "json-local-first"],
            [t("conflict.jsonRemote"), "json-remote-first"],
          ] as Array<[string, ResolveChoice]>)
        : []),
    ];
    return (
      <section className="obsttorte-view" aria-label={t("conflicts.viewTitle")}>
        <BackButton onClick={() => setSelected(null)} />
        <h3>{current.path}</h3>
        <DiffColumns conflict={current} actions={actions} />
        <label className="obsttorte-field">
          {t("conflict.draft")}
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
        </label>
        <div className="obsttorte-actions" role="toolbar" aria-label={t("conflict.actions")}>
          {choices.map(([label, choice]) => (
            <ActionButton
              key={choice}
              label={label}
              disabled={busy}
              onClick={() => choose(choice)}
            />
          ))}
        </div>
      </section>
    );
  }
  if (!items) {
    return (
      <section className="obsttorte-view" aria-label={t("conflicts.viewTitle")}>
        <Pending error={error} />
      </section>
    );
  }
  if (items.length === 0) {
    return (
      <section className="obsttorte-view" aria-label={t("conflicts.viewTitle")}>
        <p>{t("conflicts.empty")}</p>
      </section>
    );
  }
  const count = items.length;
  const confirmText = pending
    ? pending.kind === "takeover" && pending.strategy === "server"
      ? t("bulk.confirmServer", { count })
      : pending.kind === "takeover"
        ? t("bulk.confirmDevice", { count })
        : t("bulk.confirmChoice", { count, action: pending.label })
    : "";
  const applyPending = () => {
    if (!pending) return;
    const chosen = pending;
    setPending(null);
    void run(() =>
      chosen.kind === "choice"
        ? actions.resolveAll(chosen.choice)
        : actions.takeOver(chosen.strategy),
    ).then(reload);
  };
  return (
    <section className="obsttorte-view" aria-label={t("conflicts.viewTitle")}>
      <div className="obsttorte-actions" role="toolbar" aria-label={t("bulk.actions")}>
        <ActionButton
          label={t("bulk.more")}
          text="…"
          onClick={() => {
            setMenuOpen((open) => !open);
            setPending(null);
          }}
        />
        {menuOpen
          ? bulkOptions().map((option) => (
              <ActionButton
                key={option.label}
                label={option.label}
                onClick={() => {
                  setMenuOpen(false);
                  setPending(option);
                }}
              />
            ))
          : null}
      </div>
      {pending ? (
        <fieldset>
          <legend>{confirmText}</legend>
          <div className="obsttorte-actions">
            <ActionButton label={t("bulk.apply")} disabled={busy} warning onClick={applyPending} />
            <ActionButton label={t("bulk.cancel")} onClick={() => setPending(null)} />
          </div>
        </fieldset>
      ) : null}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <ActionButton label={item.path} onClick={() => openConflict(item)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export type QuarantineActions = {
  paths: () => string[];
  newPluginIds: () => string[];
  detail: (path: string) => Promise<QuarantineDetail>;
  /** 表示した sha256 がサーバーの現在の版と違えば承認せずに false を返す */
  approve: (path: string, sha256: string) => Promise<boolean>;
  reject: (path: string) => Promise<void>;
};

export class QuarantineView extends ReactView {
  constructor(
    leaf: WorkspaceLeaf,
    onSynced: SyncSignal,
    private readonly actions: QuarantineActions,
  ) {
    super(leaf, onSynced);
  }
  getViewType(): string {
    return QUARANTINE_VIEW_TYPE;
  }
  getDisplayText(): string {
    return t("quarantine.viewTitle");
  }
  getIcon(): string {
    return "shield-alert";
  }
  protected content(): ReactNode {
    return <QuarantineList actions={this.actions} />;
  }
}

function QuarantineList({ actions }: { actions: QuarantineActions }) {
  const [paths, setPaths] = useState(actions.paths());
  useOnSynced(useCallback(() => setPaths(actions.paths()), [actions]));
  const [selected, setSelected] = useState<string | null>(null);
  const fresh = new Set(actions.newPluginIds());
  if (selected) {
    return (
      <QuarantineDecision
        path={selected}
        actions={actions}
        onBack={() => setSelected(null)}
        onDecided={() => {
          setSelected(null);
          setPaths(actions.paths());
        }}
      />
    );
  }
  if (paths.length === 0) {
    return (
      <section className="obsttorte-view" aria-label={t("quarantine.viewTitle")}>
        <p>{t("quarantine.empty")}</p>
      </section>
    );
  }
  return (
    <ul className="obsttorte-view" aria-label={t("quarantine.viewTitle")}>
      {paths.map((path) => {
        const pluginId = /\/plugins\/([^/]+)\//.exec(path)?.[1] ?? "";
        return (
          <li
            key={path}
            className={fresh.has(pluginId) ? "obsttorte-row obsttorte-emphasis" : "obsttorte-row"}
          >
            <ActionButton
              label={fresh.has(pluginId) ? `${t("quarantine.newPlugin")} ${path}` : path}
              onClick={() => setSelected(path)}
            />
          </li>
        );
      })}
    </ul>
  );
}

export class SnapshotView extends ReactView {
  constructor(
    leaf: WorkspaceLeaf,
    onSynced: SyncSignal,
    private readonly loadItems: () => Promise<SnapshotListItem[]>,
    private readonly compare: (id: string) => Promise<SnapshotDelta>,
    private readonly restore: (id: string, paths?: string[]) => Promise<void>,
  ) {
    super(leaf, onSynced);
  }
  getViewType(): string {
    return SNAPSHOT_VIEW_TYPE;
  }
  getDisplayText(): string {
    return t("snapshots.viewTitle");
  }
  getIcon(): string {
    return "archive";
  }
  protected content(): ReactNode {
    return <SnapshotList load={this.loadItems} compare={this.compare} restore={this.restore} />;
  }
}

function SnapshotList({
  load,
  compare,
  restore,
}: {
  load: () => Promise<SnapshotListItem[]>;
  compare: (id: string) => Promise<SnapshotDelta>;
  restore: (id: string, paths?: string[]) => Promise<void>;
}) {
  const { value: items, error, refresh } = useLoaded(load);
  useOnSynced(refresh);
  const [selected, setSelected] = useState<string | null>(null);
  if (selected) {
    const label = items?.find((item) => item.id === selected);
    const title = label ? snapshotTitle(label) : selected;
    return (
      <section className="obsttorte-view" aria-label={t("snapshots.viewTitle")}>
        <BackButton onClick={() => setSelected(null)} />
        <h3>{title}</h3>
        <SnapshotDetail id={selected} compare={compare} restore={restore} />
      </section>
    );
  }
  if (!items || items.length === 0) {
    return (
      <section className="obsttorte-view" aria-label={t("snapshots.viewTitle")}>
        {items ? <p>{t("snapshots.empty")}</p> : <Pending error={error} />}
      </section>
    );
  }
  return (
    <ul className="obsttorte-view" aria-label={t("snapshots.viewTitle")}>
      {items.map((item) => {
        const title = snapshotTitle(item);
        return (
          <li key={item.id}>
            <ActionButton label={title} onClick={() => setSelected(item.id)} />
          </li>
        );
      })}
    </ul>
  );
}

function snapshotTitle(item: SnapshotListItem): string {
  return t("snapshots.title", {
    time: formatDateTime(item.createdAt),
    origin: t(`snapshots.origin.${item.origin}`),
  });
}

function SnapshotDetail({
  id,
  compare,
  restore,
}: {
  id: string;
  compare: (id: string) => Promise<SnapshotDelta>;
  restore: (id: string, paths?: string[]) => Promise<void>;
}) {
  const { value: delta, error, reload } = useLoaded(useCallback(() => compare(id), [compare, id]));
  const { busy, run } = useAction();
  if (!delta) return <Pending error={error} />;
  const restorePaths = (paths?: string[]) => {
    void run(() => restore(id, paths)).then((done) => {
      if (done) reload();
    });
  };
  return (
    <SnapshotDeltaList
      delta={delta}
      busy={busy}
      restoreAll={() => restorePaths()}
      restoreOne={(path) => restorePaths([path])}
    />
  );
}

function SnapshotDeltaList({
  delta,
  busy,
  restoreAll,
  restoreOne,
}: {
  delta: SnapshotDelta;
  busy: boolean;
  restoreAll: () => void;
  restoreOne: (path: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (delta.added.length + delta.changed.length + delta.removed.length === 0) {
    return <p>{t("snapshots.noChanges")}</p>;
  }
  const groups = [
    [t("snapshots.deletedSince"), delta.added, true],
    [t("snapshots.changedSince"), delta.changed, true],
    [t("snapshots.createdSince"), delta.removed, false],
  ] as const;
  return (
    <div>
      {groups.map(([label, paths, restorable]) => (
        <section key={label} aria-label={label}>
          <h3>
            {label} ({paths.length})
          </h3>
          {paths.map((path) => (
            <div key={path}>
              <span>{path}</span>
              {restorable ? (
                <ActionButton
                  label={t("snapshots.restoreFile")}
                  disabled={busy}
                  onClick={() => restoreOne(path)}
                />
              ) : null}
            </div>
          ))}
        </section>
      ))}
      {confirming ? (
        <fieldset>
          <legend>
            {t("snapshots.confirmRestore", {
              added: delta.added.length,
              changed: delta.changed.length,
              removed: delta.removed.length,
            })}
          </legend>
          <div className="obsttorte-actions">
            <ActionButton
              label={t("snapshots.confirm")}
              disabled={busy}
              warning
              onClick={() => {
                setConfirming(false);
                restoreAll();
              }}
            />
            <ActionButton label={t("bulk.cancel")} onClick={() => setConfirming(false)} />
          </div>
        </fieldset>
      ) : (
        <ActionButton
          label={t("snapshots.restore")}
          disabled={busy}
          onClick={() => setConfirming(true)}
        />
      )}
    </div>
  );
}

export type SyncLogSnapshot = {
  problem: string | null;
  entries: LogEntry[];
  verbose: boolean;
  plans: Array<{
    at: number;
    plan: SyncPlan;
    rejected: Rejection[];
  }>;
};

export class SyncLogView extends ReactView {
  constructor(
    leaf: WorkspaceLeaf,
    onSynced: SyncSignal,
    private readonly loadItems: () => Promise<SyncLogSnapshot>,
    private readonly copyRedacted: () => Promise<void>,
  ) {
    super(leaf, onSynced);
  }
  getViewType(): string {
    return LOG_VIEW_TYPE;
  }
  getDisplayText(): string {
    return t("log.viewTitle");
  }
  getIcon(): string {
    return "scroll-text";
  }
  protected content(): ReactNode {
    return <LogList load={this.loadItems} copyRedacted={this.copyRedacted} />;
  }
}

function LogList({
  load,
  copyRedacted,
}: {
  load: () => Promise<SyncLogSnapshot>;
  copyRedacted: () => Promise<void>;
}) {
  const { value: snapshot, error, refresh } = useLoaded(load);
  useOnSynced(refresh);
  const { busy, run } = useAction();
  if (!snapshot) {
    return (
      <section className="obsttorte-view" aria-label={t("log.viewTitle")}>
        <Pending error={error} />
      </section>
    );
  }
  const empty = snapshot.plans.length === 0 && snapshot.entries.length === 0;
  return (
    <section className="obsttorte-view" aria-label={t("log.viewTitle")}>
      {snapshot.problem ? (
        <p role="status">{t("log.problem", { problem: snapshot.problem })}</p>
      ) : null}
      {empty ? <p>{t("log.empty")}</p> : null}
      <ActionButton
        label={t("log.copyRedacted")}
        disabled={busy}
        onClick={() => void run(copyRedacted)}
      />
      {snapshot.plans.length > 0 ? (
        <section aria-label={t("log.plans")}>
          <h3>{t("log.plans")}</h3>
          {snapshot.plans.map((item) => (
            <section key={item.at} aria-label={t("log.plan")}>
              <h4>{formatDateTime(item.at)}</h4>
              <PlanRows rows={planRows(item.plan, item.rejected, snapshot.verbose)} />
            </section>
          ))}
        </section>
      ) : null}
      {snapshot.entries.length > 0 ? (
        <section aria-label={t("log.history")}>
          <h3>{t("log.history")}</h3>
          <ul>
            {snapshot.entries.map((item) => (
              <li
                key={`${item.seq}-${item.path}`}
                className={item.highlight.length > 0 ? "obsttorte-emphasis" : undefined}
              >
                {t("log.entry", {
                  time: formatDateTime(item.changedAt),
                  device: item.deviceName,
                  change: t(item.deleted ? "log.deleted" : "log.changed"),
                  path: item.path,
                })}
                {item.highlight.length > 0
                  ? ` (${item.highlight.map((reason) => label("log.highlight", reason)).join(", ")})`
                  : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

type PlanRow = { key: string; label: string; path: string; detail: string | null };

function planRows(plan: SyncPlan, rejected: Rejection[], verbose: boolean): PlanRow[] {
  const actions = plan.items.filter((entry) =>
    verbose ? true : entry.action !== "noop" && entry.action !== "adoptBase",
  );
  const skipped = plan.skipped.filter((entry) => verbose || entry.reason !== "excluded");
  return [
    ...actions.map((entry) => ({
      key: `action:${entry.path}`,
      label: label("log.action", entry.action),
      path: entry.path,
      detail: verbose ? (entry.localSha256 ?? entry.remoteSha256) : null,
    })),
    ...skipped.map((entry) => ({
      key: `skip:${entry.path}`,
      label: label("log.skip", entry.reason),
      path: entry.path,
      detail: null,
    })),
    ...rejected.map((entry) => ({
      key: `rejected:${entry.path}`,
      label: label("log.rejected", entry.reason),
      path: entry.path,
      detail: entry.detail ?? null,
    })),
  ];
}

function PlanRows({ rows }: { rows: PlanRow[] }) {
  if (rows.length === 0) return <p>{t("log.noChanges")}</p>;
  return (
    <ul>
      {rows.map((row) => (
        <li key={row.key}>
          <span className="obsttorte-muted">{row.label}</span> {row.path}
          {row.detail ? <code className="obsttorte-muted"> {row.detail}</code> : null}
        </li>
      ))}
    </ul>
  );
}

function BaseColumn({ text }: { text: string }) {
  return (
    <section aria-label={t("conflict.base")}>
      <h4>{t("conflict.base")}</h4>
      <pre>{text.length === 0 ? " " : text}</pre>
    </section>
  );
}

function DiffColumns({
  conflict,
  actions,
}: {
  conflict: ConflictRecord;
  actions: ConflictActions;
}) {
  const { value: texts, error } = useLoaded(
    useCallback(() => actions.texts(conflict), [actions, conflict]),
  );
  if (!texts) return <Pending error={error} />;
  return (
    <section className="obsttorte-diff" aria-label={t("conflict.diff")}>
      <BaseColumn text={texts.base} />
      <ThreeWay label={t("conflict.localColumn")} before={texts.base} after={texts.local} />
      <ThreeWay label={t("conflict.remoteColumn")} before={texts.base} after={texts.remote} />
    </section>
  );
}

function ThreeWay({ label, before, after }: { label: string; before: string; after: string }) {
  const hunks = diffLines(before, after);
  const blocks = [];
  let lineOffset = 0;
  for (const hunk of hunks) {
    const lines = [];
    for (const line of hunk.lines) {
      const words = [];
      let wordOffset = 0;
      for (const part of line.words) {
        const key = `${lineOffset}:${wordOffset}:${part.type}`;
        words.push(
          part.type === "insert" ? (
            <ins key={key}>{part.text}</ins>
          ) : part.type === "delete" ? (
            <del key={key}>{part.text}</del>
          ) : (
            <span key={key}>{part.text}</span>
          ),
        );
        wordOffset += part.text.length;
      }
      lines.push(
        <div key={`${lineOffset}:${line.type}`} className={`obsttorte-line is-${line.type}`}>
          {words}
        </div>,
      );
      lineOffset += 1;
    }
    blocks.push(
      <div key={`${hunk.beforeStart}:${hunk.afterStart}`} className="obsttorte-hunk">
        <p className="obsttorte-muted">{t("conflict.hunk", { line: hunk.afterStart + 1 })}</p>
        <pre>{lines}</pre>
      </div>,
    );
  }
  return (
    <section aria-label={label}>
      <h4>{label}</h4>
      {blocks.length > 0 ? blocks : <p>{t("conflict.unchanged")}</p>}
    </section>
  );
}

function QuarantineDecision({
  path,
  actions,
  onBack,
  onDecided,
}: {
  path: string;
  actions: QuarantineActions;
  onBack: () => void;
  onDecided: () => void;
}) {
  const { detail: load, approve, reject } = actions;
  const { value: detail, error, reload } = useLoaded(useCallback(() => load(path), [load, path]));
  const { busy, run } = useAction();
  const decide = (action: () => Promise<boolean>) => {
    let decided = false;
    void run(async () => {
      decided = await action();
    }).then((done) => {
      if (done && decided) onDecided();
    });
  };
  const approveShown = async () => {
    if (!detail) return false;
    if (await approve(path, detail.sha256)) return true;
    new Notice(t("quarantine.changed"));
    reload();
    return false;
  };
  return (
    <section className="obsttorte-view" aria-label={t("quarantine.viewTitle")}>
      <BackButton onClick={onBack} />
      <h3>{path}</h3>
      {detail ? <QuarantineDetailView detail={detail} /> : <Pending error={error} />}
      <div className="obsttorte-actions" role="toolbar" aria-label={t("quarantine.actions")}>
        <ActionButton
          label={t("quarantine.approve")}
          disabled={busy || !detail}
          onClick={() => decide(approveShown)}
        />
        <ActionButton
          label={t("quarantine.reject")}
          disabled={busy}
          onClick={() =>
            decide(async () => {
              await reject(path);
              return true;
            })
          }
        />
        <ActionButton label={t("quarantine.later")} onClick={onBack} />
      </div>
    </section>
  );
}

function QuarantineDetailView({ detail }: { detail: QuarantineDetail }) {
  const manifest = detail.manifest ?? detail.previousManifest;
  return (
    <div>
      <p>{t("quarantine.intro")}</p>
      {detail.newPlugin ? (
        <p className="obsttorte-row obsttorte-emphasis">
          <strong>{t("quarantine.newPlugin")}</strong> {t("quarantine.newPluginDesc")}
        </p>
      ) : null}
      {manifest ? (
        <ul>
          <li>
            {t("quarantine.plugin", {
              name: manifest.name || manifest.id,
              author: manifest.author || t("quarantine.none"),
            })}
          </li>
          <li>
            {t("quarantine.version", {
              from: detail.previousManifest?.version || t("quarantine.none"),
              to: detail.manifest?.version || t("quarantine.none"),
            })}
          </li>
        </ul>
      ) : null}
      <h4>{t("quarantine.files")}</h4>
      <ul>
        {detail.files.map((file) => (
          <li key={file.path}>
            {file.path} <span className="obsttorte-muted">{formatBytes(file.size)}</span>
          </li>
        ))}
      </ul>
      <details>
        <summary>{t("quarantine.checksums")}</summary>
        <ul>
          {detail.files.map((file) => (
            <li key={file.path}>
              {file.path} <code>{file.sha256}</code>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
