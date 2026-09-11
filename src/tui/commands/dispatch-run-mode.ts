import {
  FUSION_WORKERS_MAX,
  FUSION_WORKERS_MIN,
  RUN_MODE_NAMES,
  type RunModeName,
} from "../../config/index.js";

export interface RunModeCommand {
  /** Bare `/runmode`: open the composer's "Where it runs" switch. */
  readonly openSwitch: boolean;
  /** `/runmode local|cloud|fusion`. */
  readonly mode?: RunModeName;
  /** `/runmode status`. */
  readonly status?: boolean;
  /** `/runmode swap`: trade the orchestrator leg for the worker leg. */
  readonly swap?: boolean;
  /** `/runmode workers N`. */
  readonly workers?: number;
  /** Usage line for anything else. */
  readonly error?: string;
}

export const RUN_MODE_USAGE =
  "usage: /runmode (opens the switch) · /runmode local|cloud|fusion · /runmode swap · /runmode workers N · /runmode status";

/**
 * Parse the arguments of `/runmode`. Split out of
 * `slash-command-handler.ts`, which is far past its line budget, and
 * kept pure so the three routes to a run mode — this command, the
 * popup row and the `ctrl+g 1/2/3` chords — can be pinned to the same
 * outcome without a renderer.
 */
export function parseRunModeCommand(rawArgs: string): RunModeCommand {
  const args = rawArgs.trim().toLowerCase();
  if (args.length === 0) return { openSwitch: true };
  if (args === "status") return { openSwitch: false, status: true };
  if (args === "swap") return { openSwitch: false, swap: true };
  const workers = /^workers\s+(\d+)$/.exec(args);
  if (workers) {
    const n = Number(workers[1]);
    if (n < FUSION_WORKERS_MIN || n > FUSION_WORKERS_MAX) {
      return {
        openSwitch: false,
        error: `workers must be ${FUSION_WORKERS_MIN}-${FUSION_WORKERS_MAX} — ${RUN_MODE_USAGE}`,
      };
    }
    return { openSwitch: false, workers: n };
  }
  if (RUN_MODE_NAMES.includes(args as RunModeName)) {
    return { openSwitch: false, mode: args as RunModeName };
  }
  return {
    openSwitch: false,
    error: `unknown run mode "${rawArgs.trim()}" — ${RUN_MODE_USAGE}`,
  };
}
