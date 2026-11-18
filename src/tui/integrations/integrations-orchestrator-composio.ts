import {
  ComposioAccountError,
  addComposioAccount,
  listComposioConnectedAccounts,
  persistComposioAccounts,
  removeComposioAccount,
  resolveComposioApiKey,
  setDefaultComposioAccount,
  type ComposioConnectedAccount,
} from "../../composio/index.js";
import type { ComposioAccount } from "../../config/composio-accounts-config.js";
import type { ComposioConfig } from "../../config/config-schema.js";
import {
  IntegrationSecretError,
  type IntegrationField,
} from "../../integrations/index.js";

/**
 * The Composio accounts half of the hub orchestrator (ATO-1494). Three
 * typed inputs act the moment they are saved, like Atomic Mail's code:
 * add `<app> <name> <account-id> [--default]`, default `<app> <name>`
 * (or `<app> none`), remove `<app> <name>`. Each goes through the
 * ATO-548 edit helpers and `persistComposioAccounts`; the caller then
 * remounts Composio so the new defaults are pinned straight away. The
 * `a` action lists the saved names next to what Composio has signed in,
 * so the `ca_…` id to add can be read off the screen.
 */

/** Transient field keys on the Composio descriptor. */
export const COMPOSIO_ACCOUNT_FIELDS = {
  add: "addAccount",
  setDefault: "defaultAccount",
  remove: "removeAccount",
} as const;

const FIELD_KEYS: ReadonlySet<string> = new Set(Object.values(COMPOSIO_ACCOUNT_FIELDS));

export function isComposioAccountField(field: IntegrationField): boolean {
  return field.store === "transient" && FIELD_KEYS.has(field.key);
}

/**
 * Apply one typed account edit and write the list. Returns the line to
 * show. Throws `IntegrationSecretError` with a message for the pane on
 * bad input; nothing is written then.
 */
export function applyComposioAccountField(
  field: IntegrationField,
  value: string | null,
  accounts: readonly ComposioAccount[],
  configPath: string,
): string {
  if (value === null) return "Nothing to clear";
  const words = value.trim().split(/\s+/).filter((w) => w.length > 0);
  const flags = words.filter((w) => w.startsWith("--"));
  const args = words.filter((w) => !w.startsWith("--"));
  const toolkit = (args[0] ?? "").toLowerCase();
  const alias = args[1] ?? "";
  try {
    if (field.key === COMPOSIO_ACCOUNT_FIELDS.add) {
      if (args.length !== 3 || flags.some((f) => f !== "--default")) {
        throw new IntegrationSecretError("Type: <app> <name> <account-id>, e.g. gmail work ca_abc123 (add --default to use it)");
      }
      const isDefault = flags.includes("--default");
      persistComposioAccounts(
        configPath,
        addComposioAccount(accounts, { toolkit, alias, connectedAccountId: args[2]!, isDefault }),
      );
      return `${toolkit} account "${alias}" saved${isDefault ? " and used for every " + toolkit + " call" : ""}`;
    }
    if (args.length !== 2 || flags.length > 0) {
      throw new IntegrationSecretError(
        field.key === COMPOSIO_ACCOUNT_FIELDS.setDefault
          ? "Type: <app> <name>, or <app> none"
          : "Type: <app> <name>",
      );
    }
    if (field.key === COMPOSIO_ACCOUNT_FIELDS.setDefault) {
      const clear = alias === "none";
      persistComposioAccounts(configPath, setDefaultComposioAccount(accounts, toolkit, clear ? null : alias));
      return clear
        ? `${toolkit} has no default now: Composio uses the account connected last`
        : `${toolkit} now acts through "${alias}"`;
    }
    persistComposioAccounts(configPath, removeComposioAccount(accounts, toolkit, alias));
    return `${toolkit} account "${alias}" removed (it stays signed in on Composio)`;
  } catch (err) {
    if (err instanceof ComposioAccountError) throw new IntegrationSecretError(err.message);
    throw err;
  }
}

/**
 * Before an add is written: the typed `ca_…` id is looked up among the
 * accounts Composio has signed in for this user. A pinned id Composio
 * does not have makes the session create fail, and with it every
 * Composio tool, so a miss is refused with a message and nothing is
 * written. When Composio cannot be asked (no key, no user yet, offline)
 * the add still goes through and the returned note says it was not
 * checked. Returns null when the id was found, or when the input is not
 * a well-formed add (`applyComposioAccountField` reports that).
 */
