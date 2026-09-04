/**
 * r5 item 9 — the one side effect that makes the desktop's state directory
 * real, and the FIRST import in main.ts.
 *
 * Why its own module rather than three statements at the top of main.ts:
 * the desktop is CommonJS, and tsc hoists every `require` above the file's
 * own body — out/main/main.js has its requires first and its first
 * statement after all of them. An assignment written at the top of main.ts
 * would therefore run AFTER every imported module's side effects, not
 * before. `import "./state-dir-boot.js";` placed first is the only
 * ordering the emit preserves.
 *
 * What it does, in order:
 *   1. Publishes ATOMIC_AGENT_STATE_DIR into this process's environment, so
 *      plain inheritance is already correct for anything that forgets to
 *      pass `agentEnv()`.
 *   2. Latches whether the directory was fresh BEFORE anything can create
 *      it. `atag config get` and `atag serve` both write a default
 *      config.json into an empty directory, so a probe taken any later
 *      reads a directory that is no longer fresh — and the wizard would
 *      never open on a genuine first run.
 *   3. Creates it 0700 (it will hold .env).
 *   4. On a fresh directory that is the desktop's OWN (see the gate below),
 *      shares the model WEIGHTS with the terminal agent by symlinking one
 *      subdirectory, and COPIES the
 *      llama.cpp backend rather than linking it — `localModels.managed.
 *      autoUpdate` defaults to true and `atag models start` will replace
 *      `<dataDir>/backend`, which through a link would rewrite the
 *      operator's binaries. The pid file, the daemon log and the session
 *      registry all sit at the dataDir root and stay private, so the two
 *      daemons are independent; the desktop's managed port moves too
 *      (state-dir.ts DESKTOP_MANAGED_PORT).
 *
 * Known and accepted: the weights symlink is a two-way door — a later
 * `atag models pull` from the desktop writes into the terminal agent's
 * model folder, and `atag models remove` would delete from it. That is the
 * price of not downloading the same 3.2 GB twice, and it is the only path
 * by which anything the desktop runs touches ~/.atomic-agent. Config, keys
 * and the databases never do.
 *
 * WHICH IS WHY THE SEED IS GATED ON THE DIRECTORY BEING OURS — r5 review
 * fix (major). Step 4 used to run on ANY fresh directory, including one the
 * operator named through ATOMIC_AGENT_STATE_DIR precisely because it is
 * disposable (this repo's own instruction: "Run the suite with
 * ATOMIC_AGENT_STATE_DIR pointed somewhere disposable"). A lane or CI run
 * starting on an empty directory therefore had the operator's real weight
 * folder linked into it, and one `models remove` or re-pull from that
 * throwaway install would have written or deleted inside ~/.atomic-agent —
 * the exact tree this whole item exists to keep untouched, opened by the
 * module whose stated rule is that an explicit env var wins. The two-way
 * door is a bargain worth making for the desktop's OWN default directory,
 * where the operator installed this app on this Mac; it is not a bargain
 * anyone asked for on a directory they called disposable. So the seed runs
 * only when `!STATE_DIR_FROM_ENV`. The 0700 mkdir is NOT gated: every
 * directory needs it, because every one of them holds a .env.
 */

import { cpSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { DESKTOP_STATE_DIR, STATE_DIR_FROM_ENV, TUI_STATE_DIR } from "./state-dir.js";

process.env.ATOMIC_AGENT_STATE_DIR = DESKTOP_STATE_DIR;

/** Was this a genuine first run? Latched before anything can write. */
export const DESKTOP_STATE_WAS_FRESH = !existsSync(join(DESKTOP_STATE_DIR, "config.json"));

try {
  mkdirSync(DESKTOP_STATE_DIR, { recursive: true, mode: 0o700 });
} catch {
  // A directory that cannot be created is reported by the first CLI call
  // that needs it; failing to boot the window would say less.
}

/**
 * Step 4, lifted out of the module body so the suite can drive it — r5 review
 * fix (minor): everything gated on DESKTOP_STATE_WAS_FRESH had zero coverage,
 * because a lane run is never fresh. Exported, parameterised, and with no
 * reference to the two module constants, so a check can run it against a
 * throwaway pair of directories and assert what it produced: 0700, a SYMLINK
 * for the weights, a real COPY for the backend.
 *
 * `<dataDir>` is `<stateDir>/models` — paths.localModelsDataDir with no
 * dataDirOverride.
 */
export function seedFreshStateDir(desktopStateDir: string, tuiStateDir: string): void {
  try {
    // 0700 because it will hold .env. The module body above creates the
    // REAL directory unconditionally (a non-fresh launch must still have
    // one); this repeat is what makes the function stand alone, so a check
    // can run it against a throwaway path and read the mode back. mkdir
    // with `recursive` leaves an existing directory's mode alone, so
    // running it twice changes nothing.
    mkdirSync(desktopStateDir, { recursive: true, mode: 0o700 });
  } catch {
    // A directory that cannot be created is reported by the first CLI call
    // that needs it; failing to boot the window would say less.
  }
  const desktopDataDir = join(desktopStateDir, "models");
  const tuiDataDir = join(tuiStateDir, "models");
  if (desktopStateDir === tuiStateDir || !existsSync(tuiDataDir)) return;
  try {
    mkdirSync(desktopDataDir, { recursive: true });
    // The weights: shared, because they are gigabytes. `models/models` is
    // the only subdirectory that holds them (src/local-llm/backend-paths.ts).
    if (existsSync(join(tuiDataDir, "models")) && !existsSync(join(desktopDataDir, "models"))) {
      symlinkSync(join(tuiDataDir, "models"), join(desktopDataDir, "models"), "dir");
    }
    // The backend: copied, never linked — see the header.
    if (existsSync(join(tuiDataDir, "backend")) && !existsSync(join(desktopDataDir, "backend"))) {
      cpSync(join(tuiDataDir, "backend"), join(desktopDataDir, "backend"), { recursive: true });
    }
  } catch {
    // No weights to share is a slower first run, not a broken one: the
    // wizard's download step is still there.
  }
}

/**
 * The gate on step 4, as a pure function of its two inputs — written this way
 * so the suite can assert the whole truth table rather than the single cell
 * any one run happens to sit in. `fresh` says there was nothing here yet;
 * `fromEnv` says the environment NAMED this directory rather than it being
 * the desktop's own default. Only fresh-and-ours is seeded.
 */
export function shouldSeedFreshStateDir(fresh: boolean, fromEnv: boolean): boolean {
  return fresh && !fromEnv;
}

/** Did step 4 actually run, for this process? */
export const DESKTOP_STATE_SEEDED = shouldSeedFreshStateDir(DESKTOP_STATE_WAS_FRESH, STATE_DIR_FROM_ENV);

if (DESKTOP_STATE_SEEDED) seedFreshStateDir(DESKTOP_STATE_DIR, TUI_STATE_DIR);
