/**
 * Run mode — Local / Cloud / Fusion — main-process side.
 *
 * Ports of the agent's own logic (v0.6.1), kept pure so the smoke can pin
 * every sentence and every write payload without a live provider:
 *
 *   resolveRunMode             ← src/llm/run-mode/resolve-run-mode.ts
 *   describeRunModeDegradation ← src/llm/run-mode/run-mode-degradation.ts
 *   describeRunMode            ← src/llm/run-mode/run-mode-summary.ts
 *   describeFusionBlocker      ← src/tui/run-mode/fusion-preflight.ts
 *   fusionDetail               ← src/tui/composer-switch/composer-switch-rows.ts
 *   describeFusionIntro        ← src/tui/run-mode/fusion-intro.ts
 *   parseRunModeCommand        ← src/tui/commands/dispatch-run-mode.ts
 *   planEnterFusion            ← RunModeOrchestrator.setMode("fusion") + setRunModeInConfig
 *   planSwapLegs               ← RunModeOrchestrator.swapLegs
 *   planFusionWorkers          ← RunModeOrchestrator.setWorkers + setFusionWorkersInConfig
 *
 * The planners MUTATE the config object they are given — it is the one the
 * caller read under the config lock and is about to write whole — and say
 * whether anything moved. The renderer is one classic script and carries its
 * own copy of the read-side functions; the smoke asserts both copies answer
 * the same on seeded configs.
 */

export type RunModeName = "local" | "cloud" | "fusion";

export interface RunModeProvider {
  id: string;
  kind?: string;
  defaultChatModel?: string;
  model?: string;
}

export interface FusionPins {
  orchestratorProvider?: string;
  orchestratorModel?: string;
  workerProvider?: string;
  workerModel?: string;
  workers?: number;
  workerMaxSteps?: number;
  workerTimeoutMs?: number;
}

export interface RunModeConfig {
  llm?: {
    activeTextProvider?: string;
    providers?: RunModeProvider[];
    runMode?: { mode?: RunModeName; fusion?: FusionPins };
  };
  localModels?: {
    mode?: string;
    managed?: { modelId?: string | null; parallel?: number | string };
  };
}

export const LOCAL_PROVIDER_ID = "local-llama";
export const LOCAL_PROVIDER_KIND = "llama-server";
export const FUSION_WORKERS_MIN = 1;
export const FUSION_WORKERS_MAX = 8;
export const DEFAULT_FUSION_WORKERS = 2;
const DEFAULT_FUSION_WORKER_MAX_STEPS = 40;
const DEFAULT_FUSION_WORKER_TIMEOUT_MS = 2_700_000;
const RUN_MODE_NAMES: readonly RunModeName[] = ["local", "cloud", "fusion"];

export type RunModeDegradation = {
  reason: "no-cloud-provider" | "no-second-provider";
  requested: RunModeName;
};

export interface ResolvedRunMode {
  stored: RunModeName | null;
  effective: RunModeName;
  orchestratorProviderId: string | null;
  orchestratorModel: string | null;
  workerProviderId: string | null;
  workerModel: string | null;
  workers: number;
  workerMaxSteps: number;
  workerTimeoutMs: number;
  primaryProviderId: string;
  degraded: RunModeDegradation | null;
}

const isLocalKind = (p: RunModeProvider | undefined): boolean => p?.kind === LOCAL_PROVIDER_KIND;

function providersOf(cfg: RunModeConfig | null | undefined): RunModeProvider[] {
  const list = cfg?.llm?.providers;
  // resolveLlmConfig: a file with no llm block runs on the synthesized local entry.
  return Array.isArray(list) ? list : [{ id: LOCAL_PROVIDER_ID, kind: LOCAL_PROVIDER_KIND }];
}

