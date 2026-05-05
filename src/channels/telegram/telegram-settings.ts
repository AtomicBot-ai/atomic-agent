import {
  readUserConfigFileSync,
  USER_CONFIG_DEFAULTS,
  writeUserConfigFileSync,
  type TelegramParseMode,
  type UserConfigFile,
} from "../../config/index.js";
import { setDotenvKey, type SetDotenvKeyResult } from "../../config/dotenv-writer.js";

/**
 * Token-only environment variable. Lives in `<stateDir>/.env`, never
 * in user config — this matches the design memo's split between
 * "what the operator types" (config.json) and "what is secret" (.env).
 */
export const TELEGRAM_BOT_TOKEN_KEY = "TELEGRAM_BOT_TOKEN";

export interface TelegramSettingsPaths {
  /** Absolute path of the user config file (`<stateDir>/config.json`). */
  userConfigPath: string;
  /** State directory holding `<stateDir>/.env`. */
  stateDir: string;
}

export interface PersistedTelegramSettings {
  enabled: boolean;
  ownerUserId: number | null;
  parseMode: TelegramParseMode;
}

/**
 * Read the on-disk Telegram config block, falling back to defaults
 * when the file is missing. We intentionally do not migrate here —
 * the bootstrap path already migrated v8 → v9; live-control writes
 * always go through `parseUserConfigFile` (via
 * `readUserConfigFileSync`) so we end up writing a current-shape file.
 */
export function readTelegramSettings(
  paths: TelegramSettingsPaths,
): PersistedTelegramSettings {
  const file = readUserConfigFileSync(paths.userConfigPath);
  const block = file?.telegram ?? USER_CONFIG_DEFAULTS.telegram;
  return {
    enabled: block.enabled,
    ownerUserId: block.ownerUserId,
    parseMode: block.parseMode,
  };
}

/**
 * Persist a partial update to the `telegram` block of the user config
 * file. Atomic — defers to `writeUserConfigFileSync`. Returns the new
 * settings after merge so callers can update their in-memory mirror in
 * one round trip.
 */
export function writeTelegramSettings(
  paths: TelegramSettingsPaths,
  patch: Partial<PersistedTelegramSettings>,
): PersistedTelegramSettings {
  const current = readUserConfigFileSync(paths.userConfigPath);
  const base: UserConfigFile = current ?? USER_CONFIG_DEFAULTS;
  const next: UserConfigFile = {
    ...base,
    telegram: {
      ...base.telegram,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.ownerUserId !== undefined
        ? { ownerUserId: patch.ownerUserId }
        : {}),
      ...(patch.parseMode !== undefined ? { parseMode: patch.parseMode } : {}),
    },
  };
  writeUserConfigFileSync(paths.userConfigPath, next);
  return {
    enabled: next.telegram.enabled,
    ownerUserId: next.telegram.ownerUserId,
    parseMode: next.telegram.parseMode,
  };
}

/**
 * Persist (or remove) the bot token in `<stateDir>/.env`. Also
 * mirrors the value into `process.env.TELEGRAM_BOT_TOKEN` so any
 * subsequent `start()` that re-resolves the token via the env path
 * sees the new value without a full process restart.
 *
 * Never logs the token. The result object exposes only path / change
 * flags.
 */
export function writeTelegramToken(
  paths: TelegramSettingsPaths,
  token: string | null,
): SetDotenvKeyResult {
  const result = setDotenvKey(paths.stateDir, TELEGRAM_BOT_TOKEN_KEY, token);
  if (token === null) {
    delete process.env[TELEGRAM_BOT_TOKEN_KEY];
  } else {
    process.env[TELEGRAM_BOT_TOKEN_KEY] = token;
  }
  return result;
}
