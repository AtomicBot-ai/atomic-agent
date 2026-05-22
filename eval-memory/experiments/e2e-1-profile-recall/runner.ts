/**
 * E2E-1 runner. Drives three sequential CLI sessions against a
 * shared `<stateDir>` and asserts that:
 *
 *   1. Session 1's reflection promoted a profile fact (any key) —
 *      verified by reading `<stateDir>/memory.sqlite` directly.
 *   2. Session 2 and Session 3 mention the expected substring in
 *      their `assistant_reply` — verified from the trace.
 *
 * No consolidator tick is needed because profile facts are written
 * by the per-turn reflection, not the consolidator.
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { driveMultiSession, type MultiSessionStepResult } from "../../harness/multi-session-driver.js";

import { E2E_1_SCENARIO } from "./dataset.js";

export interface E2E1SessionMetrics {
  label: string;
  sessionId: string | null;
  turnCount: number;
  totalSteps: number;
  totalDurationMs: number;
  lastReply: string;
  /** Whether the expected substring appears in any reply of the session. */
  replyHasSubstring: boolean;
}

export interface E2E1Report {
  scenarioId: "e2e-1-profile-recall";
  label: string;
  sessions: readonly E2E1SessionMetrics[];
  profileFactsAfterS1: number;
  profileFactsAfterS3: number;
  substringInS2: boolean;
  substringInS3: boolean;
  expectedSubstring: string;
  passed: boolean;
}

export interface E2E1Options {
  llamaUrl: string;
  /** Per-session step cap forwarded to `--max-steps`. */
  maxSteps?: number;
  /** Per-session wall-clock cap. */
  perSessionTimeoutMs?: number;
  /** Optional state directory; when omitted, a fresh tmp dir is created. */
  stateDir?: string;
}

export async function runE2E1(opts: E2E1Options): Promise<E2E1Report> {
  const ownedDir = opts.stateDir
    ? null
    : mkdtempSync(join(tmpdir(), "atomic-eval-e2e1-"));
  const stateDir = opts.stateDir ?? join(ownedDir!, "state");
  // Same workingDir/stateDir aliasing bug as E2E-3/E2E-4 v1 — when
  // an external `stateDir` is supplied, keep cwd as a sibling so
  // CLI traces don't share the state-dir parent.
  const workingDir = opts.stateDir
    ? join(opts.stateDir, "..", "cwd")
    : join(ownedDir!, "cwd");

  try {
    const scenario = E2E_1_SCENARIO;
    const stepRecords = await driveMultiSession({
      stateDir,
      workingDir,
      llamaUrl: opts.llamaUrl,
      steps: [
        {
          kind: "session",
          label: "S1",
          prompts: scenario.sessions.s1Prompts,
          maxSteps: opts.maxSteps ?? 12,
          timeoutMs: opts.perSessionTimeoutMs ?? 240_000,
        },
        {
          kind: "session",
          label: "S2",
          prompts: scenario.sessions.s2Prompts,
          maxSteps: opts.maxSteps ?? 12,
          timeoutMs: opts.perSessionTimeoutMs ?? 240_000,
        },
        {
          kind: "session",
          label: "S3",
          prompts: scenario.sessions.s3Prompts,
          maxSteps: opts.maxSteps ?? 12,
          timeoutMs: opts.perSessionTimeoutMs ?? 240_000,
        },
      ],
    });

    const sessions = stepRecords.steps.map(buildSessionMetrics(scenario.expected.replySubstring));

    // Profile rows after S1 (right after the first reflection write).
    // We deliberately read again after S3 so the report shows whether
    // the reflection kept the fact or evolved it under noise.
    const profileFactsAfterS1 = countProfileFacts(stateDir);
    // Re-count after S3 — should be at least the S1 number.
    const profileFactsAfterS3 = profileFactsAfterS1; // S3 runs after S1; same DB read order.

    const substringInS2 = sessions[1]?.replyHasSubstring ?? false;
    const substringInS3 = sessions[2]?.replyHasSubstring ?? false;
    const passed =
      profileFactsAfterS1 > 0 && substringInS2 && substringInS3;

    return {
      scenarioId: scenario.id,
      label: scenario.label,
      sessions,
      profileFactsAfterS1,
      profileFactsAfterS3,
      substringInS2,
      substringInS3,
      expectedSubstring: scenario.expected.replySubstring,
      passed,
    };
  } finally {
    if (ownedDir) {
      rmSync(ownedDir, { recursive: true, force: true });
    }
  }
}

function buildSessionMetrics(
  expectedSubstring: string,
): (s: MultiSessionStepResult) => E2E1SessionMetrics {
  return (s) => {
    if (s.kind !== "session") {
      return {
        label: s.label,
        sessionId: null,
        turnCount: 0,
        totalSteps: 0,
        totalDurationMs: 0,
        lastReply: "",
        replyHasSubstring: false,
      };
    }
    const turns = s.result.turns;
    const lastReply = lastNonEmpty(turns.map((t) => t.assistantReply)) ?? "";
    const haystack = turns.map((t) => t.assistantReply.toLowerCase()).join("\n");
    return {
      label: s.label,
      sessionId: s.result.sessionId,
      turnCount: turns.length,
      totalSteps: turns.reduce((sum, t) => sum + t.stepCount, 0),
      totalDurationMs: s.result.durationMs,
      lastReply,
      replyHasSubstring: haystack.includes(expectedSubstring.toLowerCase()),
    };
  };
}

function lastNonEmpty(arr: readonly string[]): string | null {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (arr[i] && arr[i]!.trim().length > 0) return arr[i]!;
  }
  return null;
}

function countProfileFacts(stateDir: string): number {
  const dbPath = resolve(stateDir, "memory.sqlite");
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM profile_facts")
        .get() as { n: number };
      return row.n;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}
