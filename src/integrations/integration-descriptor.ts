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
   * Env var this field is stored under in `<stateDir>/.env`. Secrets
   * never enter `config.json`; this is the same split Telegram's bot
   * token and the LLM provider keys already use.
   */
  envVar: string;
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
  fields: readonly IntegrationField[];
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
