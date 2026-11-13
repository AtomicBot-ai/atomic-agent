import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execSync: execSyncMock }));

import {
  compareDriverVersions,
  countVulkanSummaryGpus,
  detectLinuxVulkanGpu,
  detectLinuxX64BackendAsset,
  detectNvidiaGpuFacts,
  LINUX_X64_BACKEND_ASSETS,
  parseNvidiaGpuFacts,
  probeLinuxRocmFacts,
  resetLinuxX64BackendAssetCache,
  selectLinuxX64BackendAsset,
  type LinuxProbeFs,
  type LinuxRocmFacts,
} from "./linux-x64-backend-variant.js";

const NO_ROCM: LinuxRocmFacts = { gfxTargetVersions: [], hasRuntime: false, amdVramMiB: null };
const RX_7900: LinuxRocmFacts = { gfxTargetVersions: [110000], hasRuntime: true, amdVramMiB: 24 * 1024 };

describe("selectLinuxX64BackendAsset (Core's order, ATO-619)", () => {
  it("picks CUDA 13 on driver 580+ with a Turing or newer GPU", () => {
    expect(
      selectLinuxX64BackendAsset([{ driver: "580.95.05", computeCapability: { major: 8, minor: 6 } }], NO_ROCM, false),
    ).toBe(LINUX_X64_BACKEND_ASSETS.cuda133);
  });

  it("treats an unreadable compute capability as meeting the CUDA 13 floor", () => {
    expect(selectLinuxX64BackendAsset([{ driver: "590.1", computeCapability: null }], NO_ROCM, false)).toBe(
      LINUX_X64_BACKEND_ASSETS.cuda133,
    );
  });

  it("drops to CUDA 12 when any NVIDIA GPU is older than Turing", () => {
    expect(
      selectLinuxX64BackendAsset(
        [
          { driver: "580.95.05", computeCapability: { major: 8, minor: 6 } },
          { driver: "580.95.05", computeCapability: { major: 6, minor: 1 } },
        ],
        NO_ROCM,
        false,
      ),
    ).toBe(LINUX_X64_BACKEND_ASSETS.cuda124);
  });

  it("picks CUDA 12 between 525.60.13 and 580", () => {
    expect(
      selectLinuxX64BackendAsset([{ driver: "525.60.13", computeCapability: { major: 8, minor: 9 } }], NO_ROCM, false),
    ).toBe(LINUX_X64_BACKEND_ASSETS.cuda124);
    expect(
      selectLinuxX64BackendAsset([{ driver: "550.54.14", computeCapability: { major: 8, minor: 9 } }], NO_ROCM, false),
    ).toBe(LINUX_X64_BACKEND_ASSETS.cuda124);
  });

  it("uses Vulkan on a driver older than CUDA 12's floor only when Vulkan sees the GPU", () => {
    const old = [{ driver: "525.60.11", computeCapability: { major: 7, minor: 5 } }];
    expect(selectLinuxX64BackendAsset(old, NO_ROCM, true)).toBe(LINUX_X64_BACKEND_ASSETS.vulkan);
    expect(selectLinuxX64BackendAsset(old, NO_ROCM, false)).toBe(LINUX_X64_BACKEND_ASSETS.cpu);
  });

  it("picks ROCm for a supported AMD card with a HIP runtime and 6 GiB or more", () => {
    expect(selectLinuxX64BackendAsset([], RX_7900, false)).toBe(LINUX_X64_BACKEND_ASSETS.rocm);
  });

  it("prefers CUDA over ROCm when both would work", () => {
    expect(
      selectLinuxX64BackendAsset([{ driver: "580", computeCapability: { major: 8, minor: 0 } }], RX_7900, false),
    ).toBe(LINUX_X64_BACKEND_ASSETS.cuda133);
  });

  it("skips ROCm when anything about it is uncertain", () => {
    expect(selectLinuxX64BackendAsset([], { ...RX_7900, hasRuntime: false }, true)).toBe(
      LINUX_X64_BACKEND_ASSETS.vulkan,
    );
    expect(selectLinuxX64BackendAsset([], { ...RX_7900, gfxTargetVersions: [90012] }, true)).toBe(
      LINUX_X64_BACKEND_ASSETS.vulkan,
    );
    expect(selectLinuxX64BackendAsset([], { ...RX_7900, amdVramMiB: 4096 }, true)).toBe(
      LINUX_X64_BACKEND_ASSETS.vulkan,
    );
    expect(selectLinuxX64BackendAsset([], { ...RX_7900, amdVramMiB: null }, false)).toBe(
      LINUX_X64_BACKEND_ASSETS.cpu,
    );
  });

  it("picks the CPU build with no GPU at all", () => {
    expect(selectLinuxX64BackendAsset([], NO_ROCM, false)).toBe(LINUX_X64_BACKEND_ASSETS.cpu);
  });

  it("picks Vulkan with no CUDA or ROCm when a Vulkan GPU is found", () => {
    expect(selectLinuxX64BackendAsset([], NO_ROCM, true)).toBe(LINUX_X64_BACKEND_ASSETS.vulkan);
  });
});

