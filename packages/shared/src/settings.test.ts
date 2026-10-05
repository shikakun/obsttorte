import { describe, expect, it } from "vitest";
import { DEFAULT_SHARED_SETTINGS, parseSharedSettings, SharedSettingsError } from "./settings";

describe("parseSharedSettings", () => {
  it("fills omitted fields from the defaults and keeps the given ones", () => {
    expect(parseSharedSettings({})).toEqual(DEFAULT_SHARED_SETTINGS);
    expect(
      parseSharedSettings({
        codeConfiguredPluginIds: ["customjs"],
        bulkGuard: { maxDeletions: 5 },
      }),
    ).toEqual({
      ...DEFAULT_SHARED_SETTINGS,
      codeConfiguredPluginIds: ["customjs"],
      bulkGuard: { ...DEFAULT_SHARED_SETTINGS.bulkGuard, maxDeletions: 5 },
    });
  });

  it("rejects a malformed document instead of treating it as empty", () => {
    expect(() => parseSharedSettings([])).toThrow(SharedSettingsError);
    expect(() => parseSharedSettings({ autoMerge: "yes" })).toThrow(SharedSettingsError);
    expect(() => parseSharedSettings({ snapshotRetention: { dailyDays: -1 } })).toThrow(
      SharedSettingsError,
    );
  });
});
