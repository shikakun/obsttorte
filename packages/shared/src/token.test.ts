import { describe, expect, it } from "vitest";
import { generateDeviceToken } from "./token";

describe("generateDeviceToken", () => {
  it("matches the gitleaks rule for device tokens", () => {
    expect(generateDeviceToken()).toMatch(/^obsttorte_[a-z2-7]{52}$/);
  });
});
