import { ConfigValidationError } from "./config-validation-error.js";
import { parseBool } from "./config-primitives.js";

/**
 * Settings for one chat channel beyond the built-in Telegram and Discord
 * blocks (Slack, Signal, Matrix, iMessage, ...), keyed by the channel id
 * under the top-level `channels` block of `config.json`:
 *
 * ```json
 * { "channels": { "slack": { "enabled": true, "ownerIds": ["U0123"],
 *                            "options": { "threadReplies": true } } } }
 * ```
 *
 * One generic shape on purpose: adding a messenger must not need a new
 * config version, a new parser or a new `load-config` mapping. Each
 * adapter reads its own `options` and validates them itself.
 *
 * Secrets (bot tokens, app tokens, passwords) are **never** stored here:
 * they live in `<stateDir>/.env`, the same as `TELEGRAM_BOT_TOKEN` and
 * `DISCORD_BOT_TOKEN`, and adapters read them from the environment.
 *
 * Unversioned, additive: a file without `channels` reads as `{}`, which
 * starts nothing.
 */
export interface ExtraChannelConfig {
  /** Master kill switch. Off by default: an unconfigured channel never connects. */
  enabled: boolean;
  /**
   * Platform ids of every permitted operator, as strings (Slack member
   * ids, phone numbers, Matrix ids). Empty means unpaired: the channel
   * must refuse every inbound message until one is set.
   */
  ownerIds: string[];
  /** Adapter-specific flat settings. Values are scalars only. */
  options: Record<string, string | number | boolean>;
}

/** Ids a channel may use: lower-case letters, digits and dashes. */
const CHANNEL_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** The built-in channels keep their own blocks; `channels.<id>` must not shadow them. */
const RESERVED_IDS: ReadonlySet<string> = new Set(["telegram", "discord", "swarm"]);

export function isValidExtraChannelId(id: string): boolean {
  return CHANNEL_ID_RE.test(id) && !RESERVED_IDS.has(id);
}

export function createExtraChannelDefaults(): ExtraChannelConfig {
  return { enabled: false, ownerIds: [], options: {} };
}

function parseOwnerIds(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(field, "must be an array of strings");
  }
  const out: string[] = [];
  for (const [i, value] of raw.entries()) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ConfigValidationError(`${field}[${i}]`, "must be a non-empty string");
    }
    const trimmed = value.trim();
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function parseOptions(
  raw: unknown,
  field: string,
): Record<string, string | number | boolean> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "must be an object");
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value))
    ) {
      throw new ConfigValidationError(
        `${field}.${key}`,
        "must be a string, a finite number or a boolean",
      );
    }
    out[key] = value;
  }
  return out;
}

export function parseExtraChannelConfig(
  raw: unknown,
  field: string,
): ExtraChannelConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "must be an object");
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: parseBool(obj.enabled ?? false, `${field}.enabled`),
    ownerIds: parseOwnerIds(obj.ownerIds, `${field}.ownerIds`),
    options: parseOptions(obj.options, `${field}.options`),
  };
}

/** Parse the whole `channels` block. Missing reads as `{}`. */
export function parseExtraChannelsConfig(
  raw: unknown,
  field = "channels",
): Record<string, ExtraChannelConfig> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "must be an object keyed by channel id");
  }
  const out: Record<string, ExtraChannelConfig> = {};
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidExtraChannelId(id)) {
      throw new ConfigValidationError(
        `${field}.${id}`,
        "channel id must be lower-case letters, digits or dashes and not telegram, discord or swarm",
      );
    }
    out[id] = parseExtraChannelConfig(entry, `${field}.${id}`);
  }
  return out;
}

/** Deep copy, so a runtime config never aliases the parsed user file. */
export function cloneExtraChannelsConfig(
  channels: Record<string, ExtraChannelConfig>,
): Record<string, ExtraChannelConfig> {
  const out: Record<string, ExtraChannelConfig> = {};
  for (const [id, c] of Object.entries(channels)) {
    out[id] = { enabled: c.enabled, ownerIds: [...c.ownerIds], options: { ...c.options } };
  }
  return out;
}
