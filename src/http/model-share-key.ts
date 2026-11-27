import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { restrictWindowsAcl } from "../config/windows-acl.js";
import { ensureSecretKeyFile, readSecretKeyFile } from "../local-llm/server/managed-api-key.js";

/**
 * ATO-2336: the key another app or device sends to use the local model
 * through `serve`'s `/raw/v1` routes (route-raw-model.ts).
 *
 * It is its own key, apart from the serve API key and the named tokens:
 * the share key reaches the bare model only, never the agent, its tools or
 * its settings, and the agent's keys are not accepted on the raw routes.
 * Handing it to a phone or a second laptop therefore never hands out the
 * agent.
 *
 * Kept in `<stateDir>/model-share.key`, owner-only (0600, a restricted ACL
 * on Windows), written by the same code as the serve key and the managed
 * llama-server key (`ensureSecretKeyFile`), and listed among the state
 * secrets (`getStateSecretPaths`), so an agent tool that reads it asks.
 */

export const MODEL_SHARE_KEY_FILE = "model-share.key";

/** Where the share key lives. */
export function modelShareKeyPath(stateDir: string): string {
  return join(stateDir, MODEL_SHARE_KEY_FILE);
}

/** The share key, or `null` when none was made yet (or it is unreadable). */
export function readModelShareKey(stateDir: string): string | null {
  return readSecretKeyFile(modelShareKeyPath(stateDir));
}

/** The share key, generated on first use; `null` when it can be neither read nor written. */
export function ensureModelShareKey(stateDir: string): string | null {
  return ensureSecretKeyFile(modelShareKeyPath(stateDir));
}

/**
 * Replace the share key with a fresh one, so every app that held the old
 * one gets 401 from its next request. The new key is written to a private
 * temp file and renamed over the old, so a reader sees either key whole.
 * `null` when the state dir cannot be written; the old key then stays.
 */
export function rotateModelShareKey(stateDir: string): string | null {
  const path = modelShareKeyPath(stateDir);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${randomBytes(32).toString("hex")}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    restrictWindowsAcl(tmp);
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* never written */
    }
    return null;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on Windows */
  }
  return readModelShareKey(stateDir);
}
