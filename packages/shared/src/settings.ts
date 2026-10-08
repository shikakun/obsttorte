import type { SyncMode } from "./types";

export type BulkGuardThresholds = {
  maxDeletions: number;
  maxDeletionRatio: number;
  maxChangeRatio: number;
  maxShrinkToZero: number;
};

export type SnapshotRetention = {
  dailyDays: number;
  monthlyMonths: number;
  deviceDays: number;
};

export type SharedSettings = {
  exclusions: string[];
  pluginDataSync: Record<string, boolean>;
  codeConfiguredPluginIds: string[];
  bulkGuard: BulkGuardThresholds;
  autoMerge: boolean;
  snapshotRetention: SnapshotRetention;
};

export const DEFAULT_CODE_CONFIGURED_PLUGINS = [
  "obsidian-shellcommands",
  "templater-obsidian",
  "quickadd",
  "customjs",
  "execute-code",
  "dataview",
] as const;

export const DEFAULT_SHARED_SETTINGS: SharedSettings = {
  exclusions: [],
  pluginDataSync: {},
  codeConfiguredPluginIds: [...DEFAULT_CODE_CONFIGURED_PLUGINS],
  bulkGuard: {
    maxDeletions: 50,
    maxDeletionRatio: 0.1,
    maxChangeRatio: 0.3,
    maxShrinkToZero: 1,
  },
  autoMerge: true,
  snapshotRetention: {
    dailyDays: 30,
    monthlyMonths: 24,
    deviceDays: 90,
  },
};

export class SharedSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedSettingsError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SharedSettingsError(`${name} must be an array of strings`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new SharedSettingsError(`${name} must be a boolean`);
  return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new SharedSettingsError(`${name} must be a non-negative number`);
  }
  return value;
}

function optionalBooleanRecord(value: unknown, name: string): Record<string, boolean> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new SharedSettingsError(`${name} must be an object`);
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "boolean")
      throw new SharedSettingsError(`${name}.${key} must be a boolean`);
    result[key] = entry;
  }
  return result;
}

export function parseSharedSettings(input: unknown): SharedSettings {
  if (!isRecord(input)) throw new SharedSettingsError("Shared settings must be an object");
  const defaults = DEFAULT_SHARED_SETTINGS;
  return {
    exclusions: optionalStringArray(input.exclusions, "exclusions") ?? defaults.exclusions,
    pluginDataSync:
      optionalBooleanRecord(input.pluginDataSync, "pluginDataSync") ?? defaults.pluginDataSync,
    codeConfiguredPluginIds:
      optionalStringArray(input.codeConfiguredPluginIds, "codeConfiguredPluginIds") ??
      defaults.codeConfiguredPluginIds,
    autoMerge: optionalBoolean(input.autoMerge, "autoMerge") ?? defaults.autoMerge,
    bulkGuard: numberGroup(input.bulkGuard, defaults.bulkGuard, "bulkGuard"),
    snapshotRetention: numberGroup(
      input.snapshotRetention,
      defaults.snapshotRetention,
      "snapshotRetention",
    ),
  };
}

function numberGroup<T extends Record<string, number>>(
  value: unknown,
  defaults: T,
  name: string,
): T {
  if (value === undefined) return { ...defaults };
  if (!isRecord(value)) throw new SharedSettingsError(`${name} must be an object`);
  const result: Record<string, number> = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    result[key] = optionalNumber(value[key], `${name}.${key}`) ?? fallback;
  }
  return result as T;
}

export type DeviceSettings = {
  serverUrl: string;
  accessClientId: string;
  accessClientSecretName: string;
  deviceTokenName: string;
  syncMode: SyncMode;
  syncIntervalMinutes: number;
  installId: string;
  languageOverride: string | null;
  logVerbosity: "normal" | "verbose";
};

export const DEFAULT_DEVICE_SETTINGS: Omit<DeviceSettings, "installId"> = {
  serverUrl: "",
  accessClientId: "",
  accessClientSecretName: "",
  deviceTokenName: "",
  syncMode: "bidirectional",
  syncIntervalMinutes: 5,
  languageOverride: null,
  logVerbosity: "normal",
};

const SYNC_MODES = new Set<SyncMode>(["bidirectional", "push-only", "pull-only"]);

export function parseDeviceSettings(input: unknown, installId: string): DeviceSettings {
  const defaults = DEFAULT_DEVICE_SETTINGS;
  const record = input === undefined || input === null ? {} : input;
  if (!isRecord(record)) throw new SharedSettingsError("Device settings must be an object");
  const syncMode = record.syncMode ?? defaults.syncMode;
  if (typeof syncMode !== "string" || !SYNC_MODES.has(syncMode as SyncMode)) {
    throw new SharedSettingsError("syncMode is invalid");
  }
  const interval = record.syncIntervalMinutes ?? defaults.syncIntervalMinutes;
  if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 1) {
    throw new SharedSettingsError("syncIntervalMinutes must be at least 1");
  }
  const verbosity = record.logVerbosity ?? defaults.logVerbosity;
  if (verbosity !== "normal" && verbosity !== "verbose") {
    throw new SharedSettingsError("logVerbosity is invalid");
  }
  const languageOverride = record.languageOverride ?? defaults.languageOverride;
  if (languageOverride !== null && typeof languageOverride !== "string") {
    throw new SharedSettingsError("languageOverride must be a string or null");
  }
  return {
    serverUrl: typeof record.serverUrl === "string" ? record.serverUrl : defaults.serverUrl,
    accessClientId:
      typeof record.accessClientId === "string" ? record.accessClientId : defaults.accessClientId,
    accessClientSecretName:
      typeof record.accessClientSecretName === "string"
        ? record.accessClientSecretName
        : defaults.accessClientSecretName,
    deviceTokenName:
      typeof record.deviceTokenName === "string"
        ? record.deviceTokenName
        : defaults.deviceTokenName,
    syncMode: syncMode as SyncMode,
    syncIntervalMinutes: interval,
    installId:
      typeof record.installId === "string" && record.installId.length > 0
        ? record.installId
        : installId,
    languageOverride,
    logVerbosity: verbosity,
  };
}
