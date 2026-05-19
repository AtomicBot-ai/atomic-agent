/**
 * Drive a sequence of `atomic-agent run` sessions against a SHARED
 * `<stateDir>`, with optional consolidator-tick injection between
 * sessions. Each session is a fresh CLI subprocess (so a fresh
 * `sessionId`, a fresh `### conversation` tail, a fresh reflection
 * context) but the agent's memory subsystem keeps accumulating into
 * the same `<stateDir>/memory.sqlite` — which is the entire point
 * of the E2E suite: prove that knowledge formed in session N
 * survives the session boundary and influences session N+1.
 *
 * Each `MultiSessionStep` is one of:
 *   - { kind: "session", prompts, ... }  — spawn one CLI run
 *   - { kind: "consolidate" }            — invoke runConsolidatorTick
 *
 * The shape is deliberately a flat ordered list, NOT
 * `sessions[].prompts[]`, because the consolidator may need to run
 * between two adjacent sessions, between a session and itself
 * (multiple reflection cycles), or even before any session (rare).
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { MemoryStore } from "../../src/memory/memory-store.js";

import { driveMultiTurn, type MultiTurnResult } from "./multi-turn-driver.js";
import {
  runConsolidatorTick,
  type ConsolidatorTickOutcome,
} from "./consolidator-tick.js";
import { seedConfigJson } from "./memory-profiles.js";

/**
 * One memory to seed directly into `<stateDir>/memory.sqlite` via
 * `MemoryStore.store()`. Used by the `seed_memories` step. Tags
 * default to `[]`, source to `"agent"` — same surface as the agent
 * tool would write.
 */
export interface SeededMemory {
  content: string;
  tags?: readonly string[];
  source?: "user" | "agent";
  sessionId?: string;
}

export type MultiSessionStep =
  | {
      kind: "session";
      label: string;
      prompts: readonly string[];
      maxSteps: number;
      timeoutMs: number;
    }
  | {
      kind: "consolidate";
      label: string;
      withProcedure?: boolean;
      minClusterSize?: number;
      maxClustersPerTick?: number;
      /** See `ConsolidatorTickInput.linkSweepExample`. */
      linkSweepExample?: string;
    }
  | {
      /**
       * Write fixture memories straight into `MemoryStore` before the
       * next session runs. This is **not** a "hack around the LLM" —
       * it is the canonical pattern when the scenario's subject is a
       * downstream pipeline (vote, consolidator, eviction) rather than
       * the memory-creation pipeline itself. The agent will see the
       * seeded rows on the very next turn through normal recall /
       * `### recalled` injection.
       */
      kind: "seed_memories";
      label: string;
      entries: readonly SeededMemory[];
    };

export interface SeedMemoriesStepResult {
  kind: "seed_memories";
  label: string;
  insertedIds: readonly number[];
}

export interface MultiSessionInput {
  workingDir: string;
  stateDir: string;
  /** llama-server URL — required when any step uses `consolidate`. */
  llamaUrl: string;
  steps: readonly MultiSessionStep[];
  env?: Readonly<Record<string, string>>;
  /**
   * Phase 7b — flip `memory.procedures.enabled` for the seeded
   * `config.json`. Off by default (production-like). Scenarios that
   * exercise the procedure surface (E2E-3) set this to `true` so
   * both the tool descriptor stays in the prompt and the consolidator
   * can persist procedures.
   */
  proceduresEnabled?: boolean;
  /**
   * Forwarded to `seedConfigJson` so scenarios exercising the
   * vote surface (E2E-5) can flip `memory.voting.enabled=true`.
   */
  votingEnabled?: boolean;
}

export type MultiSessionStepResult =
  | { kind: "session"; label: string; result: MultiTurnResult }
  | { kind: "consolidate"; label: string; outcome: ConsolidatorTickOutcome }
  | SeedMemoriesStepResult;

export interface MultiSessionReport {
  stateDir: string;
  workingDir: string;
  steps: readonly MultiSessionStepResult[];
}

export async function driveMultiSession(
  input: MultiSessionInput,
): Promise<MultiSessionReport> {
  // Materialise the agent's user config + traces dir before the first
  // CLI spawn. Without `config.json` pointing at the managed daemon's
  // URL, the CLI tries the hard-coded default localhost port and
  // hangs waiting for an LLM that does not exist. Mirror of what
  // `paired-runner.ts` does at line 109. We seed once because all
  // sessions in an E2E scenario share the same stateDir.
  mkdirSync(input.stateDir, { recursive: true });
  mkdirSync(input.workingDir, { recursive: true });
  mkdirSync(join(input.stateDir, "traces"), { recursive: true });
  seedConfigJson(input.stateDir, "on", {
    llamaUrl: input.llamaUrl,
    ...(input.proceduresEnabled !== undefined
      ? { proceduresEnabled: input.proceduresEnabled }
      : {}),
    ...(input.votingEnabled !== undefined
      ? { votingEnabled: input.votingEnabled }
      : {}),
  });

  const steps: MultiSessionStepResult[] = [];
  for (const step of input.steps) {
    if (step.kind === "session") {
      const opts: Parameters<typeof driveMultiTurn>[0] = {
        workingDir: input.workingDir,
        stateDir: input.stateDir,
        prompts: step.prompts,
        maxSteps: step.maxSteps,
        timeoutMs: step.timeoutMs,
        ...(input.env ? { env: input.env } : {}),
      };
      const result = await driveMultiTurn(opts);
      steps.push({ kind: "session", label: step.label, result });
      continue;
    }
    if (step.kind === "seed_memories") {
      const insertedIds = seedMemoryRows(input.stateDir, step.entries);
      steps.push({ kind: "seed_memories", label: step.label, insertedIds });
      continue;
    }
    const tickInput: Parameters<typeof runConsolidatorTick>[0] = {
      stateDir: input.stateDir,
      llamaUrl: input.llamaUrl,
      ...(step.withProcedure !== undefined ? { withProcedure: step.withProcedure } : {}),
      ...(step.minClusterSize !== undefined ? { minClusterSize: step.minClusterSize } : {}),
      ...(step.maxClustersPerTick !== undefined
        ? { maxClustersPerTick: step.maxClustersPerTick }
        : {}),
      ...(step.linkSweepExample !== undefined
        ? { linkSweepExample: step.linkSweepExample }
        : {}),
    };
    const outcome = await runConsolidatorTick(tickInput);
    steps.push({ kind: "consolidate", label: step.label, outcome });
  }
  return { stateDir: input.stateDir, workingDir: input.workingDir, steps };
}

/**
 * Open `<stateDir>/memory.sqlite` directly via `MemoryStore`, write
 * the seed rows, close the handle. The store path matches the one
 * the agent will open at next CLI spawn so there is no schema drift.
 */
function seedMemoryRows(
  stateDir: string,
  entries: readonly SeededMemory[],
): readonly number[] {
  const dbFile = resolve(stateDir, "memory.sqlite");
  const store = new MemoryStore({ dbFile, maxEntries: 5000 });
  try {
    const ids: number[] = [];
    for (const e of entries) {
      const entry = store.store({
        content: e.content,
        ...(e.tags !== undefined ? { tags: [...e.tags] } : {}),
        source: e.source ?? "agent",
        ...(e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
      });
      ids.push(entry.id);
    }
    return ids;
  } finally {
    store.close();
  }
}
