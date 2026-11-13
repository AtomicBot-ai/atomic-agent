import { describe, expect, it } from "vitest";

import { parseUserConfigFile, USER_CONFIG_DEFAULTS, USER_CONFIG_VERSION } from "./config-schema.js";
import { ConfigValidationError } from "./config-validation-error.js";
import { createNetworkDefaults, parseNetworkConfig } from "./network-config.js";

describe("network config (ATO-1084)", () => {
  it("defaults to online, so nothing changes for an existing file", () => {
    expect(USER_CONFIG_DEFAULTS.network).toEqual({ offline: false });
    expect(parseUserConfigFile({ version: USER_CONFIG_VERSION }).network).toEqual({
      offline: false,
    });
    // An older file without the block reads the default too.
    expect(parseUserConfigFile({ version: 78 }).network.offline).toBe(false);
  });

  it("reads network.offline", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      network: { offline: true },
    });
    expect(parsed.network.offline).toBe(true);
    expect(parseNetworkConfig({ offline: "on" }, createNetworkDefaults).offline).toBe(true);
  });

  it("rejects a value that is not a boolean", () => {
    expect(() =>
      parseUserConfigFile({ version: USER_CONFIG_VERSION, network: { offline: "maybe" } }),
    ).toThrow(ConfigValidationError);
    expect(() =>
      parseUserConfigFile({ version: USER_CONFIG_VERSION, network: { offline: 1 } }),
    ).toThrow(/network\.offline/);
  });
});
