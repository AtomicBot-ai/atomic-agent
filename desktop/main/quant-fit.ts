/**
 * ATO-450 — a fit badge, a speed estimate and the pick for every quant
 * the Hugging Face lookup offers.
 *
 * A VENDORED PORT, like huggingface.ts and for the same reason (the
 * desktop compiles CommonJS from main/** only): the rules are the
 * agent's, copied from
 *
 *   src/local-llm/catalog/quant-fit.ts          → fit, forecast, pick
 *   src/local-llm/backend/memory-bandwidth.ts   → the Apple chip table
 *
 * and they drift when those change. One departure: the agent reads the
 * GPU from the engine's device table; this process does not run the
 * engine, so off a Mac the GPU is unknown here. The fit then goes by RAM
 * alone, and no speed is forecast, because a guess at a card we cannot
 * see would be a number with nothing behind it.
 */

import { cpus, totalmem } from "node:os";

import type { HuggingFaceGgufChoice, HuggingFaceRepoChoices } from "./huggingface.js";

export interface QuantMachine {
  /** Physical RAM, decimal GB. */
  ramGb: number;
  /** GPU memory the weights load into, decimal GB; `null` when unknown. */
  gpuBudgetGb: number | null;
  /** Apple Silicon shared-pool bandwidth, GB/s; `null` when unknown. */
  unifiedGbPerSec: number | null;
}

export interface QuantFit {
  tier: "fits" | "tight" | "too-big";
  label: "Fits well" | "Tight fit" | "Too big";
  placement: "gpu" | "ram" | "disk";
}

export interface SpeedForecast {
  tokPerSec: number;
  label: string;
}

export interface RatedChoice extends HuggingFaceGgufChoice {
  bits: number | null;
  fit: QuantFit;
  speed: SpeedForecast | null;
  recommended: boolean;
}

/** model-upgrade.ts GPU_WEIGHTS_SHARE. */
const GPU_WEIGHTS_SHARE = 0.85;
/** gpu-memory-budget.ts MAC_UNIFIED_GPU_FRACTION. */
const MAC_UNIFIED_GPU_FRACTION = 0.75;
const UNIFIED_DECODE_EFFICIENCY = 0.6;
const MOE_ROUTING_EFFICIENCY = 0.6;
export const PLEASANT_TOK_PER_SEC = 20;
const MIN_AUTO_PICK_BITS = 4;
const BYTES_PER_GB = 1_000_000_000;

const APPLE_TIER_DEFAULT: Record<"base" | "pro" | "max" | "ultra", number> = {
  base: 100,
  pro: 150,
  max: 300,
  ultra: 800,
};
const APPLE_GB_PER_SEC: Record<string, number> = {
  "1-base": 68, "1-pro": 200, "1-max": 400, "1-ultra": 800,
  "2-base": 100, "2-pro": 200, "2-max": 400, "2-ultra": 800,
  "3-base": 100, "3-pro": 150, "3-max": 300, "3-ultra": 800,
  "4-base": 120, "4-pro": 273, "4-max": 410,
  "5-base": 153,
};

export function appleChipBandwidth(cpuModel: string | undefined): number | null {
  const match = /apple\s+m(\d+)(?:\s+(pro|max|ultra))?/i.exec(cpuModel ?? "");
  if (!match) return null;
  const tier = (match[2]?.toLowerCase() ?? "base") as keyof typeof APPLE_TIER_DEFAULT;
  return APPLE_GB_PER_SEC[`${match[1]}-${tier}`] ?? APPLE_TIER_DEFAULT[tier];
}

/** This machine, as far as the main process can see it without the engine. */
export function quantMachine(
  platform: NodeJS.Platform = process.platform,
  ramBytes: number = totalmem(),
  cpuModel: string | undefined = cpus()[0]?.model,
): QuantMachine {
  const ramGb = Math.max(1, Math.floor(ramBytes / BYTES_PER_GB));
  const apple = platform === "darwin" ? appleChipBandwidth(cpuModel) : null;
  return {
    ramGb,
    gpuBudgetGb: apple !== null ? (ramBytes * MAC_UNIFIED_GPU_FRACTION) / BYTES_PER_GB : null,
    unifiedGbPerSec: apple,
  };
}

export function quantBitsFromName(path: string): number | null {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  const q = /(?:^|[-_.])(?:ud-)?i?q(\d)(?:_|[-.]|$)/.exec(name);
  if (q) return Number(q[1]);
  const tq = /(?:^|[-_.])tq(\d)_/.exec(name);
  if (tq) return Number(tq[1]);
  const fp = /(?:^|[-_.])mxfp(\d)(?:[-_.]|$)/.exec(name);
  if (fp) return Number(fp[1]);
  if (/(?:^|[-_.])(?:bf16|f16|fp16)(?:[-_.]|$)/.test(name)) return 16;
  return null;
}

