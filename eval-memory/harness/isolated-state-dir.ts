/**
 * Per-profile isolated `<stateDir>` helper for the benchmark campaign.
 *
 * Every campaign run must start from a clean SQLite (`memory.sqlite`,
 * `sessions.sqlite`, `tasks.sqlite`), clean traces folder, and a
 * fresh `config.json` materialised from the chosen
 * `CampaignProfileName`. Sharing a `<stateDir>` between two profiles
 * — even by accident — would leak profile facts / notes / lessons
 * across runs and silently invalidate the comparison.
 *
 * `withIsolatedStateDir({ profile }, run)` provides the ergonomic
 * harness:
 *
 *  1. Create an empty temporary directory.
 *  2. Materialise the campaign profile's `config.json` into it.
 *  3. Run the callback with the resolved path.
 *  4. Optionally `rm -rf` the directory after the callback returns.
 *
 * The directory layout matches what the agent expects to find under
 * `ATOMIC_AGENT_STATE_DIR` so `multi-turn-driver.ts` can be invoked
 * unchanged.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  seedCampaignConfigJson,
  type CampaignConfigOptions,
  type CampaignProfileName,
} from "../config/campaign-profiles.js";

export interface IsolatedStateDirOptions {
  profile: CampaignProfileName;
  /**
   * Options forwarded to `seedCampaignConfigJson`. `llamaUrl` is
   * mandatory; everything else is profile-default.
   */
  configOptions: CampaignConfigOptions;
  /**
   * Slug used in the temp directory name to make `ls /tmp` more
   * readable across many parallel campaign runs. Defaults to
   * `profile`. Sanitised to `[a-z0-9_-]`.
   */
  label?: string;
  /**
   * When `true`, the directory is deleted on callback completion
   * (including throws). Defaults to `true`. Set to `false` to keep
   * the state around for post-mortem inspection (e.g. opening
   * `memory.sqlite` after a failed run).
   */
  cleanup?: boolean;
}

export interface IsolatedStateDirHandle {
  /** Absolute path to the temp directory (set into ATOMIC_AGENT_STATE_DIR). */
  stateDir: string;
  /**
   * Best-effort cleanup. Idempotent. Always safe to call from
   * `try/finally` blocks even when `cleanup: false` was passed at
   * setup time.
   */
  dispose: () => void;
}

function sanitizeSlug(label: string): string {
  return label.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase().slice(0, 32);
}

/**
 * Synchronous setup — returns a handle the caller is responsible for
 * disposing. Useful for vitest `beforeEach` / `afterEach` lifecycles
 * where a callback wrapper would be awkward.
 */
export function setupIsolatedStateDir(
  opts: IsolatedStateDirOptions,
): IsolatedStateDirHandle {
  const slug = sanitizeSlug(opts.label ?? opts.profile);
  const stateDir = mkdtempSync(join(tmpdir(), `atomic-eval-${slug}-`));
  seedCampaignConfigJson(stateDir, opts.profile, opts.configOptions);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (opts.cleanup === false) return;
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // best-effort — leftover temp dirs are harmless and the OS GCs
      // them on reboot anyway.
    }
  };
  return { stateDir, dispose };
}

/**
 * Callback-style wrapper. Resolves with whatever the callback returns
 * and guarantees cleanup. Throws are re-raised after cleanup.
 */
export async function withIsolatedStateDir<T>(
  opts: IsolatedStateDirOptions,
  run: (handle: IsolatedStateDirHandle) => Promise<T> | T,
): Promise<T> {
  const handle = setupIsolatedStateDir(opts);
  try {
    return await run(handle);
  } finally {
    handle.dispose();
  }
}
