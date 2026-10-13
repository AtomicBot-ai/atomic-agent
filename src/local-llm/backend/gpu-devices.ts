import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A single compute device reported by `llama-server --list-devices`.
 * `id` is the backend-qualified handle the model passes back via
 * `--device` (e.g. `Vulkan0`, `CUDA1`); `totalMemMiB` is `0` when the
 * backend did not report a memory figure for the device.
 */
export interface GpuDevice {
  id: string;
  description: string;
  totalMemMiB: number;
  /**
   * Free VRAM reported alongside the total (`... MiB, <free> MiB free`),
   * or `0` when the backend did not report a free figure. Used by the
   * managed-daemon context auto-sizer to fit the KV cache into whatever
   * is left after the weights load.
   */
  freeMemMiB: number;
}

/**
 * Software rasterizers expose a Vulkan device but run on the CPU — never
 * a useful offload target. Filtered out before `pickBestDevice` scores.
 */
const SOFTWARE_DEVICE_RE = /llvmpipe|lavapipe|swiftshader|software/i;

/**
 * Positive discrete-GPU hints, checked *before* the integrated ones so a
 * discrete card whose name also trips an integrated pattern (Intel Arc,
 * "Radeon RX") is never demoted.
 */
const DISCRETE_DEVICE_RE =
  /nvidia|geforce|\brtx\b|\bgtx\b|quadro|tesla|\barc\b|radeon\s*(rx|pro)\b/i;

/**
 * Integrated GPUs (Intel iGPU, AMD APUs) share system RAM and are far
 * slower than a discrete card. Vulkan reports their heap as a slice of
 * system RAM — often *larger* than a dGPU's VRAM — so without this the
 * VRAM tiebreak picks the iGPU. AMD APU marketing names carry no "APU"
 * marker: "AMD Radeon(TM) Graphics", "AMD Radeon 780M Graphics",
 * "Radeon(TM) Vega 8 Graphics".
 */
const INTEGRATED_DEVICE_RE =
  /intel|integrated|\buhd\b|\biris\b|\bvega\b|\bapu\b|radeon.*\b\d{3}m\b|radeon(\(tm\))?\s*graphics/i;

/**
 * Parse the stdout/stderr of `llama-server --list-devices`. Pure — no
 * IO. Recognises the device-table rows llama.cpp actually prints:
 *
 *   Vulkan0: NVIDIA GeForce RTX 4070 (8188 MiB, 8188 MiB free)
 *   Vulkan1: Intel(R) Graphics (RPL-S) (... MiB, ... MiB free)
 *   CUDA0: NVIDIA H100
 *   MTL0: Apple M1 Max (25559 MiB, 25558 MiB free)   ← Metal, Apple Silicon
 *
 * The leading token must be `<letters><digits>:` so header lines
 * ("Available devices:", "ggml_vulkan: ...") never match. The `id`
 * captured here is exactly what the backend answers to at `--device`
 * spawn time — it is read out of the table, never constructed, so no
 * fabricated id can reach the daemon and fail its health poll. On real
 * Apple Silicon hardware the addressable id is `MTL0` (verified on an
 * M1 Max), NOT `Metal0`; parsing the row verbatim keeps us correct
 * regardless of the exact backend prefix. When no memory figure is
 * present, `totalMemMiB` / `freeMemMiB` are `0`.
 *
 * Duplicate rows (stdout+stderr, or an init line before the memory-
 * bearing row) merge so a figure-less first sighting does not shadow
 * the real VRAM numbers used by context auto-sizing.
 */
