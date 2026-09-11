import { ConfigValidationError } from "./config-validation-error.js";

/**
 * Operator-facing run mode. Names *how* a chat runs, not a single model:
 *
 * - `local`  — the active provider is a llama-server one; everything
 *   runs on this machine.
 * - `cloud`  — the active provider is a cloud one; everything runs there.
 * - `fusion` — a cloud model orchestrates and several local-model
 *   workers execute the parts it delegates. See AGENTS.md §"Run modes
 *   (Local / Cloud / Fusion)".
 *
 * `llm.activeTextProvider` stays authoritative in every mode; this block
 * is additive (see `resolveRunMode`).
 */
export type RunModeName = "local" | "cloud" | "fusion";

export type UserLlmFusionConfig = {
  /**
   * The orchestrator leg. Must name a configured provider whose kind is
   * NOT `llama-server`. Default: the active provider when it is a cloud
   * one, else the first cloud provider in `llm.providers`.
   */
  orchestratorProvider?: string;
  /**
   * Informational pin for the orchestrator model. The wire request
   * carries no model field — the provider entry's `defaultChatModel` is
   * what actually serves — so this only overrides what is *displayed*
   * and priced. Left unset by the TUI.
   */
  orchestratorModel?: string;
  /**
   * The worker leg. Must name a configured `llama-server` provider.
   * Default: the first `llama-server` provider in `llm.providers`.
   */
  workerProvider?: string;
  /**
   * Informational pin for the worker model. The managed daemon serves
   * whatever `localModels.managed.modelId` names; this only overrides
   * the label. Left unset by the TUI.
   */
  workerModel?: string;
  /**
   * Default fan-out width, 1..8. Default 2.
   *
   * **Not a ceiling.** The orchestrator sizes each `fusion.delegate`
   * call itself — it is the party that knows how divisible the job is,
   * and the `### fusion` guidance tells it what this machine can serve
   * — so a call that names `maxWorkers` gets the number it asked for.
   * This value only fills in for a call that named nothing. What still
   * bounds the width is physical: the task count, and the llama-server
   * request slots (`localModels.managed.parallel`) on a worker leg with
   * slot affinity.
   */
  workers?: number;
  /** Step ceiling per worker turn. Default 40. */
  workerMaxSteps?: number;
  /** Wall-clock ceiling per worker turn, in ms. Default 600 000. */
  workerTimeoutMs?: number;
};

export type UserLlmRunModeConfig = {
  mode?: RunModeName;
  fusion?: UserLlmFusionConfig;
};

export const RUN_MODE_NAMES: readonly RunModeName[] = [
  "local",
  "cloud",
  "fusion",
];

/** Provider kind that identifies a local (worker-capable) leg. */
export const LOCAL_PROVIDER_KIND = "llama-server";

export const FUSION_WORKERS_MIN = 1;
export const FUSION_WORKERS_MAX = 8;
export const DEFAULT_FUSION_WORKERS = 2;
export const DEFAULT_FUSION_WORKER_MAX_STEPS = 40;
export const DEFAULT_FUSION_WORKER_TIMEOUT_MS = 600_000;

export type RunModeProviderRef = { readonly id: string; readonly kind: string };

function parseLegProviderId(
  raw: unknown,
  providers: ReadonlyArray<RunModeProviderRef>,
  field: string,
): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ConfigValidationError(field, "expected non-empty string");
  }
  const entry = providers.find((p) => p.id === raw);
  if (!entry) {
    throw new ConfigValidationError(
      field,
      `unknown provider id ${JSON.stringify(raw)}`,
    );
  }
  // Neither leg is nailed to a kind. Cloud orchestrator + local workers
  // is the default pairing and the economics the mode was built for, but
  // a local model planning for cloud executors is a legitimate setup and
  // the schema is the wrong place to forbid it — it does not refuse a
  // file, it refuses to BOOT on one, which is how an operator ends up
  // hand-editing JSON to start the app again.
  //
  // What is still checked is that the id names a configured provider,
  // above. The one pairing the runtime rejects — both legs on the same
  // provider — is caught by `resolveRunMode`, which can see both at once
  // and degrades instead of throwing.
  return raw;
}

