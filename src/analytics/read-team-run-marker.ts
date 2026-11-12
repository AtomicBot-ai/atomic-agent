import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * ATO-1247: our own machines and test runs (QA of a release, MBP checks,
 * benchmarks on Vast) are tagged so PostHog can leave them out of the
 * metrics without a hand-kept list of install ids.
 *
 * Two ways to say "this is us", either is enough:
 *   - `ATOMIC_AGENT_TEAM=1` (also true / yes / on) in the environment, for
 *     scripted runs (benchmarks, smoke, CI);
 *   - a file `~/.atomic-agent-team` (any content), created once on a team
 *     machine, so every later run there is tagged, the desktop app opened
 *     from Finder included.
 *
 * A tagged run still sends its events, with `test_run: true` on each and the
 * person property `atomic_team: true` (see AnalyticsClient). It is not an
 * opt-out: `ATOMIC_AGENT_ANALYTICS=off` stays the way to send nothing.
 */
export const TEAM_RUN_ENV = "ATOMIC_AGENT_TEAM";
export const TEAM_RUN_MARKER_FILE = ".atomic-agent-team";

const ON_VALUES = new Set(["1", "true", "yes", "on"]);

/** True when this run is ours: the env flag, or the marker file in the home directory. */
export function isTeamRun(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): boolean {
  const raw = env[TEAM_RUN_ENV];
  if (typeof raw === "string" && ON_VALUES.has(raw.trim().toLowerCase())) return true;
  try {
    return existsSync(join(home, TEAM_RUN_MARKER_FILE));
  } catch {
    return false;
  }
}
