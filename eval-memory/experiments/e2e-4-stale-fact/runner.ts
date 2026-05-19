/**
 * E2E-4 runner. Three sessions, no consolidator tick (profile facts
 * are written by reflection at end-of-turn, not by the consolidator).
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { driveMultiSession, type MultiSessionStepResult } from "../../harness/multi-session-driver.js";

import { E2E_4_SCENARIO } from "./dataset.js";

export interface E2E4SessionMetrics {
  label: string;
  sessionId: string | null;
  turnCount: number;
  totalSteps: number;
  totalDurationMs: number;
  lastReply: string;
}

export interface E2E4Report {
  scenarioId: "e2e-4-stale-fact";
  label: string;
  sessions: readonly E2E4SessionMetrics[];
  profileRowsAfterS2: ReadonlyArray<{ key: string; value: string }>;
  /** True when at least one profile_facts row VALUE contains any new substring. */
  profileHoldsNewValue: boolean;
  /** True when NO profile_facts row VALUE contains any stale substring. */
  profileFreeOfStale: boolean;
  /** True when S3 reply contains any new substring AND no stale substring. */
  s3ReplyMentionsNewOnly: boolean;
  newValueSubstrings: readonly string[];
  staleSubstrings: readonly string[];
  s3Reply: string;
  passed: boolean;
}

export interface E2E4Options {
  llamaUrl: string;
  maxSteps?: number;
  perSessionTimeoutMs?: number;
  stateDir?: string;
}

export async function runE2E4(opts: E2E4Options): Promise<E2E4Report> {
  const ownedDir = opts.stateDir
    ? null
    : mkdtempSync(join(tmpdir(), "atomic-eval-e2e4-"));
  const stateDir = opts.stateDir ?? join(ownedDir!, "state");
  const workingDir = opts.stateDir ?? join(ownedDir!, "cwd");
  const scenario = E2E_4_SCENARIO;

  try {
    const report = await driveMultiSession({
      stateDir,
      workingDir,
      llamaUrl: opts.llamaUrl,
      steps: [
        {
          kind: "session",
          label: "S1",
          prompts: scenario.sessions.s1Prompts,
          maxSteps: opts.maxSteps ?? 8,
          timeoutMs: opts.perSessionTimeoutMs ?? 240_000,
        },
        {
          kind: "session",
          label: "S2",
          prompts: scenario.sessions.s2Prompts,
          maxSteps: opts.maxSteps ?? 8,
          timeoutMs: opts.perSessionTimeoutMs ?? 240_000,
        },
        {
          kind: "session",
          label: "S3",
          prompts: scenario.sessions.s3Prompts,
          maxSteps: opts.maxSteps ?? 8,
          timeoutMs: opts.perSessionTimeoutMs ?? 240_000,
        },
      ],
    });

    const sessions = report.steps
      .filter((s) => s.kind === "session")
      .map(toSessionMetrics);

    const profileRows = readProfileRows(stateDir);
    const profileHoldsNewValue = scenario.newValueSubstrings.some((sub) =>
      profileRows.some((r) => r.value.toLowerCase().includes(sub.toLowerCase())),
    );
    const profileFreeOfStale = !scenario.staleSubstrings.some((sub) =>
      profileRows.some((r) => r.value.toLowerCase().includes(sub.toLowerCase())),
    );

    const s3Reply = (sessions.find((s) => s.label === "S3")?.lastReply ?? "").toLowerCase();
    const s3HasNew = scenario.newValueSubstrings.some((sub) => s3Reply.includes(sub.toLowerCase()));
    const s3HasStale = scenario.staleSubstrings.some((sub) => s3Reply.includes(sub.toLowerCase()));
    const s3ReplyMentionsNewOnly = s3HasNew && !s3HasStale;

    return {
      scenarioId: scenario.id,
      label: scenario.label,
      sessions,
      profileRowsAfterS2: profileRows,
      profileHoldsNewValue,
      profileFreeOfStale,
      s3ReplyMentionsNewOnly,
      newValueSubstrings: scenario.newValueSubstrings,
      staleSubstrings: scenario.staleSubstrings,
      s3Reply: sessions.find((s) => s.label === "S3")?.lastReply ?? "",
      passed: profileHoldsNewValue && profileFreeOfStale && s3ReplyMentionsNewOnly,
    };
  } finally {
    if (ownedDir) rmSync(ownedDir, { recursive: true, force: true });
  }
}

function toSessionMetrics(s: MultiSessionStepResult): E2E4SessionMetrics {
  if (s.kind !== "session") {
    return {
      label: s.label,
      sessionId: null,
      turnCount: 0,
      totalSteps: 0,
      totalDurationMs: 0,
      lastReply: "",
    };
  }
  const turns = s.result.turns;
  const lastReply = (() => {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const r = turns[i]?.assistantReply ?? "";
      if (r.trim().length > 0) return r;
    }
    return "";
  })();
  return {
    label: s.label,
    sessionId: s.result.sessionId,
    turnCount: turns.length,
    totalSteps: turns.reduce((sum, t) => sum + t.stepCount, 0),
    totalDurationMs: s.result.durationMs,
    lastReply,
  };
}

function readProfileRows(stateDir: string): ReadonlyArray<{ key: string; value: string }> {
  const dbPath = resolve(stateDir, "memory.sqlite");
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare("SELECT key, value FROM profile_facts")
        .all() as Array<{ key: string; value: string }>;
      return rows;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
