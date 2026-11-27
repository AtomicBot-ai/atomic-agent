import { getConfig, readUserConfigFileSync, resetConfigCache } from "../config/index.js";
import { ensureUserConfigFileSync, writeUserConfigFileSync } from "../config/config-file.js";
import type { UserConfigFile } from "../config/config-schema.js";
import type { UserManagedLocalLlmConfig } from "../config/local-models/local-models-types.js";

/**
 * ATO-2483: where the shared model (ATO-2336, route-raw-model.ts) can be
 * reached, as one of three choices, the way LM Studio's "Serve on Local
 * Network" and Ollama's "Expose" switch put it:
 *
 *   off      `localModels.managed.share` false: `/raw/v1` answers 404.
 *   local    on, the share listener on 127.0.0.1 (other apps on this computer).
 *   network  on, the share listener on 0.0.0.0 (other devices too, plain http).
 *
 * Network is never the default and never kept across an off: turning
 * sharing off removes `shareNetwork`, so every network exposure is an
 * explicit choice made that time.
 */

export type ModelShareMode = "off" | "local" | "network";

export const MODEL_SHARE_MODES: readonly ModelShareMode[] = ["off", "local", "network"];

/** serve's own default port (cli/serve-args.ts), so terminal and desktop name the same address. */
export const DEFAULT_MODEL_SHARE_PORT = 8787;

export interface ModelShareSettings {
  mode: ModelShareMode;
  port: number;
}

export function isModelShareMode(value: unknown): value is ModelShareMode {
  return typeof value === "string" && (MODEL_SHARE_MODES as readonly string[]).includes(value);
}

type ShareFields = Pick<UserManagedLocalLlmConfig, "share" | "shareNetwork" | "sharePort">;

export function modelShareSettingsOf(managed: Partial<ShareFields> | undefined): ModelShareSettings {
  const mode: ModelShareMode = managed?.share !== true ? "off" : managed.shareNetwork === true ? "network" : "local";
  return { mode, port: managed?.sharePort ?? DEFAULT_MODEL_SHARE_PORT };
}

/**
 * From the config file, not the process cache, as `isModelShareEnabled`
 * does: `atomic-agent models share` in another terminal changes it under a
 * running serve. A file that cannot be read reads as off.
 */
export function readModelShareSettings(path: string = getConfig().paths.userConfigFile): ModelShareSettings {
  try {
    return modelShareSettingsOf(readUserConfigFileSync(path)?.localModels.managed);
  } catch {
    return { mode: "off", port: DEFAULT_MODEL_SHARE_PORT };
  }
}

/** `managed` with the share fields of `mode`; `shareNetwork` only while it is `network`. */
export function managedWithShareMode<T extends ShareFields>(managed: T, mode: ModelShareMode): T {
  const { shareNetwork: _dropped, ...rest } = managed;
  const next = { ...rest, share: mode !== "off" } as T;
  if (mode === "network") next.shareNetwork = true;
  return next;
}

/** Write `mode` to the config file; nothing is written when it already holds it. */
export function writeModelShareMode(path: string, mode: ModelShareMode): void {
  const user = ensureUserConfigFileSync(path);
  const managed = managedWithShareMode(user.localModels.managed, mode);
  const now = user.localModels.managed;
  if (now.share === managed.share && now.shareNetwork === managed.shareNetwork) return;
  const next: UserConfigFile = { ...user, localModels: { ...user.localModels, managed } };
  writeUserConfigFileSync(path, next);
  resetConfigCache();
}
