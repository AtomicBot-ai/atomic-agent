import { ConfigValidationError } from "./config-validation-error.js";
import { parseBool, parseNonEmptyString } from "./config-primitives.js";
import { parseNullableString } from "./config-values.js";

/**
 * Telegram parse mode applied to *agent replies* on outbound. Slash
 * commands, failure messages, and approval keyboards always send as
 * plain text regardless of this setting (see README.md). MarkdownV2 is intentionally excluded —
 * the escape surface is too wide for typical LLM output.
 */
export type TelegramParseMode = "plain" | "html";

/**
 * Telegram channel configuration. Single-operator semantics: only
 * messages whose `from.id` matches `ownerUserId` are dispatched into
 * the agent loop. Group chats are dropped unconditionally.
 */
export interface TelegramConfig {
  /** Master kill switch. When `false`, the channel is constructed but never started. */
  enabled: boolean;
  /**
   * Numeric Telegram user id of the sole permitted operator. `null`
   * means "not configured yet" — the channel refuses to start until
   * an id is set (manually or via the slice-3 pairing flow).
   */
  ownerUserId: number | null;
  /**
   * Render mode for agent-driven outbound replies. Defaults to
   * `"html"` (markdown → Telegram HTML subset). Set `"plain"` to
   * disable formatting entirely — useful as an escape hatch if the
   * formatter ever misbehaves in the wild. Added in config v10;
   * older files transparently get `"html"` via the migration in
   * `parseUserConfigFile`.
   */
  parseMode: TelegramParseMode;
  /**
   * Live progress indicator in the Telegram channel: a single editable
   * "Thinking…" bubble that mirrors the turn's activity and deletes
   * itself when the reply lands. Enabled by default; `false` is the
   * kill switch if the always-on behavior surprises anyone in
   * production. Added in config v34; older files transparently get
   * `true` via the defaults-fallback in `parseUserConfigFile`.
   */
  progressIndicator: boolean;
}

/**
 * Discord remote-control channel. The bot relays DMs and @mentions to
 * the agent and posts replies back, the same shape as the Telegram
 * channel.
 *
 * As with `TelegramConfig`, the bot token is **not** stored here — it
 * lives in `<stateDir>/.env` as `DISCORD_BOT_TOKEN`. This block only
 * carries the kill switch and the single-operator owner id.
 */
export interface DiscordConfig {
  /** Master kill switch. `false` constructs the channel but never starts it. */
  enabled: boolean;
  /**
   * Discord snowflakes of every permitted operator. **Strings**, not
   * numbers: snowflakes exceed `Number.MAX_SAFE_INTEGER`, so parsing
   * one as a number silently corrupts the last digits and would let
   * the wrong account drive the agent. Empty means unpaired — the
   * channel refuses every message until at least one id is set.
   *
   * A v51 file's scalar `ownerUserId` is folded in as the first entry,
   * so an existing single-owner setup keeps working untouched.
   */
  ownerUserIds: string[];
}

/**
 * One extra bot in the swarm: a second (third, …) Telegram or Discord
 * bot on the same runtime, with its own token, owner and label, so an
 * operator can point different bots at different rooms or roles. The
 * primary `telegram` / `discord` blocks stay as they are; units are
 * additional. The token lives in `<stateDir>/.env` under `tokenEnv`,
 * never here. Added in config v52.
 */
export interface SwarmUnitConfig {
  /** Stable slug, unique across units: `[a-z0-9][a-z0-9-]{0,31}`. */
  id: string;
  kind: "telegram" | "discord";
  /** Display name in the Swarm tab and in session labels. */
  label: string;
  /** Free text: what this bot is for ("ops", "research"). Informational for now. */
  role: string;
  enabled: boolean;
  /** Name of the `.env` key holding this unit's bot token. */
  tokenEnv: string;
  /**
   * The sole operator this unit listens to, as a string for both kinds
   * (Discord snowflakes exceed `Number.MAX_SAFE_INTEGER`; Telegram ids
   * are parsed back to a number at construction). `null` = unpaired.
   */
  ownerUserId: string | null;
}

