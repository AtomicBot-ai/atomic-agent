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
    if (!canonical || canonical[1] === undefined || canonical[2] === undefined) {
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
    const device: GpuDevice = { id, description: rest, totalMemMiB, freeMemMiB };
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
    const rank = deviceClassRank(b.description) - deviceClassRank(a.description);
    if (rank !== 0) return rank;
    return b.totalMemMiB - a.totalMemMiB;
  });
  return ranked[0]?.id ?? null;
}

/**
 * Enumerate compute devices by shelling out to
 * `<binPath> --list-devices`. Best-effort: any failure (binary missing,
 * timeout, unexpected output) resolves to `[]` so callers degrade to the
 * llama.cpp default device selection / CPU fallback. Some builds print
 * the device table to stderr, so both streams are parsed.
 */
export async function listVulkanDevices(binPath: string): Promise<GpuDevice[]> {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, ["--list-devices"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return parseListDevices(`${stdout}\n${stderr}`);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const combined = `${e?.stdout ?? ""}\n${e?.stderr ?? ""}`.trim();
    if (combined.length > 0) return parseListDevices(combined);
    return [];
  }
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
 * Best-effort and never throws — enumeration failures fall through to
 * `undefined`.
 */
export async function resolveManagedDevice(
  binPath: string,
  configured: string | undefined,
): Promise<string | undefined> {
  if (configured === "cpu") return "cpu";
  if (configured && configured !== "auto") return configured;
  const devices = await listVulkanDevices(binPath);
  return pickBestDevice(devices) ?? undefined;
}
