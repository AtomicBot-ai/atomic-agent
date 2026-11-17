import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";

/**
 * ATO-619: the Linux x64 builds of the stable turboquant repo
 * (`AtomicBot-ai/atomic-llama-cpp-turboquant`, the one Atomic Core installs
 * from). Every zip carries `build/bin/llama-server` and the dispatched CPU
 * backends; the CUDA zips also bundle their CUDA runtime (`libcudart`,
 * `libcublas`), the ROCm zip needs a HIP runtime on the host, the Vulkan
 * zip a Vulkan loader and driver. The CPU zip is the build for a machine
 * with no usable GPU.
 */
export const LINUX_X64_BACKEND_ASSETS = {
  cpu: "llama-turboquant-linux-x64-cpu.zip",
  vulkan: "llama-turboquant-linux-x64-vulkan.zip",
  cuda124: "llama-turboquant-linux-x64-cuda-12.4.zip",
  cuda133: "llama-turboquant-linux-x64-cuda-13.3.zip",
  rocm: "llama-turboquant-linux-x64-rocm.zip",
} as const;

/**
 * A Linux x64 build other than Vulkan: one a release may lack, with Vulkan
 * (every release has it, and it carries the same dispatched CPU backends)
 * to fall back on.
 */
export function isLinuxX64AcceleratedAsset(assetName: string): boolean {
  return (
    assetName === LINUX_X64_BACKEND_ASSETS.cpu ||
    assetName === LINUX_X64_BACKEND_ASSETS.cuda124 ||
    assetName === LINUX_X64_BACKEND_ASSETS.cuda133 ||
    assetName === LINUX_X64_BACKEND_ASSETS.rocm
  );
}

/**
 * Driver floors Atomic Core applies to the fork's Linux CUDA builds
 * (`TURBOQUANT_CUDA_DRIVER_FLOORS.linux` in Core's `backend/turboquant.ts`).
 * Kept identical so the direct llama-server path and Core pick the same
 * build on the same machine.
 */
export const LINUX_CUDA12_MIN_DRIVER = "525.60.13";
export const LINUX_CUDA13_MIN_DRIVER = "580";

/** CUDA 13 dropped Maxwell, Pascal and Volta: Turing (7.5) is the floor (Core's `MIN_CUDA13_COMPUTE_CAPABILITY`). */
const CUDA13_MIN_COMPUTE_CAPABILITY = { major: 7, minor: 5 } as const;

/** Core's `TURBOQUANT_GPU_MIN_VRAM_MIB`: below this the fork's GPU builds are not worth it. */
export const LINUX_GPU_MIN_VRAM_MIB = 6 * 1024;

/** RDNA2 to RDNA4 as amdkfd `gfx_target_version` values: what the fork's ROCm build carries (Core's list). */
export const ROCM_SUPPORTED_GFX_TARGET_VERSIONS: readonly number[] = [
  100300, 110000, 110100, 110200, 115100, 120000, 120100,
];

/** One NVIDIA GPU as `nvidia-smi` reports it. */
export interface NvidiaGpuFacts {
  driver: string;
  /** `null` when the driver is too old to report it; treated as meeting every floor, as in Core. */
  computeCapability: { major: number; minor: number } | null;
}

/** What the ROCm decision needs from the host. */
export interface LinuxRocmFacts {
  /** Non-zero amdkfd `gfx_target_version` values (one per GPU node). */
  gfxTargetVersions: readonly number[];
  /** `libamdhip64.so` found in a ROCm prefix or on the library path. */
  hasRuntime: boolean;
  /** Largest dedicated VRAM of an AMD card (`mem_info_vram_total`), MiB; null when unknown. */
  amdVramMiB: number | null;
}

/** Numeric dotted-version compare (`580.95.05` vs `580`); missing parts count as 0. */
export function compareDriverVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Pure choice of the Linux x64 build, in Core's order
 * (`detectIdealTurboquantBackendType`): CUDA 13 (driver >= 580 and every
 * NVIDIA GPU Turing or newer), CUDA 12 (driver >= 525.60.13), ROCm (an AMD
 * card with >= 6 GiB, a supported RDNA target and a HIP runtime), then
 * Vulkan only when a Vulkan GPU was found (`hasVulkanGpu`), else the CPU
 * build. A failed or timed-out Vulkan probe counts as no GPU.
 */