export function parseListDevices(output: string): GpuDevice[] {
  const devices: GpuDevice[] = [];
  const byId = new Map<string, GpuDevice>();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const canonical = line.match(/^([A-Za-z]+\d+):\s*(.+)$/);
    if (
      !canonical ||
      canonical[1] === undefined ||
      canonical[2] === undefined
    ) {
      continue;
    }
    const id = canonical[1];
    let rest = canonical[2].trim();
    if (rest.length === 0) continue;
    let totalMemMiB = 0;
    let freeMemMiB = 0;
    const memMatch = rest.match(/\((\d+)\s*MiB/i);
    if (memMatch && memMatch[1] !== undefined) {
      totalMemMiB = Number(memMatch[1]);
      const freeMatch = rest.match(/,\s*(\d+)\s*MiB\s*free/i);
      if (freeMatch && freeMatch[1] !== undefined) {
        freeMemMiB = Number(freeMatch[1]);
      }
      const parenIdx = rest.lastIndexOf("(");
      if (parenIdx > 0) rest = rest.slice(0, parenIdx).trim();
    }

    const existing = byId.get(id);
    if (existing) {
      // A duplicate row can arrive when the table prints to both stdout
      // and stderr, or an init line precedes the memory-bearing row.
      // Keep whichever carries real figures rather than first-seen.
      if (existing.totalMemMiB === 0 && totalMemMiB > 0) {
        existing.totalMemMiB = totalMemMiB;
        existing.freeMemMiB = freeMemMiB;
        existing.description = rest;
      }
      continue;
    }
    const device: GpuDevice = {
      id,
      description: rest,
      totalMemMiB,
      freeMemMiB,
    };
    byId.set(id, device);
    devices.push(device);
  }
  return devices;
}

/**
 * Offload desirability, higher is better: 2 = known discrete card,
 * 1 = unrecognised (assume discrete — safer than assuming iGPU),
 * 0 = known integrated. Discrete hints win outright so "Intel Arc" and
 * "Radeon RX" are not caught by the integrated patterns.
 *
 * Apple Silicon descriptions (e.g. "Apple M1 Max") match neither the
 * discrete nor integrated patterns, so they land on rank 1 — the desired
 * "unrecognised → assume discrete" outcome. No Apple carve-out needed.
 */
export function deviceClassRank(description: string): 0 | 1 | 2 {
  if (DISCRETE_DEVICE_RE.test(description)) return 2;
  if (INTEGRATED_DEVICE_RE.test(description)) return 0;
  return 1;
}

/**
 * GPUs that answer to the discrete patterns (or to none) yet have no
 * memory of their own: Apple silicon; Intel's Meteor Lake and Lunar Lake
 * iGPUs, which are named Arc ("Intel(R) Arc(TM) Graphics", "Arc 140V" /
 * "Arc 130V", unlike the A- and B-series cards); AMD Strix Halo
 * ("Radeon(TM) 8060S / 8050S Graphics"); and NVIDIA's GB10 (DGX Spark) and
 * Jetson Orin / Thor modules.
 */
const UNIFIED_MEMORY_DEVICE_RE =
  /\bapple\b|\barc(\(tm\))?\s*(graphics|1[34]0v)\b|radeon(\(tm\))?\s*\d{4}s\b|\bgb10\b|\bjetson\b|\borin\b|\bthor\b/i;

/**
 * Whether the device's memory is the system's own RAM: Apple silicon's
 * Metal device (`MTL0: Apple M4 …`), an integrated GPU, or a unified-
 * memory part named like a card (`UNIFIED_MEMORY_DEVICE_RE`). The free
 * figure such a device reports is a ceiling on what the GPU may map, not
 * memory nobody else is using, so the context auto-size also leaves the
 * system its headroom there (`context-size.ts`). Pure — no IO.
 */
export function sharesSystemMemory(device: GpuDevice): boolean {
  return (
    /^(MTL|Metal)\d+$/i.test(device.id) ||
    UNIFIED_MEMORY_DEVICE_RE.test(device.description) ||
    deviceClassRank(device.description) === 0
  );
}

/**
 * Pick the best single device id for offloading, or `null` when there
 * is no usable GPU. Heuristic: drop software rasterizers, prefer a
 * discrete GPU over an integrated one, then break ties by larger VRAM.
 * Pure — no IO.
 */