describe("nvidia-smi parsing", () => {
  it("reads driver and compute capability per GPU", () => {
    expect(parseNvidiaGpuFacts("580.95.05, 8.6\n550.54.14, 7.5\n")).toEqual([
      { driver: "580.95.05", computeCapability: { major: 8, minor: 6 } },
      { driver: "550.54.14", computeCapability: { major: 7, minor: 5 } },
    ]);
  });

  it("accepts a driver-only line and skips noise", () => {
    expect(parseNvidiaGpuFacts("470.82.01\n[N/A]\nNVIDIA-SMI has failed\n")).toEqual([
      { driver: "470.82.01", computeCapability: null },
    ]);
  });

  it("compares dotted driver versions numerically", () => {
    expect(compareDriverVersions("580", "580.0.0")).toBe(0);
    expect(compareDriverVersions("525.60.13", "525.60.2")).toBe(1);
    expect(compareDriverVersions("525.60.11", "525.60.13")).toBe(-1);
  });
});

describe("detectNvidiaGpuFacts", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    resetLinuxX64BackendAssetCache();
  });
  afterEach(() => resetLinuxX64BackendAssetCache());

  it("is empty without nvidia-smi", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(detectNvidiaGpuFacts()).toEqual([]);
  });

  it("retries with the driver alone when compute_cap is unknown to the driver", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (String(cmd).includes("compute_cap")) throw new Error("Field compute_cap is not a valid field");
      return Buffer.from("470.82.01\n");
    });
    expect(detectNvidiaGpuFacts()).toEqual([{ driver: "470.82.01", computeCapability: null }]);
  });
});

function fakeFs(files: Record<string, string>): LinuxProbeFs {
  const paths = Object.keys(files);
  return {
    readdir: (dir) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const names = new Set(
        paths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split("/")[0]!),
      );
      if (names.size === 0) throw new Error("ENOENT");
      return [...names];
    },
    readFile: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p]!;
    },
    exists: (p) => p in files,
  };
}

describe("probeLinuxRocmFacts", () => {
  it("reads gfx targets, AMD VRAM and the HIP runtime", () => {
    const facts = probeLinuxRocmFacts(
      fakeFs({
        "/sys/class/kfd/kfd/topology/nodes/0/properties": "cpu_cores_count 16\ngfx_target_version 0\n",
        "/sys/class/kfd/kfd/topology/nodes/1/properties": "simd_count 192\ngfx_target_version 110000\n",
        "/sys/class/drm/card0/device/vendor": "0x1002\n",
        "/sys/class/drm/card0/device/mem_info_vram_total": `${24 * 1024 * 1024 * 1024}\n`,
        "/sys/class/drm/card1/device/vendor": "0x8086\n",
        "/sys/class/drm/card1/device/mem_info_vram_total": `${64 * 1024 * 1024 * 1024}\n`,
        "/opt/rocm-6.4.1/lib/libamdhip64.so.6.4.60401": "",
      }),
      "",
    );
    expect(facts).toEqual({ gfxTargetVersions: [110000], hasRuntime: true, amdVramMiB: 24 * 1024 });
  });

  it("finds nothing on a machine without amdkfd or ROCm", () => {
    expect(probeLinuxRocmFacts(fakeFs({}), "")).toEqual(NO_ROCM);
  });

  it("finds the runtime through LD_LIBRARY_PATH", () => {
    const facts = probeLinuxRocmFacts(fakeFs({ "/custom/hip/libamdhip64.so": "" }), "/custom/hip:relative/dir");
    expect(facts.hasRuntime).toBe(true);
  });
});

const RTX_SUMMARY = `==========
VULKANINFO
==========

Devices:
========
GPU0:
	apiVersion         = 1.3.277
	vendorID           = 0x10de
	deviceType         = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU
	deviceName         = NVIDIA GeForce RTX 3060
GPU1:
	apiVersion         = 1.3.255
	vendorID           = 0x10005
	deviceType         = PHYSICAL_DEVICE_TYPE_CPU
	deviceName         = llvmpipe (LLVM 15.0.7, 256 bits)
`;

