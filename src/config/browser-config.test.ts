import { describe, expect, it } from "vitest";
import { USER_CONFIG_DEFAULTS, parseUserConfigFile } from "./config-schema.js";

describe("browser block in config.json", () => {
  it("defaults to empty domain lists, so an older file blocks and gates nothing", () => {
    expect(USER_CONFIG_DEFAULTS.browser).toEqual({ blockedDomains: [], allowedDomains: [] });
    const parsed = parseUserConfigFile({ version: USER_CONFIG_DEFAULTS.version });
    expect(parsed.browser).toEqual({ blockedDomains: [], allowedDomains: [] });
  });

  it("reads both lists as given", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_DEFAULTS.version,
      browser: { blockedDomains: ["bank.example", "*.ads.test"], allowedDomains: ["github.com"] },
    });
    expect(parsed.browser).toEqual({
      blockedDomains: ["bank.example", "*.ads.test"],
      allowedDomains: ["github.com"],
    });
  });

  it("null reads as an empty list", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_DEFAULTS.version,
      browser: { blockedDomains: null, allowedDomains: null },
    });
    expect(parsed.browser).toEqual({ blockedDomains: [], allowedDomains: [] });
  });

  it("rejects a non-array or an empty entry, naming the key", () => {
    expect(() =>
      parseUserConfigFile({ version: USER_CONFIG_DEFAULTS.version, browser: { blockedDomains: "bank.example" } }),
    ).toThrow(/browser\.blockedDomains/);
    expect(() =>
      parseUserConfigFile({ version: USER_CONFIG_DEFAULTS.version, browser: { allowedDomains: [""] } }),
    ).toThrow(/browser\.allowedDomains\[0\]/);
  });
});
