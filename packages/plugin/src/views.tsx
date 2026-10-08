import {
  diffLines,
  mergeText,
  newerConflictSide,
  type Rejection,
  type SnapshotDelta,
  type SyncPlan,
} from "@obsttorte/engine";
import type { ConflictRecord, LogEntry, SnapshotListItem } from "@obsttorte/shared";
import {
  ItemView,
  Menu,
  Notice,
  Platform,
  setIcon,
  setTooltip,
  type WorkspaceLeaf,
} from "obsidian";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import type { QuarantineDetail, ResolveChoice } from "./actions";
import { formatBytes, formatDateTime, label, t } from "./i18n";
import { describeFailure, failureOf } from "./problems";

export const CONFLICT_VIEW_TYPE = "obsttorte-conflicts";
export const QUARANTINE_VIEW_TYPE = "obsttorte-quarantine";
export const STATUS_VIEW_TYPE = "obsttorte-status";
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
  cta,
  onClick,
}: {
  label: string;
  text?: string;
  disabled?: boolean;
  /** 取り消しにくい操作を確定するボタン */
  warning?: boolean;
  cta?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={warning ? "mod-warning" : cta ? "mod-cta" : undefined}
      aria-label={text === undefined ? undefined : label}
      ref={text === undefined ? undefined : tooltip(label)}
      disabled={disabled}
      onClick={onClick}
    >
      {text ?? label}
    </button>
  );
}

export type ConflictTexts = { base: string; local: string; remote: string };

export type ConflictActions = {
  load: () => Promise<ConflictRecord[]>;
  texts: (conflict: ConflictRecord) => Promise<ConflictTexts>;
  resolve: (conflict: ConflictRecord, choice: ResolveChoice, text?: string) => Promise<void>;
  resolveAll: (choice: "local" | "remote" | "newer") => Promise<void>;
  takeOver: (strategy: "server" | "device") => Promise<void>;
  openFile: (path: string) => void;
  confirm: (message: string, action: string) => Promise<boolean>;
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

type Bulk =
  | { kind: "choice"; choice: "local" | "remote" | "newer" }
  | { kind: "takeover"; strategy: "server" | "device" };

function Icon({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={className ? `obsttorte-icon ${className}` : "obsttorte-icon"}
      aria-hidden="true"
      ref={(element) => {
        if (element) setIcon(element, name);
      }}
    />
  );
}

function showMenuBelow(menu: Menu, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  menu.showAtPosition({ x: rect.left, y: rect.bottom, width: rect.width });
}

function ConflictList({ actions }: { actions: ConflictActions }) {
  const { value: items, error, refresh } = useLoaded(actions.load);
  useOnSynced(refresh);
  const { busy, run } = useAction();
  const [selected, setSelected] = useState<ConflictRecord | null>(null);
  const [listShown, setListShown] = useState(false);
  const headingId = useId();
  const current = items?.some((item) => item.id === selected?.id) ? selected : null;
  useEffect(() => {
    if (!current && items?.[0]) setSelected(items[0]);
  }, [current, items]);
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
  const bulk = async (choice: Bulk) => {
    const message =
      choice.kind === "choice"
        ? t(`bulk.confirm.${choice.choice}`, { count })
        : t(`bulk.confirm.${choice.strategy}`, { count });
    if (!(await actions.confirm(message, t("bulk.apply")))) return;
    await run(() =>
      choice.kind === "choice"
        ? actions.resolveAll(choice.choice)
        : actions.takeOver(choice.strategy),
    );
    refresh();
  };
  const openBulkMenu = (anchor: HTMLElement) => {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(t("bulk.every")).setIsLabel(true));
    for (const choice of ["local", "remote", "newer"] as const) {
      menu.addItem((item) =>
        item.setTitle(t(`bulk.${choice}`)).onClick(() => void bulk({ kind: "choice", choice })),
      );
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("bulk.vault")).setIsLabel(true));
    for (const strategy of ["device", "server"] as const) {
      menu.addItem((item) =>
        item
          .setTitle(t(`bulk.${strategy}`))
          .setWarning(true)
          .onClick(() => void bulk({ kind: "takeover", strategy })),
      );
    }
    showMenuBelow(menu, anchor);
  };
  const resolve = (conflict: ConflictRecord, choice: ResolveChoice, text?: string) => {
    const index = items.findIndex((item) => item.id === conflict.id);
    const next = items[index + 1] ?? items[index - 1] ?? null;
    void run(() => actions.resolve(conflict, choice, text)).then((done) => {
      if (!done) return;
      setSelected(next);
      refresh();
    });
  };
  return (
    <div className={listShown ? "obsttorte-conflicts is-list" : "obsttorte-conflicts"}>
      <nav className="obsttorte-conflict-list" aria-labelledby={headingId}>
        <div className="obsttorte-conflict-list-header">
          <h2 id={headingId}>{t("conflicts.count", { count })}</h2>
          <button
            type="button"
            className="clickable-icon"
            aria-label={t("bulk.actions")}
            aria-haspopup="menu"
            ref={tooltip(t("bulk.actions"))}
            disabled={busy}
            onClick={(event) => openBulkMenu(event.currentTarget)}
          >
            <Icon name="ellipsis" />
          </button>
        </div>
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="obsttorte-conflict-item"
                aria-current={item.id === current?.id ? "true" : undefined}
                onClick={() => {
                  setSelected(item);
                  setListShown(false);
                }}
              >
                <span className="obsttorte-conflict-path">{item.path}</span>
                <span className="obsttorte-muted">
                  {t("conflicts.itemMeta", {
                    device: item.deviceName,
                    time: formatDateTime(item.createdAt),
                  })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {current ? (
        <ConflictDetail
          key={current.id}
          conflict={current}
          actions={actions}
          busy={busy}
          onResolve={resolve}
          onShowList={() => setListShown(true)}
        />
      ) : null}
    </div>
  );
}