/** resolveRunMode — `llm.activeTextProvider` stays authoritative; `runMode.mode` is additive. */
export function resolveRunMode(cfg: RunModeConfig | null | undefined): ResolvedRunMode {
  const runMode = cfg?.llm?.runMode;
  const fusion = runMode?.fusion;
  const stored = runMode?.mode ?? null;
  const providers = providersOf(cfg);
  const activeId = cfg?.llm?.activeTextProvider ?? LOCAL_PROVIDER_ID;
  const byId = (id: string | undefined) => (id === undefined ? undefined : providers.find((p) => p.id === id));
  const managedModelId = cfg?.localModels?.managed?.modelId ?? null;

  const active = byId(activeId);
  const derived: RunModeName = active === undefined || isLocalKind(active) ? "local" : "cloud";

  const orchestrator =
    byId(fusion?.orchestratorProvider)
    ?? (active !== undefined && !isLocalKind(active) ? active : undefined)
    ?? providers.find((p) => !isLocalKind(p));
  const worker =
    byId(fusion?.workerProvider)
    ?? providers.find((p) => isLocalKind(p) && p.id !== orchestrator?.id)
    ?? providers.find((p) => p.id !== orchestrator?.id);

  const orchestratorProviderId = orchestrator?.id ?? null;
  const workerProviderId = worker?.id ?? null;

  let effective: RunModeName = derived;
  let degraded: RunModeDegradation | null = null;
  if (stored === "fusion") {
    if (orchestratorProviderId === null) degraded = { reason: "no-cloud-provider", requested: stored };
    else if (workerProviderId === null) degraded = { reason: "no-second-provider", requested: stored };
    else if (activeId === orchestratorProviderId) effective = "fusion";
  } else if (stored === "cloud" && orchestratorProviderId === null) {
    degraded = { reason: "no-cloud-provider", requested: stored };
  }

  const primaryProviderId = (effective === "local" ? workerProviderId : orchestratorProviderId) ?? activeId;
  return {
    stored,
    effective,
    orchestratorProviderId,
    orchestratorModel: fusion?.orchestratorModel ?? orchestrator?.defaultChatModel ?? orchestrator?.model ?? null,
    workerProviderId,
    workerModel:
      fusion?.workerModel
      ?? (worker !== undefined && isLocalKind(worker)
        ? (managedModelId ?? worker.model ?? null)
        : (worker?.defaultChatModel ?? worker?.model ?? null)),
    workers: fusion?.workers ?? DEFAULT_FUSION_WORKERS,
    workerMaxSteps: fusion?.workerMaxSteps ?? DEFAULT_FUSION_WORKER_MAX_STEPS,
    workerTimeoutMs: fusion?.workerTimeoutMs ?? DEFAULT_FUSION_WORKER_TIMEOUT_MS,
    primaryProviderId,
    degraded,
  };
}

export function describeRunModeDegradation(degraded: RunModeDegradation): string {
  if (degraded.reason === "no-cloud-provider") {
    return degraded.requested === "fusion"
      ? "Fusion needs a cloud orchestrator — no cloud provider is configured. Staying on local. Add one in Manage → LLM → Cloud (or /llm)."
      : "Cloud mode needs a cloud provider — none is configured. Staying on local. Add one in Manage → LLM → Cloud (or /llm).";
  }
  return "Fusion needs two providers — one to orchestrate and one to run the workers. Only one is configured. Add another in Manage → LLM (or /llm).";
}

export function runModeLabel(mode: RunModeName): string {
  return mode === "fusion" ? "Fusion" : mode === "cloud" ? "Cloud" : "Local";
}

/** The body of `/runmode status`. */
export function describeRunMode(rm: ResolvedRunMode): string {
  const parts: string[] = [];
  if (rm.effective === "fusion") {
    parts.push(
      `Fusion — orchestrator ${rm.orchestratorProviderId}${rm.orchestratorModel ? ` (${rm.orchestratorModel})` : ""}, `
      + `${rm.workers} worker${rm.workers === 1 ? "" : "s"} on ${rm.workerProviderId}${rm.workerModel ? ` (${rm.workerModel})` : ""}`,
    );
  } else {
    parts.push(`${runModeLabel(rm.effective)} — active provider ${rm.primaryProviderId}`);
  }
  if (rm.degraded) {
    parts.push(describeRunModeDegradation(rm.degraded));
  } else if (rm.stored !== null && rm.stored !== rm.effective) {
    parts.push(
      `stored ${rm.stored}, effective ${rm.effective} — the ${rm.stored === "fusion" ? "orchestrator" : rm.stored} `
      + "provider is not the active one; pick the mode again to re-apply",
    );
  }
  return parts.join(". ");
}

export interface FusionFacts {
  /** Cloud provider ids that have a usable key (`providersReady`). */
  readyIds: readonly string[];
  /** The local catalogue snapshot has landed. */
  localLoaded: boolean;
  /** Something is on disk. */
  localDownloaded: boolean;
}

