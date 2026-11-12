import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execSync: execSyncMock }));

import {
  compareDriverVersions,
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
      selectLinuxX64BackendAsset([{ driver: "580.95.05", computeCapability: { major: 8, minor: 6 } }], NO_ROCM),
    ).toBe(LINUX_X64_BACKEND_ASSETS.cuda133);
  });

  it("treats an unreadable compute capability as meeting the CUDA 13 floor", () => {
    expect(selectLinuxX64BackendAsset([{ driver: "590.1", computeCapability: null }], NO_ROCM)).toBe(
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
      ),
    ).toBe(LINUX_X64_BACKEND_ASSETS.cuda124);
  });

  it("picks CUDA 12 between 525.60.13 and 580", () => {
    expect(
      selectLinuxX64BackendAsset([{ driver: "525.60.13", computeCapability: { major: 8, minor: 9 } }], NO_ROCM),
    ).toBe(LINUX_X64_BACKEND_ASSETS.cuda124);
    expect(
      selectLinuxX64BackendAsset([{ driver: "550.54.14", computeCapability: { major: 8, minor: 9 } }], NO_ROCM),
    ).toBe(LINUX_X64_BACKEND_ASSETS.cuda124);
  });

  it("keeps Vulkan on a driver older than CUDA 12's floor", () => {
    expect(
      selectLinuxX64BackendAsset([{ driver: "525.60.11", computeCapability: { major: 7, minor: 5 } }], NO_ROCM),
    ).toBe(LINUX_X64_BACKEND_ASSETS.vulkan);
  });

  it("picks ROCm for a supported AMD card with a HIP runtime and 6 GiB or more", () => {
    expect(selectLinuxX64BackendAsset([], RX_7900)).toBe(LINUX_X64_BACKEND_ASSETS.rocm);
  });

  it("prefers CUDA over ROCm when both would work", () => {
    expect(
      selectLinuxX64BackendAsset([{ driver: "580", computeCapability: { major: 8, minor: 0 } }], RX_7900),
    ).toBe(LINUX_X64_BACKEND_ASSETS.cuda133);
  });

  it("keeps Vulkan when anything about ROCm is uncertain", () => {
    expect(selectLinuxX64BackendAsset([], { ...RX_7900, hasRuntime: false })).toBe(LINUX_X64_BACKEND_ASSETS.vulkan);
    expect(selectLinuxX64BackendAsset([], { ...RX_7900, gfxTargetVersions: [90012] })).toBe(
      LINUX_X64_BACKEND_ASSETS.vulkan,
    );
    expect(selectLinuxX64BackendAsset([], { ...RX_7900, amdVramMiB: 4096 })).toBe(LINUX_X64_BACKEND_ASSETS.vulkan);
    expect(selectLinuxX64BackendAsset([], { ...RX_7900, amdVramMiB: null })).toBe(LINUX_X64_BACKEND_ASSETS.vulkan);
  });

  it("keeps Vulkan with no GPU at all", () => {
    expect(selectLinuxX64BackendAsset([], NO_ROCM)).toBe(LINUX_X64_BACKEND_ASSETS.vulkan);
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

describe("probeLinuxRocmFacts", () => {
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
