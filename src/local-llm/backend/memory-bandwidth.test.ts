import { describe, expect, it } from "vitest";

import {
  appleChipBandwidth,
  DEFAULT_DISCRETE_GB_PER_SEC,
  DEFAULT_RAM_GB_PER_SEC,
  discreteGpuBandwidth,
  estimateMemoryBandwidth,
} from "./memory-bandwidth.js";

describe("appleChipBandwidth", () => {
  it("reads the chip and its tier", () => {
    expect(appleChipBandwidth("Apple M1")).toBe(68);
    expect(appleChipBandwidth("Apple M2 Pro")).toBe(200);
    expect(appleChipBandwidth("Apple M4 Max")).toBe(410);
    expect(appleChipBandwidth("Apple M2 Ultra")).toBe(800);
  });

  it("falls back to the tier default for a chip the table does not know", () => {
    expect(appleChipBandwidth("Apple M9 Max")).toBe(300);
    expect(appleChipBandwidth("Apple M9")).toBe(100);
  });

  it("says nothing for a chip that is not Apple's", () => {
    expect(appleChipBandwidth("Intel(R) Core(TM) i7-9750H")).toBeNull();
    expect(appleChipBandwidth(undefined)).toBeNull();
  });
});

describe("discreteGpuBandwidth", () => {
  it("matches the longer name before the shorter one it contains", () => {
    expect(discreteGpuBandwidth("NVIDIA GeForce RTX 4060 Ti")).toBe(288);
    expect(discreteGpuBandwidth("NVIDIA GeForce RTX 4060")).toBe(272);
    expect(discreteGpuBandwidth("AMD Radeon RX 7900 XTX")).toBe(960);
    expect(discreteGpuBandwidth("AMD Radeon RX 7900 XT")).toBe(800);
  });

  it("uses a conservative default for an unknown card", () => {
    expect(discreteGpuBandwidth("NVIDIA RTX A2000")).toBe(DEFAULT_DISCRETE_GB_PER_SEC);
  });
});

describe("estimateMemoryBandwidth", () => {
  it("treats Apple Silicon as one shared pool", () => {
    expect(
      estimateMemoryBandwidth({ platform: "darwin", cpuModel: "Apple M3 Pro", hasGpu: true }),
    ).toEqual({ gpuGbPerSec: 150, ramGbPerSec: 150, unified: true });
  });

  it("gives an Intel Mac plain RAM and no GPU", () => {
    expect(
      estimateMemoryBandwidth({ platform: "darwin", cpuModel: "Intel(R) Core(TM) i9", hasGpu: true }),
    ).toEqual({ gpuGbPerSec: null, ramGbPerSec: DEFAULT_RAM_GB_PER_SEC, unified: false });
  });

  it("reads an integrated GPU at RAM speed", () => {
    expect(
      estimateMemoryBandwidth({ platform: "win32", gpuDescription: "AMD Radeon 780M Graphics", hasGpu: true })
        .gpuGbPerSec,
    ).toBe(DEFAULT_RAM_GB_PER_SEC);
  });

  it("keeps Intel Arc a discrete card", () => {
    expect(
      estimateMemoryBandwidth({ platform: "win32", gpuDescription: "Intel(R) Arc(TM) A770", hasGpu: true })
        .gpuGbPerSec,
    ).toBe(DEFAULT_DISCRETE_GB_PER_SEC);
  });

  it("has no GPU figure on a CPU-only machine", () => {
    expect(estimateMemoryBandwidth({ platform: "linux", hasGpu: false })).toEqual({
      gpuGbPerSec: null,
      ramGbPerSec: DEFAULT_RAM_GB_PER_SEC,
      unified: false,
    });
  });
});
