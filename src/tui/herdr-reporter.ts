import { spawn } from "node:child_process";

import type { TuiState } from "./tui-state.js";

/**
 * Self-reported lifecycle status for the herdr agent runtime.
 *
 * herdr (github.com/herdrdev/herdr) keeps agents alive inside
 * background terminal panes and labels each pane with the agent's
 * state: working, blocked on a human, or idle. For agents it does not
 * recognise it falls back to scraping the bottom of the screen, and it
 * knows nothing about ours. When herdr launches a pane process it
 * injects a socket CLI into the environment, and a pane can claim its
 * own label through `pane report-agent`; a self-report is
 * authoritative, so no detection manifest is needed on their side.
 * That is the whole integration: tell herdr what we already know
 * about ourselves, and say goodbye on the way out so the pane does
 * not stay labelled after the process is gone.
 */

const SOURCE = "custom:atomic";
const AGENT_LABEL = "atomic";

export type HerdrAgentState = "working" | "blocked" | "idle";

export interface HerdrRuntimeEnv {
  binPath: string;
  paneId: string;
}

type SpawnFn = typeof spawn;

/**
 * The env triplet herdr injects into every pane process. All three
 * must be present: HERDR_ENV=1 is the flag, the other two are the
 * call ingredients, and a partial set means something nonstandard is
 * going on (a user exporting variables by hand), where staying quiet
 * is the safe answer.
 */
export function detectHerdrEnv(
  env: NodeJS.ProcessEnv = process.env,
): HerdrRuntimeEnv | null {
  if (env.HERDR_ENV !== "1") return null;
  const binPath = env.HERDR_BIN_PATH;
  const paneId = env.HERDR_PANE_ID;
  if (!binPath || !paneId) return null;
  return { binPath, paneId };
}

/**
 * Collapse the TUI state into herdr's three-state vocabulary.
 *
 * Approval and the plan hand-off both mean "a human must act before
 * anything moves", which is exactly what herdr renders as blocked, so
 * they win over `status`. "quitting" maps to idle on purpose: the
 * release call is what actually ends the story, and a dying pane
 * advertised as working reads as a stuck agent.
 */
export function deriveHerdrReport(
  state: Pick<TuiState, "status" | "pendingApproval" | "planHandoff">,
): { state: HerdrAgentState; message?: string } {
  if (state.pendingApproval) {
    return { state: "blocked", message: state.pendingApproval.tool };
  }
  if (state.planHandoff) {
    return { state: "blocked", message: "plan ready" };
  }
  if (state.status === "running") {
    return { state: "working" };
  }
  return { state: "idle" };
}

export class HerdrReporter {
  private seq: number;
  private lastKey: string | null = null;
  private released = false;

  constructor(
    private readonly env: HerdrRuntimeEnv,
    private readonly spawnFn: SpawnFn = spawn,
    now: () => number = Date.now,
  ) {
    // herdr keeps the highest sequence it has seen per pane and drops
    // anything at or below it, across process lifetimes. A counter
    // starting at zero would lose every report after the agent is
    // restarted in the same pane, so the epoch seconds are the floor:
    // strictly above any earlier run's numbers, comfortably inside
    // both i64 and i32, and bumped once per call within the process.
    this.seq = Math.floor(now() / 1000);
  }

  /**
   * Report a state change. Repeats of the same state+message pair are
   * dropped here so call sites can re-derive on every render without
   * spawning a process per keystroke; `--seq` keeps herdr from
   * applying two in-flight reports out of order.
   */
  report(state: HerdrAgentState, message?: string): void {
    if (this.released) return;
    const key = `${state}\u0000${message ?? ""}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.seq += 1;
    const args = [
      "pane",
      "report-agent",
      this.env.paneId,
      "--source",
      SOURCE,
      "--agent",
      AGENT_LABEL,
      "--state",
      state,
      "--seq",
      String(this.seq),
    ];
    if (message) {
      args.push("--message", message);
    }
    this.run(args);
  }

  /**
   * Hand the pane label back. Idempotent; reports after it are
   * dropped. The release must carry a sequence number above the last
   * report's or herdr silently drops it as stale (verified against
   * herdr 0.9.0), which would leave a dead pane labelled forever.
   */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.seq += 1;
    this.run([
      "pane",
      "release-agent",
      this.env.paneId,
      "--source",
      SOURCE,
      "--agent",
      AGENT_LABEL,
      "--seq",
      String(this.seq),
    ]);
  }

  /**
   * Fire-and-forget. herdr dying mid-session must never surface in
   * the TUI, so every failure path here ends in silence, and the
   * child is unref'd so a report in flight cannot hold our exit open.
   */
  private run(args: string[]): void {
    try {
      const child = this.spawnFn(this.env.binPath, args, {
        stdio: "ignore",
      });
      child.on("error", () => {});
      child.unref();
    } catch {
      // Reporting is a courtesy to the host, not a feature the user
      // asked for; a spawn failure is the host's problem, not ours.
    }
  }
}

export function createHerdrReporter(
  env: NodeJS.ProcessEnv = process.env,
  spawnFn: SpawnFn = spawn,
): HerdrReporter | null {
  const runtime = detectHerdrEnv(env);
  return runtime ? new HerdrReporter(runtime, spawnFn) : null;
}
