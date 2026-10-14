/**
 * ATO-416 (C16) — a terminal user opening the desktop for the first time.
 *
 * The desktop now runs on the terminal agent's own directory (state-dir.ts),
 * so a person who already set Atomic Agent up in the terminal opens the
 * desktop onto a config.json that exists and an onboarding the terminal
 * finished. The full setup wizard would ask them to do it all again; nothing
 * at all would leave them wondering where the chats in the sidebar came from.
 * So the window says it once, in the chat area, in plain words (renderer.js
 * sharedSetupNoticeShow), and does not open the wizard.
 *
 * WHEN, exactly: all of
 *   - the directory is the terminal's (a desktop pointed at a directory of
 *     its own has nothing to explain);
 *   - config.json was already there before this launch could write one
 *     (state-dir-boot.ts DESKTOP_STATE_WAS_FRESH is false: on a fresh
 *     directory the wizard is the right answer);
 *   - its `tui.onboarding.completedAt` is set (the agent's own "setup is
 *     done" stamp; a skipped or half-done setup is not "already set up");
 *   - this desktop never ran on this directory before. That is a record in
 *     Electron's userData, not in config.json: the agent's schema would drop
 *     a key it does not know, and the question is about THIS app on THIS
 *     machine. Every launch writes it, so a desktop that ran its own wizard
 *     here last time is never told the terminal set it up.
 *
 * Known and accepted: a desktop from before ATO-416 has no record yet, so an
 * operator upgrading with a finished terminal setup sees the notice once
 * too. For them it is the news: the desktop's chats and settings are the
 * terminal's from this release on.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The words, said once. No dashes (ATO-305). */
export const SHARED_SETUP_NOTICE =
  "Atomic Agent on this computer is already set up. The desktop app uses the same chats, memory, skills and settings as the terminal.";

/** Where the record lives, inside Electron's userData. */
export function stateDirsRecordPath(userData: string): string {
  return join(userData, "state-dirs.json");
}

/** The state directories this desktop has run on, as recorded. Empty when there is no record. */
export function readStateDirsRecord(file: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { dirs?: unknown };
    return Array.isArray(raw.dirs) ? raw.dirs.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

/** Add `stateDir` to the record. Best effort: a record that cannot be written shows the notice once more, nothing worse. */
export function recordStateDirRun(file: string, stateDir: string): void {
  const dirs = readStateDirsRecord(file);
  if (dirs.includes(stateDir)) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ dirs: [...dirs, stateDir].slice(-20) }));
  } catch {
    // see above
  }
}

/** Whether the config's own onboarding says setup was finished. */
export function onboardingCompleted(config: unknown): boolean {
  const ob = (config as { tui?: { onboarding?: { completedAt?: unknown } } } | null)?.tui?.onboarding;
  return typeof ob?.completedAt === "string" && ob.completedAt.length > 0;
}

/** The rule above, pure. */
export function sharedSetupNoticeDue(input: {
  shared: boolean;
  fresh: boolean;
  config: unknown;
  ranHereBefore: boolean;
}): boolean {
  return input.shared && !input.fresh && !input.ranHereBefore && onboardingCompleted(input.config);
}

/** config.json as it is on disk, or null. Read straight from the file: no `atag` process at boot. */
export function readConfigFile(stateDir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));
  } catch {
    return null;
  }
}
