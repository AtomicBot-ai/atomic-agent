import { resolveServerBinPath } from "../backend-paths.js";
import { coreBackendSpawn } from "../core/core-backend-env.js";
import { readCoreBackend, type ManagedEngine } from "../core/core-state.js";
import {
  deviceTableOnce,
  probeDevices,
  unavailableDeviceTable,
  type DeviceProbe,
  type DeviceProbeSpawn,
  type DeviceTable,
} from "./gpu-devices.js";
import { resolvePlatformAsset } from "./platform-assets.js";

/**
 * The llama-server a managed launch is asked `--list-devices` of, and how
 * it is run. Under `llama-server` it is the agent's own build, run as is.
 * Under `atomic-core` it is the build Core recorded for its active backend
 * (`backend.json`), the one Core will load the model with, run with the
 * environment Core runs it with (`coreBackendSpawn`). `null` when Core has
 * no backend installed yet: there is nothing to ask until it does.
 */
export interface ManagedDeviceSource {
  binPath: string;
  spawn?: DeviceProbeSpawn;
}

export function managedDeviceSource(dataDir: string, engine?: ManagedEngine): ManagedDeviceSource | null {
  if (engine === "atomic-core") {
    const backend = readCoreBackend(dataDir);
    return backend ? { binPath: backend.binary, spawn: coreBackendSpawn(backend.binary) } : null;
  }
  return { binPath: resolveServerBinPath(dataDir, resolvePlatformAsset().binaryName) };
}

/** Why a launch has no device table to read: Core's backend is not installed. */
export const CORE_BACKEND_MISSING = "the Atomic Core backend is not installed yet";

/**
 * The launch's device table (`deviceTableOnce`) on the engine's own
 * llama-server. Read it after the engine is installed: under Core, a first
 * start installs Core and its backend before the table is built, so the
 * device pick and the context fit see the devices of the build that loads.
 */
export function managedDeviceTable(dataDir: string, engine?: ManagedEngine): DeviceTable {
  const source = managedDeviceSource(dataDir, engine);
  return source ? deviceTableOnce(source.binPath, source.spawn) : unavailableDeviceTable(CORE_BACKEND_MISSING);
}

/** One `--list-devices` on the engine's llama-server (`models devices`, the TUI's device list). */
export async function probeManagedDevices(dataDir: string, engine?: ManagedEngine): Promise<DeviceProbe> {
  const source = managedDeviceSource(dataDir, engine);
  return source ? probeDevices(source.binPath, source.spawn) : { devices: [], error: CORE_BACKEND_MISSING };
}

/**
 * The `models start` device line's words for an `auto` pick that found no
 * GPU because the binary could not be asked — instead of "no GPU detected",
 * which would claim the machine has none.
 */
export function describeUnlistedDevices(failure: string): string {
  return `auto → CPU (could not list devices: ${failure})`;
}
