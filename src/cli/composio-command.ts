import { getConfig, readUserConfigFileSync } from "../config/index.js";
import type { ComposioAccount } from "../config/composio-accounts-config.js";
import {
  ComposioAccountError,
  addComposioAccount,
  listComposioConnectedAccounts,
  persistComposioAccounts,
  removeComposioAccount,
  resolveComposioApiKey,
  setDefaultComposioAccount,
  type ComposioConnectedAccount,
} from "../composio/index.js";

/**
 * ATO-1494 — `atomic-agent composio accounts`: name the Composio
 * connected accounts (a work and a personal Gmail) and pick which one
 * each app acts through. Same shape as `gh auth status|switch` and
 * Raycast's account list: a short local alias per account, one default
 * per app. The list lives in `composio.accounts` (ATO-548); the default
 * becomes a session pin the next time the agent starts.
 */
const HELP = [
  "Usage: atomic-agent composio accounts <command>",
  "",
  "Several accounts for one app (a work and a personal Gmail), each with a short name.",
  "The default account of an app is the one every call for that app goes through.",
  "",
  "Commands:",
  "  list [--connected] [--json]                     Saved accounts; --connected also asks Composio which are signed in",
  "  add <app> <name> <account-id> [--default]       Save a connected account (ca_…) under a name",
  "  remove <app> <name>                             Forget a saved account (it stays signed in on Composio)",
  "  default <app> <name>                            Make it the app's default",
  "  default <app> --clear                           No default: Composio uses the latest connected account",
  "",
  "<app> is the Composio toolkit slug: gmail, github, slack, google_calendar, …",
  "Names: lowercase letters, digits and '-', up to 32 characters.",
  "Changes take effect the next time the agent starts (restart a running TUI or desktop app).",
].join("\n");

export interface ComposioCommandDeps {
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
  /** `<stateDir>/config.json`; default from the loaded config. */
  configPath?: string;
  /** Composio's connected accounts for this install; default calls the API. */
  listConnected?: () => Promise<ComposioConnectedAccount[]>;
}

const RESTART_NOTE = "takes effect the next time the agent starts";

