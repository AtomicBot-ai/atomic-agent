import { describe, expect, it } from "vitest";
import { parseUserConfigFile, USER_CONFIG_DEFAULTS } from "../config-schema.js";
import { normaliseKnownHostEntry, parseAgentSecurityConfig } from "./security-config.js";

describe("agent.security (ATO-2505)", () => {
  it("defaults to argScanThreshold 0.7, also for a file without the block", () => {
    expect(USER_CONFIG_DEFAULTS.agent.security).toEqual({ argScanThreshold: 0.7, knownHosts: [] });
    expect(parseUserConfigFile({ agent: {} }).agent.security).toEqual({ argScanThreshold: 0.7, knownHosts: [] });
  });

  it("reads a threshold in 0.5..0.7", () => {
    expect(parseAgentSecurityConfig({ argScanThreshold: 0.6 })).toEqual({ argScanThreshold: 0.6, knownHosts: [] });
    expect(parseAgentSecurityConfig({ argScanThreshold: "0.5" })).toEqual({ argScanThreshold: 0.5, knownHosts: [] });
  });

  // Review round 1: one unasked edit of config.json set 1 and quieted every
  // 0.8 and 0.9 bypass ask. A raised value now reads as the default.
  it.each([0.85, 0.95, 1])("reads a raised threshold %s as 0.7", (value) => {
    expect(parseAgentSecurityConfig({ argScanThreshold: value })).toEqual({ argScanThreshold: 0.7, knownHosts: [] });
  });

  it.each([0.2, 1.5, -1, "high", null])("refuses %j", (value) => {
    if (value === null) {
      expect(parseAgentSecurityConfig({ argScanThreshold: value })).toEqual({ argScanThreshold: 0.7, knownHosts: [] });
      return;
    }
    expect(() => parseAgentSecurityConfig({ argScanThreshold: value })).toThrow(/argScanThreshold/);
  });

  it("refuses a block that is not an object", () => {
    expect(() => parseAgentSecurityConfig(0.8)).toThrow(/agent\.security/);
  });

  it("reads knownHosts, normalised and without repeats (ATO-2528)", () => {
    expect(parseAgentSecurityConfig({ knownHosts: ["GitHub.com.", "*.npmjs.org", "github.com"] }).knownHosts).toEqual([
      "github.com",
      "*.npmjs.org",
    ]);
  });

  it.each([["https://github.com"], ["*"], [""], [3], "github.com"])("refuses knownHosts %j", (value) => {
    expect(() => parseAgentSecurityConfig({ knownHosts: value })).toThrow(/knownHosts/);
  });

  // Review round 2: `*.com` made every .com host known.
  it.each([["*.com"], ["*.io."], ["*.co"]])("refuses a wildcard over a single label %j", (value) => {
    expect(() => parseAgentSecurityConfig({ knownHosts: value })).toThrow(/knownHosts/);
    expect(normaliseKnownHostEntry(value[0]!)).toBeNull();
  });

  it("keeps a wildcard over two labels", () => {
    expect(normaliseKnownHostEntry("*.example.com")).toBe("*.example.com");
    expect(normaliseKnownHostEntry("*.example.co.uk")).toBe("*.example.co.uk");
    expect(normaliseKnownHostEntry("*.github.com")).toBe("*.github.com");
  });

  // Review round 3 (F2105-R3.8): `*.co.uk` made every .co.uk host known.
  it.each(["*.co.uk", "*.com.au", "*.ne.jp", "*.github.io", "*.herokuapp.com"])(
    "refuses a wildcard over an open suffix %j",
    (value) => {
      expect(normaliseKnownHostEntry(value)).toBeNull();
      expect(() => parseAgentSecurityConfig({ knownHosts: [value] })).toThrow(/knownHosts/);
    },
  );
});
