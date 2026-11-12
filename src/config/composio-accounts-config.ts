/**
 * `composio.accounts`: the operator's named Composio connected accounts.
 *
 * Composio lets one user id hold several connected accounts for the same
 * toolkit (a work and a personal Gmail). Each entry here gives one of
 * them a short local alias and, optionally, marks it as the toolkit's
 * default. A default is passed to Composio as a session pin
 * (`connected_accounts`), so every call for that toolkit acts through
 * that account. A toolkit with no default is left to Composio, which
 * uses the most recently connected account, exactly as before.
 *
 * The list is an array on purpose: arrays are whole values for
 * `carryUnknownConfigKeys`, so removing an account really removes it.
 */

import { ConfigValidationError } from "./config-validation-error.js";

export interface ComposioAccount {
  /** Composio toolkit slug, lowercase (`gmail`, `github`, `google_calendar`). */
  toolkit: string;
  /** Local label: lowercase letters, digits and `-`, 1-32 chars, unique per toolkit. */
  alias: string;
  /** Composio connected account id (`ca_…`). Unique across the list. */
  connectedAccountId: string;
  /** Pin this account for its toolkit. At most one per toolkit. */
  isDefault: boolean;
}

/** Alias rule: starts with a letter or digit, then letters, digits or `-`. */
export const COMPOSIO_ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Toolkit slug rule, as Composio spells them. */
export const COMPOSIO_TOOLKIT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Connected account ids are opaque; refuse only what cannot be one. */
const CONNECTED_ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Why `alias` is not a valid alias, or `undefined` when it is. */
export function composioAliasError(alias: unknown): string | undefined {
  if (typeof alias !== "string") return "alias must be a string";
  if (COMPOSIO_ALIAS_RE.test(alias)) return undefined;
  return "alias must be 1-32 characters: lowercase letters, digits and '-', not starting with '-'";
}

/** Why `toolkit` is not a valid toolkit slug, or `undefined`. */
export function composioToolkitError(toolkit: unknown): string | undefined {
  if (typeof toolkit !== "string") return "toolkit must be a string";
  if (COMPOSIO_TOOLKIT_RE.test(toolkit)) return undefined;
  return "toolkit must be a lowercase Composio toolkit slug (letters, digits, '_' or '-')";
}

/** Why `id` is not a plausible connected account id, or `undefined`. */
export function composioConnectedAccountIdError(id: unknown): string | undefined {
  if (typeof id === "string" && CONNECTED_ACCOUNT_ID_RE.test(id)) return undefined;
  return "connectedAccountId must be a Composio connected account id";
}

/**
 * The first rule the list as a whole breaks, or `undefined`: duplicate
 * alias within a toolkit, the same connected account twice, or two
 * defaults for one toolkit. Shared by the config parser and the edit
 * helpers in `src/composio/`, so both refuse the same lists.
 */
export function composioAccountsListError(
  accounts: readonly ComposioAccount[],
): string | undefined {
  const aliases = new Set<string>();
  const ids = new Set<string>();
  const defaults = new Set<string>();
  for (const a of accounts) {
    const key = `${a.toolkit}\u0000${a.alias}`;
    if (aliases.has(key)) {
      return `alias "${a.alias}" is used twice for ${a.toolkit}`;
    }
    aliases.add(key);
    if (ids.has(a.connectedAccountId)) {
      return `connected account ${a.connectedAccountId} is listed twice`;
    }
    ids.add(a.connectedAccountId);
    if (a.isDefault) {
      if (defaults.has(a.toolkit)) {
        return `${a.toolkit} has more than one default account`;
      }
      defaults.add(a.toolkit);
    }
  }
  return undefined;
}

/** Parse `composio.accounts`. Absent or null is an empty list. */
export function parseComposioAccounts(
  raw: unknown,
  field: string,
): ComposioAccount[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected an array or null");
  }
  const out = raw.map((entry, i) => parseEntry(entry, `${field}[${i}]`));
  const listError = composioAccountsListError(out);
  if (listError !== undefined) {
    throw new ConfigValidationError(field, listError);
  }
  return out;
}

function parseEntry(raw: unknown, field: string): ComposioAccount {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected an object");
  }
  const o = raw as Record<string, unknown>;
  const toolkitError = composioToolkitError(o.toolkit);
  if (toolkitError !== undefined) {
    throw new ConfigValidationError(`${field}.toolkit`, toolkitError);
  }
  const aliasError = composioAliasError(o.alias);
  if (aliasError !== undefined) {
    throw new ConfigValidationError(`${field}.alias`, aliasError);
  }
  const idError = composioConnectedAccountIdError(o.connectedAccountId);
  if (idError !== undefined) {
    throw new ConfigValidationError(`${field}.connectedAccountId`, idError);
  }
  if (o.isDefault !== undefined && typeof o.isDefault !== "boolean") {
    throw new ConfigValidationError(`${field}.isDefault`, "expected a boolean");
  }
  return {
    toolkit: o.toolkit as string,
    alias: o.alias as string,
    connectedAccountId: o.connectedAccountId as string,
    isDefault: o.isDefault === true,
  };
}
