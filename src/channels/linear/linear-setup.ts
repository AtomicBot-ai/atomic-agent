/**
 * What the Linear setup wizard writes (ATO-2464), shared by
 * `atag connect linear` and the desktop's Connections tab.
 *
 * Secrets go through the agent's validated credential path
 * (`saveSecret`: `.env` by default, the OS keychain when the user chose
 * it), never into `config.json`. The channel block is a point edit of
 * `channels.linear` in the raw config tree, validated by the schema
 * before anything is written, so the rest of the file stays as it was.
 */

import {
  parseUserConfigFile,
  resetConfigCache,
  saveSecret,
  type SavedSecret,
} from "../../config/index.js";
import { readRawConfigTree, writeRawUserConfigFileSync } from "../../config/config-paths.js";
import type { LinearApi } from "./linear-api.js";
import type { LinearMode } from "./linear-types.js";

export interface LinearChannelSettings {
  enabled: boolean;
  ownerIds: string[];
  mode: LinearMode;
  /** Handles that address the agent, comma separated, without `@`. */
  mention?: string;
  pollSeconds?: number;
  port?: number;
  /** OAuth app client id, for refreshing an app token (`--app`). */
  oauthClientId?: string;
}

/** Linear user ids are uuids. */
export const LINEAR_USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Write `channels.linear`, keeping any option already there that this
 * call does not set. Throws `ConfigValidationError` and writes nothing
 * when the result does not validate.
 */
export function writeLinearChannelConfig(configPath: string, settings: LinearChannelSettings): void {
  const tree = readRawConfigTree(configPath);
  const channels = isObject(tree.channels) ? tree.channels : {};
  const prev = isObject(channels.linear) ? channels.linear : {};
  const prevOptions = isObject(prev.options) ? prev.options : {};
  const options: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(prevOptions)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") options[k] = v;
  }
  options.mode = settings.mode;
  if (settings.mention !== undefined) options.mention = settings.mention;
  if (settings.pollSeconds !== undefined) options.pollSeconds = settings.pollSeconds;
  if (settings.port !== undefined) options.port = settings.port;
  if (settings.oauthClientId !== undefined) options.oauthClientId = settings.oauthClientId;
  channels.linear = { ...prev, enabled: settings.enabled, ownerIds: [...settings.ownerIds], options };
  tree.channels = channels;
  parseUserConfigFile(tree);
  writeRawUserConfigFileSync(configPath, tree);
  resetConfigCache();
}

/** Turn the channel off, keeping its settings and saved keys. */
export function disableLinearChannel(configPath: string): boolean {
  const tree = readRawConfigTree(configPath);
  const channels = isObject(tree.channels) ? tree.channels : null;
  const prev = channels && isObject(channels.linear) ? channels.linear : null;
  if (!channels || !prev) return false;
  channels.linear = { ...prev, enabled: false };
  parseUserConfigFile(tree);
  writeRawUserConfigFileSync(configPath, tree);
  resetConfigCache();
  return true;
}

/** Save one Linear secret wherever the agent keeps keys. */
export function saveLinearSecret(stateDir: string, name: string, value: string | null): SavedSecret {
  return saveSecret(stateDir, name, value);
}

/** The Linear user with `email` in the key's workspace, or `null`. */
export async function findLinearUserByEmail(
  api: Pick<LinearApi, "query">,
  email: string,
): Promise<{ id: string; name: string } | null> {
  const data = (await api.query(
    "query AtomicAgentUserByEmail($email: String!) { users(filter: { email: { eq: $email } }) { nodes { id name } } }",
    { email: email.trim() },
  )) as { users?: { nodes?: Array<{ id?: unknown; name?: unknown }> } };
  const user = data.users?.nodes?.[0];
  if (typeof user?.id !== "string") return null;
  return { id: user.id, name: typeof user.name === "string" ? user.name : "" };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
