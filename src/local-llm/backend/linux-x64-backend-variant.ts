import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";

/**
 * ATO-619: the Linux x64 builds of the stable turboquant repo
 * (`AtomicBot-ai/atomic-llama-cpp-turboquant`, the one Atomic Core installs
 * from). Every zip carries `build/bin/llama-server` and the dispatched CPU
 * backends; the CUDA zips also bundle their CUDA runtime (`libcudart`,
 * `libcublas`), the ROCm zip needs a HIP runtime on the host.
 */
export const LINUX_X64_BACKEND_ASSETS = {
  vulkan: "llama-turboquant-linux-x64-vulkan.zip",
  cuda124: "llama-turboquant-linux-x64-cuda-12.4.zip",
  cuda133: "llama-turboquant-linux-x64-cuda-13.3.zip",
  rocm: "llama-turboquant-linux-x64-rocm.zip",
} as const;

/** A Linux x64 GPU build other than Vulkan: one a release may lack, with Vulkan to fall back on. */
export function isLinuxX64AcceleratedAsset(assetName: string): boolean {
  return (
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
 * card with >= 6 GiB, a supported RDNA target and a HIP runtime), else
 * Vulkan. Where Core would pick its CPU build (no usable GPU) this keeps
 * Vulkan, the build the direct path has always installed: it carries the
 * same dispatched CPU backends.
 */
export function selectLinuxX64BackendAsset(
  nvidia: readonly NvidiaGpuFacts[],
  rocm: LinuxRocmFacts,
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
  return LINUX_X64_BACKEND_ASSETS.vulkan;
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
  let hasRuntime = false;
  for (const dir of new Set(libraryDirs)) {
    if (safe(() => fs.exists(posix.join(dir, "libamdhip64.so")), false)) {
      hasRuntime = true;
      break;
    }
    // Runtime-only packages can omit the unversioned linker symlink.
    if (safe(() => fs.readdir(dir), []).some((n) => /^libamdhip64\.so(?:\.\d+)+$/.test(n))) {
      hasRuntime = true;
      break;
    }
  }
  return { gfxTargetVersions, hasRuntime, amdVramMiB };
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
  cachedLinuxX64Asset = selectLinuxX64BackendAsset(nvidia, rocm);
  return cachedLinuxX64Asset;
}

/** Test helper: clear the process-wide detection cache. */
export function resetLinuxX64BackendAssetCache(): void {
  cachedLinuxX64Asset = null;
}