export function selectLinuxX64BackendAsset(
  nvidia: readonly NvidiaGpuFacts[],
  rocm: LinuxRocmFacts,
  hasVulkanGpu: boolean,
): string {
  if (nvidia.length > 0) {
    const meets = (floor: string) =>
      nvidia.some((g) => compareDriverVersions(g.driver, floor) >= 0);
    const allTuringOrNewer = nvidia.every(
      ({ computeCapability: cc }) =>
        cc === null ||
        cc.major > CUDA13_MIN_COMPUTE_CAPABILITY.major ||
        (cc.major === CUDA13_MIN_COMPUTE_CAPABILITY.major &&
          cc.minor >= CUDA13_MIN_COMPUTE_CAPABILITY.minor),
    );
    if (meets(LINUX_CUDA13_MIN_DRIVER) && allTuringOrNewer) {
      return LINUX_X64_BACKEND_ASSETS.cuda133;
    }
    if (meets(LINUX_CUDA12_MIN_DRIVER)) return LINUX_X64_BACKEND_ASSETS.cuda124;
  }
  const rocmUsable =
    rocm.hasRuntime &&
    rocm.amdVramMiB !== null &&
    rocm.amdVramMiB >= LINUX_GPU_MIN_VRAM_MIB &&
    rocm.gfxTargetVersions.some((v) => ROCM_SUPPORTED_GFX_TARGET_VERSIONS.includes(v));
  if (rocmUsable) return LINUX_X64_BACKEND_ASSETS.rocm;
  return hasVulkanGpu ? LINUX_X64_BACKEND_ASSETS.vulkan : LINUX_X64_BACKEND_ASSETS.cpu;
}

/**
 * Parse `nvidia-smi --query-gpu=driver_version,compute_cap --format=csv,noheader`
 * (`580.95.05, 8.6` per GPU), or the driver-only query (`580.95.05`).
 */
export function parseNvidiaGpuFacts(output: string): NvidiaGpuFacts[] {
  const gpus: NvidiaGpuFacts[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [driverRaw, ccRaw] = line.split(",").map((s) => s.trim());
    if (!driverRaw || !/^\d+(\.\d+)*$/.test(driverRaw)) continue;
    const cc = ccRaw?.match(/^(\d+)\.(\d+)$/);
    gpus.push({
      driver: driverRaw,
      computeCapability: cc ? { major: Number(cc[1]), minor: Number(cc[2]) } : null,
    });
  }
  return gpus;
}

