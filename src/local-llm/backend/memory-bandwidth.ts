/**
 * ATO-450 — how fast this machine can read memory, for the rough speed
 * forecast in `../catalog/quant-fit.ts`. Nothing here is measured: the
 * figures are the vendors' published peak memory bandwidth for the chip
 * or card, looked up by name, and a conservative default when the name
 * is not in the table. The forecast built on them is labelled an
 * estimate wherever it is shown.
 *
 * Pure — the caller passes the names it already read (`os.cpus()` on a
 * Mac, the engine's device table elsewhere).
 */

/** Where the weights are read from, and how fast, in GB/s. */
export interface MemoryBandwidth {
  /**
   * Bandwidth of the memory the GPU reads the weights from: VRAM on a
   * discrete card, the shared pool on Apple Silicon. `null` when there
   * is no GPU to offload to (or it is unknown).
   */
  gpuGbPerSec: number | null;
  /** System RAM, read by the CPU for whatever does not fit the GPU. */
  ramGbPerSec: number;
  /** Apple Silicon: GPU and CPU read the same pool. */
  unified: boolean;
}

/**
 * Dual-channel DDR4-3200 is 51.2 GB/s; most desktops and laptops sit at
 * or above it. Used for the CPU's share whenever nothing better is known.
 */
export const DEFAULT_RAM_GB_PER_SEC = 50;

/** A discrete card whose name is not in the table: a low mid-range card. */
export const DEFAULT_DISCRETE_GB_PER_SEC = 250;

/** An Apple chip that is not in the table, by tier. */
const APPLE_TIER_DEFAULT: Record<"base" | "pro" | "max" | "ultra", number> = {
  base: 100,
  pro: 150,
  max: 300,
  ultra: 800,
};

/**
 * Apple Silicon, `<generation>-<tier>` → GB/s. Where a tier ships in two
 * memory configurations (M3 Max, M4 Max) the lower one is used, so the
 * forecast errs on the slow side.
 */
const APPLE_GB_PER_SEC: Record<string, number> = {
  "1-base": 68,
  "1-pro": 200,
  "1-max": 400,
  "1-ultra": 800,
  "2-base": 100,
  "2-pro": 200,
  "2-max": 400,
  "2-ultra": 800,
  "3-base": 100,
  "3-pro": 150,
  "3-max": 300,
  "3-ultra": 800,
  "4-base": 120,
  "4-pro": 273,
  "4-max": 410,
  "5-base": 153,
};

/**
 * Discrete cards, matched in order against the device description, so
 * a longer name ("4070 Ti") comes before the shorter one it contains.
 */
const DISCRETE_GB_PER_SEC: readonly [RegExp, number][] = [
  [/\b5090\b/, 1792],
  [/\b5080\b/, 960],
  [/\b5070\s*ti\b/i, 896],
  [/\b5070\b/, 672],
  [/\b5060\s*ti\b/i, 448],
  [/\b5060\b/, 448],
  [/\b4090\b/, 1008],
  [/\b4080\b/, 717],
  [/\b4070\s*ti\b/i, 504],
  [/\b4070\b/, 504],
  [/\b4060\s*ti\b/i, 288],
  [/\b4060\b/, 272],
  [/\b3090\b/, 936],
  [/\b3080\b/, 760],
  [/\b3070\b/, 448],
  [/\b3060\b/, 360],
  [/\bgb10\b|dgx\s*spark/i, 273],
  [/\bh100\b/i, 2000],
  [/\ba100\b/i, 1555],
  [/7900\s*xtx/i, 960],
  [/7900\s*xt\b/i, 800],
  [/7800\s*xt/i, 624],
  [/7600/, 288],
];

/** `Apple M2 Pro` → 200. `null` for anything that is not an Apple chip. */
export function appleChipBandwidth(cpuModel: string | undefined): number | null {
  const match = /apple\s+m(\d+)(?:\s+(pro|max|ultra))?/i.exec(cpuModel ?? "");
  if (!match) return null;
  const tier = (match[2]?.toLowerCase() ?? "base") as keyof typeof APPLE_TIER_DEFAULT;
  return APPLE_GB_PER_SEC[`${match[1]}-${tier}`] ?? APPLE_TIER_DEFAULT[tier];
}

/** A discrete card's bandwidth from its name, or the default for a card. */
export function discreteGpuBandwidth(description: string | undefined): number {
  const name = description ?? "";
  for (const [pattern, gbPerSec] of DISCRETE_GB_PER_SEC) {
    if (pattern.test(name)) return gbPerSec;
  }
  return DEFAULT_DISCRETE_GB_PER_SEC;
}

/**
 * Integrated GPUs and APUs read system RAM. Same names as
 * `gpu-devices.ts`'s integrated class; Intel Arc is a discrete card.
 */
const INTEGRATED_RE =
  /intel|integrated|\buhd\b|\biris\b|\bvega\b|\bapu\b|radeon.*\b\d{3}m\b|radeon(\(tm\))?\s*graphics/i;

export interface BandwidthInput {
  platform: NodeJS.Platform;
  /** `os.cpus()[0].model`: names the Apple chip. */
  cpuModel?: string;
  /** Description of the GPU the weights load into, from the device table. */
  gpuDescription?: string;
  /** The machine has a GPU to offload to (`gpuBudgetGb !== null`). */
  hasGpu: boolean;
}

/** Best guess at this machine's memory bandwidth. Never throws. */
export function estimateMemoryBandwidth(input: BandwidthInput): MemoryBandwidth {
  if (input.platform === "darwin") {
    const apple = appleChipBandwidth(input.cpuModel);
    // An Intel Mac reads its RAM like any PC; its GPU is not offloaded to here.
    if (apple === null) {
      return { gpuGbPerSec: null, ramGbPerSec: DEFAULT_RAM_GB_PER_SEC, unified: false };
    }
    return { gpuGbPerSec: apple, ramGbPerSec: apple, unified: true };
  }
  if (!input.hasGpu) {
    return { gpuGbPerSec: null, ramGbPerSec: DEFAULT_RAM_GB_PER_SEC, unified: false };
  }
  const description = input.gpuDescription ?? "";
  if (description && INTEGRATED_RE.test(description) && !/\barc\b/i.test(description)) {
    return {
      gpuGbPerSec: DEFAULT_RAM_GB_PER_SEC,
      ramGbPerSec: DEFAULT_RAM_GB_PER_SEC,
      unified: false,
    };
  }
  return {
    gpuGbPerSec: discreteGpuBandwidth(description),
    ramGbPerSec: DEFAULT_RAM_GB_PER_SEC,
    unified: false,
  };
}
