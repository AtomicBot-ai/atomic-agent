import type { RunModeName } from "../../config/index.js";
import { RUN_MODES } from "../run-mode/run-mode-nav.js";

export interface RunModeCommand {
  /** Return to the Run section (what `/run` always did as a `/chat` alias). */
  returnToRun: boolean;
  /** Open the dial overlay (bare `/run`). */
  openPicker: boolean;
  mode?: RunModeName;
  cloudShare?: number;
  /** Usage line to echo instead of acting. */
  error?: string;
}

const USAGE = "usage: /run [local|cloud|fusion] [0-100]";

/**
 * Parse `/run [mode] [share]`.
 *
 * Bare `/run` keeps its historical behaviour — returning to the Run
 * section, which it had as an alias of `/chat` — and additionally opens
 * the mode picker. Keeping both means the alias's muscle memory still
 * works while the name now also owns the thing it is named after.
 *
 * Lives in its own module because `slash-command-handler.ts` is already
 * far past the 300-line budget.
 */
export function parseRunModeCommand(rawArgs: string): RunModeCommand {
  const [rawMode, rawShare, ...rest] = rawArgs
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (rawMode === undefined) {
    return { returnToRun: true, openPicker: true };
  }
  if (rest.length > 0) {
    return { returnToRun: false, openPicker: false, error: USAGE };
  }
  const mode = rawMode.toLowerCase();
  if (!RUN_MODES.includes(mode as RunModeName)) {
    return {
      returnToRun: false,
      openPicker: false,
      error: `unknown run mode ${JSON.stringify(rawMode)} — ${USAGE}`,
    };
  }
  if (rawShare === undefined) {
    return { returnToRun: true, openPicker: false, mode: mode as RunModeName };
  }
  const share = Number.parseInt(rawShare.replace(/%$/, ""), 10);
  if (!Number.isInteger(share) || share < 0 || share > 100) {
    return {
      returnToRun: false,
      openPicker: false,
      error: `cloud share must be an integer 0-100 — ${USAGE}`,
    };
  }
  return {
    returnToRun: true,
    openPicker: false,
    mode: mode as RunModeName,
    cloudShare: share,
  };
}
