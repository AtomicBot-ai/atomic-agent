/**
 * The contract every third-party integration declares itself with.
 *
 * Before this existed, each integration grew its own settings surface:
 * Telegram had a tab, LLM providers had a wizard, Composio had nothing.
 * An operator looking for "where do I put my key" had to already know
 * which of those a given service was. A descriptor moves that knowledge
 * into data, so the Integrations hub can render any integration —
 * present or future — without a bespoke pane, and adding one is a
 * descriptor plus a registry line rather than a TUI slice.
 *
 * Descriptors are pure data plus two pure functions. Nothing here reads
 * config, touches the filesystem, or talks to a runtime; the hub's
 * orchestrator owns all of that.
 */

/** One credential an integration needs. */
export interface IntegrationField {
  /** Stable id, unique within the integration. */
  key: string;
  /** Human label, e.g. "API key". */
  label: string;
  /**
   * Where the value lives.
   *
   * `"env"` (the default) means `<stateDir>/.env` — the right home for
   * anything secret. `"config"` means a dotted path in `config.json`,
   * for the non-secret settings an integration still needs before it
   * can run (an owner id, an endpoint). Without this the hub could
   * only ever be half a setup surface: the operator would paste a
   * token here and then hand-edit JSON for the rest.
   */
  store?: "env" | "config";
  /**
   * Env var this field is stored under in `<stateDir>/.env`. Secrets
   * never enter `config.json`; this is the same split Telegram's bot
   * token and the LLM provider keys already use. Required for
   * `store: "env"` (the default) and absent for `store: "config"`.
   */
  envVar?: string;
  /**
   * Dotted `config.json` path, e.g. `discord.ownerUserId`. Required
   * when `store === "config"`. A `null` clears it.
   */
  configPath?: string;
  /**
   * `"text"` (default) is a typed value; `"boolean"` renders as an
   * on/off toggle and stores `true` / `false` rather than a string.
   * Toggles are how a channel's kill switch reaches the hub — without
   * one an operator would set a token here and still need the CLI to
   * turn the thing on.
   */
  kind?: "text" | "boolean";
  /** Mask the value in the UI and never log it. */
  secret: boolean;
  /** A field the integration cannot work without. */
  required: boolean;
  /** Short hint rendered under the input. */
  help?: string;
  /**
   * Reject a bad value at entry. Returns an error message, or
   * `undefined` when the value is acceptable.
   */
  validate?: (raw: string) => string | undefined;
}

export type IntegrationStatusLevel =
  | "not_configured"
  | "configured"
  | "connected"
  | "error";

export interface IntegrationStatus {
  level: IntegrationStatusLevel;
  /** One line shown next to the badge. */
  detail?: string;
}

/** What the hub knows at render time, passed to `status()`. */
export interface IntegrationStatusContext {
  /** Field keys that currently resolve to a non-empty value. */
  presentFields: ReadonlySet<string>;
  /** Every required field has a value. */
  configured: boolean;
  /**
   * Live MCP server states by server name, for integrations that mount
   * one. Absent when the runtime is not available (e.g. in tests).
   */
  mcpServerStates?: ReadonlyMap<string, string>;
  /**
   * Live channel states by channel name (`ChannelState` values), for
   * integrations that run one — Telegram today. Absent when the
   * runtime is not available (e.g. in tests).
   */
  channelStates?: ReadonlyMap<string, string>;
  /**
   * Last error per channel, straight from `channel.lastError()`.
   *
   * A status line that says "channel failed to start" tells the
   * operator nothing they cannot already see from the badge. The
   * channel knows *why* — a held lock, a rejected token, disallowed
   * intents — and that is the only part worth screen space.
   */
  channelErrors?: ReadonlyMap<string, string>;
}

/**
 * A verb the detail view offers, beyond editing fields.
 *
 * Credentials alone are not a setup surface for a live channel:
 * pairing an owner, restarting after a token change and toggling the
 * channel are all things the operator must be able to do in the same
 * place, or the hub is half the story and they go hunting for a tab
 * that no longer exists.
 */
export interface IntegrationAction {
  /** Single keypress in the detail view. Must not collide with e/d/esc. */
  key: string;
  /** Stable id the orchestrator dispatches on. */
  id: string;
  /** Short imperative label, e.g. "pair", "restart". */
  label: string;
  /**
   * Hidden when this returns false — "pair" makes no sense before a
   * token exists, and offering it would only produce a confusing
   * failure.
   */
  available?: (ctx: IntegrationStatusContext) => boolean;
}

export interface IntegrationDescriptor {
  /** Stable id, also the `/integrations <id>` selector. */
  id: string;
  /** Display name, e.g. "Composio". */
  label: string;
  /** One line explaining what connecting this buys the operator. */
  summary: string;
  /** Where to get the credentials. */
  docsUrl?: string;
  /**
   * The walkthrough shown in the detail view until the integration is
   * connected: what to click on the other side, in order, in the words
   * the other side uses.
   *
   * A credential field labelled "Bot token" is only self-explanatory to
   * someone who has already made a bot. Everyone else needs to be told
   * that the token comes from @BotFather, that Discord's "client
   * secret" is not it, and that a Discord bot has to be invited to a
   * server before it can be messaged at all -- and needs to be told it
   * *here*, not in a README they do not know exists. Steps disappear
   * once the integration reports `connected`, so a working setup is not
   * nagged at.
   */
  setupSteps?: readonly string[];
  fields: readonly IntegrationField[];
  /** Verbs offered alongside the fields. */
  actions?: readonly IntegrationAction[];
  /**
   * Whether a restart is needed for changes to take effect. The hub
   * says so explicitly rather than leaving the operator to guess why
   * nothing happened.
   */
  appliesLive: boolean;
  status: (ctx: IntegrationStatusContext) => IntegrationStatus;
}

/** Default status: configured-or-not, with no runtime signal. */
export function basicStatus(ctx: IntegrationStatusContext): IntegrationStatus {
  return ctx.configured
    ? { level: "configured" }
    : { level: "not_configured" };
}

/** Every required field of `descriptor` that has a value. */
export function isConfigured(
  descriptor: IntegrationDescriptor,
  presentFields: ReadonlySet<string>,
): boolean {
  const required = descriptor.fields.filter((f) => f.required);
  // An integration with no required fields is never "configured" by
  // omission — that would badge an untouched entry as ready to use.
  if (required.length === 0) return false;
  return required.every((f) => presentFields.has(f.key));
}
