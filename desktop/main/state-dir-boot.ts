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
 *   4. On a fresh directory only, shares the model WEIGHTS with the
 *      terminal agent by symlinking one subdirectory, and COPIES the
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
 */

import { cpSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { DESKTOP_STATE_DIR, TUI_STATE_DIR } from "./state-dir.js";

process.env.ATOMIC_AGENT_STATE_DIR = DESKTOP_STATE_DIR;

/** Was this a genuine first run? Latched before anything can write. */
export const DESKTOP_STATE_WAS_FRESH = !existsSync(join(DESKTOP_STATE_DIR, "config.json"));

try {
  mkdirSync(DESKTOP_STATE_DIR, { recursive: true, mode: 0o700 });
} catch {
  // A directory that cannot be created is reported by the first CLI call
  // that needs it; failing to boot the window would say less.
}

/** `<stateDir>/models` — paths.localModelsDataDir with no dataDirOverride. */
const desktopDataDir = join(DESKTOP_STATE_DIR, "models");
const tuiDataDir = join(TUI_STATE_DIR, "models");

if (DESKTOP_STATE_WAS_FRESH && DESKTOP_STATE_DIR !== TUI_STATE_DIR && existsSync(tuiDataDir)) {
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
