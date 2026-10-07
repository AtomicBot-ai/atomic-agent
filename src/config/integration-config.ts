import { ConfigValidationError } from "./config-validation-error.js";

import { parseBool, parseNonEmptyString } from "./config-primitives.js";

import { parseNullableString } from "./config-values.js";

/**
 * Git remote-sync policy. Added in config v52.
 *
 * The agent can drive a repository that never leaves the machine: with
 * `remoteSync: false` (the default) every network git verb — `push`,
 * `fetch`, `pull`, `clone`, `remote add` / `set-url` — is refused before
 * any approval prompt, both through the dedicated `os.git.*` tools and
 * through `os.shell.run`. Flipping it on lets the agent sync a
 * repository with its remotes, each operation still going through the
 * approval ladder. The GitHub token itself is **not** stored here — it
 * lives in `<stateDir>/.env` as `GITHUB_TOKEN`, written by the
 * Integrations hub, like every other credential.
 */
export interface GitConfig {
  /** `false` keeps every repository local-only; the safe default. */
  remoteSync: boolean;
}

/**
 * Composio integration. Composio is a hosted catalogue of 1500+ SaaS
 * toolkits (Gmail, Slack, Notion, Linear, …) that also brokers each
 * app's OAuth. The agent reaches it as an ordinary MCP server: a
 * tool-router session yields a Streamable-HTTP MCP endpoint carrying
 * four meta-tools, and `src/mcp/` does the rest.
 *
 * As with `TelegramConfig`, the API key is **not** stored here — it
 * lives in `<stateDir>/.env` under the name in `apiKeyEnv` and is
 * loaded at bootstrap by `loadDotenvFromStateDir`. A missing key is
 * the integration's real gate: no key, no MCP server, no Composio
 * tool in the registry.
 */
export interface ComposioConfig {
  /**
   * Master kill switch. `false` keeps the integration dormant even
   * when a key is present — the escape hatch for an operator who
   * wants the key on disk but the toolkits off.
   */
  enabled: boolean;
  /** Name of the env var holding the API key. */
  apiKeyEnv: string;
  /**
   * Stable anonymous install id scoping Composio connected accounts.
   * Minted once as a random UUID and never derived from the operator's
   * email: Composio's docs advise against emails as user ids, and an
   * email is PII the integration has no reason to disclose. Losing it
   * means re-authorising every connected app, so it is persisted.
   */
  userId: string | null;
  /** Cached tool-router session id (`trs_…`), so a boot costs no API call. */
  sessionId: string | null;
  /** Cached MCP endpoint for `sessionId`. */
  mcpUrl: string | null;
}

/** Where a finished (or failed) background model download is reported. */
export type DownloadNotifyChannelSetting =
  "telegram" | "discord" | "email" | "off";

export interface NotificationsConfig {
  downloads: {
    /**
     * `null` means the operator has not been asked yet: the Models tab
     * asks once, the first time a pull starts, and remembers the answer
     * here. `"off"` is a remembered "no". Added in config v52.
     */
    channel: DownloadNotifyChannelSetting | null;
  };
}

/**
 * Atomic Mail — the agent's own `@atomicmail.ai` inbox. The API key
 * lives in `<stateDir>/.env` as `ATOMIC_MAIL_API_KEY`; this block holds
 * what is not secret: the address, and the owner's verified e-mail.
 * Added in config v53.
 */
export interface AtomicMailConfig {
  /** `name@atomicmail.ai`, once registered. */
  address: string | null;
  /** The JMAP account id that goes with it. */
  accountId: string | null;
  /** Where the operator wants to be reached. */
  ownerEmail: string | null;
  /** ISO time the operator typed the code back; `null` = not yet. */
  ownerVerifiedAt: string | null;
  /** A code has been sent and not yet typed back. Never the code itself. */
  pendingVerification: {
    email: string;
    /** sha256 of the six digits. */
    codeHash: string;
    expiresAt: string;
    /** Wrong guesses so far; the code is dropped after a few. */
    attempts: number;
  } | null;
}