function runNvidiaSmi(query: string): string | null {
  try {
    return execSync(`nvidia-smi --query-gpu=${query} --format=csv,noheader`, {
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return null;
  }
}

/** NVIDIA GPUs on this host; empty when `nvidia-smi` is missing or fails. */
export function detectNvidiaGpuFacts(): NvidiaGpuFacts[] {
  const full = runNvidiaSmi("driver_version,compute_cap");
  if (full !== null) {
    const gpus = parseNvidiaGpuFacts(full);
    if (gpus.length > 0) return gpus;
  }
  // A driver too old for `compute_cap` rejects the whole query.
  const driverOnly = runNvidiaSmi("driver_version");
  return driverOnly === null ? [] : parseNvidiaGpuFacts(driverOnly);
}

/** The reads the ROCm probe makes; swapped in tests. */
export interface LinuxProbeFs {
  readdir: (path: string) => string[];
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
}

const nodeProbeFs: LinuxProbeFs = {
  readdir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path, "utf8"),
  exists: (path) => existsSync(path),
};

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * The host facts behind the ROCm choice, read the way Core's
 * `probeLinuxRocmHost` reads them: `gfx_target_version` from the amdkfd
 * topology, `libamdhip64.so` in a ROCm prefix or on the library path. The
 * VRAM comes from the amdgpu sysfs (`mem_info_vram_total` of a card whose
 * vendor is 0x1002), where Core reads it from its Vulkan probe.
 */
export function probeLinuxRocmFacts(
  fs: LinuxProbeFs = nodeProbeFs,
  libraryPath: string = process.env.LD_LIBRARY_PATH ?? "",
): LinuxRocmFacts {
  const nodesDir = "/sys/class/kfd/kfd/topology/nodes";
  const gfxTargetVersions: number[] = [];
  for (const node of safe(() => fs.readdir(nodesDir), [])) {
    const props = safe(() => fs.readFile(posix.join(nodesDir, node, "properties")), "");
    for (const line of props.split("\n")) {
      const m = line.match(/^gfx_target_version\s+(\d+)\s*$/);
      if (m && Number(m[1]) !== 0) gfxTargetVersions.push(Number(m[1]));
    }
  }

  let amdVramMiB: number | null = null;
  const drmDir = "/sys/class/drm";
  for (const card of safe(() => fs.readdir(drmDir), [])) {
    if (!/^card\d+$/.test(card)) continue;
    const dev = posix.join(drmDir, card, "device");
    if (safe(() => fs.readFile(posix.join(dev, "vendor")), "").trim() !== "0x1002") continue;
    const bytes = Number(safe(() => fs.readFile(posix.join(dev, "mem_info_vram_total")), "").trim());
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    const mib = Math.floor(bytes / (1024 * 1024));
    if (amdVramMiB === null || mib > amdVramMiB) amdVramMiB = mib;
  }

  const libraryDirs = [
    ...libraryPath.split(":").filter((d) => posix.isAbsolute(d)),
    "/opt/rocm/lib",
    "/opt/rocm/lib64",
    "/usr/lib/x86_64-linux-gnu",
    "/usr/lib64",
    "/usr/lib",
  ];
  for (const entry of safe(() => fs.readdir("/opt"), [])) {
    if (entry.startsWith("rocm-")) {
      libraryDirs.push(posix.join("/opt", entry, "lib"), posix.join("/opt", entry, "lib64"));
    }
  }
  const hasRuntime = hasSharedLibrary(fs, libraryDirs, "libamdhip64.so");
  return { gfxTargetVersions, hasRuntime, amdVramMiB };
}

/** `<base>` or a versioned `<base>.N[.N...]` in one of `dirs`. */
function hasSharedLibrary(fs: LinuxProbeFs, dirs: readonly string[], base: string): boolean {
  const versioned = new RegExp(`^${base.replace(/\./g, "\\.")}(?:\\.\\d+)+$`);
  for (const dir of new Set(dirs)) {
    if (safe(() => fs.exists(posix.join(dir, base)), false)) return true;
    // Runtime-only packages can omit the unversioned linker symlink.
    if (safe(() => fs.readdir(dir), []).some((n) => versioned.test(n))) return true;
  }
  return false;
}

/**
 * Software rasterizers expose a Vulkan device but run on the CPU; the same
 * filter `gpu-devices.ts` applies before picking an offload device.
 */
const SOFTWARE_VULKAN_DEVICE_RE = /llvmpipe|lavapipe|swiftshader|software/i;

const HARDWARE_VULKAN_DEVICE_TYPES = new Set([
  "PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU",
  "PHYSICAL_DEVICE_TYPE_DISCRETE_GPU",
  "PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU",
]);

/**
 * Hardware GPUs in `vulkaninfo --summary` output: one block per device
 * with `deviceType = PHYSICAL_DEVICE_TYPE_*` and `deviceName = ...`.
 * CPU-type devices and software rasterizers (llvmpipe, lavapipe,
 * SwiftShader) are not counted.
 */
export function countVulkanSummaryGpus(output: string): number {
  let count = 0;
  let type: string | null = null;
  let name: string | null = null;
  const flush = () => {
    if (type !== null && HARDWARE_VULKAN_DEVICE_TYPES.has(type) && !SOFTWARE_VULKAN_DEVICE_RE.test(name ?? "")) {
      count++;
    }
    type = null;
    name = null;
  };
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^GPU\d+:$/.test(line)) {
      flush();
      continue;
    }
    const m = line.match(/^(deviceType|deviceName)\s*=\s*(.+)$/);
    if (!m) continue;
    if (m[1] === "deviceType") type = m[2]!.trim();
    else name = m[2]!.trim();
  }
  flush();
  return count;
}

