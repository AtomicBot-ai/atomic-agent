/**
 * ATO-1494: the Composio card's account switcher (composio-accounts.ts says
 * what the list is).
 *
 *   composio:listAccounts   {stateDir}                       saved list + Composio's signed-in accounts
 *   composio:addAccount     {toolkit, alias, connectedAccountId, isDefault}
 *   composio:removeAccount  {toolkit, alias}
 *   composio:setDefault     {toolkit, alias | null}
 *
 * Every edit reads `composio.accounts`, applies the core's rules and writes
 * the whole list back in one config write. Edits run one after another, so
 * two quick clicks cannot write over each other. The agent reads the list
 * when it starts; the window owes a restart, as it does after a saved key.
 */

import {
  addAccount,
  listConnectedAccounts,
  readAccounts,
  removeAccount,
  setDefaultAccount,
  type AccountsEdit,
  type ComposioAccount,
  type ComposioConnectedAccount,
} from "./composio-accounts.js";
import { COMPOSIO_API_KEY_ENV, readDotenvValue } from "./composio-key.js";

export interface ComposioAccountsDeps {
  /** The effective `composio` block (`atag config get composio`). */
  readComposio: () => Promise<{ ok: boolean; value?: unknown; error?: string }>;
  /** Writes `composio.accounts`, whole, in one config write. */
  writeAccounts: (accounts: ComposioAccount[]) => Promise<{ ok: boolean; error?: string }>;
  /** This app's environment: a key there wins over `.env`, as in the agent. */
  env: NodeJS.ProcessEnv;
  listConnected?: typeof listConnectedAccounts;
}

export interface AccountsList {
  ok: boolean;
  accounts: ComposioAccount[];
  /** Composio's signed-in accounts; null when they could not be asked for (connectedError says why). */
  connected: ComposioConnectedAccount[] | null;
  connectedError?: string;
  error?: string;
}

/* The key the agent would load: this app's environment first, then <stateDir>/.env (composio-key.ts checkSavedComposioKey). */
function apiKeyFor(deps: ComposioAccountsDeps, stateDir: string | null): string | undefined {
  const fromEnv = deps.env[COMPOSIO_API_KEY_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  return stateDir ? readDotenvValue(stateDir, COMPOSIO_API_KEY_ENV) : undefined;
}

export async function listComposioAccounts(deps: ComposioAccountsDeps, stateDir: string | null): Promise<AccountsList> {
  const cfg = await deps.readComposio();
  if (!cfg.ok) return { ok: false, accounts: [], connected: null, error: `Could not read the settings: ${cfg.error ?? "unknown error"}` };
  const accounts = readAccounts(cfg.value);
  const block = cfg.value && typeof cfg.value === "object" ? (cfg.value as Record<string, unknown>) : {};
  const userId = typeof block.userId === "string" ? block.userId.trim() : "";
  const apiKey = apiKeyFor(deps, stateDir);
  if (!apiKey) return { ok: true, accounts, connected: null, connectedError: "No Composio API key is saved." };
  if (!userId) return { ok: true, accounts, connected: [], connectedError: "No app is connected yet. Ask the agent to connect one first." };
  try {
    const connected = await (deps.listConnected ?? listConnectedAccounts)({ apiKey, userId });
    return { ok: true, accounts, connected };
  } catch (err) {
    const why = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "the request timed out." : err instanceof Error ? err.message : String(err);
    return { ok: true, accounts, connected: null, connectedError: `Could not ask Composio which accounts are signed in: ${why}` };
  }
}

type Edit = (accounts: readonly ComposioAccount[], input: unknown) => AccountsEdit;

let queue: Promise<unknown> = Promise.resolve();

/** Read, edit, write back; one at a time. */
export function editComposioAccounts(deps: ComposioAccountsDeps, edit: Edit, input: unknown): Promise<{ ok: boolean; accounts?: ComposioAccount[]; error?: string }> {
  const run = async () => {
    const cfg = await deps.readComposio();
    if (!cfg.ok) return { ok: false, error: `Could not read the settings: ${cfg.error ?? "unknown error"}` };
    const next = edit(readAccounts(cfg.value), input);
    if (!next.ok) return { ok: false, error: next.error };
    const wrote = await deps.writeAccounts(next.accounts);
    if (!wrote.ok) return { ok: false, error: `Could not save the accounts: ${wrote.error ?? "unknown error"}` };
    return { ok: true, accounts: next.accounts };
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void;
}

export function registerComposioAccountsIpc(opts: { ipcMain: IpcMainLike; deps: ComposioAccountsDeps; ownDir: (d: unknown) => d is string }): void {
  const { ipcMain, deps, ownDir } = opts;
  ipcMain.handle("composio:listAccounts", (_event, payload) => {
    const stateDir = (payload as { stateDir?: unknown } | null)?.stateDir;
    return listComposioAccounts(deps, ownDir(stateDir) ? stateDir : null);
  });
  ipcMain.handle("composio:addAccount", (_event, payload) => editComposioAccounts(deps, addAccount, payload));
  ipcMain.handle("composio:removeAccount", (_event, payload) => editComposioAccounts(deps, removeAccount, payload));
  ipcMain.handle("composio:setDefault", (_event, payload) => editComposioAccounts(deps, setDefaultAccount, payload));
}
