import { execSync } from "node:child_process";

import {
  LINUX_ARM64_MIN_GLIBC,
  UnsupportedGlibcError,
} from "./platform-assets.js";
import type { BackendVariantPreference } from "./windows-backend-variant.js";

export { LINUX_ARM64_MIN_GLIBC } from "./platform-assets.js";

/**
 * The turboquant repo publishes two Linux arm64 builds, both carried by
 * every nightly since `turboquant-29d8598` (and by `turboquant-6df272c`,
 * the release marked Latest):
 *
 *  - `llama-turboquant-linux-arm64-cuda-13.3.zip` (~554 MB): CUDA for
 *    GB10, the DGX Spark superchip, with `libcudart` / `libcublas` /
 *    `libcublasLt` bundled. Its CUDA kernels are compiled for
 *    `sm_121a` only, and arch-specific (`a`) SASS runs on that exact
 *    compute capability and nothing else. On a GH200 (9.0) or Jetson
 *    Thor (11.0) the NVIDIA driver loads `libggml-cuda.so`, the device
 *    is found, and the first kernel launch fails.
 *  - `llama-turboquant-linux-arm64-vulkan.zip` (~33 MB): Vulkan, which
 *    the NVIDIA driver and Mesa both serve.
 *
 * Both zips carry the same dispatched CPU backends (`armv8.0_1` through
 * `armv9.2_2`) and `dlopen` their GPU backend, so a box whose GPU cannot
 * be used still serves on the CPU with either one. The CUDA build is
 * therefore picked by the GPU's compute capability, not by the driver's
 * CUDA version, and everything else gets the Vulkan build.
 */
export const LINUX_ARM64_BACKEND_ASSETS = {
  cuda133: "llama-turboquant-linux-arm64-cuda-13.3.zip",
  vulkan: "llama-turboquant-linux-arm64-vulkan.zip",
} as const;

/**
 * The asset `resolvePlatformAsset` names for linux arm64, before any
 * hardware probe. Downloads go through `resolveDownloadAsset`, which
 * swaps in the Vulkan build for anything that is not a GB10.
 */
export const LINUX_ARM64_BACKEND_ASSET = LINUX_ARM64_BACKEND_ASSETS.cuda133;

/** `nvidia-smi --query-gpu=compute_cap` values the CUDA build has kernels for. */
export const CUDA_BUILD_COMPUTE_CAPS: readonly string[] = ["12.1"];

/**
 * Parse `nvidia-smi --query-gpu=compute_cap --format=csv,noheader`: one
 * `major.minor` per GPU. Lines that are not a capability (`[N/A]`, an
 * error string) are dropped. Pure — no IO.
 */
export function parseComputeCaps(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\d+$/.test(line));
}

/**
 * Pure selection of the linux arm64 build from the detected compute
 * capabilities. `null` (no NVIDIA driver / `nvidia-smi` missing) and any
 * GPU the CUDA build has no kernels for yield Vulkan.
 */
export function selectLinuxArm64BackendAsset(
  computeCaps: readonly string[] | null,
): string {
  if (computeCaps?.some((cap) => CUDA_BUILD_COMPUTE_CAPS.includes(cap))) {
    return LINUX_ARM64_BACKEND_ASSETS.cuda133;
  }
  return LINUX_ARM64_BACKEND_ASSETS.vulkan;
}

/**
 * Run `nvidia-smi` for the GPUs' compute capabilities, or null when the
 * tool is missing / errors / reports none.
 */
export function detectComputeCaps(): string[] | null {
  try {
    const out = execSync(
      "nvidia-smi --query-gpu=compute_cap --format=csv,noheader",
      { timeout: 4000, stdio: ["ignore", "pipe", "ignore"] },
    ).toString();
    const caps = parseComputeCaps(out);
    return caps.length > 0 ? caps : null;
  } catch {
    return null;
  }
}

let cachedLinuxArm64Asset: string | null = null;

/**
 * The linux arm64 build to download, with the probe cached process-wide
 * like the Windows detection. A configured `"vulkan"` or `"cuda-13.3"`
 * pins that build without probing; `"cpu"` and `"cuda-12.4"` name
 * builds that arm64 does not publish, so they detect like `"auto"`.
 */
export function detectLinuxArm64BackendAsset(
  configured: BackendVariantPreference,
): string {
  if (configured === "vulkan") return LINUX_ARM64_BACKEND_ASSETS.vulkan;
  if (configured === "cuda-13.3") return LINUX_ARM64_BACKEND_ASSETS.cuda133;
  if (cachedLinuxArm64Asset !== null) return cachedLinuxArm64Asset;
  cachedLinuxArm64Asset = selectLinuxArm64BackendAsset(detectComputeCaps());
  return cachedLinuxArm64Asset;
}

/** Test helper: clear the process-wide detection cache. */
export function resetLinuxArm64BackendAssetCache(): void {
  cachedLinuxArm64Asset = null;
}

/**
 * True when `version` (`"2.39"`) is at least `LINUX_ARM64_MIN_GLIBC`.
 * `null` — musl, or a runtime that does not report glibc — is false.
 * Pure — no IO.
 */
export function isSupportedGlibc(version: string | null): boolean {
  const match = version?.match(/^(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const min = LINUX_ARM64_MIN_GLIBC;
  return major > min.major || (major === min.major && minor >= min.minor);
}

let cachedGlibcVersion: string | null | undefined;

/**
 * The glibc this process runs on, from Node's diagnostic report header,
 * or null when there is none (musl). Cached: generating a report is not
 * free and the answer cannot change during a run.
 */
export function detectGlibcVersion(): string | null {
  if (cachedGlibcVersion !== undefined) return cachedGlibcVersion;
  const report = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  cachedGlibcVersion = report?.header?.glibcVersionRuntime ?? null;
  return cachedGlibcVersion;
}

/** Test helper: clear the cached glibc probe. */
export function resetGlibcVersionCache(): void {
  cachedGlibcVersion = undefined;
}

/** Throw `UnsupportedGlibcError` unless `version` can load the arm64 build. */
export function assertLinuxArm64Glibc(version: string | null): void {
  if (!isSupportedGlibc(version)) throw new UnsupportedGlibcError(version);
}

/**
 * Whether managed mode can serve this machine, without throwing. The
 * Models tab and `models status` ask this to explain themselves; the
 * install path asserts instead.
 */
export function linuxArm64ManagedSupport(
  glibcVersion: string | null = detectGlibcVersion(),
): { supported: boolean; glibcVersion: string | null } {
  return { supported: isSupportedGlibc(glibcVersion), glibcVersion };
}
