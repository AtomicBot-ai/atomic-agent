/**
 * Persistence for swarm units.
 *
 * Same split as the primary channels: the unit list (ids, labels, roles,
 * owners, kill switches) lives in `config.json` under `swarm.units`; each
 * unit's bot token lives in `<stateDir>/.env` under the unit's own
 * `tokenEnv` key (0600) and never in config.
 */

import {
  ensureUserConfigFileSync,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
  type SwarmUnitConfig,
} from "../../config/index.js";
import { setDotenvKey } from "../../config/dotenv-writer.js";
import type { SetDotenvKeyResult } from "../../config/dotenv-writer.js";

export interface SwarmSettingsPaths {
  stateDir: string;
  userConfigFile: string;
}

/** Replace `swarm.units` wholesale and invalidate the config cache. */
export function writeSwarmUnits(
  paths: SwarmSettingsPaths,
  units: readonly SwarmUnitConfig[],
): void {
  const prev = ensureUserConfigFileSync(paths.userConfigFile);
  const draft = {
    ...prev,
    swarm: { ...prev.swarm, units: units.map((u) => ({ ...u })) },
  };
  writeUserConfigFileSync(paths.userConfigFile, parseUserConfigFile(draft));
  resetConfigCache();
}

/**
 * Persist (or remove) one unit's bot token under its own `.env` key,
 * mirroring it into `process.env` so the unit's channel resolves the
 * new value on its next `start()` without a process restart. Never
 * logs the value.
 */
export function writeSwarmUnitToken(
  paths: SwarmSettingsPaths,
  tokenEnv: string,
  token: string | null,
): SetDotenvKeyResult {
  const result = setDotenvKey(paths.stateDir, tokenEnv, token);
  if (token === null) delete process.env[tokenEnv];
  else process.env[tokenEnv] = token;
  return result;
}

/** The token for `tokenEnv` as the runtime currently sees it. */
export function readSwarmUnitToken(
  tokenEnv: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[tokenEnv];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const ID_CHARS = /[^a-z0-9]+/g;

/**
 * A config-safe id from a label: `Ops Bot` → `ops-bot`, made unique
 * against `taken` with a numeric suffix.
 */
export function slugForUnit(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(ID_CHARS, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "bot";
  const root = /^[a-z0-9]/.test(base) ? base : `b-${base}`;
  if (!taken.has(root)) return root;
  for (let i = 2; ; i += 1) {
    const candidate = `${root}-${i}`.slice(0, 32);
    if (!taken.has(candidate)) return candidate;
  }
}

/** `.env` key for a unit's token: `TELEGRAM_BOT_TOKEN_OPS_BOT`. */
export function tokenEnvForUnit(
  kind: "telegram" | "discord",
  id: string,
): string {
  return `${kind.toUpperCase()}_BOT_TOKEN_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}
