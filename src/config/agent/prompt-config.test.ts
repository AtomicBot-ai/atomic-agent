import { describe, expect, it } from "vitest";
import { COMPACT_PROMPT_MODES, createPromptDefaults, parsePromptConfig } from "./prompt-config.js";
import { ConfigValidationError } from "../config-validation-error.js";
import { parseUserConfigFile, USER_CONFIG_DEFAULTS } from "../config-schema.js";

describe("agent.prompt", () => {
  it("defaults to compact auto", () => {
    expect(COMPACT_PROMPT_MODES).toEqual(["auto", "on", "off"]);
    expect(createPromptDefaults()).toEqual({ compact: "auto" });
    expect(USER_CONFIG_DEFAULTS.agent.prompt).toEqual({ compact: "auto" });
    expect(parseUserConfigFile({}).agent.prompt).toEqual({ compact: "auto" });
  });

  it("reads every known mode", () => {
    for (const compact of COMPACT_PROMPT_MODES) {
      expect(parsePromptConfig({ compact }, createPromptDefaults())).toEqual({ compact });
    }
    expect(parseUserConfigFile({ agent: { prompt: { compact: "off" } } }).agent.prompt.compact).toBe("off");
  });

  it("reads a mode a newer build wrote as the default instead of failing", () => {
    expect(parsePromptConfig({ compact: "ultra" }, createPromptDefaults())).toEqual({ compact: "auto" });
  });

  it("refuses a wrong type", () => {
    expect(() => parsePromptConfig({ compact: true }, createPromptDefaults())).toThrow(ConfigValidationError);
    expect(() => parsePromptConfig("on", createPromptDefaults())).toThrow(ConfigValidationError);
  });
});
