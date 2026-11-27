import { describe, expect, it } from "vitest";
import { parseUserConfigFile, USER_CONFIG_DEFAULTS, USER_CONFIG_VERSION } from "../config-schema.js";

function parsedCpuMoe(value: unknown): unknown {
  return parseUserConfigFile({
    version: USER_CONFIG_VERSION,
    localModels: { managed: { cpuMoe: value } },
  }).localModels.managed.cpuMoe;
}

describe("localModels.managed.cpuMoe (ATO-2380)", () => {
  it("defaults to auto, also for a file that predates the key", () => {
    expect(USER_CONFIG_DEFAULTS.localModels.managed.cpuMoe).toBe("auto");
    expect(parseUserConfigFile({ version: USER_CONFIG_VERSION }).localModels.managed.cpuMoe).toBe("auto");
  });

  it("keeps auto, off and a pinned layer count; 0 reads as off", () => {
    expect(parsedCpuMoe("auto")).toBe("auto");
    expect(parsedCpuMoe("off")).toBe("off");
    expect(parsedCpuMoe(24)).toBe(24);
    expect(parsedCpuMoe(0)).toBe("off");
  });

  it("names the field for a value llama.cpp cannot take", () => {
    for (const bad of ["on", -1, 2.5, 513, true]) {
      expect(() => parsedCpuMoe(bad)).toThrow(/localModels\.managed\.cpuMoe/);
    }
  });
});
