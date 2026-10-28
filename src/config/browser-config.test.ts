import { describe, expect, it } from "vitest";
import { USER_CONFIG_DEFAULTS, parseUserConfigFile } from "./config-schema.js";
import { cdpUrlProblem } from "./browser-config.js";

const CONNECT_DEFAULTS = { connect: "agent", cdpUrl: null, userDataDir: null };

describe("browser block in config.json", () => {
  it("defaults to empty domain lists, so an older file blocks and gates nothing", () => {
    expect(USER_CONFIG_DEFAULTS.browser).toEqual({ blockedDomains: [], allowedDomains: [], ...CONNECT_DEFAULTS });
    const parsed = parseUserConfigFile({ version: USER_CONFIG_DEFAULTS.version });
    expect(parsed.browser).toEqual({ blockedDomains: [], allowedDomains: [], ...CONNECT_DEFAULTS });
  });

  it("reads both lists as given", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_DEFAULTS.version,
      browser: { blockedDomains: ["bank.example", "*.ads.test"], allowedDomains: ["github.com"] },
    });
    expect(parsed.browser).toEqual({
      blockedDomains: ["bank.example", "*.ads.test"],
      allowedDomains: ["github.com"],
      ...CONNECT_DEFAULTS,
    });
  });

  it("null reads as an empty list", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_DEFAULTS.version,
      browser: { blockedDomains: null, allowedDomains: null },
    });
    expect(parsed.browser).toEqual({ blockedDomains: [], allowedDomains: [], ...CONNECT_DEFAULTS });
  });

  it("rejects a non-array or an empty entry, naming the key", () => {
    expect(() =>
      parseUserConfigFile({ version: USER_CONFIG_DEFAULTS.version, browser: { blockedDomains: "bank.example" } }),
    ).toThrow(/browser\.blockedDomains/);
    expect(() =>
      parseUserConfigFile({ version: USER_CONFIG_DEFAULTS.version, browser: { allowedDomains: [""] } }),
    ).toThrow(/browser\.allowedDomains\[0\]/);
  });

  it("keeps the agent's own Chrome unless the user opts into theirs", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_DEFAULTS.version,
      browser: { connect: "user-chrome", userDataDir: "~/chrome-data", cdpUrl: "http://127.0.0.1:9222" },
    });
    expect(parsed.browser.connect).toBe("user-chrome");
    expect(parsed.browser.userDataDir).toBe("~/chrome-data");
    expect(parsed.browser.cdpUrl).toBe("http://127.0.0.1:9222");
    expect(() =>
      parseUserConfigFile({ version: USER_CONFIG_DEFAULTS.version, browser: { connect: "yes" } }),
    ).toThrow(/browser\.connect/);
  });

  it("holds a file cdpUrl to this machine", () => {
    expect(cdpUrlProblem("ws://localhost:9222/devtools/browser/abc")).toBeNull();
    expect(cdpUrlProblem("http://[::1]:9222")).toBeNull();
    expect(cdpUrlProblem("http://192.168.1.5:9222")).toMatch(/not this machine/);
    expect(cdpUrlProblem("http://127.0.0.1.evil.test:9222")).toMatch(/not this machine/);
    expect(cdpUrlProblem("file:///tmp/x")).toMatch(/scheme/);
    expect(() =>
      parseUserConfigFile({ version: USER_CONFIG_DEFAULTS.version, browser: { cdpUrl: "http://example.com:9222" } }),
    ).toThrow(/browser\.cdpUrl/);
  });
});
