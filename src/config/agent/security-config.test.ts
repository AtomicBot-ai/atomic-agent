import { describe, expect, it } from "vitest";
import { parseUserConfigFile, USER_CONFIG_DEFAULTS } from "../config-schema.js";
import { parseAgentSecurityConfig } from "./security-config.js";

describe("agent.security (ATO-2505)", () => {
  it("defaults to argScanThreshold 0.7, also for a file without the block", () => {
    expect(USER_CONFIG_DEFAULTS.agent.security).toEqual({ argScanThreshold: 0.7 });
    expect(parseUserConfigFile({ agent: {} }).agent.security).toEqual({ argScanThreshold: 0.7 });
  });

  it("reads a threshold in 0.5..1", () => {
    expect(parseAgentSecurityConfig({ argScanThreshold: 0.85 })).toEqual({ argScanThreshold: 0.85 });
    expect(parseAgentSecurityConfig({ argScanThreshold: 1 })).toEqual({ argScanThreshold: 1 });
    expect(parseAgentSecurityConfig({ argScanThreshold: "0.5" })).toEqual({ argScanThreshold: 0.5 });
  });

  it.each([0.2, 1.5, -1, "high", null])("refuses %j", (value) => {
    if (value === null) {
      expect(parseAgentSecurityConfig({ argScanThreshold: value })).toEqual({ argScanThreshold: 0.7 });
      return;
    }
    expect(() => parseAgentSecurityConfig({ argScanThreshold: value })).toThrow(/argScanThreshold/);
  });

  it("refuses a block that is not an object", () => {
    expect(() => parseAgentSecurityConfig(0.8)).toThrow(/agent\.security/);
  });
});