export async function checkComposioAccountToAdd(
  value: string,
  deps: ComposioAccountsListDeps,
): Promise<string | null> {
  const args = value.trim().split(/\s+/).filter((w) => w.length > 0 && !w.startsWith("--"));
  if (args.length !== 3) return null;
  const toolkit = args[0]!.toLowerCase();
  const id = args[2]!;
  const apiKey = resolveComposioApiKey({
    apiKeyEnv: deps.composio.apiKeyEnv,
    ...(deps.env === undefined ? {} : { env: deps.env }),
  });
  if (apiKey === undefined) return "no API key";
  if (!deps.composio.userId) return "no app connected yet";
  let connected: ComposioConnectedAccount[];
  try {
    connected = await (deps.listConnected ?? listComposioConnectedAccounts)({ apiKey, userId: deps.composio.userId });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const found = connected.find((c) => c.id === id);
  if (!found) {
    throw new IntegrationSecretError(`Composio has no signed-in account ${id}. Press a to see the ids it has`);
  }
  if (found.toolkit !== toolkit) {
    throw new IntegrationSecretError(`${id} is a ${found.toolkit} account on Composio, not ${toolkit}`);
  }
  return null;
}

/** An add that went through without the Composio check. */
export function uncheckedAccountMessage(message: string, why: string): string {
  return `${message} (not checked with Composio: ${why})`;
}

/**
 * The pane's error when Composio did not come back after an account
 * edit: its tools are off now, and the line says how to get them back.
 */
export function composioRemountFailedMessage(message: string, value: string): string {
  const words = value.trim().split(/\s+/).filter((w) => w.length > 0 && !w.startsWith("--"));
  const toolkit = (words[0] ?? "<app>").toLowerCase();
  const alias = words[1] ?? "<name>";
  return `${message}, but Composio did not start with it, so its tools are off. ` +
    `Type "${toolkit} none" in Default account or "${toolkit} ${alias}" in Remove account to get them back`;
}

export interface ComposioAccountsListDeps {
  composio: Pick<ComposioConfig, "accounts" | "apiKeyEnv" | "userId">;
  env?: NodeJS.ProcessEnv;
  listConnected?: typeof listComposioConnectedAccounts;
}

/**
 * The `a` action: one line per app with its saved names (`*` marks the
 * default), then the signed-in accounts not saved yet with their ids.
 * Composio being unreachable still shows the saved list.
 */
export async function composioAccountsSummary(deps: ComposioAccountsListDeps): Promise<string> {
  const { accounts } = deps.composio;
  let connected: ComposioConnectedAccount[] | null = null;
  let why: string | null = null;
  const apiKey = resolveComposioApiKey({
    apiKeyEnv: deps.composio.apiKeyEnv,
    ...(deps.env === undefined ? {} : { env: deps.env }),
  });
  if (apiKey === undefined) why = "no API key";
  else if (!deps.composio.userId) why = "no app connected yet";
  else {
    try {
      connected = await (deps.listConnected ?? listComposioConnectedAccounts)({ apiKey, userId: deps.composio.userId });
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
  }
  const parts: string[] = [];
  const toolkits = [...new Set(accounts.map((a) => a.toolkit))].sort();
  for (const t of toolkits) {
    const names = accounts
      .filter((a) => a.toolkit === t)
      .map((a) => (a.isDefault ? `*${a.alias}` : a.alias))
      .sort((a, b) => a.replace("*", "").localeCompare(b.replace("*", "")));
    parts.push(`${t}: ${names.join(", ")}`);
  }
  const saved = new Set(accounts.map((a) => a.connectedAccountId));
  const unsaved = (connected ?? []).filter((c) => !saved.has(c.id));
  const head = parts.length > 0 ? `Saved (* = default): ${parts.join(" · ")}` : "No saved accounts: every app uses the account connected last";
  const tail = unsaved.length > 0
    ? ` · Not saved: ${unsaved.map((c) => `${c.toolkit} ${c.id}${c.displayName ? ` (${c.displayName})` : ""}`).join(", ")}`
    : "";
  const note = why !== null ? ` · Composio not asked: ${why}` : "";
  return `${head}${tail}${note}`;
}