export function activeShareFromName(name: string): number {
  const m = /(\d+(?:\.\d+)?)b[-_]a(\d+(?:\.\d+)?)b/i.exec(name);
  if (!m) return 1;
  const total = Number(m[1]);
  const active = Number(m[2]);
  if (!(total > 0) || !(active > 0) || active >= total) return 1;
  return active / total;
}

export function quantFitFor(weightsGb: number, machine: QuantMachine): QuantFit {
  if (machine.gpuBudgetGb !== null && weightsGb <= machine.gpuBudgetGb * GPU_WEIGHTS_SHARE) {
    return { tier: "fits", label: "Fits well", placement: "gpu" };
  }
  if (machine.gpuBudgetGb === null && Math.ceil(weightsGb * 1.5) + 2 <= machine.ramGb) {
    return { tier: "fits", label: "Fits well", placement: "ram" };
  }
  if (Math.ceil(weightsGb * 1.2) <= machine.ramGb) {
    return { tier: "tight", label: "Tight fit", placement: "ram" };
  }
  return { tier: "too-big", label: "Too big", placement: "disk" };
}

export function formatSpeedEstimate(tokPerSec: number): string {
  if (tokPerSec < 1) return "under 1 tok/s, estimate";
  const t = tokPerSec;
  const rounded = t < 10 ? Math.round(t) : t < 100 ? Math.round(t / 5) * 5 : Math.round(t / 10) * 10;
  return `~${rounded} tok/s, estimate`;
}

/** Apple Silicon only, see the module comment. */
export function forecastDecodeSpeed(
  weightsGb: number,
  activeShare: number,
  machine: QuantMachine,
  fit: QuantFit,
): SpeedForecast | null {
  if (machine.unifiedGbPerSec === null || !(weightsGb > 0) || fit.placement === "disk") return null;
  const perTokenGb = activeShare < 1 ? (weightsGb * activeShare) / MOE_ROUTING_EFFICIENCY : weightsGb;
  const tokPerSec = (machine.unifiedGbPerSec * UNIFIED_DECODE_EFFICIENCY) / perTokenGb;
  return { tokPerSec: Math.round(tokPerSec * 10) / 10, label: formatSpeedEstimate(tokPerSec) };
}

/** quant-fit.ts pickBestQuant, rule for rule. */
export function pickBestQuant(rated: readonly RatedChoice[]): number | null {
  const eligible = rated
    .map((r, index) => ({ r, index }))
    .filter(({ r }) => r.bits !== null && r.bits >= MIN_AUTO_PICK_BITS);
  const fits = eligible.filter(({ r }) => r.fit.tier === "fits");
  const pleasant = fits.filter(({ r }) => r.speed === null || r.speed.tokPerSec >= PLEASANT_TOK_PER_SEC);
  if (pleasant.length > 0) {
    return pleasant.reduce((best, cur) =>
      cur.r.bits! > best.r.bits! || (cur.r.bits === best.r.bits && cur.r.sizeBytes > best.r.sizeBytes) ? cur : best,
    ).index;
  }
  const smallest = (list: typeof eligible) =>
    list.reduce((best, cur) => (cur.r.sizeBytes < best.r.sizeBytes ? cur : best)).index;
  if (fits.length > 0) return smallest(fits);
  const tight = eligible.filter(({ r }) => r.fit.tier === "tight");
  return tight.length > 0 ? smallest(tight) : null;
}

/**
 * Every choice rated, and the pick moved to the front so the list opens
 * on it. A one-file lookup (the reference named the file) is rated but
 * never reordered or marked.
 */
export function rateRepoChoices(
  repo: HuggingFaceRepoChoices,
  machine: QuantMachine,
): HuggingFaceRepoChoices & { choices: readonly RatedChoice[] } {
  const rated: RatedChoice[] = repo.choices.map((choice) => {
    const weightsGb = choice.sizeBytes / BYTES_PER_GB;
    const fit = quantFitFor(weightsGb, machine);
    const share = activeShareFromName(`${repo.repoId} ${choice.path}`);
    return {
      ...choice,
      bits: quantBitsFromName(choice.path),
      fit,
      speed: forecastDecodeSpeed(weightsGb, share, machine, fit),
      recommended: false,
    };
  });
  const best = rated.length > 1 ? pickBestQuant(rated) : null;
  if (best === null) return { ...repo, choices: rated };
  return {
    ...repo,
    choices: [{ ...rated[best]!, recommended: true }, ...rated.filter((_, i) => i !== best)],
  };
}
