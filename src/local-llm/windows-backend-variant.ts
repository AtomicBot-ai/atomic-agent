import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";

import {
  assertLinuxArm64Glibc,
  detectGlibcVersion,
} from "./linux-arm64-backend-variant.js";
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
 * the Windows zips outright (no probe). Meaningful on win32 only —
 * macOS, Linux x64 and Linux arm64 each publish a single asset, so the
 * preference has nothing to choose between and is ignored there.
 */
export const BACKEND_VARIANT_PREFERENCES = [
  "auto",
  "cpu",
  "vulkan",
  "cuda-12.4",
  "cuda-13.3",
] as const;

export type BackendVariantPreference =
  (typeof BACKEND_VARIANT_PREFERENCES)[number];

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
export function isWindowsGpuBackendAsset(
  assetName: string | undefined,
): boolean {
  if (assetName === undefined) return true;
  return (
    assetName === WINDOWS_BACKEND_ASSETS.vulkan ||
    assetName === WINDOWS_BACKEND_ASSETS.cuda124 ||
    assetName === WINDOWS_BACKEND_ASSETS.cuda133
  );
}

/** True for either Windows CUDA build. */
export function isWindowsCudaBackendAsset(
  assetName: string | undefined,
): boolean {
  return (
    assetName === WINDOWS_BACKEND_ASSETS.cuda124 ||
    assetName === WINDOWS_BACKEND_ASSETS.cuda133
  );
}

/**
 * ATO-244: is `dir` a Windows CUDA build that cannot load on a machine
 * without the CUDA Toolkit? `ggml-cuda.dll` links against the CUDA
 * runtime, and a build is only self-contained when a `cudart64_*.dll`
 * sits next to it. Without one the DLL fails to load silently,
 * llama-server reports `Available devices: (none)` and the model runs
 * on the CPU — the cuda-13.3 zip of turboquant-6df272c shipped exactly
 * like that. A dir
 * with no `ggml-cuda.dll` (Vulkan, CPU, not installed) is never
 * "incomplete". File names are compared case-insensitively, as Windows
 * resolves them.
 */
export function isIncompleteWindowsCudaBackend(dir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir).map((e) => e.toLowerCase());
  } catch {
    return false;
  }
  if (!entries.includes("ggml-cuda.dll")) return false;
  return !entries.some((e) => /^cudart64_\d+\.dll$/.test(e));
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

/** A GPU's CUDA compute capability, e.g. `8.6` for an RTX 3080 Ti. */
export interface ComputeCapability {
  major: number;
  minor: number;
}

/**
 * Parse `nvidia-smi --query-gpu=compute_cap --format=csv,noheader`: one
 * `major.minor` line per GPU. Returns the highest capability listed, or
 * null when no line parses (no GPU, a driver too old to know the field,
 * which prints `[N/A]` or an error instead).
 */
export function parseComputeCapabilities(
  output: string,
): ComputeCapability | null {
  let best: ComputeCapability | null = null;
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\.(\d+)$/);
    if (!match) continue;
    const cc = { major: Number(match[1]), minor: Number(match[2]) };
    if (
      best === null ||
      cc.major > best.major ||
      (cc.major === best.major && cc.minor > best.minor)
    ) {
      best = cc;
    }
  }
  return best;
}

/**
 * Lowest compute capability the cuda-12.4 build has no code for. The
 * 12.4 toolkit stops at sm_90 (Hopper); every Blackwell part — sm_100
 * datacenter, sm_120 RTX 50-series — postdates it, so the build either
 * JITs from PTX or falls off the GPU there.
 */
const FIRST_CC_BEYOND_CUDA_12_4 = 10;

/**
 * Pure selection of the Windows backend zip from a detected driver CUDA
 * version and the highest GPU compute capability. `null` CUDA (no NVIDIA
 * driver / unparseable) always yields Vulkan; an unknown capability is
 * treated as pre-Blackwell.
 *
 * ATO-244: the cuda-13.3 zip is never picked by detection. As of release
 * turboquant-6df272c it ships `ggml-cuda.dll` without the CUDA runtime it
 * links against (no `cudart64_13.dll`, `cublas64_13.dll`,
 * `cublasLt64_13.dll`), while the cuda-12.4 zip carries its own
 * `cudart64_12` / `cublas64_12` / `cublasLt64_12`. On a machine without
 * the CUDA Toolkit, ggml-cuda.dll therefore fails to load silently,
 * llama-server lists no devices and the model runs on the CPU — every
 * current NVIDIA driver (r580+, CUDA 13.x) used to land there. The 12.4
 * build is the right pick for any driver reporting CUDA >= 12.4: newer
 * drivers run older CUDA runtimes, and 12.4 has native code for Ampere,
 * Ada and Hopper. Blackwell is the exception — 12.4 has no sm_100/sm_120
 * code — so those cards get Vulkan rather than the runtime-less 13.3 zip.
 * Once the 13.3 zip ships its runtime DLLs (check the release assets for
 * `cudart64_13.dll`), drivers >= 13.0 — and Blackwell above all — can go
 * back to it; `isIncompleteWindowsCudaBackend` and the installer's
 * refusal of a runtime-less CUDA zip are the safety net if that regresses.
 * Operators with the toolkit installed can still pin `"cuda-13.3"`.
 */
