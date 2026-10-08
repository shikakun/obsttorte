import {
  DEFAULT_DEVICE_SETTINGS,
  DEFAULT_SHARED_SETTINGS,
  type DeviceSettings,
  type DeviceSummary,
  parseDeviceSettings,
  parseSharedSettings,
  type SharedSettings,
} from "@obsttorte/shared";
import {
  type App,
  type Plugin,
  PluginSettingTab,
  SecretComponent,
  type Setting,
  type SettingDefinitionItem,
  type SettingGroupItem,
  setIcon,
} from "obsidian";
import { formatDateTime, t } from "./i18n";

export type PluginData = DeviceSettings & {
  reloadPending: string[];
  lastConfirmedAt: number | null;
  lastRehashAt: number | null;
  autoSyncPaused: boolean;
  paused: boolean;
};

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function lines(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadDeviceSettings(raw: unknown, installId: string): PluginData {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  // 一時停止は以前syncModeの値として保存していた
  const pausedByMode = record.syncMode === "paused";
  const settings = parseDeviceSettings(
    pausedByMode ? { ...record, syncMode: "bidirectional" } : raw,
    installId,
  );
  return {
    ...settings,
    paused: pausedByMode || record.paused === true,
    reloadPending: stringList(record.reloadPending),
    lastConfirmedAt: typeof record.lastConfirmedAt === "number" ? record.lastConfirmedAt : null,
    lastRehashAt: typeof record.lastRehashAt === "number" ? record.lastRehashAt : null,
    autoSyncPaused: record.autoSyncPaused === true,
  };
}

export function emptyDeviceSettings(installId: string): PluginData {
  return {
    ...DEFAULT_DEVICE_SETTINGS,
    installId,
    reloadPending: [],
    lastConfirmedAt: null,
    lastRehashAt: null,
    autoSyncPaused: false,
    paused: false,
  };
}

export async function readSharedSettings(app: App): Promise<SharedSettings> {
  const path = `${app.vault.configDir}/obsttorte.json`;
  if (!(await app.vault.adapter.exists(path))) return structuredClone(DEFAULT_SHARED_SETTINGS);
  return parseSharedSettings(JSON.parse(await app.vault.adapter.read(path)));
}

export async function writeSharedSettings(app: App, settings: SharedSettings): Promise<void> {
  await app.vault.adapter.write(
    `${app.vault.configDir}/obsttorte.json`,
    `${JSON.stringify(settings, null, 2)}\n`,
  );
}

export type DeviceListing = { devices: DeviceSummary[]; currentId: string } | { problem: string };

export type ConnectionSummary = { ok: boolean; title: string; detail: string };

export type SettingsDeps = {
  data: () => PluginData;
  save: (data: PluginData) => Promise<void>;
  shared: () => SharedSettings;
  saveShared: (settings: SharedSettings) => Promise<void>;
  pluginIds: () => string[];
  connection: () => ConnectionSummary;
  missingCredentials: () => number;
  checkConnection: () => Promise<string>;
  listDevices: () => Promise<DeviceListing>;
  setPaused: (paused: boolean) => Promise<void>;
  exportPlan: (redacted: boolean) => void;
  rebuildIndex: () => Promise<void>;
  purge: () => void;
  confirm: (message: string, action: string) => Promise<boolean>;
};

const PLUGIN_DATA_PREFIX = "pluginData:";
const CODE_PLUGIN_PREFIX = "codePlugin:";
const RATIO_KEYS = new Set(["maxDeletionRatio", "maxChangeRatio"]);

function wholeNumber(min: number) {
  return (value: number) =>
    Number.isInteger(value) && value >= min ? undefined : t("validate.wholeNumber", { min });
}

function percent(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? undefined : t("validate.percent");
}

export function isAllowedServerUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return url.protocol === "https:" || (url.protocol === "http:" && local);
  } catch {
    return false;
  }
}

