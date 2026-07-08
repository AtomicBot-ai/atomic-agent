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
 * Integrated GPUs (Intel iGPU, some AMD APUs) share system RAM and are
 * far slower than a discrete card. Used as a tiebreaker so an auto-pick
 * prefers the dGPU even when the iGPU reports more "memory".
 */
const INTEGRATED_DEVICE_RE = /intel|integrated|\buhd\b|\biris\b/i;

/**
 * Parse the stdout/stderr of `llama-server --list-devices`. Pure — no
 * IO. Recognises lines of the shape:
 *
 *   Vulkan0: NVIDIA GeForce RTX 4070 (8188 MiB, 8188 MiB free)
 *   Vulkan1: Intel(R) Graphics (RPL-S) (... MiB, ... MiB free)
 *
 * The leading token must be `<letters><digits>` followed by `:` so
 * header lines ("Available devices:", "ggml_vulkan: ...") never match.
 * When no `(<n> MiB ...)` figure is present, `totalMemMiB` is `0` and
 * the whole remainder becomes the description.
 */
export function parseListDevices(output: string): GpuDevice[] {
  const devices: GpuDevice[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z]+\d+):\s*(.+)$/);
    if (!match || match[1] === undefined || match[2] === undefined) continue;
    const id = match[1];
    let rest = match[2].trim();
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
    devices.push({ id, description: rest, totalMemMiB, freeMemMiB });
  }
  return devices;
}

function isDiscrete(description: string): boolean {
  return !INTEGRATED_DEVICE_RE.test(description);
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
    const aDiscrete = isDiscrete(a.description);
    const bDiscrete = isDiscrete(b.description);
    if (aDiscrete !== bDiscrete) return aDiscrete ? -1 : 1;
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