/** describeFusionBlocker — why Fusion cannot be switched on, or null. */
export function describeFusionBlocker(cfg: RunModeConfig | null | undefined, facts: FusionFacts): string | null {
  const providers = providersOf(cfg);
  const cloudReady = providers.filter((p) => !isLocalKind(p) && facts.readyIds.includes(p.id)).length;
  // Abstains until the first snapshot lands: an empty list is indistinguishable
  // from "nothing downloaded" before then.
  const localReady = !facts.localLoaded || facts.localDownloaded ? providers.filter(isLocalKind).length : 0;
  if (cloudReady + localReady >= 2) return null;
  if (cloudReady + localReady === 1 && localReady === 1) {
    return "needs a second provider to orchestrate — Manage › LLM › Cloud";
  }
  if (cloudReady + localReady === 1) return "needs a second provider for the workers — Manage › LLM";
  return "needs two providers, one per leg — Manage › LLM";
}

/** The fusion backend row's detail when nothing blocks it. */
export function fusionDetail(rm: ResolvedRunMode): string {
  return `cloud plans · ${rm.workers} local worker${rm.workers === 1 ? "" : "s"}`;
}

export const FUSION_MARK = [
  "        ●  orchestrator",
  "        │",
  "   ┌────┼────┐",
  "   ○    ○    ○  workers",
].join("\n");

/**
 * describeFusionIntro, as paragraphs after the mark. One sentence is the
 * desktop's: the TUI's last paragraph names `ctrl+r`, a terminal chord this
 * window does not have — the seats are picked with the Provider and Workers
 * controls here.
 */
export function describeFusionIntro(rm: ResolvedRunMode): string[] {
  const orchestrator = rm.orchestratorModel ?? rm.orchestratorProviderId ?? "your cloud provider";
  const worker = rm.workerModel ?? rm.workerProviderId ?? "the local model";
  return [
    "Fusion splits the work between two models: one decides, the other does.",
    `Right now — ${orchestrator} plans. It reads enough to choose an approach, breaks the job into self-contained parts, writes the brief for each, then reads what comes back, judges it, and sends anything weak out again.`
      + ` ${worker} executes: each worker takes one part and reports. They cannot reach you or ask for approval, so anything needing a person comes back up.`,
    "How many run at once is not a setting. The orchestrator sizes each fan-out to the job at hand, up to what this machine can serve.",
    "Either seat takes either kind, and the pairing is the interesting part. Cloud planning with local workers is the usual one: sharp judgement, cheap bulk. Invert it and a local model plans while cloud workers execute — your reasoning never leaves the machine and you rent only the lifting. Two cloud models work as well, a careful one directing a fast one; so does a big local model directing a small one.",
    "Worth playing with: a result is only as good as the model that did the work, and only as sensible as the model that planned it. Move that line and the output changes character.",
    "The Provider and Workers controls pick both seats — each row says whether it runs local or in the cloud. /runmode status says what is resolved right now; /runmode cloud or /runmode local leaves fusion.",
  ];
}

export const RUN_MODE_USAGE =
  "usage: /runmode (opens the switch) · /runmode local|cloud|fusion · /runmode swap · /runmode workers N · /runmode status";

export interface RunModeCommand {
  openSwitch: boolean;
  mode?: RunModeName;
  status?: boolean;
  swap?: boolean;
  workers?: number;
  error?: string;
}

export function parseRunModeCommand(rawArgs: string): RunModeCommand {
  const args = rawArgs.trim().toLowerCase();
  if (args.length === 0) return { openSwitch: true };
  if (args === "status") return { openSwitch: false, status: true };
  if (args === "swap") return { openSwitch: false, swap: true };
  const workers = /^workers\s+(\d+)$/.exec(args);
  if (workers) {
    const n = Number(workers[1]);
    if (n < FUSION_WORKERS_MIN || n > FUSION_WORKERS_MAX) {
      return { openSwitch: false, error: `workers must be ${FUSION_WORKERS_MIN}-${FUSION_WORKERS_MAX} — ${RUN_MODE_USAGE}` };
    }
    return { openSwitch: false, workers: n };
  }
  if ((RUN_MODE_NAMES as readonly string[]).includes(args)) return { openSwitch: false, mode: args as RunModeName };
  return { openSwitch: false, error: `unknown run mode "${rawArgs.trim()}" — ${RUN_MODE_USAGE}` };
}

export const SWAP_NEEDS_FUSION = "swap needs fusion — pick it first (`/runmode fusion`)";

export interface RunModeVerdict {
  /** The config object was changed and must be written. */
  write: boolean;
  /** One sentence; nothing was changed. */
  refusal?: string;
  /** The provider that is now `llm.activeTextProvider`. */
  leg?: string;
  before: ResolvedRunMode;
  after?: ResolvedRunMode;
  /** setWorkers' runtime_info line. */
  notice?: string;
}

function withoutUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * setMode("fusion"): pick both legs the way the TUI does, then write the mode,
 * the orchestrator as the active provider and BOTH pins in one change.
 * `isKeyed` is resolveLlmProviderApiKey || usesExternalCliAuth.
 */
