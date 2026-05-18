/**
 * Paired ON / OFF runner. Given a multi-turn scenario, executes it
 * twice — once with `memory.* = on` (all v2 phases enabled), once
 * with the v1 baseline — and returns side-by-side metrics + memory
 * snapshots.
 *
 * Each side gets its own `<stateDir>` and `<workingDir>` so there is
 * no cross-talk. Both sides see the same `llamaUrl` (and the same
 * embedding daemon, when present), so the comparison isolates the
 * memory-flag delta from the model under test.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seedConfigJson, type MemoryProfile } from "./memory-profiles.js";
import {
  driveMultiTurn,
  type MultiTurnResult,
  type TurnRecord,
} from "./multi-turn-driver.js";
import { readMemorySnapshot, type MemorySnapshot } from "./memory-dump.js";

export interface PairedScenarioInput {
  /** Scenario id (stable across runs — used in reports). */
  id: string;
  /** User-facing label for the report header. */
  label: string;
  /** Ordered list of user messages. */
  prompts: readonly string[];
  /** Step cap per turn. */
  maxStepsPerTurn?: number;
  /** Hard wall-clock cap on each side's subprocess. */
  timeoutMs?: number;
  /** Optional extra env per side. */
  env?: Readonly<Record<string, string>>;
}

export interface PairedRunOptions {
  /** Chat llama base URL (e.g. `http://127.0.0.1:18991`). */
  llamaUrl: string;
  /** Embedding daemon options. Only used by the ON profile. */
  embeddings?: { enabled: boolean; modelId?: string };
  /**
   * If `true`, OFF runs first; if `false`, ON runs first. Default is
   * a deterministic alternation by scenario id so a systematic
   * "first-mover gets the cold cache" bias does not skew aggregates.
   */
  preferOnFirst?: boolean;
  /** Optional clean-up override — defaults to true. */
  cleanupTempDirs?: boolean;
}

export interface OneSideResult {
  profile: MemoryProfile;
  stateDir: string;
  workingDir: string;
  run: MultiTurnResult;
  snapshot: MemorySnapshot;
}

export interface PairedScenarioResult {
  scenarioId: string;
  label: string;
  prompts: readonly string[];
  on: OneSideResult;
  off: OneSideResult;
  /** Synthetic deltas the eval cares about — pre-computed for the report. */
  delta: {
    /** Total tool calls across all turns: on − off. */
    toolCallsDelta: number;
    /** Total prompt tokens: on − off. */
    promptTokensDelta: number;
    /** Number of turns that completed (reason !== null) — on − off. */
    completedTurnsDelta: number;
    /** Memory rows produced by ON only (count of NOTEs / lessons / profile facts). */
    onMemoryArtifacts: number;
  };
}

const DEFAULT_MAX_STEPS = 30;
const DEFAULT_TIMEOUT_MS = 4 * 60_000;

export async function runPairedScenario(
  scenario: PairedScenarioInput,
  opts: PairedRunOptions,
): Promise<PairedScenarioResult> {
  const cleanup = opts.cleanupTempDirs ?? true;
  const order: MemoryProfile[] =
    opts.preferOnFirst === false ? ["off", "on"] : ["on", "off"];

  const sides = new Map<MemoryProfile, OneSideResult>();
  const dirsToClean: string[] = [];

  try {
    for (const profile of order) {
      const stateDir = mkdtempSync(join(tmpdir(), `atomic-eval-memory-${profile}-`));
      const workingDir = mkdtempSync(join(tmpdir(), `atomic-eval-memory-${profile}-cwd-`));
      dirsToClean.push(stateDir, workingDir);

      // Seed the config.json for this side. `seedConfigJson` writes a
      // v15 file so the agent boots without a migration warning.
      const seedOpts: Parameters<typeof seedConfigJson>[2] = { llamaUrl: opts.llamaUrl };
      if (opts.embeddings) seedOpts.embeddings = opts.embeddings;
      if (scenario.maxStepsPerTurn !== undefined) {
        seedOpts.maxSteps = scenario.maxStepsPerTurn;
      }
      seedConfigJson(stateDir, profile, seedOpts);

      // The agent expects the traces directory to exist before it
      // writes; let it create it on demand (the runtime already does
      // this), but ensure the dir is writable.
      mkdirSync(join(stateDir, "traces"), { recursive: true });

      const driverOpts: Parameters<typeof driveMultiTurn>[0] = {
        workingDir,
        stateDir,
        prompts: scenario.prompts,
        maxSteps: scenario.maxStepsPerTurn ?? DEFAULT_MAX_STEPS,
        timeoutMs: scenario.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      };
      if (scenario.env) driverOpts.env = scenario.env;
      const run = await driveMultiTurn(driverOpts);
      const snapshot = readMemorySnapshot(join(stateDir, "memory.sqlite"));
      sides.set(profile, { profile, stateDir, workingDir, run, snapshot });
    }

    const on = sides.get("on")!;
    const off = sides.get("off")!;
    return {
      scenarioId: scenario.id,
      label: scenario.label,
      prompts: scenario.prompts,
      on,
      off,
      delta: computeDelta(on, off),
    };
  } finally {
    if (cleanup) {
      for (const dir of dirsToClean) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }
  }
}

function computeDelta(on: OneSideResult, off: OneSideResult): PairedScenarioResult["delta"] {
  const toolCalls = (turns: readonly TurnRecord[]): number =>
    turns.reduce((s, t) => s + t.toolCalls.length, 0);
  const promptTokens = (turns: readonly TurnRecord[]): number =>
    turns.reduce((s, t) => s + t.promptTokens, 0);
  const completedTurns = (turns: readonly TurnRecord[]): number =>
    turns.filter((t) => t.reason !== null).length;
  return {
    toolCallsDelta: toolCalls(on.run.turns) - toolCalls(off.run.turns),
    promptTokensDelta: promptTokens(on.run.turns) - promptTokens(off.run.turns),
    completedTurnsDelta: completedTurns(on.run.turns) - completedTurns(off.run.turns),
    onMemoryArtifacts:
      on.snapshot.memories.length +
      on.snapshot.lessons.length +
      on.snapshot.profileFacts.filter((f) => f.supersededBy === null).length,
  };
}
