/**
 * Glue layer between the campaign config profiles and the existing
 * `multi-turn-driver` subprocess runner. Every campaign-level
 * experiment (LoCoMo, LongMemEval, ALFWorld, SWE-bench Lite, the
 * existing E1..E12 suite, …) should drive scenarios through this
 * helper so that:
 *
 *  - The `<stateDir>` is fresh per profile per scenario (no leak
 *    across profiles).
 *  - The chosen `CampaignProfileName` is materialised exactly once,
 *    in one place, via `seedCampaignConfigJson`.
 *  - The same multi-turn driver subprocess flow is used everywhere
 *    so trace parsing / token accounting / latency capture is
 *    consistent.
 *
 * This is intentionally thin — it does not own scenario semantics
 * (prompt list, judging rubric, expected behaviour). Those live in
 * the per-experiment `runner.ts`.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  seedCampaignConfigJson,
  type CampaignProfileName,
  type CampaignConfigOptions,
} from "../config/campaign-profiles.js";
import {
  driveMultiTurn,
  type MultiTurnOptions,
  type MultiTurnResult,
} from "./multi-turn-driver.js";

export interface CampaignScenarioInput {
  /** Named campaign profile to run under. */
  profile: CampaignProfileName;
  /** Profile-config overrides forwarded to `seedCampaignConfigJson`. */
  configOptions: CampaignConfigOptions;
  /**
   * Multi-turn driver options. `stateDir` and `workingDir` are
   * filled in by the helper from a fresh temp directory, so callers
   * MUST omit them. Everything else (`prompts`, `maxSteps`,
   * `timeoutMs`, drain knobs) is forwarded verbatim.
   */
  driver: Omit<MultiTurnOptions, "stateDir" | "workingDir">;
  /**
   * Slug used in the temp directory name (`/tmp/atomic-eval-<slug>-XXXX`)
   * for easier postmortem identification when many scenarios run in
   * parallel. Sanitised to `[a-z0-9_-]`.
   */
  label?: string;
  /**
   * When `true` (default), the temp `<stateDir>` is removed after
   * the run. Set to `false` to keep `memory.sqlite` / traces around
   * for inspection (the helper still returns the path so the caller
   * can grep it).
   */
  cleanup?: boolean;
}

export interface CampaignScenarioOutput {
  /** What the multi-turn driver reported. */
  result: MultiTurnResult;
  /** Absolute path to the temp `<stateDir>`. Removed unless `cleanup: false`. */
  stateDir: string;
  /** Absolute path to the temp `<workingDir>`. Removed unless `cleanup: false`. */
  workingDir: string;
}

function sanitizeSlug(label: string): string {
  return label.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase().slice(0, 32);
}

/**
 * Run a single multi-turn scenario under a named campaign profile.
 * Always disposes the temp directories on exit unless `cleanup:
 * false` is set; throws are re-raised after cleanup.
 */
export async function runCampaignScenario(
  input: CampaignScenarioInput,
): Promise<CampaignScenarioOutput> {
  const slug = sanitizeSlug(input.label ?? input.profile);
  const stateDir = mkdtempSync(join(tmpdir(), `atomic-eval-${slug}-state-`));
  const workingDir = mkdtempSync(join(tmpdir(), `atomic-eval-${slug}-work-`));
  // Make sure subsequent agent calls do not bail because the working
  // dir disappeared between mkdtemp and spawn (rare on macOS / linux
  // tmpfs, but cheap to guard).
  mkdirSync(resolve(workingDir), { recursive: true });

  let result: MultiTurnResult | null = null;
  try {
    seedCampaignConfigJson(stateDir, input.profile, input.configOptions);
    result = await driveMultiTurn({
      ...input.driver,
      stateDir,
      workingDir,
    });
    return { result, stateDir, workingDir };
  } finally {
    if (input.cleanup !== false) {
      try {
        rmSync(stateDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        rmSync(workingDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}