/** `vulkaninfo --summary`: its output, `"missing"` when not installed, `"failed"` on any other error or timeout. */
export type VulkaninfoResult = { output: string } | "missing" | "failed";

function runVulkaninfo(): VulkaninfoResult {
  try {
    return {
      output: execSync("vulkaninfo --summary", {
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString(),
    };
  } catch (err) {
    // The shell exits 127 when the command does not exist.
    return (err as { status?: unknown }).status === 127 ? "missing" : "failed";
  }
}

/** PCI vendors with a hardware Vulkan driver on Linux: AMD, NVIDIA, Intel. */
const VULKAN_GPU_VENDORS = new Set(["0x1002", "0x10de", "0x8086"]);

/**
 * Whether this host has a hardware Vulkan GPU. `vulkaninfo --summary`
 * decides when it is installed; a failure or timeout there counts as no
 * GPU. Without `vulkaninfo` (the `vulkan-tools` package is often absent)
 * it falls back to the DRM render nodes: a `renderD*` node whose PCI
 * vendor is AMD, NVIDIA or Intel, plus a Vulkan loader
 * (`libvulkan.so.1`) the Vulkan build could load.
 */
export function detectLinuxVulkanGpu(
  fs: LinuxProbeFs = nodeProbeFs,
  run: () => VulkaninfoResult = runVulkaninfo,
  libraryPath: string = process.env.LD_LIBRARY_PATH ?? "",
): boolean {
  const result = run();
  if (result === "failed") return false;
  if (result !== "missing") return countVulkanSummaryGpus(result.output) > 0;

  const drmDir = "/sys/class/drm";
  const hasGpuRenderNode = safe(() => fs.readdir(drmDir), []).some(
    (node) =>
      /^renderD\d+$/.test(node) &&
      VULKAN_GPU_VENDORS.has(
        safe(() => fs.readFile(posix.join(drmDir, node, "device", "vendor")), "").trim().toLowerCase(),
      ),
  );
  if (!hasGpuRenderNode) return false;
  return hasSharedLibrary(
    fs,
    [
      ...libraryPath.split(":").filter((d) => posix.isAbsolute(d)),
      "/usr/lib/x86_64-linux-gnu",
      "/usr/lib64",
      "/usr/lib",
      "/usr/local/lib",
    ],
    "libvulkan.so",
  );
}

let cachedLinuxX64Asset: string | null = null;

/**
 * The Linux x64 build for this machine, probed once per process (the
 * hardware does not change during a run). Only reached by an actual
 * download or update check (`resolveDownloadAsset`), never by the
 * `isBackendDownloaded` poll.
 */
export function detectLinuxX64BackendAsset(): string {
  if (cachedLinuxX64Asset !== null) return cachedLinuxX64Asset;
  const nvidia = detectNvidiaGpuFacts();
  // A usable CUDA build ends the search; the ROCm probe is for the rest.
  const rocm: LinuxRocmFacts = nvidia.some(
    (g) => compareDriverVersions(g.driver, LINUX_CUDA12_MIN_DRIVER) >= 0,
  )
    ? { gfxTargetVersions: [], hasRuntime: false, amdVramMiB: null }
    : probeLinuxRocmFacts();
  const gpuChoice = selectLinuxX64BackendAsset(nvidia, rocm, false);
  // Vulkan is probed only when neither CUDA nor ROCm applies.
  cachedLinuxX64Asset =
    gpuChoice !== LINUX_X64_BACKEND_ASSETS.cpu
      ? gpuChoice
      : selectLinuxX64BackendAsset(nvidia, rocm, detectLinuxVulkanGpu());
  return cachedLinuxX64Asset;
}

/** Test helper: clear the process-wide detection cache. */
export function resetLinuxX64BackendAssetCache(): void {
  cachedLinuxX64Asset = null;
}
