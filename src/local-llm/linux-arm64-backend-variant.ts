import { execSync } from "node:child_process";

import { UnsupportedGlibcError } from "./platform-assets.js";
import type { BackendVariantPreference } from "./windows-backend-variant.js";

/**
 * The turboquant repo ships two Linux arm64 backend builds. The binary
 * inside both zips is `llama-server`; only the bundled GPU backend
 * differs, and both carry the portable CPU backend, so a box whose GPU
 * cannot be used still serves on the CPU.
 *
 * The CUDA build is compiled for exactly the architectures listed in
 * `CUDA_BUILD_COMPUTE_CAPS` (GB10, the DGX Spark superchip) with the
 * CUDA runtime and cuBLAS bundled. It has no kernels for any other GPU,
 * so it is picked by the GPU's compute capability, not by the driver's
 * CUDA version: a GH200 or Jetson Thor with a CUDA 13 driver would load
 * it and then fail on its first kernel launch. Everything else gets
 * Vulkan, which the NVIDIA driver also serves.
 */
export const LINUX_ARM64_BACKEND_ASSETS = {
  vulkan: "llama-turboquant-linux-arm64-vulkan.zip",
  cuda133: "llama-turboquant-linux-arm64-cuda-13.3.zip",
} as const;

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
 * Pure selection of the Linux arm64 backend zip from the detected
 * compute capabilities. `null` (no NVIDIA driver / nvidia-smi missing)
 * and any GPU the CUDA build has no kernels for yield Vulkan.
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

/** Oldest glibc the arm64 builds load on (see `UnsupportedGlibcError`). */
export const LINUX_ARM64_MIN_GLIBC = { major: 2, minor: 38 } as const;

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
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  cachedGlibcVersion = report?.header?.glibcVersionRuntime ?? null;
  return cachedGlibcVersion;
}

/** Throw `UnsupportedGlibcError` unless `version` can load the arm64 builds. */
export function assertLinuxArm64Glibc(version: string | null): void {
  if (!isSupportedGlibc(version)) throw new UnsupportedGlibcError(version);
}

let cachedLinuxArm64Asset: string | null = null;

/**
 * Detect the Linux arm64 backend asset, caching the probe process-wide
 * the same way the Windows detection does. A configured `"vulkan"` or
 * `"cuda-13.3"` pins that build without probing. `"cpu"` and
 * `"cuda-12.4"` name builds that do not exist for arm64, so they fall
 * through to detection; both arm64 builds carry the CPU backend anyway.
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
