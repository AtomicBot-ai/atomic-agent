import { describe, expect, it } from "vitest";

import type { MachineForModels } from "../local-llm/catalog/model-upgrade.js";
import {
  capabilitiesForServedModel,
  describeOs,
  formatMachineLine,
  probeMachineLine,
} from "./machine-line.js";
import type { CapabilitiesSummary } from "./stable-prefix.js";

/**
 * ATO-1721 / ATO-1706: the `machine:` capabilities line. Fixed facts only
 * (no free memory or free disk), so the stable prefix keeps its bytes.
 */

const CPU_ONLY: MachineForModels = { ramGb: 16, gpuBudgetGb: null, freeDiskGb: 123.4, cpuOnly: true };

describe("formatMachineLine", () => {
  it("prints RAM, CPU, GPU and OS of the bug report's machine", () => {
    expect(
      formatMachineLine({
        machine: CPU_ONLY,
        platform: "win32",
        cpuModel: "Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz  ",
        osName: "Windows 10",
      }),
    ).toBe("16 GB RAM, Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz, no GPU, Windows 10");
  });

  it("never prints free disk", () => {
    const line = formatMachineLine({ machine: CPU_ONLY, platform: "linux", osName: "Ubuntu 24.04 LTS" });
    expect(line).toBe("16 GB RAM, no GPU, Ubuntu 24.04 LTS");
    expect(line).not.toContain("123");
  });

  it("names a discrete GPU by its memory and an Apple chip's shared GPU", () => {
    const gpu = { ramGb: 32, gpuBudgetGb: 7.6, freeDiskGb: null, cpuOnly: false };
    expect(formatMachineLine({ machine: gpu, platform: "linux", cpuModel: "AMD Ryzen 7", osName: null }))
      .toBe("32 GB RAM, AMD Ryzen 7, GPU with 8 GB memory");
    expect(formatMachineLine({ machine: { ...gpu, gpuBudgetGb: 24 }, platform: "darwin", cpuModel: "Apple M4", osName: "macOS 26" }))
      .toBe("32 GB RAM, Apple M4, GPU on the chip (shares RAM), macOS 26");
  });

  it("claims nothing about a GPU it could not see", () => {
    const unknown = { ramGb: 8, gpuBudgetGb: null, freeDiskGb: null, cpuOnly: false };
    expect(formatMachineLine({ machine: unknown, platform: "win32", osName: "Windows 11" }))
      .toBe("8 GB RAM, Windows 11");
  });
});

describe("describeOs", () => {
  it("tells Windows 10 from 11 by build number", () => {
    expect(describeOs("win32", "10.0.19045")).toBe("Windows 10");
    expect(describeOs("win32", "10.0.22631")).toBe("Windows 11");
  });

  it("maps the Darwin major to the macOS version", () => {
    expect(describeOs("darwin", "25.1.0")).toBe("macOS 26");
    expect(describeOs("darwin", "24.6.0")).toBe("macOS 15");
    expect(describeOs("darwin", "20.1.0")).toBe("macOS 11");
  });

  it("reads PRETTY_NAME on Linux and falls back when the file is missing", () => {
    expect(describeOs("linux", "6.8.0", () => 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n'))
      .toBe("Ubuntu 24.04.1 LTS");
    expect(describeOs("linux", "6.8.0", () => { throw new Error("ENOENT"); })).toBe("Linux");
  });
});

describe("probeMachineLine", () => {
  const base = { dataDir: "/models", platform: "win32" as const, cpuModel: "Intel Core i5-8250U", osName: "Windows 10" };

  it("formats what probeMachineForModels returned", async () => {
    expect(await probeMachineLine({ ...base, probe: async () => CPU_ONLY }))
      .toBe("16 GB RAM, Intel Core i5-8250U, no GPU, Windows 10");
  });

  it("is identical across two calls (stable-prefix bytes)", async () => {
    const probe = async () => CPU_ONLY;
    const first = await probeMachineLine({ ...base, probe });
    const second = await probeMachineLine({ ...base, probe });
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("returns null when the probe fails, sync or async", async () => {
    expect(await probeMachineLine({ ...base, probe: async () => { throw new Error("spawn failed"); } })).toBeNull();
    expect(await probeMachineLine({ ...base, probe: () => { throw new Error("sync"); } })).toBeNull();
  });

  it("returns null when the probe is slower than the timeout", async () => {
    const never = () => new Promise<MachineForModels>(() => {});
    expect(await probeMachineLine({ ...base, probe: never, timeoutMs: 10 })).toBeNull();
  });
});

describe("capabilitiesForServedModel", () => {
  const caps: CapabilitiesSummary = {
    platform: "win32",
    arch: "x64",
    browserChannel: "chrome",
    workingDir: "/w",
    hasClipboard: true,
    hasWmctrl: true,
    hasNotifications: true,
    machine: "16 GB RAM, no GPU, Windows 10",
  };

  it("keeps the line for a model on this machine and drops it otherwise", () => {
    expect(capabilitiesForServedModel(caps, true)).toBe(caps);
    const cloud = capabilitiesForServedModel(caps, false);
    expect(cloud).not.toHaveProperty("machine");
    expect(caps.machine).toBe("16 GB RAM, no GPU, Windows 10");
  });
});