export function planEnterFusion(
  cfg: RunModeConfig,
  pins: Partial<FusionPins>,
  isKeyed: (p: RunModeProvider) => boolean,
): RunModeVerdict {
  const before = resolveRunMode(cfg);
  const snapshot = JSON.stringify(cfg);
  const llm = cfg.llm ?? {};
  const providers = providersOf(cfg);
  const active = llm.activeTextProvider ?? LOCAL_PROVIDER_ID;
  const activeIsCloud = providers.some((p) => p.id === active && !isLocalKind(p));
  const cloud = providers.filter((p) => !isLocalKind(p));
  const firstUsableCloud = (cloud.find(isKeyed) ?? cloud[0])?.id ?? null;
  // Cloud orchestrator is the default, not the rule: an explicit pin wins whatever its kind.
  const leg = pins.orchestratorProvider ?? (activeIsCloud ? active : null) ?? firstUsableCloud
    ?? before.orchestratorProviderId ?? active;
  const workerLeg = pins.workerProvider
    ?? (before.workerProviderId !== leg ? before.workerProviderId : null)
    ?? providers.find((p) => p.id !== leg)?.id
    ?? null;
  if (workerLeg === null) {
    return { write: false, before, refusal: describeRunModeDegradation({ reason: "no-second-provider", requested: "fusion" }) };
  }
  if (!Array.isArray(llm.providers) || !llm.providers.some((p) => p.id === leg)) {
    return { write: false, before, refusal: `provider "${leg}" is not configured` };
  }
  const fusion = withoutUndefined({ ...llm.runMode?.fusion, ...pins, orchestratorProvider: leg, workerProvider: workerLeg });
  cfg.llm = {
    ...llm,
    activeTextProvider: leg,
    runMode: { ...llm.runMode, mode: "fusion", ...(Object.keys(fusion).length > 0 ? { fusion } : {}) },
  };
  return { write: JSON.stringify(cfg) !== snapshot, leg, before, after: resolveRunMode(cfg) };
}

/** swapLegs: the orchestrator becomes the worker and back, model pins riding along. */
export function planSwapLegs(cfg: RunModeConfig, isKeyed: (p: RunModeProvider) => boolean): RunModeVerdict {
  const before = resolveRunMode(cfg);
  if (before.stored !== "fusion") return { write: false, before, refusal: SWAP_NEEDS_FUSION };
  const o = before.orchestratorProviderId;
  const w = before.workerProviderId;
  if (o === null || w === null || o === w) {
    return { write: false, before, refusal: describeRunModeDegradation({ reason: "no-second-provider", requested: "fusion" }) };
  }
  const pinned = cfg.llm?.runMode?.fusion;
  return planEnterFusion(cfg, {
    orchestratorProvider: w,
    workerProvider: o,
    orchestratorModel: pinned?.workerModel,
    workerModel: pinned?.orchestratorModel,
  }, isKeyed);
}

/**
 * setWorkers: `llm.runMode.fusion.workers` and `localModels.managed.parallel`
 * in one change — how many workers, and how many llama-server slots for them.
 * Valid off the fusion route too: the count is remembered.
 */
export function planFusionWorkers(cfg: RunModeConfig, workers: number): RunModeVerdict {
  const before = resolveRunMode(cfg);
  if (!Number.isInteger(workers) || workers < FUSION_WORKERS_MIN || workers > FUSION_WORKERS_MAX) {
    return { write: false, before, refusal: `workers must be an integer ${FUSION_WORKERS_MIN}-${FUSION_WORKERS_MAX}, got ${workers}` };
  }
  if (!cfg.llm) return { write: false, before, refusal: "no provider is configured yet — Manage › LLM" };
  const snapshot = JSON.stringify(cfg);
  const parallelBefore = cfg.localModels?.managed?.parallel;
  const llm = cfg.llm;
  cfg.llm = { ...llm, runMode: { ...llm.runMode, fusion: { ...llm.runMode?.fusion, workers } } };
  cfg.localModels = { ...cfg.localModels, managed: { ...cfg.localModels?.managed, parallel: workers } };
  const hint = cfg.localModels.mode === "managed" && parallelBefore !== workers
    ? ` — restart the local daemon (Manage › LLM › Local, \`s\`) to apply --parallel ${workers}`
    : "";
  return {
    write: JSON.stringify(cfg) !== snapshot,
    before,
    after: resolveRunMode(cfg),
    notice: `fusion: ${workers} worker${workers === 1 ? "" : "s"}${hint}`,
  };
}
