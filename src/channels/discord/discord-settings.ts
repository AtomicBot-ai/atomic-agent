/**
 * Persistence for the Discord channel's settings.
 *
 * Same split as Telegram: the bot token lives in `<stateDir>/.env`
 * (0600) and never in `config.json`, which carries only the kill
 * switch and the owner id.
 */

import {
  ensureUserConfigFileSync,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../../config/index.js";
import { setDotenvKey } from "../../config/dotenv-writer.js";
import type { SetDotenvKeyResult } from "../../config/dotenv-writer.js";
import { DISCORD_BOT_TOKEN_KEY } from "./discord-channel-types.js";

export interface DiscordSettingsPaths {
  stateDir: string;
  userConfigFile: string;
}

export interface DiscordSettingsPatch {
  enabled?: boolean;
  ownerUserId?: string | null;
}

/** Merge `patch` into `config.discord` and invalidate the config cache. */
export function writeDiscordSettings(
  paths: DiscordSettingsPaths,
  patch: DiscordSettingsPatch,
): void {
  const prev = ensureUserConfigFileSync(paths.userConfigFile);
  const draft = {
    ...prev,
    discord: {
      ...prev.discord,
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.ownerUserId === undefined
        ? {}
        : { ownerUserId: patch.ownerUserId }),
    },
  };
  writeUserConfigFileSync(paths.userConfigFile, parseUserConfigFile(draft));
  resetConfigCache();
}

/**
 * Persist (or remove) the bot token, mirroring it into `process.env`
 * so a subsequent `start()` resolves the new value without a full
 * process restart. Never logs the token.
 */
export function writeDiscordToken(
  paths: DiscordSettingsPaths,
  token: string | null,
): SetDotenvKeyResult {
  const result = setDotenvKey(paths.stateDir, DISCORD_BOT_TOKEN_KEY, token);
  if (token === null) delete process.env[DISCORD_BOT_TOKEN_KEY];
  else process.env[DISCORD_BOT_TOKEN_KEY] = token;
  return result;
}