export async function composioCommand(
  args: string[],
  deps: ComposioCommandDeps = {},
): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const writeErr = deps.writeErr ?? ((t: string) => { process.stderr.write(t); });
  const [group, sub, ...rest] = args;
  if (!group || group === "-h" || group === "--help") {
    write(`${HELP}\n`);
    return group ? 0 : 2;
  }
  if (group !== "accounts") {
    writeErr(`unknown composio command "${group}"\n\n${HELP}\n`);
    return 2;
  }
  if (!sub || sub === "-h" || sub === "--help") {
    write(`${HELP}\n`);
    return sub ? 0 : 2;
  }

  const configPath = deps.configPath ?? getConfig().paths.userConfigFile;
  const accounts = readUserConfigFileSync(configPath)?.composio.accounts ?? [];
  const flags = rest.filter((a) => a.startsWith("--"));
  const positional = rest.filter((a) => !a.startsWith("--"));
  const known = KNOWN_FLAGS[sub];
  if (known === undefined) {
    writeErr(`unknown composio accounts command "${sub}"\n\n${HELP}\n`);
    return 2;
  }
  const badFlag = flags.find((f) => !known.includes(f));
  if (badFlag !== undefined) {
    writeErr(`unknown option "${badFlag}" for "${sub}"\n\n${HELP}\n`);
    return 2;
  }

  if (sub === "list") {
    if (positional.length > 0) return usage(writeErr, "list takes no arguments");
    return listAccounts(accounts, {
      json: flags.includes("--json"),
      connected: flags.includes("--connected"),
      write,
      writeErr,
      listConnected: deps.listConnected ?? defaultListConnected,
    });
  }

  try {
    if (sub === "add") {
      const [toolkit, alias, id] = positional;
      if (!toolkit || !alias || !id || positional.length > 3) {
        return usage(writeErr, "add needs <app> <name> <account-id>");
      }
      const isDefault = flags.includes("--default");
      const next = addComposioAccount(accounts, {
        toolkit,
        alias,
        connectedAccountId: id,
        isDefault,
      });
      persistComposioAccounts(configPath, next);
      write(`saved ${toolkit.toLowerCase()} account "${alias}"${isDefault ? " as the default" : ""}; ${RESTART_NOTE}\n`);
      return 0;
    }
    if (sub === "remove") {
      const [toolkit, alias] = positional;
      if (!toolkit || !alias || positional.length > 2) {
        return usage(writeErr, "remove needs <app> <name>");
      }
      persistComposioAccounts(configPath, removeComposioAccount(accounts, toolkit, alias));
      write(`removed ${toolkit.toLowerCase()} account "${alias}"; ${RESTART_NOTE}\n`);
      return 0;
    }
    // default
    const [toolkit, alias] = positional;
    const clear = flags.includes("--clear");
    if (!toolkit || (clear ? alias !== undefined : !alias) || positional.length > 2) {
      return usage(writeErr, "default needs <app> <name>, or <app> --clear");
    }
    const next = setDefaultComposioAccount(accounts, toolkit, clear ? null : alias!);
    persistComposioAccounts(configPath, next);
    write(
      clear
        ? `${toolkit.toLowerCase()} has no default now: Composio uses the latest connected account; ${RESTART_NOTE}\n`
        : `${toolkit.toLowerCase()} now acts through "${alias}"; ${RESTART_NOTE}\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof ComposioAccountError) {
      writeErr(`composio: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

const KNOWN_FLAGS: Record<string, readonly string[]> = {
  list: ["--json", "--connected"],
  add: ["--default"],
  remove: [],
  default: ["--clear"],
};

function usage(writeErr: (t: string) => void, message: string): number {
  writeErr(`${message}\n\n${HELP}\n`);
  return 2;
}

interface ListOptions {
  json: boolean;
  connected: boolean;
  write: (t: string) => void;
  writeErr: (t: string) => void;
  listConnected: () => Promise<ComposioConnectedAccount[]>;
}

async function listAccounts(
  accounts: readonly ComposioAccount[],
  opts: ListOptions,
): Promise<number> {
  let connected: ComposioConnectedAccount[] | undefined;
  if (opts.connected) {
    try {
      connected = await opts.listConnected();
    } catch (err) {
      opts.writeErr(`composio: could not list connected accounts: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (opts.json) {
    opts.write(`${JSON.stringify({ accounts, ...(connected ? { connected } : {}) }, null, 2)}\n`);
    return 0;
  }
  opts.write(`${formatAccountsTable(accounts, connected)}\n`);
  return 0;
}

/** Human list: saved accounts per app, then signed-in accounts not saved yet. */
export function formatAccountsTable(
  accounts: readonly ComposioAccount[],
  connected?: readonly ComposioConnectedAccount[],
): string {
  const lines: string[] = [];
  if (accounts.length === 0) {
    lines.push("no saved accounts: every app uses the account connected last");
  }
  const sorted = [...accounts].sort((a, b) =>
    a.toolkit === b.toolkit ? cmp(a.alias, b.alias) : cmp(a.toolkit, b.toolkit),
  );
  for (const a of sorted) {
    const who = connected?.find((c) => c.id === a.connectedAccountId);
    const state = connected === undefined ? "" : who ? ` ${who.displayName ?? who.status}` : " not signed in on Composio";
    lines.push(`${a.isDefault ? "*" : " "} ${a.toolkit.padEnd(16)} ${a.alias.padEnd(16)} ${a.connectedAccountId}${state}`);
  }
  const saved = new Set(accounts.map((a) => a.connectedAccountId));
  const unsaved = (connected ?? []).filter((c) => !saved.has(c.id));
  if (unsaved.length > 0) {
    lines.push("", "signed in on Composio, not saved (add one with: atomic-agent composio accounts add <app> <name> <account-id>):");
    for (const c of unsaved) {
      lines.push(`  ${c.toolkit.padEnd(16)} ${c.id}${c.displayName ? ` ${c.displayName}` : ""}`);
    }
  }
  if (accounts.some((a) => a.isDefault)) lines.push("", "* = default for its app");
  return lines.join("\n");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function defaultListConnected(): Promise<ComposioConnectedAccount[]> {
  const composio = getConfig().composio;
  const apiKey = resolveComposioApiKey({ apiKeyEnv: composio.apiKeyEnv });
  if (apiKey === undefined) throw new Error("no Composio API key is set");
  if (!composio.userId) throw new Error("Composio has not connected any app on this install yet");
  return listComposioConnectedAccounts({ apiKey, userId: composio.userId });
}
