/**
 * Named Composio accounts: pure edits of `composio.accounts` and the
 * session pins derived from it (ATO-548).
 *
 * Selection is per toolkit, not per call. The account marked default
 * for a toolkit is pinned on the tool-router session
 * (`connected_accounts`), so every call for that toolkit acts through
 * it; switching the default creates a new session on the next mount.
 * A toolkit with no default is not pinned and Composio keeps choosing
 * the most recently connected account, which is the behaviour every
 * install had before this list existed.
 *
 * Every helper returns a new list and never mutates its input. Invalid
 * input throws `ComposioAccountError` with a message fit for the UI.
 */

import {
  composioAccountsListError,
  composioAliasError,
  composioConnectedAccountIdError,
  composioToolkitError,
  type ComposioAccount,
} from "../config/composio-accounts-config.js";

export class ComposioAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposioAccountError";
  }
}

export interface AddComposioAccountInput {
  toolkit: string;
  alias: string;
  connectedAccountId: string;
  /** Make it the toolkit's default, replacing any previous one. */
  isDefault?: boolean;
}

/** Add a named account. Toolkit is lowercased; the alias must already be valid. */
export function addComposioAccount(
  accounts: readonly ComposioAccount[],
  input: AddComposioAccountInput,
): ComposioAccount[] {
  const toolkit = normalizeToolkit(input.toolkit);
  const entry: ComposioAccount = {
    toolkit,
    alias: input.alias,
    connectedAccountId: input.connectedAccountId.trim(),
    isDefault: input.isDefault === true,
  };
  for (const err of [
    composioToolkitError(entry.toolkit),
    composioAliasError(entry.alias),
    composioConnectedAccountIdError(entry.connectedAccountId),
  ]) {
    if (err !== undefined) throw new ComposioAccountError(err);
  }
  const base = entry.isDefault
    ? accounts.map((a) => (a.toolkit === toolkit ? { ...a, isDefault: false } : a))
    : [...accounts];
  return checked([...base, entry]);
}

/** Remove one named account. Unknown alias is an error, not a no-op. */
export function removeComposioAccount(
  accounts: readonly ComposioAccount[],
  toolkit: string,
  alias: string,
): ComposioAccount[] {
  const slug = normalizeToolkit(toolkit);
  requireAccount(accounts, slug, alias);
  return accounts.filter((a) => !(a.toolkit === slug && a.alias === alias));
}

/**
 * Make `alias` the toolkit's default, or clear the toolkit's default
 * with `null` (back to Composio's own choice).
 */
export function setDefaultComposioAccount(
  accounts: readonly ComposioAccount[],
  toolkit: string,
  alias: string | null,
): ComposioAccount[] {
  const slug = normalizeToolkit(toolkit);
  if (alias !== null) requireAccount(accounts, slug, alias);
  return accounts.map((a) =>
    a.toolkit === slug ? { ...a, isDefault: a.alias === alias } : a,
  );
}

/** The named account for `toolkit` + `alias`, if any. */
export function findComposioAccount(
  accounts: readonly ComposioAccount[],
  toolkit: string,
  alias: string,
): ComposioAccount | undefined {
  const slug = normalizeToolkit(toolkit);
  return accounts.find((a) => a.toolkit === slug && a.alias === alias);
}

/**
 * Session pins for Composio: `{ toolkit: [connectedAccountId] }` for each
 * toolkit that has a default, keys sorted so equal lists give equal pins.
 */
export function composioSessionPins(
  accounts: readonly ComposioAccount[],
): Record<string, string[]> {
  const pins: Record<string, string[]> = {};
  const defaults = accounts
    .filter((a) => a.isDefault)
    .sort((a, b) => (a.toolkit < b.toolkit ? -1 : a.toolkit > b.toolkit ? 1 : 0));
  for (const a of defaults) pins[a.toolkit] = [a.connectedAccountId];
  return pins;
}

/**
 * The `composio.sessionPins` stamp for a session created with `pins`:
 * `null` when nothing is pinned, otherwise `<sessionId>#gmail=ca_1,…`.
 */
export function composioSessionStamp(
  sessionId: string,
  pins: Readonly<Record<string, readonly string[]>>,
): string | null {
  const keys = Object.keys(pins).sort();
  if (keys.length === 0) return null;
  const body = keys.map((k) => `${k}=${(pins[k] ?? []).join("+")}`).join(",");
  return `${sessionId}#${body}`;
}

function requireAccount(
  accounts: readonly ComposioAccount[],
  toolkit: string,
  alias: string,
): void {
  if (findComposioAccount(accounts, toolkit, alias) === undefined) {
    throw new ComposioAccountError(`no ${toolkit} account named "${alias}"`);
  }
}

function normalizeToolkit(toolkit: string): string {
  return toolkit.trim().toLowerCase();
}

function checked(accounts: ComposioAccount[]): ComposioAccount[] {
  const err = composioAccountsListError(accounts);
  if (err !== undefined) throw new ComposioAccountError(err);
  return accounts;
}
