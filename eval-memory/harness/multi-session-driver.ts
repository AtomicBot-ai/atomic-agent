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
import { join } from "node:path";

import { driveMultiTurn, type MultiTurnResult } from "./multi-turn-driver.js";
import {
  runConsolidatorTick,
  type ConsolidatorTickOutcome,
} from "./consolidator-tick.js";
import { seedConfigJson } from "./memory-profiles.js";

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
    };

export interface MultiSessionInput {
  workingDir: string;
  stateDir: string;
  /** llama-server URL — required when any step uses `consolidate`. */
  llamaUrl: string;
  steps: readonly MultiSessionStep[];
  env?: Readonly<Record<string, string>>;
}

export type MultiSessionStepResult =
  | { kind: "session"; label: string; result: MultiTurnResult }
  | { kind: "consolidate"; label: string; outcome: ConsolidatorTickOutcome };

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
  seedConfigJson(input.stateDir, "on", { llamaUrl: input.llamaUrl });

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
    const tickInput: Parameters<typeof runConsolidatorTick>[0] = {
      stateDir: input.stateDir,
      llamaUrl: input.llamaUrl,
      ...(step.withProcedure !== undefined ? { withProcedure: step.withProcedure } : {}),
      ...(step.minClusterSize !== undefined ? { minClusterSize: step.minClusterSize } : {}),
      ...(step.maxClustersPerTick !== undefined
        ? { maxClustersPerTick: step.maxClustersPerTick }
        : {}),
    };
    const outcome = await runConsolidatorTick(tickInput);
    steps.push({ kind: "consolidate", label: step.label, outcome });
  }
  return { stateDir: input.stateDir, workingDir: input.workingDir, steps };
}
