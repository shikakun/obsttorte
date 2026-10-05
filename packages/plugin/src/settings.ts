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
} from "obsidian";
import { formatDateTime, t } from "./i18n";

export type PluginData = DeviceSettings & {
  reloadPending: string[];
  lastConfirmedAt: number | null;
  lastSnapshotAt: number | null;
  lastRehashAt: number | null;
  autoSyncPaused: boolean;
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
  const settings = parseDeviceSettings(raw, installId);
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    ...settings,
    reloadPending: stringList(record.reloadPending),
    lastConfirmedAt: typeof record.lastConfirmedAt === "number" ? record.lastConfirmedAt : null,
    lastSnapshotAt: typeof record.lastSnapshotAt === "number" ? record.lastSnapshotAt : null,
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
    lastSnapshotAt: null,
    lastRehashAt: null,
    autoSyncPaused: false,
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

export type DeviceListing = { devices: DeviceSummary[] } | { problem: string };

const PLUGIN_DATA_PREFIX = "pluginData:";
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

export class ObsttorteSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: Plugin,
    private readonly data: () => PluginData,
    private readonly save: (data: PluginData) => Promise<void>,
    private readonly saveShared: (settings: SharedSettings) => Promise<void>,
    private readonly checkConnection: () => Promise<string>,
    private readonly sharedNow: () => SharedSettings,
    private readonly listDevices: () => Promise<DeviceListing>,
    private readonly pluginIds: () => string[],
    private readonly actions: {
      syncNow: () => void;
      exportPlan: () => void;
      openSnapshots: () => void;
      rebuildIndex: () => Promise<void>;
    },
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const shared = (heading: string) => `${t(heading)} — ${t("settings.shared")}`;
    return [
      {
        type: "group",
        heading: t("settings.connection"),
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
          {
            name: t("connection.check"),
            desc: t("settings.checkDesc"),
            action: () => void this.checkConnection(),
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.sync"),
        items: [
          {
            name: t("settings.syncMode"),
            desc: t("settings.syncModeDesc"),
            control: {
              type: "dropdown",
              key: "syncMode",
              options: {
                bidirectional: t("settings.mode.bidirectional"),
                "push-only": t("settings.mode.push-only"),
                "pull-only": t("settings.mode.pull-only"),
                paused: t("settings.mode.paused"),
              },
            },
          },
          {
            name: t("settings.interval"),
            desc: t("settings.intervalDesc"),
            control: {
              type: "number",
              key: "syncIntervalMinutes",
              min: 1,
              step: 1,
              validate: wholeNumber(1),
            },
          },
          { name: t("settings.syncNow"), action: () => this.actions.syncNow() },
          {
            name: t("settings.exportPlan"),
            desc: t("settings.exportPlanDesc"),
            action: () => this.actions.exportPlan(),
          },
        ],
      },
      {
        type: "group",
        heading: shared("settings.protection"),
        items: [
          {
            name: t("settings.autoMerge"),
            desc: t("settings.autoMergeDesc"),
            control: { type: "toggle", key: "autoMerge" },
          },
          {
            name: t("settings.maxDeletions"),
            desc: t("settings.maxDeletionsDesc"),
            control: {
              type: "number",
              key: "maxDeletions",
              min: 0,
              step: 1,
              validate: wholeNumber(0),
            },
          },
          {
            name: t("settings.maxDeletionRatio"),
            desc: t("settings.maxDeletionRatioDesc"),
            control: {
              type: "number",
              key: "maxDeletionRatio",
              min: 0,
              max: 100,
              step: "any",
              validate: percent,
            },
          },
          {
            name: t("settings.maxChangeRatio"),
            desc: t("settings.maxChangeRatioDesc"),
            control: {
              type: "number",
              key: "maxChangeRatio",
              min: 0,
              max: 100,
              step: "any",
              validate: percent,
            },
          },
          {
            name: t("settings.shrinkToZero"),
            desc: t("settings.shrinkToZeroDesc"),
            control: {
              type: "number",
              key: "maxShrinkToZero",
              min: 0,
              step: 1,
              validate: wholeNumber(0),
            },
          },
        ],
      },
      {
        type: "group",
        heading: shared("settings.plugins"),
        items: [
          { name: t("settings.pluginData"), desc: t("settings.pluginDataDesc") },
          ...this.pluginDataItems(),
          {
            name: t("settings.codePlugins"),
            desc: t("settings.codePluginsDesc"),
            control: { type: "textarea", key: "codeConfiguredPluginIds", rows: 4 },
          },
        ],
      },
      {
        type: "group",
        heading: shared("settings.exclusions"),
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
            render: (setting) => {
              const config = this.app.vault.configDir;
              const selfId = this.plugin.manifest.id;
              setting.setDesc(
                createFragment((fragment) => {
                  fragment.createDiv({ text: t("settings.fixedExclusionsDesc") });
                  fragment.createDiv({
                    cls: "obsttorte-fixed-exclusions",
                    text: [
                      `${config}/plugins/${selfId}/`,
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
            },
          },
        ],
      },
      {
        type: "group",
        heading: shared("settings.history"),
        items: [
          {
            name: t("settings.dailyDays"),
            desc: t("settings.dailyDaysDesc"),
            control: {
              type: "number",
              key: "dailyDays",
              min: 0,
              step: 1,
              validate: wholeNumber(0),
            },
          },
          {
            name: t("settings.monthlyMonths"),
            desc: t("settings.monthlyMonthsDesc"),
            control: {
              type: "number",
              key: "monthlyMonths",
              min: 0,
              step: 1,
              validate: wholeNumber(0),
            },
          },
          {
            name: t("settings.deviceDays"),
            desc: t("settings.deviceDaysDesc"),
            control: {
              type: "number",
              key: "deviceDays",
              min: 0,
              step: 1,
              validate: wholeNumber(0),
            },
          },
          { name: t("settings.openSnapshots"), action: () => this.actions.openSnapshots() },
        ],
      },
      {
        type: "group",
        heading: t("settings.devices"),
        items: [
          {
            name: t("settings.registeredDevices"),
            render: (setting) => this.renderDevices(setting),
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
            desc: t("settings.logVerbosityDesc"),
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
            name: t("settings.rebuildIndex"),
            desc: t("settings.rebuildIndexDesc"),
            action: () => void this.actions.rebuildIndex(),
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    const shared = this.sharedNow();
    if (key.startsWith(PLUGIN_DATA_PREFIX)) {
      const choice = shared.pluginDataSync[key.slice(PLUGIN_DATA_PREFIX.length)];
      return choice === undefined ? "ask" : choice ? "sync" : "skip";
    }
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
    if (key === "codeConfiguredPluginIds") return shared.codeConfiguredPluginIds.join("\n");
    if (key === "languageOverride") return this.data().languageOverride ?? "";
    return this.data()[key as keyof PluginData];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const shared = this.sharedNow();
    if (key.startsWith(PLUGIN_DATA_PREFIX)) {
      const id = key.slice(PLUGIN_DATA_PREFIX.length);
      const { [id]: _, ...rest } = shared.pluginDataSync;
      const pluginDataSync = value === "ask" ? rest : { ...rest, [id]: value === "sync" };
      await this.saveShared({ ...shared, pluginDataSync });
      return;
    }
    if (key === "autoMerge") {
      await this.saveShared({ ...shared, autoMerge: value === true });
      return;
    }
    if (key === "codeConfiguredPluginIds" || key === "exclusions") {
      await this.saveShared({ ...shared, [key]: lines(value) });
      return;
    }
    if (key === "maxDeletions" || key === "maxShrinkToZero" || RATIO_KEYS.has(key)) {
      const number = RATIO_KEYS.has(key) ? Number(value) / 100 : Number(value);
      await this.saveShared({ ...shared, bulkGuard: { ...shared.bulkGuard, [key]: number } });
      return;
    }
    if (key === "dailyDays" || key === "monthlyMonths" || key === "deviceDays") {
      await this.saveShared({
        ...shared,
        snapshotRetention: { ...shared.snapshotRetention, [key]: Number(value) },
      });
      return;
    }
    if (key === "languageOverride") {
      await this.save({
        ...this.data(),
        languageOverride: typeof value === "string" && value.length > 0 ? value : null,
      });
      // 新しい言語で項目名と説明を描き直す
      this.update();
      return;
    }
    if (key === "serverUrl" && typeof value === "string") {
      await this.save({ ...this.data(), serverUrl: value.trim() });
      return;
    }
    await this.save({ ...this.data(), [key]: value });
  }

  private pluginDataItems(): SettingGroupItem[] {
    const ids = this.pluginIds().filter((id) => id !== this.plugin.manifest.id);
    if (ids.length === 0) return [{ name: t("settings.pluginDataNone") }];
    return ids.map((id) => ({
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
    }));
  }

  private renderDevices(setting: Setting): void {
    setting.setDesc(t("view.loading"));
    void this.listDevices().then((listing) => {
      setting.setDesc(
        createFragment((fragment) => {
          fragment.createDiv({ text: t("settings.registeredDevicesDesc") });
          if ("problem" in listing) {
            fragment.createDiv({ text: listing.problem });
            return;
          }
          for (const device of listing.devices) {
            fragment.createDiv({
              text: device.revokedAt
                ? t("devices.revoked", { name: device.name })
                : device.lastSeenAt
                  ? t("devices.lastSeen", {
                      name: device.name,
                      time: formatDateTime(device.lastSeenAt),
                    })
                  : t("devices.neverSeen", { name: device.name }),
            });
          }
        }),
      );
    });
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
          secret.setValue(this.data()[key]);
          secret.onChange((value) => this.save({ ...this.data(), [key]: value }));
          return secret;
        });
      },
    };
  }
}
