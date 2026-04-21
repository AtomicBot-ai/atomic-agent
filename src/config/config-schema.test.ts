import { describe, expect, it } from "vitest";

import {
  ConfigValidationError,
  USER_CONFIG_DEFAULTS,
  USER_CONFIG_VERSION,
  parseUserConfigFile,
} from "./config-schema.js";

describe("parseUserConfigFile", () => {
  it("returns defaults when all fields are missing", () => {
    const parsed = parseUserConfigFile({ version: USER_CONFIG_VERSION });
    expect(parsed).toEqual(USER_CONFIG_DEFAULTS);
  });

  it("accepts a fully specified config and normalises it", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      llama: { url: "http://localhost:18991" },
      log: { level: "debug" },
      agent: {
        tokenBudget: 3000,
        maxSteps: 10,
        toolTimeoutMs: 45000,
        approvalRequired: false,
      },
    });
    expect(parsed.llama.url).toBe("http://localhost:18991");
    expect(parsed.log.level).toBe("debug");
    expect(parsed.agent.tokenBudget).toBe(3000);
    expect(parsed.agent.approvalRequired).toBe(false);
  });

  it("coerces boolean-ish strings for approvalRequired", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      agent: { approvalRequired: "false" },
    });
    expect(parsed.agent.approvalRequired).toBe(false);
  });

  it("rejects unsupported version", () => {
    expect(() => parseUserConfigFile({ version: 2 })).toThrow(
      ConfigValidationError,
    );
  });

  it("rejects invalid log level", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        log: { level: "loud" },
      }),
    ).toThrow(/log.level/);
  });

  it("rejects invalid URL", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        llama: { url: "not a url" },
      }),
    ).toThrow(/llama.url/);
  });

  it("rejects non-positive tokenBudget", () => {
    expect(() =>
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        agent: { tokenBudget: 0 },
      }),
    ).toThrow(/agent.tokenBudget/);
  });

  it("rejects non-object root", () => {
    expect(() => parseUserConfigFile([])).toThrow(ConfigValidationError);
    expect(() => parseUserConfigFile(null)).toThrow(ConfigValidationError);
    expect(() => parseUserConfigFile("oops")).toThrow(ConfigValidationError);
  });
});
