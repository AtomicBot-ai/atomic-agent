import { describe, expect, it } from "vitest";

import {
  parseListDevices,
  pickBestDevice,
  resolveManagedDevice,
  type GpuDevice,
} from "./gpu-devices.js";

describe("parseListDevices", () => {
  it("parses Vulkan device lines with VRAM", () => {
    const out = [
      "Available devices:",
      "  Vulkan0: NVIDIA GeForce RTX 4070 (8188 MiB, 8188 MiB free)",
      "  Vulkan1: Intel(R) Graphics (RPL-S) (12000 MiB, 11000 MiB free)",
    ].join("\n");
    expect(parseListDevices(out)).toEqual<GpuDevice[]>([
      {
        id: "Vulkan0",
        description: "NVIDIA GeForce RTX 4070",
        totalMemMiB: 8188,
        freeMemMiB: 8188,
      },
      {
        id: "Vulkan1",
        description: "Intel(R) Graphics (RPL-S)",
        totalMemMiB: 12000,
        freeMemMiB: 11000,
      },
    ]);
  });

  it("ignores header / noise lines", () => {
    const out = [
      "ggml_vulkan: Found 1 Vulkan devices:",
      "load_backend: loaded Vulkan backend",
      "  Vulkan0: AMD Radeon RX 7900 XTX (24560 MiB, 24560 MiB free)",
    ].join("\n");
    const devices = parseListDevices(out);
    expect(devices).toHaveLength(1);
    expect(devices[0].id).toBe("Vulkan0");
  });

  it("handles lines without a MiB figure (totalMemMiB = 0)", () => {
    const devices = parseListDevices("  CUDA0: NVIDIA H100");
    expect(devices).toEqual<GpuDevice[]>([
      { id: "CUDA0", description: "NVIDIA H100", totalMemMiB: 0, freeMemMiB: 0 },
    ]);
  });

  it("parses the free VRAM figure when present", () => {
    const devices = parseListDevices(
      "  CUDA0: NVIDIA GeForce RTX 4070 Laptop GPU (8187 MiB, 7054 MiB free)",
    );
    expect(devices[0].totalMemMiB).toBe(8187);
    expect(devices[0].freeMemMiB).toBe(7054);
  });

  it("returns [] for empty / unrelated output", () => {
    expect(parseListDevices("")).toEqual([]);
    expect(parseListDevices("no devices here")).toEqual([]);
  });
});

describe("pickBestDevice", () => {
  it("prefers a discrete GPU over an integrated one regardless of reported VRAM", () => {
    const devices: GpuDevice[] = [
      {
        id: "Vulkan0",
        description: "NVIDIA GeForce RTX 4070",
        totalMemMiB: 8188,
        freeMemMiB: 8188,
      },
      {
        id: "Vulkan1",
        description: "Intel(R) Graphics",
        totalMemMiB: 16000,
        freeMemMiB: 16000,
      },
    ];
    expect(pickBestDevice(devices)).toBe("Vulkan0");
  });

  it("breaks ties between discrete GPUs by larger VRAM", () => {
    const devices: GpuDevice[] = [
      {
        id: "Vulkan0",
        description: "NVIDIA RTX 4070",
        totalMemMiB: 8188,
        freeMemMiB: 8188,
      },
      {
        id: "Vulkan1",
        description: "AMD Radeon RX 7900 XTX",
        totalMemMiB: 24560,
        freeMemMiB: 24560,
      },
    ];
    expect(pickBestDevice(devices)).toBe("Vulkan1");
  });

  it("excludes software rasterizers", () => {
    const devices: GpuDevice[] = [
      {
        id: "Vulkan0",
        description: "llvmpipe (LLVM 17)",
        totalMemMiB: 32000,
        freeMemMiB: 32000,
      },
    ];
    expect(pickBestDevice(devices)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(pickBestDevice([])).toBeNull();
  });

  // AMD APU iGPUs carry no "Intel"/"integrated" marker and Vulkan
  // reports their shared-RAM heap as larger than the dGPU's VRAM, so the
  // VRAM tiebreak used to hand the model to the iGPU.
  it.each([
    "AMD Radeon(TM) Graphics",
    "AMD Radeon 780M Graphics",
    "AMD Radeon(TM) Vega 8 Graphics",
    "Intel(R) Graphics (RPL-S)",
  ])("prefers the dGPU over integrated %s reporting more memory", (igpu) => {
    const devices: GpuDevice[] = [
      {
        id: "Vulkan0",
        description: igpu,
        totalMemMiB: 16384,
        freeMemMiB: 16384,
      },
      {
        id: "Vulkan1",
        description: "NVIDIA GeForce RTX 4060 Laptop GPU",
        totalMemMiB: 8188,
        freeMemMiB: 8188,
      },
    ];
    expect(pickBestDevice(devices)).toBe("Vulkan1");
  });

  it("does not demote a discrete Intel Arc to integrated", () => {
    const devices: GpuDevice[] = [
      {
        id: "Vulkan0",
        description: "Intel(R) Arc(TM) A770 Graphics",
        totalMemMiB: 16384,
        freeMemMiB: 16384,
      },
      {
        id: "Vulkan1",
        description: "Intel(R) UHD Graphics 770",
        totalMemMiB: 32000,
        freeMemMiB: 32000,
      },
    ];
    expect(pickBestDevice(devices)).toBe("Vulkan0");
  });

  it("falls back to an integrated GPU when no discrete is present", () => {
    const devices: GpuDevice[] = [
      {
        id: "Vulkan0",
        description: "Intel(R) Iris Xe Graphics",
        totalMemMiB: 4096,
        freeMemMiB: 4096,
      },
    ];
    expect(pickBestDevice(devices)).toBe("Vulkan0");
  });
});

describe("resolveManagedDevice", () => {
  it("returns 'cpu' for the cpu sentinel without spawning", async () => {
    // A bogus bin path proves enumeration is not attempted.
    expect(await resolveManagedDevice("/nonexistent/llama-server", "cpu")).toBe(
      "cpu",
    );
  });

  it("passes a concrete device id through without spawning", async () => {
    expect(
      await resolveManagedDevice("/nonexistent/llama-server", "Vulkan1"),
    ).toBe("Vulkan1");
  });

  it("returns undefined for 'auto' when enumeration fails (bin missing)", async () => {
    expect(
      await resolveManagedDevice("/nonexistent/llama-server", "auto"),
    ).toBeUndefined();
  });

  it("returns undefined for unset config when enumeration fails", async () => {
    expect(
      await resolveManagedDevice("/nonexistent/llama-server", undefined),
    ).toBeUndefined();
  });
});
