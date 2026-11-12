import { describe, expect, it } from "vitest";

import { probeMachineForModels } from "./machine-for-models.js";

const GB = 1_000_000_000;
const seams = {
  dataDir: "/nowhere/models",
  freeDiskBytes: async () => 200 * GB,
  totalRamBytes: 32 * GB,
};

describe("probeMachineForModels", () => {
  it("uses unified memory on a Mac and never spawns the engine", async () => {
    let asked = false;
    const m = await probeMachineForModels({
      ...seams,
      platform: "darwin",
      cpuModel: "Apple M2 Pro",
      listDevices: async () => {
        asked = true;
        return { devices: [], error: null };
      },
    });
    expect(asked).toBe(false);
    expect(m).toEqual({
      ramGb: 32,
      gpuBudgetGb: 24,
      freeDiskGb: 200,
      cpuOnly: false,
      bandwidth: { gpuGbPerSec: 200, ramGbPerSec: 200, unified: true },
    });
  });

  it("reads the discrete GPU from the engine's device list", async () => {
    const m = await probeMachineForModels({
      ...seams,
      platform: "win32",
      listDevices: async () => ({
        devices: [{ id: "CUDA0", description: "NVIDIA GeForce RTX 4070", totalMemMiB: 12_282, freeMemMiB: 11_000 }],
        error: null,
      }),
    });
    expect(m.cpuOnly).toBe(false);
    expect(m.gpuBudgetGb).toBeCloseTo((12_282 * 1024 * 1024) / GB, 3);
    // ATO-450: the card's name sets the bandwidth the speed forecast uses.
    expect(m.bandwidth).toEqual({ gpuGbPerSec: 504, ramGbPerSec: 50, unified: false });
  });

  it("calls a machine with no device CPU-only", async () => {
    const m = await probeMachineForModels({
      ...seams,
      platform: "linux",
      listDevices: async () => ({ devices: [], error: null }),
    });
    expect(m).toMatchObject({ gpuBudgetGb: null, cpuOnly: true });
    expect(m.bandwidth).toEqual({ gpuGbPerSec: null, ramGbPerSec: 50, unified: false });
  });

  it("asks nvidia-smi when the engine is not installed yet", async () => {
    const m = await probeMachineForModels({
      ...seams,
      platform: "win32",
      listDevices: async () => ({ devices: [], error: "not installed" }),
      nvidiaVramMiB: async () => 8192,
    });
    expect(m.bandwidth?.gpuGbPerSec).toBe(250);
    expect(m.cpuOnly).toBe(false);
    expect(m.gpuBudgetGb).toBeCloseTo((8192 * 1024 * 1024) / GB, 3);
  });

  it("leaves the GPU unknown, not absent, when nothing answers", async () => {
    const m = await probeMachineForModels({
      ...seams,
      platform: "linux",
      listDevices: async () => ({ devices: [], error: "not installed" }),
      nvidiaVramMiB: async () => null,
    });
    expect(m).toMatchObject({ gpuBudgetGb: null, cpuOnly: false });
  });

  it("honours a CPU-forced device without probing", async () => {
    const m = await probeMachineForModels({
      ...seams,
      platform: "linux",
      configuredDevice: "cpu",
      listDevices: async () => {
        throw new Error("should not be asked");
      },
    });
    expect(m).toMatchObject({ cpuOnly: true, gpuBudgetGb: null });
  });

  it("reports an unknown disk as null", async () => {
    const m = await probeMachineForModels({
      ...seams,
      platform: "darwin",
      freeDiskBytes: async () => null,
    });
    expect(m.freeDiskGb).toBeNull();
  });
});