export function selectWindowsBackendAsset(
  cuda: CudaVersion | null,
  computeCapability: ComputeCapability | null = null,
): string {
  if (cuda === null) return WINDOWS_BACKEND_ASSETS.vulkan;
  if (!isAtLeast(cuda, 12, 4)) return WINDOWS_BACKEND_ASSETS.vulkan;
  if (
    computeCapability !== null &&
    computeCapability.major >= FIRST_CC_BEYOND_CUDA_12_4
  ) {
    return WINDOWS_BACKEND_ASSETS.vulkan;
  }
  return WINDOWS_BACKEND_ASSETS.cuda124;
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

/**
 * Run `nvidia-smi --query-gpu=compute_cap` and return the highest GPU
 * compute capability, or null when the query fails (tool missing, a
 * driver too old for the field). Separate from the cache for the same
 * reason as `detectDriverCudaVersion`.
 */
export function detectGpuComputeCapability(): ComputeCapability | null {
  try {
    const out = execSync(
      "nvidia-smi --query-gpu=compute_cap --format=csv,noheader",
      {
        timeout: 4000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).toString();
    return parseComputeCapabilities(out);
  } catch {
    return null;
  }
}

let cachedWindowsAsset: string | null = null;

/**
 * Detect the best Windows backend asset for this machine, caching the
 * result process-wide. Hardware does not change during a run, so we
 * probe `nvidia-smi` at most once per query; the hot path
 * (`isBackendDownloaded` poll) never triggers a probe because it only
 * needs `binaryName`.
 * A non-`auto` configured variant bypasses both the probe and the
 * cache — the preference can change mid-process (config edit, CPU
 * fallback), so it must never be shadowed by a stale detection result.
 */
export function detectWindowsBackendAsset(): string {
  if (configuredBackendVariant !== "auto") {
    return ASSET_BY_VARIANT_PREFERENCE[configuredBackendVariant];
  }
  if (cachedWindowsAsset !== null) return cachedWindowsAsset;
  const cuda = detectDriverCudaVersion();
  // The capability only matters once a CUDA build is in play, so a box
  // without a usable driver pays for one probe, not two.
  const computeCapability =
    cuda !== null && isAtLeast(cuda, 12, 4)
      ? detectGpuComputeCapability()
      : null;
  cachedWindowsAsset = selectWindowsBackendAsset(cuda, computeCapability);
  return cachedWindowsAsset;
}

/** Test helper: clear the process-wide detection cache. */
export function resetWindowsBackendAssetCache(): void {
  cachedWindowsAsset = null;
}

/**
 * Resolve the platform asset for an actual download. Identical to
 * `resolvePlatformAsset` everywhere but Windows, where it swaps the
 * default Vulkan `assetName` for the CUDA build when a compatible
 * NVIDIA driver is present (see `selectWindowsBackendAsset`).
 * `binaryName` is unchanged within a platform, so install paths and
 * `isBackendDownloaded` stay stable.
 *
 * Linux arm64 keeps `resolvePlatformAsset`'s single asset — there is
 * only one published arm64 build — but refuses a host whose glibc
 * cannot load it (`UnsupportedGlibcError`), because that refusal must
 * come before a 554 MB download rather than after it. `glibcVersion` is
 * for tests; production reads the running process.
 */
export function resolveDownloadAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  glibcVersion?: string | null,
): PlatformAsset {
  const base = resolvePlatformAsset(platform, arch);
  if (base.platform === "linux" && base.arch === "arm64") {
    assertLinuxArm64Glibc(
      glibcVersion === undefined ? detectGlibcVersion() : glibcVersion,
    );
    return base;
  }
  if (base.platform !== "win32") return base;
  return { ...base, assetName: detectWindowsBackendAsset() };
}