function serverUrl(value: string) {
  if (value.trim() === "" || isAllowedServerUrl(value)) return undefined;
  return t("validate.url");
}

function numberControl(key: string, min: number) {
  return { type: "number" as const, key, min, step: 1, validate: wholeNumber(min) };
}

function ratioControl(key: string) {
  return {
    type: "number" as const,
    key,
    min: 0,
    max: 100,
    step: "any" as const,
    validate: percent,
  };
}

export class ObsttorteSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: Plugin,
    private readonly deps: SettingsDeps,
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        heading: t("settings.connection"),
        items: [
          { name: t("settings.connection"), render: (setting) => this.renderConnection(setting) },
          {
            type: "page",
            name: t("settings.credentials"),
            displayValue: () => {
              const missing = this.deps.missingCredentials();
              return missing > 0
                ? t("settings.credentialsMissing", { count: missing })
                : t("settings.credentialsSet");
            },
            status: () => (this.deps.missingCredentials() > 0 ? "warning" : null),
            items: [
              {
                type: "group",
                items: [
                  {
                    name: t("settings.serverUrl"),
                    desc: t("settings.serverUrlDesc"),
                    control: {
                      type: "text",
                      key: "serverUrl",
                      placeholder: "https://obsttorte.example.workers.dev",
                      validate: serverUrl,
                    },
                  },
                  {
                    name: t("settings.accessClientId"),
                    desc: t("settings.accessClientIdDesc"),
                    control: { type: "text", key: "accessClientId" },
                  },
                  this.secretSetting(
                    t("settings.accessClientSecret"),
                    t("settings.accessClientSecretDesc"),
                    "accessClientSecretName",
                  ),
                  this.secretSetting(
                    t("settings.deviceToken"),
                    t("settings.deviceTokenDesc"),
                    "deviceTokenName",
                  ),
                ],
              },
            ],
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.thisDevice"),
        items: [
          {
            name: t("settings.syncMode"),
            control: {
              type: "dropdown",
              key: "syncMode",
              options: {
                bidirectional: t("settings.mode.bidirectional"),
                "push-only": t("settings.mode.push-only"),
                "pull-only": t("settings.mode.pull-only"),
              },
            },
          },
          { name: t("settings.paused"), control: { type: "toggle", key: "paused" } },
          { name: t("settings.interval"), control: numberControl("syncIntervalMinutes", 1) },
        ],
      },
      {
        type: "group",
        heading: t("settings.allDevices"),
        items: [
          {
            type: "page",
            name: t("settings.exclusions"),
            displayValue: () => {
              const count = this.deps.shared().exclusions.length;
              return count > 0 ? t("settings.patternCount", { count }) : t("settings.none");
            },
            items: [
              {
                type: "group",
                items: [
                  {
                    name: t("settings.exclusionPatterns"),
                    desc: t("settings.exclusionPatternsDesc"),
                    control: {
                      type: "textarea",
                      key: "exclusions",
                      placeholder: "Private/**\n**/*.pdf",
                      rows: 4,
                    },
                  },
                  {
                    name: t("settings.fixedExclusions"),
                    render: (setting) => this.renderFixedExclusions(setting),
                  },
                ],
              },
            ],
          },
          {
            type: "page",
            name: t("settings.plugins"),
            displayValue: () => {
              const pending = this.pendingPluginData();
              return pending > 0
                ? t("settings.pluginDataPending", { count: pending })
                : t("settings.pluginCount", { count: this.otherPluginIds().length });
            },
            status: () => (this.pendingPluginData() > 0 ? "warning" : null),
            items: this.pluginItems(),
          },
          {
            name: t("settings.autoMerge"),
            desc: t("settings.autoMergeDesc"),
            control: { type: "toggle", key: "autoMerge" },
          },
          {
            type: "page",
            name: t("settings.guard"),
            displayValue: () => {
              const guard = this.deps.shared().bulkGuard;
              return t("settings.guardSummary", {
                deletions: guard.maxDeletions,
                ratio: Math.round(guard.maxDeletionRatio * 1000) / 10,
              });
            },
            items: [
              {
                type: "group",
                items: [
                  { name: t("settings.maxDeletions"), control: numberControl("maxDeletions", 0) },
                  {
                    name: t("settings.maxDeletionRatio"),
                    control: ratioControl("maxDeletionRatio"),
                  },
                  { name: t("settings.maxChangeRatio"), control: ratioControl("maxChangeRatio") },
                  {
                    name: t("settings.shrinkToZero"),
                    desc: t("settings.shrinkToZeroDesc"),
                    control: numberControl("maxShrinkToZero", 0),
                  },
                ],
              },
            ],
          },
          {
            type: "page",
            name: t("settings.retention"),
            displayValue: () => {
              const retention = this.deps.shared().snapshotRetention;
              return t("settings.retentionSummary", {
                daily: retention.dailyDays,
                monthly: retention.monthlyMonths,
              });
            },
            items: [
              {
                type: "group",
                items: [
                  { name: t("settings.dailyDays"), control: numberControl("dailyDays", 0) },
                  { name: t("settings.monthlyMonths"), control: numberControl("monthlyMonths", 0) },
                  { name: t("settings.deviceDays"), control: numberControl("deviceDays", 0) },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.devices"),
        items: [
          {
            type: "page",
            name: t("settings.registeredDevices"),
            items: [
              {
                type: "group",
                items: [
                  {
                    name: t("settings.registeredDevices"),
                    render: (setting) => this.renderDevices(setting),
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.advanced"),
        items: [
          {
            name: t("settings.language"),
            control: {
              type: "dropdown",
              key: "languageOverride",
              options: { "": t("settings.languageDefault"), en: "English", ja: "日本語" },
            },
          },
          {
            name: t("settings.logVerbosity"),
            control: {
              type: "dropdown",
              key: "logVerbosity",
              options: {
                normal: t("settings.logVerbosity.normal"),
                verbose: t("settings.logVerbosity.verbose"),
              },
            },
          },
          {
            type: "page",
            name: t("settings.troubleshooting"),
            items: [
              {
                type: "group",
                items: [
                  { name: t("commands.exportPlan"), action: () => this.deps.exportPlan(false) },
                  {
                    name: t("commands.exportPlanRedacted"),
                    action: () => this.deps.exportPlan(true),
                  },
                  {
                    name: t("settings.rebuildIndex"),
                    action: () => void this.rebuildIndex(),
                  },
                  { name: t("commands.purge"), action: () => this.deps.purge() },
                ],
              },
            ],
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    const shared = this.deps.shared();
    if (key.startsWith(PLUGIN_DATA_PREFIX)) {
      const choice = shared.pluginDataSync[key.slice(PLUGIN_DATA_PREFIX.length)];
      return choice === undefined ? "ask" : choice ? "sync" : "skip";
    }
    if (key.startsWith(CODE_PLUGIN_PREFIX)) {
      return shared.codeConfiguredPluginIds.includes(key.slice(CODE_PLUGIN_PREFIX.length));
    }
    if (key === "codeConfiguredElsewhere") return this.codePluginsElsewhere().join("\n");
    if (key === "autoMerge") return shared.autoMerge;
    if (key === "exclusions") return shared.exclusions.join("\n");
    if (key === "maxDeletions") return shared.bulkGuard.maxDeletions;
    // 割合は0〜1で保存し、画面では百分率で見せる
    if (RATIO_KEYS.has(key)) {
      const ratio = shared.bulkGuard[key as "maxDeletionRatio" | "maxChangeRatio"];
      return Math.round(ratio * 1000) / 10;
    }
    if (key === "maxShrinkToZero") return shared.bulkGuard.maxShrinkToZero;
    if (key === "dailyDays") return shared.snapshotRetention.dailyDays;
    if (key === "monthlyMonths") return shared.snapshotRetention.monthlyMonths;
    if (key === "deviceDays") return shared.snapshotRetention.deviceDays;
    if (key === "languageOverride") return this.deps.data().languageOverride ?? "";
    return this.deps.data()[key as keyof PluginData];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const shared = this.deps.shared();
    if (key.startsWith(PLUGIN_DATA_PREFIX)) {
      const id = key.slice(PLUGIN_DATA_PREFIX.length);
      const { [id]: _, ...rest } = shared.pluginDataSync;
      const pluginDataSync = value === "ask" ? rest : { ...rest, [id]: value === "sync" };
      await this.deps.saveShared({ ...shared, pluginDataSync });
      return;
    }
    if (key.startsWith(CODE_PLUGIN_PREFIX)) {
      const id = key.slice(CODE_PLUGIN_PREFIX.length);
      const others = shared.codeConfiguredPluginIds.filter((item) => item !== id);
      const codeConfiguredPluginIds = value === true ? [...others, id] : others;
      await this.deps.saveShared({ ...shared, codeConfiguredPluginIds });
      return;
    }
    if (key === "codeConfiguredElsewhere") {
      const installed = new Set(this.otherPluginIds());
      const kept = shared.codeConfiguredPluginIds.filter((id) => installed.has(id));
      const added = lines(value).filter((id) => !installed.has(id));
      await this.deps.saveShared({ ...shared, codeConfiguredPluginIds: [...kept, ...added] });
      return;
    }
    if (key === "autoMerge") {
      await this.deps.saveShared({ ...shared, autoMerge: value === true });
      return;
    }
    if (key === "exclusions") {
      await this.deps.saveShared({ ...shared, exclusions: lines(value) });
      return;
    }
    if (key === "maxDeletions" || key === "maxShrinkToZero" || RATIO_KEYS.has(key)) {
      const number = RATIO_KEYS.has(key) ? Number(value) / 100 : Number(value);
      await this.deps.saveShared({
        ...shared,
        bulkGuard: { ...shared.bulkGuard, [key]: number },
      });
      return;
    }
    if (key === "dailyDays" || key === "monthlyMonths" || key === "deviceDays") {
      await this.deps.saveShared({
        ...shared,
        snapshotRetention: { ...shared.snapshotRetention, [key]: Number(value) },
      });
      return;
    }
    if (key === "paused") {
      await this.deps.setPaused(value === true);
      return;
    }
    if (key === "languageOverride") {
      await this.deps.save({
        ...this.deps.data(),
        languageOverride: typeof value === "string" && value.length > 0 ? value : null,
      });
      // 新しい言語で項目名と説明を描き直す
      this.update();
      return;
    }
    if (key === "serverUrl" && typeof value === "string") {
      await this.deps.save({ ...this.deps.data(), serverUrl: value.trim() });
      return;
    }
    await this.deps.save({ ...this.deps.data(), [key]: value });
  }

  private otherPluginIds(): string[] {
    return this.deps.pluginIds().filter((id) => id !== this.plugin.manifest.id);
  }

  private pendingPluginData(): number {
    const chosen = this.deps.shared().pluginDataSync;
    return this.otherPluginIds().filter((id) => chosen[id] === undefined).length;
  }

  private codePluginsElsewhere(): string[] {
    const installed = new Set(this.otherPluginIds());
    return this.deps.shared().codeConfiguredPluginIds.filter((id) => !installed.has(id));
  }

  private pluginItems(): SettingDefinitionItem[] {
    const ids = this.otherPluginIds();
    if (ids.length === 0) {
      return [{ type: "group", items: [{ name: t("settings.pluginDataNone") }] }];
    }
    const chosen = this.deps.shared().pluginDataSync;
    const ordered = [
      ...ids.filter((id) => chosen[id] === undefined),
      ...ids.filter((id) => chosen[id] !== undefined),
    ];
    return [
      {
        type: "group",
        heading: t("settings.pluginDataSync"),
        items: [
          { name: t("settings.pluginDataCaution") },
          ...ordered.map(
            (id): SettingGroupItem => ({
              name: id,
              control: {
                type: "dropdown",
                key: `${PLUGIN_DATA_PREFIX}${id}`,
                options: {
                  ask: t("pluginData.ask"),
                  sync: t("pluginData.sync"),
                  skip: t("pluginData.skip"),
                },
              },
            }),
          ),
        ],
      },
      {
        type: "group",
        heading: t("settings.codePlugins"),
        items: [
          ...ids.map(
            (id): SettingGroupItem => ({
              name: id,
              control: { type: "toggle", key: `${CODE_PLUGIN_PREFIX}${id}` },
            }),
          ),
          {
            name: t("settings.codePluginsElsewhere"),
            control: { type: "textarea", key: "codeConfiguredElsewhere", rows: 3 },
          },
        ],
      },
    ];
  }

  private renderConnection(setting: Setting): void {
    const summary = this.deps.connection();
    setting.setName(
      createFragment((fragment) => {
        const icon = fragment.createSpan({
          cls: summary.ok ? "obsttorte-connection is-ok" : "obsttorte-connection is-error",
        });
        setIcon(icon, summary.ok ? "circle-check" : "circle-x");
        fragment.appendText(summary.title);
      }),
    );
    setting.setDesc(summary.detail);
    setting.addButton((button) =>
      button.setButtonText(t("connection.check")).onClick(async () => {
        button.setDisabled(true);
        await this.deps.checkConnection();
        this.update();
      }),
    );
  }

  private renderFixedExclusions(setting: Setting): void {
    const config = this.app.vault.configDir;
    setting.setDesc(
      createFragment((fragment) => {
        fragment.createDiv({
          cls: "obsttorte-fixed-exclusions",
          text: [
            `${config}/plugins/${this.plugin.manifest.id}/`,
            `${config}/workspace.json`,
            `${config}/workspace-mobile.json`,
            `${config}/workspaces.json`,
            ".trash/",
            ".DS_Store, Thumbs.db, desktop.ini",
            "*.tmp, *.swp, ~$*, .#*",
          ].join("\n"),
        });
      }),
    );
  }

  private renderDevices(setting: Setting): void {
    setting.setDesc(t("view.loading"));
    void this.deps.listDevices().then((listing) => {
      setting.setDesc(
        createFragment((fragment) => {
          fragment.createDiv({ text: t("settings.registeredDevicesDesc") });
          if ("problem" in listing) {
            fragment.createDiv({ text: listing.problem });
            return;
          }
          for (const device of listing.devices) {
            const name =
              device.id === listing.currentId
                ? t("devices.current", { name: device.name })
                : device.name;
            fragment.createDiv({
              text: device.revokedAt
                ? t("devices.revoked", { name })
                : device.lastSeenAt
                  ? t("devices.lastSeen", { name, time: formatDateTime(device.lastSeenAt) })
                  : t("devices.neverSeen", { name }),
            });
          }
        }),
      );
    });
  }

  private async rebuildIndex(): Promise<void> {
    const confirmed = await this.deps.confirm(
      t("settings.rebuildIndexDesc"),
      t("settings.rebuildApply"),
    );
    if (confirmed) await this.deps.rebuildIndex();
  }

  private secretSetting(
    name: string,
    desc: string,
    key: "accessClientSecretName" | "deviceTokenName",
  ): SettingGroupItem {
    return {
      name,
      desc,
      render: (setting) => {
        setting.addComponent((element) => {
          const secret = new SecretComponent(this.app, element);
          secret.setValue(this.deps.data()[key]);
          secret.onChange((value) => this.deps.save({ ...this.deps.data(), [key]: value }));
          return secret;
        });
      },
    };
  }
}
