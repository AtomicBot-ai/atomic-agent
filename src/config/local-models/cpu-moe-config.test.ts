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

describe("localModels.managed.rpcServers (ATO-2338)", () => {
  const parsed = (value: unknown) =>
    parseUserConfigFile({ version: USER_CONFIG_VERSION, localModels: { managed: { rpcServers: value } } })
      .localModels.managed.rpcServers;

  it("defaults to none and keeps host:port entries", () => {
    expect(parseUserConfigFile({ version: USER_CONFIG_VERSION }).localModels.managed.rpcServers).toEqual([]);
    expect(parsed(["192.168.1.20:50052", "studio.local:50052"])).toEqual(["192.168.1.20:50052", "studio.local:50052"]);
  });

  it("names the bad entry", () => {
    expect(() => parsed("192.168.1.20:50052")).toThrow(/localModels\.managed\.rpcServers/);
    expect(() => parsed(["ok.local:1", "a,b:2"])).toThrow(/localModels\.managed\.rpcServers\[1\]/);
  });
});