export function parseDownloadNotifyChannel(
  raw: unknown,
  field: string,
): DownloadNotifyChannelSetting | null {
  if (raw === null || raw === undefined) return null;
  if (
    raw === "telegram" ||
    raw === "discord" ||
    raw === "email" ||
    raw === "off"
  ) {
    return raw;
  }
  throw new ConfigValidationError(
    field,
    `expected "telegram", "discord", "email", "off" or null, got ${JSON.stringify(raw)}`,
  );
}

function parsePendingVerification(
  raw: unknown,
  field: string,
): AtomicMailConfig["pendingVerification"] {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected an object or null");
  }
  const o = raw as Record<string, unknown>;
  const email = parseNullableString(o.email, `${field}.email`);
  const codeHash = parseNullableString(o.codeHash, `${field}.codeHash`);
  const expiresAt = parseNullableString(o.expiresAt, `${field}.expiresAt`);
  if (!email || !codeHash || !expiresAt) {
    throw new ConfigValidationError(
      field,
      "expected email, codeHash and expiresAt",
    );
  }
  const attempts =
    typeof o.attempts === "number" && o.attempts >= 0
      ? Math.floor(o.attempts)
      : 0;
  return { email, codeHash, expiresAt, attempts };
}

export function createNotificationsDefaults(): NotificationsConfig {
  return {
    // Added in v55. `null` = not asked yet; the Models tab asks once.
    downloads: {
      channel: null,
    },
  };
}

export function createAtomicMailDefaults(): AtomicMailConfig {
  return {
    // Added in v56. Nothing until the operator registers an inbox.
    address: null,
    accountId: null,
    ownerEmail: null,
    ownerVerifiedAt: null,
    pendingVerification: null,
  };
}

export function createGitDefaults(): GitConfig {
  return {
    // Added in v52. Off by default: a repository the agent versions must
    // not reach a remote until the operator deliberately opens the door.
    remoteSync: false,
  };
}

export function createComposioDefaults(): ComposioConfig {
  return {
    // Added in v50. `enabled: true` is safe because the key, not this
    // flag, is what actually mounts anything: with no key in the env
    // the runtime opens no connection and registers no tool.
    enabled: true,
    apiKeyEnv: "COMPOSIO_API_KEY",
    userId: null,
    sessionId: null,
    mcpUrl: null,
  };
}

export function parseNotificationsConfig(
  rawDownloads: Record<string, unknown>,
  readDefaults: () => NotificationsConfig,
): NotificationsConfig {
  return {
      downloads: {
        channel: parseDownloadNotifyChannel(
          rawDownloads.channel ??
            readDefaults().downloads.channel,
          "notifications.downloads.channel",
        ),
      },
    };
}

export function parseAtomicMailConfig(
  raw: Record<string, unknown>,
): AtomicMailConfig {
  return {
      address: parseNullableString(raw.address, "atomicMail.address"),
      accountId: parseNullableString(
        raw.accountId,
        "atomicMail.accountId",
      ),
      ownerEmail: parseNullableString(
        raw.ownerEmail,
        "atomicMail.ownerEmail",
      ),
      ownerVerifiedAt: parseNullableString(
        raw.ownerVerifiedAt,
        "atomicMail.ownerVerifiedAt",
      ),
      pendingVerification: parsePendingVerification(
        raw.pendingVerification,
        "atomicMail.pendingVerification",
      ),
    };
}

export function parseGitConfig(
  raw: Record<string, unknown>,
  readDefaults: () => GitConfig,
): GitConfig {
  return {
      remoteSync: parseBool(
        raw.remoteSync ?? readDefaults().remoteSync,
        "git.remoteSync",
      ),
    };
}

export function parseComposioConfig(
  raw: Record<string, unknown>,
  readDefaults: () => ComposioConfig,
): ComposioConfig {
  return {
      enabled: parseBool(
        raw.enabled ?? readDefaults().enabled,
        "composio.enabled",
      ),
      apiKeyEnv: parseNonEmptyString(
        raw.apiKeyEnv ?? readDefaults().apiKeyEnv,
        "composio.apiKeyEnv",
      ),
      userId: parseNullableString(raw.userId, "composio.userId"),
      sessionId: parseNullableString(raw.sessionId, "composio.sessionId"),
      mcpUrl: parseNullableString(raw.mcpUrl, "composio.mcpUrl"),
    };
}
