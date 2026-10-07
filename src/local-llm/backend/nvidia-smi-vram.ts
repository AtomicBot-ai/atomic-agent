import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Parse the output of
 * `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`.
 * Each non-empty line is one GPU's total memory in MiB. Returns the
 * maximum across GPUs (matching the largest-VRAM device an `auto` pick
 * would offload to), or `null` when no line parses to a positive
 * number. Pure — no IO.
 */
export function parseNvidiaVramMiB(output: string): number | null {
  let maxMiB = 0;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const mib = Number.parseInt(trimmed, 10);
    if (Number.isFinite(mib) && mib > maxMiB) maxMiB = mib;
  }
  return maxMiB > 0 ? maxMiB : null;
}

/**
 * Best-effort probe of total NVIDIA VRAM via `nvidia-smi`. Used as a
 * pre-download fallback on Linux/Windows when the llama.cpp backend is
 * not yet on disk and `--list-devices` therefore cannot run, so the
 * onboarding model list can still flag models that will not fit on the
 * GPU. Returns the largest single-GPU `memory.total` in MiB, or `null`
 * when `nvidia-smi` is absent, errors, or reports nothing parseable.
 * NVIDIA-only by design — other vendors stay null until the backend
 * lands and the Vulkan enumeration covers them. Never throws.
 */
export async function probeNvidiaVramMiB(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { timeout: 4000, maxBuffer: 256 * 1024 },
    );
    return parseNvidiaVramMiB(stdout);
  } catch {
    return null;
  }
}