const LLVMPIPE_ONLY = `Devices:
========
GPU0:
	vendorID           = 0x10005
	deviceType         = PHYSICAL_DEVICE_TYPE_CPU
	deviceName         = llvmpipe (LLVM 15.0.7, 256 bits)
`;

describe("Linux Vulkan GPU probe (no GPU means the CPU build)", () => {
  it("counts hardware GPUs and skips CPU-type and software devices", () => {
    expect(countVulkanSummaryGpus(RTX_SUMMARY)).toBe(1);
    expect(countVulkanSummaryGpus(LLVMPIPE_ONLY)).toBe(0);
    expect(countVulkanSummaryGpus("")).toBe(0);
  });

  it("finds one Vulkan device through vulkaninfo", () => {
    expect(detectLinuxVulkanGpu(fakeFs({}), () => ({ output: RTX_SUMMARY }), "")).toBe(true);
  });

  it("finds nothing when vulkaninfo enumerates no hardware device", () => {
    expect(detectLinuxVulkanGpu(fakeFs({}), () => ({ output: LLVMPIPE_ONLY }), "")).toBe(false);
    expect(detectLinuxVulkanGpu(fakeFs({}), () => ({ output: "Devices:\n========\n" }), "")).toBe(false);
  });

  it("treats a failed or timed-out vulkaninfo as no device, without the sysfs fallback", () => {
    const gpuHost = fakeFs({
      "/sys/class/drm/renderD128/device/vendor": "0x1002\n",
      "/usr/lib/x86_64-linux-gnu/libvulkan.so.1": "",
    });
    expect(detectLinuxVulkanGpu(gpuHost, () => "failed", "")).toBe(false);
  });

  it("falls back to a GPU render node plus a Vulkan loader when vulkaninfo is not installed", () => {
    const files = {
      "/sys/class/drm/renderD128/device/vendor": "0x8086\n",
      "/sys/class/drm/card0/device/vendor": "0x8086\n",
      "/usr/lib/x86_64-linux-gnu/libvulkan.so.1": "",
    };
    expect(detectLinuxVulkanGpu(fakeFs(files), () => "missing", "")).toBe(true);
    // No loader: the Vulkan build could not use the GPU.
    expect(
      detectLinuxVulkanGpu(fakeFs({ "/sys/class/drm/renderD128/device/vendor": "0x8086\n" }), () => "missing", ""),
    ).toBe(false);
    // A virtual display adapter (virtio) is not a Vulkan GPU.
    expect(
      detectLinuxVulkanGpu(
        fakeFs({
          "/sys/class/drm/renderD128/device/vendor": "0x1af4\n",
          "/usr/lib/x86_64-linux-gnu/libvulkan.so.1": "",
        }),
        () => "missing",
        "",
      ),
    ).toBe(false);
    expect(detectLinuxVulkanGpu(fakeFs({}), () => "missing", "")).toBe(false);
  });
});

describe("detectLinuxX64BackendAsset", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    resetLinuxX64BackendAssetCache();
  });
  afterEach(() => resetLinuxX64BackendAssetCache());

  it("probes Vulkan when CUDA does not apply and installs Vulkan for a Vulkan GPU", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (String(cmd).startsWith("vulkaninfo")) return Buffer.from(RTX_SUMMARY);
      throw new Error("not found");
    });
    expect(detectLinuxX64BackendAsset()).toBe(LINUX_X64_BACKEND_ASSETS.vulkan);
  });

  it("installs the CPU build when the Vulkan probe times out", () => {
    execSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("spawnSync /bin/sh ETIMEDOUT"), { code: "ETIMEDOUT", status: null });
    });
    expect(detectLinuxX64BackendAsset()).toBe(LINUX_X64_BACKEND_ASSETS.cpu);
  });

  it("does not run vulkaninfo when CUDA applies", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (String(cmd).includes("--query-gpu=driver_version")) return Buffer.from("580.95.05, 8.6\n");
      throw new Error(`unexpected ${String(cmd)}`);
    });
    expect(detectLinuxX64BackendAsset()).toBe(LINUX_X64_BACKEND_ASSETS.cuda133);
    expect(execSyncMock.mock.calls.some(([cmd]) => String(cmd).startsWith("vulkaninfo"))).toBe(false);
  });
});
