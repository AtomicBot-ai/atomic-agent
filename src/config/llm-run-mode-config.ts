import { ConfigValidationError } from "./config-validation-error.js";

/**
 * Operator-facing run mode. Names the *pair* of providers a turn is
 * allowed to use, not a single model:
 *
 * - `local`  — the configured llama-server provider only.
 * - `cloud`  — the configured cloud provider only.
 * - `fusion` — cloud orchestrates, local executes. See
 *   AGENTS.md §"Run modes (Local / Cloud / Fusion)".
 */
export type RunModeName = "local" | "cloud" | "fusion";

/**
 * Where fusion sends the memory sub-runners (reflection, link
 * generation, curation votes, query rewriting, distillation).
 *
 * `local` (default) keeps them on the executor: they are cold-path
 * structured-JSON jobs that ride the reserved reflection slot and are
 * already KV-warm locally, so routing them to the cloud multiplies
 * per-turn cost for no user-visible latency win. `cloud` sends them to
 * the orchestrator; `follow` reuses whatever the last main-loop step
 * used.
 */
export type RunModeSubRunners = "local" | "cloud" | "follow";

export type UserLlmFusionConfig = {
  /**
   * How much of a turn leans on the cloud orchestrator, 0-100.
   *
   * This is a DIAL, NOT A QUOTA. It does not promise that N% of steps
   * reach the cloud; it moves the cutoff on a bounded per-step
   * complexity score (`src/agent/routing/compute-step-complexity.ts`):
   * a step routes to the cloud when `score >= 100 - cloudShare`. `0`
   * behaves exactly like `local`, `100` exactly like `cloud`.
   *
   * Resist "fixing" this into a running-counter scheduler — a quota
   * necessarily sends some trivial steps to the cloud and keeps some
   * hard ones local, which is the opposite of the intent.
   */
  cloudShare?: number;
  subRunners?: RunModeSubRunners;
};

export type UserLlmRunModeConfig = {
  mode?: RunModeName;
  /** Pin the local leg. Default: the first `llama-server`-kind provider. */
  localProvider?: string;
  /** Pin the cloud leg. Default: the first non-`llama-server` provider. */
  cloudProvider?: string;
  fusion?: UserLlmFusionConfig;
};

/** Default cloud share when fusion is selected without an explicit dial. */
export const DEFAULT_FUSION_CLOUD_SHARE = 40;

const RUN_MODE_NAMES: readonly RunModeName[] = ["local", "cloud", "fusion"];
const SUB_RUNNER_TARGETS: readonly RunModeSubRunners[] = [
  "local",
  "cloud",
  "follow",
];

function parseKnownProviderId(
  raw: unknown,
  providerIds: ReadonlySet<string>,
  field: string,
): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ConfigValidationError(field, "expected non-empty string");
  }
  if (!providerIds.has(raw)) {
    throw new ConfigValidationError(
      field,
      `unknown provider id ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function parseCloudShare(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new ConfigValidationError(field, "expected an integer 0-100");
  }
  if (raw < 0 || raw > 100) {
    throw new ConfigValidationError(
      field,
      `expected an integer 0-100, got ${raw}`,
    );
  }
  return raw;
}

function parseFusion(
  raw: unknown,
  field: string,
): UserLlmFusionConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected object");
  }
  const obj = raw as Record<string, unknown>;
  const out: UserLlmFusionConfig = {};
  if (obj.cloudShare !== undefined) {
    out.cloudShare = parseCloudShare(obj.cloudShare, `${field}.cloudShare`);
  }
  if (obj.subRunners !== undefined) {
    const target = obj.subRunners;
    if (
      typeof target !== "string" ||
      !SUB_RUNNER_TARGETS.includes(target as RunModeSubRunners)
    ) {
      throw new ConfigValidationError(
        `${field}.subRunners`,
        `expected ${SUB_RUNNER_TARGETS.join("|")}`,
      );
    }
    out.subRunners = target as RunModeSubRunners;
  }
  return out;
}

/**
 * Validate the `llm.runMode` block. `providerIds` is the set of ids the
 * sibling `llm.providers` array declares — a pinned leg that names a
 * provider which does not exist is a config error, not a silent
 * degradation, because the operator meant something specific.
 */
export function parseLlmRunModeConfig(
  raw: unknown,
  providerIds: ReadonlySet<string>,
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
  if (obj.localProvider !== undefined) {
    out.localProvider = parseKnownProviderId(
      obj.localProvider,
      providerIds,
      `${field}.localProvider`,
    );
  }
  if (obj.cloudProvider !== undefined) {
    out.cloudProvider = parseKnownProviderId(
      obj.cloudProvider,
      providerIds,
      `${field}.cloudProvider`,
    );
  }
  if (obj.fusion !== undefined) {
    out.fusion = parseFusion(obj.fusion, `${field}.fusion`);
  }
  return out;
}