function parseBoundedInt(
  raw: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < min ||
    raw > max
  ) {
    throw new ConfigValidationError(
      field,
      `expected an integer ${min}-${max}, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function parseOptionalLabel(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ConfigValidationError(field, "expected non-empty string");
  }
  return raw;
}

function parseFusion(
  raw: unknown,
  providers: ReadonlyArray<RunModeProviderRef>,
  field: string,
): UserLlmFusionConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected object");
  }
  const obj = raw as Record<string, unknown>;
  const out: UserLlmFusionConfig = {};
  if (obj.orchestratorProvider !== undefined) {
    out.orchestratorProvider = parseLegProviderId(
      obj.orchestratorProvider,
      providers,
      `${field}.orchestratorProvider`,
    );
  }
  if (obj.orchestratorModel !== undefined) {
    out.orchestratorModel = parseOptionalLabel(
      obj.orchestratorModel,
      `${field}.orchestratorModel`,
    );
  }
  if (obj.workerProvider !== undefined) {
    out.workerProvider = parseLegProviderId(
      obj.workerProvider,
      providers,
      `${field}.workerProvider`,
    );
  }
  if (obj.workerModel !== undefined) {
    out.workerModel = parseOptionalLabel(
      obj.workerModel,
      `${field}.workerModel`,
    );
  }
  if (obj.workers !== undefined) {
    out.workers = parseBoundedInt(
      obj.workers,
      `${field}.workers`,
      FUSION_WORKERS_MIN,
      FUSION_WORKERS_MAX,
    );
  }
  if (obj.workerMaxSteps !== undefined) {
    out.workerMaxSteps = parseBoundedInt(
      obj.workerMaxSteps,
      `${field}.workerMaxSteps`,
      1,
      1000,
    );
  }
  if (obj.workerTimeoutMs !== undefined) {
    out.workerTimeoutMs = parseBoundedInt(
      obj.workerTimeoutMs,
      `${field}.workerTimeoutMs`,
      1_000,
      86_400_000,
    );
  }
  return out;
}

/**
 * Validate the `llm.runMode` block against the sibling `llm.providers`
 * array. A pinned leg that names a provider which does not exist, or
 * one of the wrong kind, is a config error rather than a silent
 * degradation: the operator meant something specific.
 */
export function parseLlmRunModeConfig(
  raw: unknown,
  providers: ReadonlyArray<RunModeProviderRef>,
  field: string,
): UserLlmRunModeConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected object");
  }
  const obj = raw as Record<string, unknown>;
  const out: UserLlmRunModeConfig = {};
  if (obj.mode !== undefined) {
    const mode = obj.mode;
    if (
      typeof mode !== "string" ||
      !RUN_MODE_NAMES.includes(mode as RunModeName)
    ) {
      throw new ConfigValidationError(
        `${field}.mode`,
        `expected ${RUN_MODE_NAMES.join("|")}`,
      );
    }
    out.mode = mode as RunModeName;
  }
  if (obj.fusion !== undefined) {
    out.fusion = parseFusion(obj.fusion, providers, `${field}.fusion`);
  }
  return out;
}

/**
 * Drop fusion leg pins that name a provider being removed. The parser
 * refuses a pin to an unknown id, so leaving one behind would make the
 * file unreadable on the next start. Returns the input untouched when
 * nothing is pinned to `removedId`.
 */
export function scrubRunModeProviderPins(
  runMode: UserLlmRunModeConfig | undefined,
  removedId: string,
): UserLlmRunModeConfig | undefined {
  if (!runMode?.fusion) return runMode;
  const { orchestratorProvider, workerProvider, ...rest } = runMode.fusion;
  if (orchestratorProvider !== removedId && workerProvider !== removedId)
    return runMode;
  return {
    ...runMode,
    fusion: {
      ...rest,
      ...(orchestratorProvider && orchestratorProvider !== removedId
        ? { orchestratorProvider }
        : {}),
      ...(workerProvider && workerProvider !== removedId
        ? { workerProvider }
        : {}),
    },
  };
}
