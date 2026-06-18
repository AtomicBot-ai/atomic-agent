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
      { id: "Vulkan0", description: "NVIDIA GeForce RTX 4070", totalMemMiB: 8188 },
      { id: "Vulkan1", description: "Intel(R) Graphics (RPL-S)", totalMemMiB: 12000 },
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
      { id: "CUDA0", description: "NVIDIA H100", totalMemMiB: 0 },
    ]);
  });

  it("returns [] for empty / unrelated output", () => {
    expect(parseListDevices("")).toEqual([]);
    expect(parseListDevices("no devices here")).toEqual([]);
  });
});

describe("pickBestDevice", () => {
  it("prefers a discrete GPU over an integrated one regardless of reported VRAM", () => {
    const devices: GpuDevice[] = [
      { id: "Vulkan0", description: "NVIDIA GeForce RTX 4070", totalMemMiB: 8188 },
      { id: "Vulkan1", description: "Intel(R) Graphics", totalMemMiB: 16000 },
    ];
    expect(pickBestDevice(devices)).toBe("Vulkan0");
  });

  it("breaks ties between discrete GPUs by larger VRAM", () => {
    const devices: GpuDevice[] = [
      { id: "Vulkan0", description: "NVIDIA RTX 4070", totalMemMiB: 8188 },
      { id: "Vulkan1", description: "AMD Radeon RX 7900 XTX", totalMemMiB: 24560 },
    ];
    expect(pickBestDevice(devices)).toBe("Vulkan1");
  });

  it("excludes software rasterizers", () => {
    const devices: GpuDevice[] = [
      { id: "Vulkan0", description: "llvmpipe (LLVM 17)", totalMemMiB: 32000 },
    ];
    expect(pickBestDevice(devices)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(pickBestDevice([])).toBeNull();
  });

  it("falls back to an integrated GPU when no discrete is present", () => {
    const devices: GpuDevice[] = [
      { id: "Vulkan0", description: "Intel(R) Iris Xe Graphics", totalMemMiB: 4096 },
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
