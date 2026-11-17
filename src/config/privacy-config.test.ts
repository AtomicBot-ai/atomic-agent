import { describe, expect, it } from "vitest";

import { parseUserConfigFile, USER_CONFIG_DEFAULTS, USER_CONFIG_VERSION } from "./config-schema.js";
import { ConfigValidationError } from "./config-validation-error.js";
import { createPrivacyDefaults, parsePrivacyConfig } from "./privacy-config.js";

describe("privacy config (ATO-599)", () => {
  it("defaults to the shield off, so nothing changes for an existing file", () => {
    expect(USER_CONFIG_DEFAULTS.privacy).toEqual({ shield: { enabled: false } });
    expect(parseUserConfigFile({ version: USER_CONFIG_VERSION }).privacy).toEqual({
      shield: { enabled: false },
    });
    // An older file without the block reads the default too.
    expect(parseUserConfigFile({ version: 78 }).privacy.shield.enabled).toBe(false);
  });

  it("reads privacy.shield.enabled", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      privacy: { shield: { enabled: true } },
    });
    expect(parsed.privacy.shield.enabled).toBe(true);
    expect(parsePrivacyConfig({ shield: { enabled: "on" } }, createPrivacyDefaults).shield.enabled).toBe(true);
    // A block without `shield` reads the default.
    expect(parsePrivacyConfig({}, createPrivacyDefaults).shield.enabled).toBe(false);
  });

  it("rejects a value that is not a boolean", () => {
    expect(() =>
      parseUserConfigFile({ version: USER_CONFIG_VERSION, privacy: { shield: { enabled: "maybe" } } }),
    ).toThrow(ConfigValidationError);
    expect(() =>
      parseUserConfigFile({ version: USER_CONFIG_VERSION, privacy: { shield: { enabled: 1 } } }),
    ).toThrow(/privacy\.shield\.enabled/);
  });
});
