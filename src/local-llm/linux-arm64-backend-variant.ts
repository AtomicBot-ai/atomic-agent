import {
  LINUX_ARM64_MIN_GLIBC,
  UnsupportedGlibcError,
} from "./platform-assets.js";

export { LINUX_ARM64_MIN_GLIBC } from "./platform-assets.js";

/**
 * The turboquant repo publishes exactly **one** Linux arm64 build, and
 * this is its name. Verified against the repo's releases rather than
 * assumed: across all 64 releases the only `linux-arm64` assets are
 * `llama-turboquant-linux-arm64-cuda-13.3.{zip,tar.gz}`. There is no
 * arm64 Vulkan, CPU or CUDA 12.4 asset, so arm64 has nothing to select
 * between and `backendVariant` is ignored there, exactly as it is on
 * macOS and Linux x64.
 *
 * The name says CUDA, but the zip is not CUDA-only, which is why one
 * asset can serve every arm64 machine. Read out of the published zip:
 *
 *  - `llama-server` is a 72 KB launcher whose `DT_NEEDED` list is
 *    `libllama-server-impl.so`, libstdc++, libgcc, libc. Neither it nor
 *    `libllama-server-impl.so` links `libcuda.so.1` or
 *    `libggml-cuda.so`. The compute backends are separate shared
 *    objects the ggml registry `dlopen`s at startup, so on a machine
 *    with no NVIDIA driver the CUDA backend simply fails to load and
 *    the server runs on the CPU. It does not fail to start.
 *  - The CPU backend ships as eight variants, `libggml-cpu-armv8.0_1`
 *    through `libggml-cpu-armv9.2_2`, picked by runtime dispatch — so
 *    plain aarch64 hardware down to armv8.0 is covered.
 *  - The size (554 MB, against 30 MB for linux-x64-vulkan) is almost
 *    entirely `libcublasLt` and `libcublas`. That is the cost of the
 *    one published arm64 build; it is stated in the README so the
 *    download is not a surprise.
 *
 * If an arm64 Vulkan or CPU asset is ever published, this module is
 * where the choice between them belongs — see the git history of this
 * file for a detection-by-compute-capability shape that was removed
 * because it could only ever return one answer.
 */
export const LINUX_ARM64_BACKEND_ASSET =
  "llama-turboquant-linux-arm64-cuda-13.3.zip";

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
