import { describe, expect, it } from "vitest";

import { MAC_UNIFIED_GPU_FRACTION, resolveGpuBudgetGb } from "./gpu-memory-budget.js";
import type { GpuDevice } from "./gpu-devices.js";

const GB = 1_000_000_000;

const discrete: GpuDevice[] = [
  { id: "Vulkan0", description: "NVIDIA GeForce RTX 4070", totalMemMiB: 8188 },
  { id: "Vulkan1", description: "AMD Radeon RX 7900 XTX", totalMemMiB: 24560 },
];

describe("resolveGpuBudgetGb", () => {
  it("uses a fraction of total RAM on macOS (unified memory, no devices)", () => {
    const budget = resolveGpuBudgetGb({
      platform: "darwin",
      totalRamBytes: 32 * GB,
      devices: [],
      configuredDevice: "auto",
    });
    expect(budget).toBeCloseTo(32 * MAC_UNIFIED_GPU_FRACTION, 5);
  });

  it("returns null on macOS when total RAM is unknown", () => {
    expect(
      resolveGpuBudgetGb({
        platform: "darwin",
        totalRamBytes: 0,
        devices: [],
        configuredDevice: "auto",
      }),
    ).toBeNull();
  });

  it("uses the best device VRAM on Linux for 'auto'", () => {
    const budget = resolveGpuBudgetGb({
      platform: "linux",
      totalRamBytes: 64 * GB,
      devices: discrete,
      configuredDevice: "auto",
    });
    // 24560 MiB -> decimal GB
    expect(budget).toBeCloseTo((24560 * 1024 * 1024) / GB, 5);
  });

  it("uses the configured concrete device VRAM on Linux", () => {
    const budget = resolveGpuBudgetGb({
      platform: "linux",
      totalRamBytes: 64 * GB,
      devices: discrete,
      configuredDevice: "Vulkan0",
    });
    expect(budget).toBeCloseTo((8188 * 1024 * 1024) / GB, 5);
  });

  it("returns null when the device is forced to cpu", () => {
    expect(
      resolveGpuBudgetGb({
        platform: "linux",
        totalRamBytes: 64 * GB,
        devices: discrete,
        configuredDevice: "cpu",
      }),
    ).toBeNull();
  });

  it("returns null on Linux when no GPU is present", () => {
    expect(
      resolveGpuBudgetGb({
        platform: "linux",
        totalRamBytes: 64 * GB,
        devices: [],
        configuredDevice: "auto",
      }),
    ).toBeNull();
  });

  it("returns null when the chosen device reports no VRAM figure", () => {
    expect(
      resolveGpuBudgetGb({
        platform: "linux",
        totalRamBytes: 64 * GB,
        devices: [{ id: "CUDA0", description: "NVIDIA H100", totalMemMiB: 0 }],
        configuredDevice: "auto",
      }),
    ).toBeNull();
  });

  it("returns null for a configured id that does not exist", () => {
    expect(
      resolveGpuBudgetGb({
        platform: "linux",
        totalRamBytes: 64 * GB,
        devices: discrete,
        configuredDevice: "Vulkan9",
      }),
    ).toBeNull();
  });

  it("returns null on unsupported platforms", () => {
    expect(
      resolveGpuBudgetGb({
        platform: "freebsd" as NodeJS.Platform,
        totalRamBytes: 64 * GB,
        devices: discrete,
        configuredDevice: "auto",
      }),
    ).toBeNull();
  });
});
