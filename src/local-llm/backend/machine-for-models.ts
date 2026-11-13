/**
 * ATO-1043 — the IO half of the model recommendation: what this machine
 * has, read once. The decision itself is pure (`model-upgrade.ts`).
 *
 * - RAM: `os.totalmem()`, in GB as the machine is sold (`marketedRamGb`, ATO-1442).
 * - GPU memory: unified memory on macOS (no spawn); elsewhere the
 *   engine's `--list-devices` (`probeManagedDevices`), and `nvidia-smi`
 *   when the engine is not installed yet, which is exactly the first
 *   launch this feature runs on.
 * - Free disk: `statfs` of the models folder (or the nearest parent that
 *   exists, since a fresh install has no models folder yet).
 */

import { statfs } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { totalmem } from "node:os";

import type { MachineForModels } from "../catalog/model-upgrade.js";
import type { ManagedEngine } from "../core/core-state.js";
import { resolveGpuBudgetGb } from "./gpu-memory-budget.js";
import { marketedRamGb } from "./host-ram.js";
import { pickBestDevice, type GpuDevice } from "./gpu-devices.js";
import { probeManagedDevices } from "./managed-devices.js";
import { probeNvidiaVramMiB } from "./nvidia-smi-vram.js";

const BYTES_PER_GB = 1_000_000_000;

export interface ProbeMachineInput {
  dataDir: string;
  engine?: ManagedEngine;
  /** `config.localModels.managed.device`. */
  configuredDevice?: string;
  platform?: NodeJS.Platform;
  /** Seams for tests. */
  totalRamBytes?: number;
  listDevices?: () => Promise<{ devices: GpuDevice[]; error: string | null }>;
  nvidiaVramMiB?: () => Promise<number | null>;
  freeDiskBytes?: (path: string) => Promise<number | null>;
}

export async function probeMachineForModels(
  input: ProbeMachineInput,
): Promise<MachineForModels> {
  const platform = input.platform ?? process.platform;
  const totalRamBytes = input.totalRamBytes ?? totalmem();
  const ramGb = marketedRamGb(totalRamBytes);
  const freeBytes = await (input.freeDiskBytes ?? freeDiskBytesAt)(
    input.dataDir,
  );
  const freeDiskGb = freeBytes === null ? null : freeBytes / BYTES_PER_GB;

  if (platform === "darwin") {
    return {
      ramGb,
      gpuBudgetGb: resolveGpuBudgetGb({
        platform,
        totalRamBytes,
        devices: [],
        configuredDevice: input.configuredDevice,
      }),
      freeDiskGb,
      cpuOnly: false,
    };
  }

  if (input.configuredDevice === "cpu") {
    return { ramGb, gpuBudgetGb: null, freeDiskGb, cpuOnly: true };
  }

  const probe = await (input.listDevices ??
    (() => probeManagedDevices(input.dataDir, input.engine)))().catch(
    (err: unknown) => ({
      devices: [] as GpuDevice[],
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  if (probe.error === null) {
    const budget = resolveGpuBudgetGb({
      platform,
      totalRamBytes,
      devices: probe.devices,
      configuredDevice: input.configuredDevice,
    });
    // The engine answered: no real GPU in its list means the CPU runs it.
    const cpuOnly = pickBestDevice(probe.devices) === null;
    return { ramGb, gpuBudgetGb: budget, freeDiskGb, cpuOnly };
  }

  // The engine is not installed yet (a first launch): ask the NVIDIA
  // driver directly. No answer leaves the GPU unknown, not absent — RAM
  // alone then decides, as the first-run picker always has.
  const vramMiB = await (input.nvidiaVramMiB ?? probeNvidiaVramMiB)().catch(
    () => null,
  );
  return {
    ramGb,
    gpuBudgetGb:
      vramMiB !== null && vramMiB > 0 ? (vramMiB * 1024 * 1024) / BYTES_PER_GB : null,
    freeDiskGb,
    cpuOnly: false,
  };
}

/** Free bytes on the disk holding `path` (or its nearest existing parent). */
async function freeDiskBytesAt(path: string): Promise<number | null> {
  let at = path;
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
  try {
    const s = await statfs(at);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}
