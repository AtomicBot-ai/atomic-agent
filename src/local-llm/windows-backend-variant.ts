import { execSync } from "node:child_process";

import { resolvePlatformAsset, type PlatformAsset } from "./platform-assets.js";

/**
 * The turboquant repo ships four Windows x64 backend builds. The binary
 * inside every zip is `llama-server.exe`; only the bundled compute
 * backend differs. We pick the fastest one the machine can actually run
 * and fall back to Vulkan (broadest GPU support, no CUDA driver
 * requirement) when no compatible NVIDIA driver is detected. The CPU
 * build is never picked by detection — it exists for boxes whose only
 * "GPU" is an iGPU the Vulkan build cannot actually load a model on
 * (e.g. AMD 5600G Vega), reached via `localModels.managed.backendVariant`
 * or the automatic start-failure fallback in `cpu-backend-fallback.ts`.
 */
export const WINDOWS_BACKEND_ASSETS = {
  vulkan: "llama-turboquant-windows-x64-vulkan.zip",
  cuda124: "llama-turboquant-windows-x64-cuda-12.4.zip",
  cuda133: "llama-turboquant-windows-x64-cuda-13.3.zip",
  cpu: "llama-turboquant-windows-x64-cpu.zip",
} as const;

/**
 * Operator-facing values for `localModels.managed.backendVariant`.
 * `"auto"` keeps the nvidia-smi driven detection; the rest pin one of
 * the Windows zips outright (no probe). Meaningful only on win32 —
 * every other platform publishes a single asset, so the preference is
 * ignored there.
 */
export const BACKEND_VARIANT_PREFERENCES = [
  "auto",
  "cpu",
  "vulkan",
  "cuda-12.4",
  "cuda-13.3",
] as const;

export type BackendVariantPreference = (typeof BACKEND_VARIANT_PREFERENCES)[number];

export function isBackendVariantPreference(
  raw: unknown,
): raw is BackendVariantPreference {
  return BACKEND_VARIANT_PREFERENCES.includes(raw as BackendVariantPreference);
}

const ASSET_BY_VARIANT_PREFERENCE: Record<
  Exclude<BackendVariantPreference, "auto">,
  string
> = {
  cpu: WINDOWS_BACKEND_ASSETS.cpu,
  vulkan: WINDOWS_BACKEND_ASSETS.vulkan,
  "cuda-12.4": WINDOWS_BACKEND_ASSETS.cuda124,
  "cuda-13.3": WINDOWS_BACKEND_ASSETS.cuda133,
};

/**
 * Configured `localModels.managed.backendVariant`, pushed in by
 * `loadConfig` the same way `setCustomLocalModels` publishes custom
 * models — the local-llm layer stays config-free. Also flipped to
 * `"cpu"` in-process by the start-failure fallback so the re-download
 * that follows resolves the CPU zip without waiting for a config
 * round-trip.
 */
let configuredBackendVariant: BackendVariantPreference = "auto";

export function setConfiguredBackendVariant(v: BackendVariantPreference): void {
  configuredBackendVariant = v;
}

export function getConfiguredBackendVariant(): BackendVariantPreference {
  return configuredBackendVariant;
}

/**
 * True when `assetName` is one of the Windows GPU builds (or an install
 * old enough to predate `BackendVersionInfo.asset` — the CPU zip was not
 * downloadable back then, so an undefined asset on win32 is a GPU build).
 */
export function isWindowsGpuBackendAsset(assetName: string | undefined): boolean {
  if (assetName === undefined) return true;
  return (
    assetName === WINDOWS_BACKEND_ASSETS.vulkan ||
    assetName === WINDOWS_BACKEND_ASSETS.cuda124 ||
    assetName === WINDOWS_BACKEND_ASSETS.cuda133
  );
}

export interface CudaVersion {
  major: number;
  minor: number;
}

/**
 * Parse the CUDA version field from `nvidia-smi` header output. This
 * value is the **maximum** CUDA runtime version the installed driver
 * supports (not the CUDA toolkit version), which is exactly what we need
 * to decide which prebuilt CUDA backend will load. Returns null when the
 * field is absent.
 *
 * The field name is not stable across drivers. Up to 5xx/6xx-early the
 * header reads `Driver Version: X  CUDA Version: Y`; driver 610 renamed
 * the pair to `KMD Version: X  CUDA UMD Version: Y`. Matching
 * `CUDA Version:` literally returned null on 610 boxes, so every machine
 * on a current driver silently fell back to the Vulkan build — which is
 * the only configuration that enumerates an AMD APU alongside the
 * NVIDIA card. The optional word tolerates that rename (and any future
 * qualifier) without loosening the match to bare "CUDA".
 */
export function parseDriverCudaVersion(output: string): CudaVersion | null {
  const match = output.match(/CUDA(?:\s+\w+)?\s+Version:\s*(\d+)\.(\d+)/i);
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
  // Threshold is the driver's CUDA *major*, not the build's exact minor:
  // CUDA minor-version compatibility lets a 13.3-built binary run on any
  // 13.x driver. Gating on >= 13.3 sent 13.0 drivers to the 12.4 build,
  // which has no sm_120 (Blackwell) code at all — that toolkit predates
  // the arch, so RTX 50-series had to JIT from PTX or fall off the GPU.
  if (isAtLeast(cuda, 13, 0)) return WINDOWS_BACKEND_ASSETS.cuda133;
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
 * A non-`auto` configured variant bypasses both the probe and the
 * cache — the preference can change mid-process (config edit, CPU
 * fallback), so it must never be shadowed by a stale detection result.
 */
export function detectWindowsBackendAsset(): string {
  if (configuredBackendVariant !== "auto") {
    return ASSET_BY_VARIANT_PREFERENCE[configuredBackendVariant];
  }
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
