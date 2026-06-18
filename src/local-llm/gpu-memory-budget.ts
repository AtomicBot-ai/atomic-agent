import { pickBestDevice, type GpuDevice } from "./gpu-devices.js";

/**
 * Fraction of total system RAM treated as the GPU memory budget on
 * Apple Silicon (unified memory). macOS has no discrete VRAM — Metal
 * shares the system RAM pool and the default working-set ceiling sits
 * around 70-75% of total. We use the conservative upper bound so the
 * "Not enough VRAM" badge does not flag models that would actually
 * load.
 */
export const MAC_UNIFIED_GPU_FRACTION = 0.75;

/** Bytes in one decimal gigabyte (matches `LocalModelDef.fileSizeGb`). */
const BYTES_PER_GB = 1_000_000_000;

/** MiB in one decimal gigabyte (binary VRAM figure -> decimal GB). */
const MIB_PER_GB = BYTES_PER_GB / (1024 * 1024);

export interface ResolveGpuBudgetInput {
  /** `process.platform` of the host. */
  platform: NodeJS.Platform;
  /** Total physical RAM in bytes (`os.totalmem()`). */
  totalRamBytes: number;
  /**
   * Devices enumerated via `llama-server --list-devices`. Empty / not
   * provided on macOS (the budget comes from unified RAM, no spawn).
   */
  devices: readonly GpuDevice[];
  /**
   * Configured device preference (`config.localModels.managed.device`):
   * `"cpu"`, `"auto"`, a concrete id (e.g. `"Vulkan0"`), or undefined.
   */
  configuredDevice: string | undefined;
}

/**
 * Resolve the GPU memory budget (in decimal GB) the active model would
 * have to fit into, or `null` when there is no meaningful GPU budget to
 * compare against (external mode / no GPU / CPU-forced / unknown). The
 * `null` case is the signal for the UI to suppress the VRAM badge.
 *
 * Platform-specific:
 *  - `darwin`        — unified memory: a fraction of total system RAM.
 *  - `linux`/`win32` — discrete VRAM of the device that will actually be
 *    used (`cpu` -> null; concrete id -> that device; `auto`/unset ->
 *    `pickBestDevice`). A device with no reported VRAM (`totalMemMiB === 0`)
 *    yields `null`.
 *
 * Pure — no IO.
 */
export function resolveGpuBudgetGb(input: ResolveGpuBudgetInput): number | null {
  const { platform, totalRamBytes, devices, configuredDevice } = input;
  if (platform === "darwin") {
    if (totalRamBytes <= 0) return null;
    return (totalRamBytes * MAC_UNIFIED_GPU_FRACTION) / BYTES_PER_GB;
  }
  if (platform === "linux" || platform === "win32") {
    if (configuredDevice === "cpu") return null;
    const device = resolveTargetDevice(devices, configuredDevice);
    if (!device || device.totalMemMiB <= 0) return null;
    return device.totalMemMiB / MIB_PER_GB;
  }
  return null;
}

/**
 * Map the configured device preference to the concrete `GpuDevice` whose
 * VRAM bounds the offload: a concrete id resolves to the matching device,
 * `auto`/unset falls back to `pickBestDevice`.
 */
function resolveTargetDevice(
  devices: readonly GpuDevice[],
  configuredDevice: string | undefined,
): GpuDevice | null {
  if (configuredDevice && configuredDevice !== "auto") {
    return devices.find((d) => d.id === configuredDevice) ?? null;
  }
  const bestId = pickBestDevice(devices);
  if (!bestId) return null;
  return devices.find((d) => d.id === bestId) ?? null;
}
