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
