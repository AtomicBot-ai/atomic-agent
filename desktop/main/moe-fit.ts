/**
 * ATO-2455: which models fit this machine with experts in system RAM.
 *
 * Off a Mac this process cannot see the GPU (quant-fit.ts: the engine
 * reads its device table, this process does not run the engine), so the
 * agent says it: `atag models recommend --json` gives `machine.dedicatedGpu`,
 * `machine.gpuBudgetGb`, `machine.cpuMoe` and an `expertsInRam` list (id,
 * tier, speed) from the agent's own rule (src/local-llm/catalog/
 * moe-split-fit.ts). Read once in the background and kept: the card does
 * not change while the app runs. A change of `localModels.managed.cpuMoe`
 * forgets it (`forgetMoeFitFacts`), so the next list reads it again.
 *
 * Never on a Mac: one memory for both, the agent never moves experts
 * there. An agent without ATO-2455 answers without the fields, and the
 * rows keep their RAM-only verdict.
 */

export interface ExpertsInRamFit {
  /** "fits": comfortable; "tight": the RAM only just holds the experts. */
  tier: "fits" | "tight";
  /** `~15 tok/s, estimate`, or null. */
  speed: string | null;
}

export interface MoeFitFacts {
  dedicatedGpu: boolean;
  /** GPU memory for the weights, decimal GB, as the agent read it. */
  gpuBudgetGb: number | null;
  /** `localModels.managed.cpuMoe`: "auto", "off" or a pinned count. */
  cpuMoe: "auto" | "off" | number;
  byId: Record<string, ExpertsInRamFit>;
}

/** The facts from `models recommend --json`, or null for an agent without them. */
export function parseMoeFitFacts(stdout: string | null): MoeFitFacts | null {
  if (!stdout) return null;
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const o = json as { machine?: Record<string, unknown>; expertsInRam?: unknown };
  const machine = o.machine;
  if (!machine || typeof machine.dedicatedGpu !== "boolean" || !Array.isArray(o.expertsInRam)) return null;
  const raw = machine.cpuMoe;
  const cpuMoe: MoeFitFacts["cpuMoe"] =
    raw === "off" ? "off" : typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : "auto";
  const gpu = machine.gpuBudgetGb;
  const byId: Record<string, ExpertsInRamFit> = {};
  for (const e of o.expertsInRam as unknown[]) {
    const row = e as { id?: unknown; tier?: unknown; speed?: unknown };
    if (typeof row.id !== "string" || (row.tier !== "fits" && row.tier !== "tight")) continue;
    byId[row.id] = { tier: row.tier, speed: typeof row.speed === "string" ? row.speed : null };
  }
  return {
    dedicatedGpu: machine.dedicatedGpu,
    gpuBudgetGb: typeof gpu === "number" && gpu > 0 ? gpu : null,
    cpuMoe,
    byId,
  };
}

/** Each listed model the facts name gets `expertsInRam`; the rest are left as they are. */
export function withExpertsInRam<R extends { models?: Array<{ id: string }> }>(list: R, facts: MoeFitFacts | null): R {
  if (!facts || !list.models || facts.cpuMoe === "off") return list;
  return {
    ...list,
    models: list.models.map((m) => (facts.byId[m.id] ? { ...m, expertsInRam: facts.byId[m.id] } : m)),
  } as R;
}

let cached: MoeFitFacts | null = null;
/** A read finished (with facts or without): no second device probe until forgotten. */
let read = false;
let pending: Promise<void> | null = null;
/** Bumped by a forget, so a read started before it does not land after it. */
let generation = 0;

/**
 * The facts read so far, or null; the first call starts the read in the
 * background (`fetch` is agent-cli.ts modelsRecommend) and returns null,
 * so no list waits on a device probe. Nothing on a Mac.
 */
export function moeFitFactsNow(
  fetch: () => Promise<string | null>,
  platform: NodeJS.Platform = process.platform,
): MoeFitFacts | null {
  if (platform === "darwin") return null;
  if (!read && !pending) {
    const gen = generation;
    pending = fetch()
      .then((stdout) => {
        if (gen === generation) cached = parseMoeFitFacts(stdout);
      })
      .catch(() => {
        if (gen === generation) cached = null;
      })
      .finally(() => {
        if (gen === generation) read = true;
        pending = null;
      });
  }
  return cached;
}

/** `localModels.managed.cpuMoe` changed: read the facts again next time. */
export function forgetMoeFitFacts(): void {
  cached = null;
  read = false;
  generation += 1;
}
