import { describe, expect, it } from "vitest";

import { parseUserConfigFile, USER_CONFIG_DEFAULTS, USER_CONFIG_VERSION } from "./config-schema.js";
import { ConfigValidationError } from "./config-validation-error.js";
import {
  createNetworkDefaults,
  parseNetworkConfig,
  parseNetworkProxyConfig,
  parseProxyUrl,
} from "./network-config.js";

describe("network config (ATO-1084)", () => {
  it("defaults to online, so nothing changes for an existing file", () => {
    expect(USER_CONFIG_DEFAULTS.network).toEqual({
      offline: false,
      proxy: { url: null, noProxy: [] },
    });
    expect(parseUserConfigFile({ version: USER_CONFIG_VERSION }).network).toEqual({
      offline: false,
      proxy: { url: null, noProxy: [] },
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

describe("network.proxy (ATO-87)", () => {
  const parse = (proxy: unknown) =>
    parseUserConfigFile({ version: USER_CONFIG_VERSION, network: { proxy } }).network.proxy;

  it("reads a proxy URL and a no-proxy list", () => {
    expect(parse({ url: " http://user:pw@10.0.0.2:3128 ", noProxy: ["Example.com", " ", "intra.lan"] })).toEqual({
      url: "http://user:pw@10.0.0.2:3128",
      noProxy: ["example.com", "intra.lan"],
    });
    expect(parse({ url: "https://proxy.corp:443", noProxy: "a.com, b.com" }).noProxy).toEqual(["a.com", "b.com"]);
  });

  it("treats null or an empty string as off", () => {
    expect(parse({ url: null }).url).toBeNull();
    expect(parse({ url: "" }).url).toBeNull();
    expect(parseNetworkProxyConfig(undefined, createNetworkDefaults().proxy)).toEqual({ url: null, noProxy: [] });
  });

  it("refuses SOCKS with a hint to use the HTTP port", () => {
    expect(() => parse({ url: "socks5://127.0.0.1:1080" })).toThrow(/HTTP port/);
  });

  it("refuses anything that is not scheme://host:port", () => {
    expect(() => parse({ url: "127.0.0.1:8080" })).toThrow(ConfigValidationError);
    expect(() => parse({ url: "ftp://p:21" })).toThrow(/http:\/\/ or https:\/\//);
    expect(() => parse({ url: "http://p:8080/path" })).toThrow(/scheme:\/\/host:port/);
    expect(() => parse({ url: 42 })).toThrow(/network\.proxy\.url/);
    expect(() => parse({ noProxy: [1] })).toThrow(/network\.proxy\.noProxy/);
    expect(() => parse("http://p:1")).toThrow(/network\.proxy: must be an object/);
  });

  it("never repeats the password in an error", () => {
    try {
      parseProxyUrl("http://user:s3cret@p:1/x", "network.proxy.url");
    } catch (err) {
      expect(String(err)).not.toContain("s3cret");
      return;
    }
    throw new Error("expected a refusal");
  });
});