function isBinary(text: string): boolean {
  return text.includes("\u0000") || text.includes("�");
}

function ConflictDetail({
  conflict,
  actions,
  busy,
  onResolve,
  onShowList,
}: {
  conflict: ConflictRecord;
  actions: ConflictActions;
  busy: boolean;
  onResolve: (conflict: ConflictRecord, choice: ResolveChoice, text?: string) => void;
  onShowList: () => void;
}) {
  const { value: texts, error } = useLoaded(
    useCallback(() => actions.texts(conflict), [actions, conflict]),
  );
  const [draft, setDraft] = useState<string | null>(null);
  const titleId = useId();
  const binary = texts ? isBinary(texts.local) || isBinary(texts.remote) : false;
  const newer =
    conflict.localUpdatedAt || conflict.remoteUpdatedAt
      ? newerConflictSide(conflict.localUpdatedAt, conflict.remoteUpdatedAt)
      : null;
  const openOtherMenu = (anchor: HTMLElement) => {
    if (!texts) return;
    const menu = new Menu();
    const choices: Array<[string, ResolveChoice]> = [
      [t("conflict.both"), "local-remote"],
      [t("conflict.bothReverse"), "remote-local"],
      ...(conflict.path.endsWith(".json")
        ? ([
            [t("conflict.jsonLocal"), "json-local-first"],
            [t("conflict.jsonRemote"), "json-remote-first"],
          ] as Array<[string, ResolveChoice]>)
        : []),
    ];
    for (const [title, choice] of choices) {
      menu.addItem((item) => item.setTitle(title).onClick(() => onResolve(conflict, choice)));
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle(t("conflict.edit")).onClick(() => {
        const merged = mergeText(texts.base, texts.local, texts.remote);
        setDraft(merged.kind === "conflict" ? merged.textWithMarkers : merged.text);
      }),
    );
    showMenuBelow(menu, anchor);
  };
  const sides = [
    {
      key: "local",
      icon: Platform.isMobile ? "smartphone" : "laptop",
      label: t("conflict.localColumn"),
      at: conflict.localUpdatedAt,
    },
    {
      key: "remote",
      icon: "cloud",
      label: t("conflict.remoteColumn"),
      at: conflict.remoteUpdatedAt,
    },
  ];
  return (
    <section className="obsttorte-conflict" aria-labelledby={titleId}>
      <button type="button" className="obsttorte-conflict-back" onClick={onShowList}>
        {t("conflicts.backToList")}
      </button>
      <header className="obsttorte-conflict-header">
        <h2 id={titleId}>{conflict.path}</h2>
        <ActionButton
          label={t("conflict.openFile")}
          onClick={() => actions.openFile(conflict.path)}
        />
      </header>
      <ul className="obsttorte-sides" aria-label={t("conflict.sides")}>
        {sides.map((side) => (
          <li key={side.key} className="obsttorte-chip">
            <Icon name={side.icon} className={`is-${side.key}`} />
            <span>{side.label}</span>
            {side.at ? <span className="obsttorte-muted">{formatDateTime(side.at)}</span> : null}
          </li>
        ))}
      </ul>
      {!texts ? (
        <Pending error={error} />
      ) : draft !== null ? (
        <ConflictEditor
          draft={draft}
          busy={busy}
          onChange={setDraft}
          onSubmit={() => onResolve(conflict, "edit", draft)}
          onCancel={() => setDraft(null)}
        />
      ) : binary ? null : (
        <ConflictTabs texts={texts} />
      )}
      {draft === null ? (
        <div className="obsttorte-actions" role="toolbar" aria-label={t("conflict.actions")}>
          {(["local", "remote"] as const).map((side) => (
            <button
              key={side}
              type="button"
              className={newer === side ? "mod-cta" : undefined}
              disabled={busy || !texts}
              onClick={() => onResolve(conflict, side)}
            >
              {t(`conflict.${side}`)}
              {newer === side ? (
                <span className="obsttorte-badge">{t("conflict.newer")}</span>
              ) : null}
            </button>
          ))}
          {texts && !binary ? (
            <button
              type="button"
              aria-haspopup="menu"
              disabled={busy}
              onClick={(event) => openOtherMenu(event.currentTarget)}
            >
              {t("conflict.other")}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const CONFLICT_TABS = ["compare", "local", "remote", "base"] as const;
type ConflictTab = (typeof CONFLICT_TABS)[number];

function ConflictTabs({ texts }: { texts: ConflictTexts }) {
  const [tab, setTab] = useState<ConflictTab>("compare");
  const tabs = useRef(new Map<ConflictTab, HTMLButtonElement>());
  const id = useId();
  const move = (offset: number) => {
    const index = CONFLICT_TABS.indexOf(tab) + offset + CONFLICT_TABS.length;
    const next = CONFLICT_TABS[index % CONFLICT_TABS.length] ?? "compare";
    setTab(next);
    tabs.current.get(next)?.focus();
  };
  const text = tab === "compare" ? "" : texts[tab];
  return (
    <div className="obsttorte-conflict-body">
      <div
        role="tablist"
        aria-label={t("conflict.views")}
        className="obsttorte-tabs"
        onKeyDown={(event) => {
          const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          if (offset === 0) return;
          event.preventDefault();
          move(offset);
        }}
      >
        {CONFLICT_TABS.map((key) => (
          <button
            key={key}
            ref={(element) => {
              if (element) tabs.current.set(key, element);
            }}
            id={`${id}-${key}`}
            type="button"
            role="tab"
            aria-selected={key === tab}
            aria-controls={`${id}-panel`}
            tabIndex={key === tab ? 0 : -1}
            onClick={() => setTab(key)}
          >
            {t(`conflict.tab.${key}`)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${tab}`}
        className="obsttorte-panel"
      >
        {tab === "compare" ? (
          <Comparison local={texts.local} remote={texts.remote} />
        ) : text.length > 0 ? (
          <pre>{text}</pre>
        ) : (
          <p>{t(tab === "base" ? "conflict.noBase" : "conflict.empty")}</p>
        )}
      </div>
    </div>
  );
}

function Comparison({ local, remote }: { local: string; remote: string }) {
  const hunks = diffLines(remote, local);
  if (hunks.length === 0) return <p>{t("conflict.same")}</p>;
  const blocks = [];
  let lineOffset = 0;
  for (const hunk of hunks) {
    const lines = [];
    for (const line of hunk.lines) {
      const side = line.type === "insert" ? "local" : line.type === "delete" ? "remote" : null;
      const words = [];
      let wordOffset = 0;
      for (const part of line.words) {
        words.push(
          <span
            key={`${lineOffset}:${wordOffset}`}
            className={part.type === "equal" ? undefined : "obsttorte-changed"}
          >
            {part.text}
          </span>,
        );
        wordOffset += part.text.length;
      }
      lines.push(
        <div key={`${lineOffset}:${line.type}`} className={`obsttorte-line is-${side ?? "equal"}`}>
          <span className="obsttorte-line-side">
            {side ? t(side === "local" ? "conflict.localColumn" : "conflict.remoteColumn") : ""}
          </span>
          <span className="obsttorte-line-text">{words}</span>
        </div>,
      );
      lineOffset += 1;
    }
    blocks.push(
      <div key={`${hunk.beforeStart}:${hunk.afterStart}`} className="obsttorte-hunk">
        {lines}
      </div>,
    );
  }
  return <div className="obsttorte-comparison">{blocks}</div>;
}

function ConflictEditor({
  draft,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: string;
  busy: boolean;
  onChange: (text: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const markers = draft.split("\n").filter((line) => line.startsWith("<<<<<<< ")).length;
  return (
    <div className="obsttorte-conflict-body">
      <textarea
        className="obsttorte-editor"
        aria-label={t("conflict.draft")}
        value={draft}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="obsttorte-actions">
        <button type="button" className="mod-cta" disabled={busy || markers > 0} onClick={onSubmit}>
          {t("conflict.applyEdit")}
        </button>
        <ActionButton label={t("bulk.cancel")} onClick={onCancel} />
        {markers > 0 ? (
          <p role="status" className="obsttorte-warning">
            {t("conflict.markersLeft", { count: markers })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export type QuarantineActions = {
  detail: (path: string) => Promise<QuarantineDetail>;
  /** 表示した sha256 がサーバーの現在の版と違えば承認せずに false を返す */
  approve: (path: string, sha256: string) => Promise<boolean>;
  reject: (path: string) => Promise<void>;
};

export type StatusSnapshot = {
  headline: string;
  problem: string | null;
  syncing: boolean;
  paused: boolean;
  conflicts: number;
  quarantine: Array<{ path: string; newPlugin: boolean }>;
  pluginData: number;
  unsynced: number;
  writeFailed: number;
  reloadPending: boolean;
};

export type StatusActions = {
  subscribe: SyncSignal;
  snapshot: () => StatusSnapshot;
  syncNow: () => void;
  togglePause: () => void;
  openConflicts: () => void;
  openLog: () => void;
  openSnapshots: () => void;
  choosePluginData: () => void;
  reload: () => void;
  quarantine: QuarantineActions;
};

export class StatusView extends ReactView {
  constructor(
    leaf: WorkspaceLeaf,
    onSynced: SyncSignal,
    private readonly actions: StatusActions,
  ) {
    super(leaf, onSynced);
  }
  getViewType(): string {
    return STATUS_VIEW_TYPE;
  }
  getDisplayText(): string {
    return t("status.viewTitle");
  }
  getIcon(): string {
    return "refresh-cw";
  }
  protected content(): ReactNode {
    return <StatusPanel actions={this.actions} />;
  }
}

type Task = { key: string; text: string; action: string; onClick: () => void };

function StatusPanel({ actions }: { actions: StatusActions }) {
  const status = useSyncExternalStore(actions.subscribe, actions.snapshot);
  const [reviewing, setReviewing] = useState<string | null>(null);
  if (reviewing) {
    return (
      <QuarantineDecision
        path={reviewing}
        actions={actions.quarantine}
        onBack={() => setReviewing(null)}
        onDecided={() => setReviewing(null)}
      />
    );
  }
  const tasks: Task[] = [
    ...(status.conflicts > 0
      ? [
          {
            key: "conflicts",
            text: t("task.conflicts", { count: status.conflicts }),
            action: t("task.open"),
            onClick: actions.openConflicts,
          },
        ]
      : []),
    ...status.quarantine.map((item) => ({
      key: `quarantine:${item.path}`,
      text: item.newPlugin ? `${t("quarantine.newPlugin")} ${item.path}` : item.path,
      action: t("task.review"),
      onClick: () => setReviewing(item.path),
    })),
    ...(status.pluginData > 0
      ? [
          {
            key: "plugin-data",
            text: t("task.pluginData", { count: status.pluginData }),
            action: t("task.choose"),
            onClick: actions.choosePluginData,
          },
        ]
      : []),
    ...(status.unsynced > 0
      ? [
          {
            key: "unsynced",
            text: t("task.unsynced", { count: status.unsynced }),
            action: t("task.openLog"),
            onClick: actions.openLog,
          },
        ]
      : []),
    ...(status.writeFailed > 0
      ? [
          {
            key: "write-failed",
            text: t("task.writeFailed", { count: status.writeFailed }),
            action: t("task.openLog"),
            onClick: actions.openLog,
          },
        ]
      : []),
    ...(status.reloadPending
      ? [
          {
            key: "reload",
            text: t("task.reload"),
            action: t("notice.reloadButton"),
            onClick: actions.reload,
          },
        ]
      : []),
  ];
  return (
    <section className="obsttorte-view" aria-label={t("status.viewTitle")}>
      <div className="obsttorte-status-summary">
        <p className="obsttorte-headline" role="status">
          {status.headline}
        </p>
        {status.problem ? <p role="alert">{status.problem}</p> : null}
        <div className="obsttorte-actions">
          {status.paused ? (
            <ActionButton label={t("menu.resume")} cta onClick={actions.togglePause} />
          ) : (
            <>
              <ActionButton
                label={t("menu.syncNow")}
                cta
                disabled={status.syncing}
                onClick={actions.syncNow}
              />
              <ActionButton label={t("menu.pause")} onClick={actions.togglePause} />
            </>
          )}
        </div>
      </div>
      {tasks.length > 0 ? (
        <section aria-labelledby="obsttorte-tasks">
          <h4 id="obsttorte-tasks">{t("task.heading")}</h4>
          <ul className="obsttorte-tasks">
            {tasks.map((task) => (
              <li key={task.key}>
                <span>{task.text}</span>
                <ActionButton label={task.action} onClick={task.onClick} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="obsttorte-actions">
        <ActionButton label={t("menu.openLog")} onClick={actions.openLog} />
        <ActionButton label={t("settings.openSnapshots")} onClick={actions.openSnapshots} />
      </div>
    </section>
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
    <section className="obsttorte-view" aria-label={t("quarantine.actions")}>
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