export function pickBestDevice(devices: readonly GpuDevice[]): string | null {
  const candidates = devices.filter(
    (d) => !SOFTWARE_DEVICE_RE.test(d.description),
  );
  if (candidates.length === 0) return null;
  const ranked = [...candidates].sort((a, b) => {
    const rank =
      deviceClassRank(b.description) - deviceClassRank(a.description);
    if (rank !== 0) return rank;
    return b.totalMemMiB - a.totalMemMiB;
  });
  return ranked[0]?.id ?? null;
}

/**
 * How to run the binary for `--list-devices`: the environment and working
 * directory it needs. The agent's own llama.cpp build runs as is (none); a
 * build Atomic Core installed is run with the environment Core gives it
 * (`coreBackendSpawn`), or its GPU backends do not load.
 */
export interface DeviceProbeSpawn {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** What one `--list-devices` run said, and why it said nothing when it could not run. */
export interface DeviceProbe {
  devices: GpuDevice[];
  /**
   * Why the binary could not be asked (missing, not executable, a library
   * it could not load, killed at the deadline), or `null` when it ran. A
   * binary that ran and reported no GPU is `null` with no devices: that is
   * a machine with no GPU, not a failure.
   */
  error: string | null;
}

/** Deadline for one `--list-devices` run. */
const DEVICE_PROBE_TIMEOUT_MS = 5000;

/** The first line of what a failed run printed, or what failed to run it. */
function describeProbeFailure(err: unknown, output: string): string {
  const e = err as { code?: unknown; killed?: boolean; signal?: unknown; message?: string };
  if (e?.killed) return `--list-devices did not answer within ${DEVICE_PROBE_TIMEOUT_MS / 1000} s`;
  const first = output.split("\n").map((l) => l.trim()).find(Boolean);
  if (first) return first.slice(0, 200);
  if (typeof e?.code === "string") return `${e.code}${e.message ? `: ${e.message}` : ""}`.slice(0, 200);
  if (typeof e?.code === "number") return `--list-devices exited with code ${e.code}`;
  if (typeof e?.signal === "string") return `--list-devices was killed by ${e.signal}`;
  return (e?.message ?? String(err)).slice(0, 200);
}

/**
 * Enumerate compute devices by shelling out to `<binPath> --list-devices`,
 * and say why when the binary could not be asked. Never throws. Some
 * builds print the device table to stderr, so both streams are parsed; a
 * run that failed but still printed a table keeps it.
 */
export async function probeDevices(binPath: string, spawn?: DeviceProbeSpawn): Promise<DeviceProbe> {
  try {
    const { stdout, stderr } = await execFileAsync(
      binPath,
      ["--list-devices"],
      {
        timeout: DEVICE_PROBE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        ...(spawn?.env ? { env: spawn.env } : {}),
        ...(spawn?.cwd ? { cwd: spawn.cwd } : {}),
      },
    );
    return { devices: parseListDevices(`${stdout}\n${stderr}`), error: null };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const combined = `${e?.stdout ?? ""}\n${e?.stderr ?? ""}`.trim();
    const devices = combined.length > 0 ? parseListDevices(combined) : [];
    return { devices, error: devices.length > 0 ? null : describeProbeFailure(err, combined) };
  }
}

/**
 * Enumerate compute devices by shelling out to
 * `<binPath> --list-devices`. Best-effort: any failure (binary missing,
 * timeout, unexpected output) resolves to `[]` so callers degrade to the
 * llama.cpp default device selection / CPU fallback. `probeDevices` says
 * why a run came back empty.
 */
export async function listVulkanDevices(binPath: string, spawn?: DeviceProbeSpawn): Promise<GpuDevice[]> {
  return (await probeDevices(binPath, spawn)).devices;
}

/** A launch's device table, read on demand (`deviceTableOnce`). */
export type ListDevices = () => Promise<readonly GpuDevice[]>;

/**
 * A launch's device table that also says why it is empty when the binary
 * could not be asked (`failure()`: `null` until it has run, and whenever
 * the run answered, devices or none).
 */
export interface DeviceTable {
  (): Promise<readonly GpuDevice[]>;
  failure(): string | null;
}

/**
 * `<binPath> --list-devices` for one launch: run the first time something
 * asks, and that answer handed to everyone after. A managed start reads
 * the table twice — to pick the device, then for the free memory the
 * context is fitted into — and each run starts the backend (on Apple
 * silicon, Metal's device and its shader library), so the second spawn
 * was pure delay before the model began to load.
 *
 * An empty answer is not kept: it is what a run that ran out its 5 s
 * deadline leaves, and the first start after a llama.cpp install is slow
 * to start the backend at all (16 s before the server printed its first
 * line, on a 16 GB Mac). It is asked once more at once, and that answer
 * stands either way — a machine with no GPU says nothing twice.
 *
 * `spawn` is how the binary is run (`DeviceProbeSpawn`): Atomic Core's
 * build needs Core's environment.
 */
export function deviceTableOnce(binPath: string, spawn?: DeviceProbeSpawn): DeviceTable {
  let table: Promise<DeviceProbe> | null = null;
  let last: DeviceProbe | null = null;
  let asked = 0;
  const ask = (): Promise<DeviceProbe> => {
    asked += 1;
    table = probeDevices(binPath, spawn).then((probe) => {
      last = probe;
      return probe;
    });
    return table;
  };
  const read = async (): Promise<readonly GpuDevice[]> => {
    const probe = await (table ?? ask());
    return probe.devices.length === 0 && asked < 2 ? (await ask()).devices : probe.devices;
  };
  return Object.assign(read, { failure: () => last?.error ?? null });
}

/** A table that cannot be asked at all (no binary to ask): empty, and says why. */
export function unavailableDeviceTable(reason: string): DeviceTable {
  return Object.assign(async () => [] as readonly GpuDevice[], { failure: () => reason });
}

/**
 * Resolve the configured device preference into a concrete value for the
 * daemon argv builder:
 *
 *   - `"cpu"`            → `"cpu"` (caller forces `-ngl 0`).
 *   - a concrete id      → passed through unchanged (no enumeration).
 *   - `"auto"` / unset   → enumerate + `pickBestDevice`; `undefined`
 *                          when no usable GPU (llama.cpp defaults / CPU).
 *
 * `opts.multiGpu` (a configured `localModels.managed.tensorSplit`)
 * changes only the `"auto"` / unset branch: instead of pinning the one
 * best device — which would defeat `--tensor-split` — it resolves to
 * `undefined` without enumerating, so llama.cpp keeps every GPU visible
 * and splits across them. `"cpu"` still wins outright, and an explicit
 * id (including a comma-separated list like `"Vulkan0,Vulkan1"`) still
 * passes through so the operator can restrict which devices join the
 * split.
 *
 * Best-effort and never throws — enumeration failures fall through to
 * `undefined`. `opts.listDevices` is the launch's own table
 * (`deviceTableOnce`), so the context fit after it does not enumerate
 * again; without it the binary is asked here, run as `opts.spawn` says.
 */
export async function resolveManagedDevice(
  binPath: string,
  configured: string | undefined,
  opts?: { multiGpu?: boolean; listDevices?: ListDevices; spawn?: DeviceProbeSpawn },
): Promise<string | undefined> {
  if (configured === "cpu") return "cpu";
  if (configured && configured !== "auto") return configured;
  if (opts?.multiGpu) return undefined;
  const devices = await (opts?.listDevices ?? (() => listVulkanDevices(binPath, opts?.spawn)))();
  return pickBestDevice(devices) ?? undefined;
}
