import { execSync } from "node:child_process";

import { resolvePlatformAsset, type PlatformAsset } from "./platform-assets.js";

/**
 * The turboquant repo ships four Windows x64 backend builds. The binary
 * inside every zip is `llama-server.exe`; only the bundled compute
 * backend differs. We pick the fastest one the machine can actually run
 * and fall back to Vulkan (broadest GPU support, no CUDA driver
 * requirement) when no compatible NVIDIA driver is detected.
 */
export const WINDOWS_BACKEND_ASSETS = {
  vulkan: "llama-turboquant-windows-x64-vulkan.zip",
  cuda124: "llama-turboquant-windows-x64-cuda-12.4.zip",
  cuda133: "llama-turboquant-windows-x64-cuda-13.3.zip",
} as const;

export interface CudaVersion {
  major: number;
  minor: number;
}

/**
 * Parse the `CUDA Version: X.Y` field from `nvidia-smi` header output.
 * This value is the **maximum** CUDA runtime version the installed
 * driver supports (not the CUDA toolkit version), which is exactly what
 * we need to decide which prebuilt CUDA backend will load. Returns null
 * when the field is absent.
 */
export function parseDriverCudaVersion(output: string): CudaVersion | null {
  const match = output.match(/CUDA Version:\s*(\d+)\.(\d+)/i);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

function isAtLeast(v: CudaVersion, major: number, minor: number): boolean {
  return v.major > major || (v.major === major && v.minor >= minor);
}

/**
 * Pure selection of the Windows backend zip from a detected driver CUDA
 * version. Picks the newest CUDA build the driver can run, otherwise
 * Vulkan. `null` (no NVIDIA driver / unparseable) always yields Vulkan.
 */
export function selectWindowsBackendAsset(cuda: CudaVersion | null): string {
  if (cuda === null) return WINDOWS_BACKEND_ASSETS.vulkan;
  if (isAtLeast(cuda, 13, 3)) return WINDOWS_BACKEND_ASSETS.cuda133;
  if (isAtLeast(cuda, 12, 4)) return WINDOWS_BACKEND_ASSETS.cuda124;
  return WINDOWS_BACKEND_ASSETS.vulkan;
}

/**
 * Run `nvidia-smi` and return the driver's max supported CUDA version,
 * or null when the tool is missing / errors / has no NVIDIA GPU. Kept
 * separate from the cache so tests can exercise the glue without a real
 * GPU by stubbing `child_process`.
 */
export function detectDriverCudaVersion(): CudaVersion | null {
  try {
    const out = execSync("nvidia-smi", {
      timeout: 4000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return parseDriverCudaVersion(out);
  } catch {
    return null;
  }
}

let cachedWindowsAsset: string | null = null;

/**
 * Detect the best Windows backend asset for this machine, caching the
 * result process-wide. Hardware does not change during a run, so we
 * probe `nvidia-smi` at most once; the hot path (`isBackendDownloaded`
 * poll) never triggers a probe because it only needs `binaryName`.
 */
export function detectWindowsBackendAsset(): string {
  if (cachedWindowsAsset !== null) return cachedWindowsAsset;
  cachedWindowsAsset = selectWindowsBackendAsset(detectDriverCudaVersion());
  return cachedWindowsAsset;
}

/** Test helper: clear the process-wide detection cache. */
export function resetWindowsBackendAssetCache(): void {
  cachedWindowsAsset = null;
}

/**
 * Resolve the platform asset for an actual download. Identical to
 * `resolvePlatformAsset` on macOS/Linux; on Windows it swaps the default
 * Vulkan `assetName` for the CUDA build when a compatible NVIDIA driver
 * is present. `binaryName` is unchanged (`llama-server.exe` in every
 * Windows zip), so install paths and `isBackendDownloaded` stay stable.
 */
export function resolveDownloadAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PlatformAsset {
  const base = resolvePlatformAsset(platform, arch);
  if (base.platform !== "win32") return base;
  return { ...base, assetName: detectWindowsBackendAsset() };
}