export interface SwarmConfig {
  units: SwarmUnitConfig[];
}

export const SWARM_UNIT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

const SWARM_TOKEN_ENV = /^[A-Z_][A-Z0-9_]*$/;

const SWARM_LABEL_MAX = 40;

const SWARM_ROLE_MAX = 120;

/**
 * A Discord snowflake as it appears in the client's "Copy User ID":
 * 15-25 digits. Validated here as well as in the hub's field so a
 * hand-edited `config.json` cannot arm an owner id that can never
 * match an author id.
 */
const DISCORD_SNOWFLAKE_RE = /^\d{15,25}$/;

/**
 * `swarm.units[]`. Every unit is checked in full — a half-valid unit
 * would construct a channel that can never start — and ids / token
 * env names must be unique or two units would share a bot.
 */
function parseSwarmUnits(value: unknown, field: string): SwarmUnitConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigValidationError(field, "must be an array");
  }
  const ids = new Set<string>();
  const envs = new Set<string>();
  return value.map((raw, i) => {
    const at = `${field}[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ConfigValidationError(at, "must be an object");
    }
    const u = raw as Record<string, unknown>;
    const id = parseNonEmptyString(u.id, `${at}.id`);
    if (!SWARM_UNIT_ID.test(id)) {
      throw new ConfigValidationError(
        `${at}.id`,
        "must match [a-z0-9][a-z0-9-]{0,31}",
      );
    }
    if (ids.has(id))
      throw new ConfigValidationError(`${at}.id`, `duplicate id '${id}'`);
    ids.add(id);
    if (u.kind !== "telegram" && u.kind !== "discord") {
      throw new ConfigValidationError(
        `${at}.kind`,
        'must be "telegram" or "discord"',
      );
    }
    const label = parseNonEmptyString(u.label, `${at}.label`);
    if (label.length > SWARM_LABEL_MAX) {
      throw new ConfigValidationError(
        `${at}.label`,
        `must be at most ${SWARM_LABEL_MAX} characters`,
      );
    }
    const role = u.role === undefined || u.role === null ? "" : u.role;
    if (typeof role !== "string" || role.length > SWARM_ROLE_MAX) {
      throw new ConfigValidationError(
        `${at}.role`,
        `must be a string of at most ${SWARM_ROLE_MAX} characters`,
      );
    }
    const tokenEnv = parseNonEmptyString(u.tokenEnv, `${at}.tokenEnv`);
    if (!SWARM_TOKEN_ENV.test(tokenEnv)) {
      throw new ConfigValidationError(
        `${at}.tokenEnv`,
        "must be an env var name ([A-Z_][A-Z0-9_]*)",
      );
    }
    if (envs.has(tokenEnv)) {
      throw new ConfigValidationError(
        `${at}.tokenEnv`,
        `duplicate token env '${tokenEnv}'`,
      );
    }
    envs.add(tokenEnv);
    const ownerUserId = parseNullableString(u.ownerUserId, `${at}.ownerUserId`);
    if (ownerUserId !== null && !/^\d{1,25}$/.test(ownerUserId)) {
      throw new ConfigValidationError(
        `${at}.ownerUserId`,
        "must be a numeric user id",
      );
    }
    return {
      id,
      kind: u.kind,
      label,
      role,
      enabled: parseBool(u.enabled ?? false, `${at}.enabled`),
      tokenEnv,
      ownerUserId,
    };
  });
}

/**
 * Parse `discord.ownerUserIds`, accepting the v51 scalar
 * `discord.ownerUserId` as a one-entry list.
 *
 * Both keys present is not an error — the list wins and the scalar is
 * ignored, which is what a file written by v52 and then hand-edited by
 * someone following v51 docs should do. Order is preserved and
 * duplicates are dropped so the parsed shape is canonical.
 */
export function parseDiscordOwnerUserIds(
  discord: Record<string, unknown>,
): string[] {
  const field = "discord.ownerUserIds";
  const raw = discord.ownerUserIds;
  if (raw === undefined || raw === null) {
    const legacy = parseNullableString(
      discord.ownerUserId,
      "discord.ownerUserId",
    );
    if (legacy === null) return [];
    if (!DISCORD_SNOWFLAKE_RE.test(legacy)) {
      throw new ConfigValidationError(
        "discord.ownerUserId",
        `expected a 15-25 digit Discord user id, got ${JSON.stringify(legacy)}`,
      );
    }
    return [legacy];
  }
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected string[], got ${JSON.stringify(raw)}`,
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string" || !DISCORD_SNOWFLAKE_RE.test(entry)) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `expected a 15-25 digit Discord user id, got ${JSON.stringify(entry)}`,
      );
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

/**
 * Parse the agent-reply parse mode for outbound Telegram messages.
 * Accepts `"plain"` and `"html"` only — `markdownV2` is intentionally
 * excluded (see `TelegramParseMode` doc-comment for rationale).
 */
function parseTelegramParseMode(
  raw: unknown,
  field: string,
): TelegramParseMode {
  if (raw === "plain" || raw === "html") return raw;
  throw new ConfigValidationError(
    field,
    `expected one of plain|html, got ${JSON.stringify(raw)}`,
  );
}

/**
 * Parse a Telegram numeric user id. Accepts `null` (not configured),
 * a positive integer, or a numeric string (so hand-edited config
 * files written by humans still validate). Anything else throws.
 * Telegram user ids fit comfortably inside `Number.MAX_SAFE_INTEGER`
 * for the foreseeable future, so we keep the simpler `number` shape
 * instead of `bigint`.
 */
export function parseTelegramOwnerId(
  raw: unknown,
  field: string,
): number | null {
  if (raw === null || raw === undefined) return null;
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new ConfigValidationError(
      field,
      `expected positive integer or null, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

export function createTelegramDefaults(): TelegramConfig {
  return {
    enabled: false,
    ownerUserId: null,
    parseMode: "html",
    progressIndicator: true,
  };
}

export function parseTelegramConfig(
  raw: Record<string, unknown>,
  readDefaults: () => TelegramConfig,
): TelegramConfig {
  return {
      enabled: parseBool(
        raw.enabled ?? readDefaults().enabled,
        "telegram.enabled",
      ),
      ownerUserId: parseTelegramOwnerId(
        raw.ownerUserId ?? readDefaults().ownerUserId,
        "telegram.ownerUserId",
      ),
      parseMode: parseTelegramParseMode(
        raw.parseMode ?? readDefaults().parseMode,
        "telegram.parseMode",
      ),
      progressIndicator: parseBool(
        raw.progressIndicator ??
          readDefaults().progressIndicator,
        "telegram.progressIndicator",
      ),
    };
}

export function createDiscordDefaults(): DiscordConfig {
  return {
    // Added in v51. Off by default: an unpaired channel with a token
    // would connect and then refuse every message, which looks broken.
    enabled: false,
    // v52: a list. Empty is the unpaired state the switch above assumes.
    ownerUserIds: [],
  };
}

export function parseDiscordConfig(
  raw: Record<string, unknown>,
  readDefaults: () => DiscordConfig,
): DiscordConfig {
  return {
      enabled: parseBool(
        raw.enabled ?? readDefaults().enabled,
        "discord.enabled",
      ),
      ownerUserIds: parseDiscordOwnerUserIds(raw),
    };
}

export function createSwarmDefaults(): SwarmConfig {
  return {
    // Added in v52. No extra bots until the operator adds one.
    units: [],
  };
}

export function parseSwarmConfig(
  raw: Record<string, unknown>,
): SwarmConfig {
  return {
      units: parseSwarmUnits(raw.units, "swarm.units"),
    };
}
