/**
 * Settings › Connections › Composio › Accounts (ATO-1494): several connected
 * accounts for one app (a work and a personal Gmail), each with a short name,
 * and the one each app acts through.
 *
 * The list is the core's `composio.accounts` (ATO-548,
 * src/config/composio-accounts-config.ts): `{toolkit, alias,
 * connectedAccountId, isDefault}`, one default per toolkit. The agent pins
 * each default on its Composio session when it starts
 * (src/composio/resolve-composio-server.ts), and the cached session carries a
 * `sessionPins` stamp, so a changed default makes the next start create a new
 * session on its own. All the window has to do is write the list and offer
 * the restart, the way a saved key does.
 *
 * The rules below repeat the core's (composio-accounts.ts and
 * composio-accounts-config.ts) because the list crosses IPC and the agent
 * this app runs may not be the one the rules came from: a list the core would
 * refuse is never written. `composioSessionPins` / `composioSessionStamp`
 * repeat the core's too, for composio-key.ts's check, which caches a session.
 *
 * "Signed in on Composio" comes from GET /connected_accounts for the
 * install's user id (src/composio/composio-accounts-api.ts), so the window
 * offers the accounts that exist instead of asking for a `ca_…` id. Nothing
 * here logs or returns the API key.
 */

/* src/composio/composio-api.ts COMPOSIO_API_BASE (composio-key.ts imports this file, so not from there). */
const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3.1";

export interface ComposioAccount {
  toolkit: string;
  alias: string;
  connectedAccountId: string;
  isDefault: boolean;
}

export interface ComposioConnectedAccount {
  id: string;
  toolkit: string;
  status: string;
  /** Provider-side identity (an e-mail, a login) once active. */
  displayName: string | null;
}

/* src/config/composio-accounts-config.ts COMPOSIO_ALIAS_RE / COMPOSIO_TOOLKIT_RE / CONNECTED_ACCOUNT_ID_RE. */
const ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TOOLKIT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const ALIAS_RULE = "A name is 1 to 32 lowercase letters, digits or '-', not starting with '-'.";

export type AccountsEdit = { ok: true; accounts: ComposioAccount[] } | { ok: false; error: string };

/** `composio.accounts` as `atag config get composio` answers it; anything malformed is dropped, not guessed at. */
export function readAccounts(block: unknown): ComposioAccount[] {
  const raw = block && typeof block === "object" ? (block as Record<string, unknown>).accounts : undefined;
  if (!Array.isArray(raw)) return [];
  const out: ComposioAccount[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (typeof o.toolkit !== "string" || typeof o.alias !== "string" || typeof o.connectedAccountId !== "string") continue;
    out.push({ toolkit: o.toolkit, alias: o.alias, connectedAccountId: o.connectedAccountId, isDefault: o.isDefault === true });
  }
  return out;
}

/** composio-accounts.ts addComposioAccount: toolkit lowercased, a new default replaces the old one. */
export function addAccount(accounts: readonly ComposioAccount[], input: unknown): AccountsEdit {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const toolkit = typeof o.toolkit === "string" ? o.toolkit.trim().toLowerCase() : "";
  const alias = typeof o.alias === "string" ? o.alias.trim() : "";
  const id = typeof o.connectedAccountId === "string" ? o.connectedAccountId.trim() : "";
  if (!TOOLKIT_RE.test(toolkit)) return { ok: false, error: "That is not a Composio app name." };
  if (!ALIAS_RE.test(alias)) return { ok: false, error: ALIAS_RULE };
  if (!ID_RE.test(id)) return { ok: false, error: "That is not a Composio account id." };
  if (accounts.some((a) => a.toolkit === toolkit && a.alias === alias)) return { ok: false, error: `There is already a ${toolkit} account named "${alias}".` };
  if (accounts.some((a) => a.connectedAccountId === id)) return { ok: false, error: "This account is already saved under another name." };
  const isDefault = o.isDefault === true;
  const base = isDefault ? accounts.map((a) => (a.toolkit === toolkit ? { ...a, isDefault: false } : { ...a })) : accounts.map((a) => ({ ...a }));
  return { ok: true, accounts: [...base, { toolkit, alias, connectedAccountId: id, isDefault }] };
}

/** composio-accounts.ts removeComposioAccount: an unknown name is an error, not a no-op. */
export function removeAccount(accounts: readonly ComposioAccount[], input: unknown): AccountsEdit {
  const found = target(accounts, input);
  if ("error" in found) return { ok: false, error: found.error };
  return { ok: true, accounts: accounts.filter((a) => !(a.toolkit === found.toolkit && a.alias === found.alias)).map((a) => ({ ...a })) };
}

/** composio-accounts.ts setDefaultComposioAccount: `alias: null` clears the app's default. */
export function setDefaultAccount(accounts: readonly ComposioAccount[], input: unknown): AccountsEdit {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (o.alias === null) {
    const toolkit = typeof o.toolkit === "string" ? o.toolkit.trim().toLowerCase() : "";
    return { ok: true, accounts: accounts.map((a) => (a.toolkit === toolkit ? { ...a, isDefault: false } : { ...a })) };
  }
  const found = target(accounts, input);
  if ("error" in found) return { ok: false, error: found.error };
  return { ok: true, accounts: accounts.map((a) => (a.toolkit === found.toolkit ? { ...a, isDefault: a.alias === found.alias } : { ...a })) };
}

function target(accounts: readonly ComposioAccount[], input: unknown): { toolkit: string; alias: string } | { error: string } {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const toolkit = typeof o.toolkit === "string" ? o.toolkit.trim().toLowerCase() : "";
  const alias = typeof o.alias === "string" ? o.alias.trim() : "";
  if (!accounts.some((a) => a.toolkit === toolkit && a.alias === alias)) return { error: `No ${toolkit || "app"} account is named "${alias}".` };
  return { toolkit, alias };
}

/** composio-accounts.ts composioSessionPins: `{toolkit: [id]}` per default, keys sorted. */
export function composioSessionPins(accounts: readonly ComposioAccount[]): Record<string, string[]> {
  const pins: Record<string, string[]> = {};
  for (const a of accounts.filter((x) => x.isDefault).sort((x, y) => (x.toolkit < y.toolkit ? -1 : x.toolkit > y.toolkit ? 1 : 0))) {
    pins[a.toolkit] = [a.connectedAccountId];
  }
  return pins;
}

/** composio-accounts.ts composioSessionStamp: null with no pins, else `<sessionId>#gmail=ca_1,…`. */
export function composioSessionStamp(sessionId: string, pins: Readonly<Record<string, readonly string[]>>): string | null {
  const keys = Object.keys(pins).sort();
  if (keys.length === 0) return null;
  return `${sessionId}#${keys.map((k) => `${k}=${(pins[k] ?? []).join("+")}`).join(",")}`;
}

export interface ListConnectedOptions {
  apiKey: string;
  userId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** composio-accounts-api.ts listComposioConnectedAccounts, first page of ACTIVE accounts (100 is plenty for one person). */
export async function listConnectedAccounts(opts: ListConnectedOptions): Promise<ComposioConnectedAccount[]> {
  const q = new URLSearchParams();
  q.append("user_ids", opts.userId);
  q.append("statuses", "ACTIVE");
  q.set("limit", "100");
  const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl ?? COMPOSIO_API_BASE}/connected_accounts?${q.toString()}`, {
    method: "GET",
    headers: { "x-api-key": opts.apiKey },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error(`Composio rejected the API key (HTTP ${res.status}).`);
  if (!res.ok) throw new Error(`Composio returned HTTP ${res.status}.`);
  const body = (await res.json()) as unknown;
  const items = body && typeof body === "object" ? (body as Record<string, unknown>).items : undefined;
  if (!Array.isArray(items)) throw new Error("Composio returned no account list.");
  const out: ComposioConnectedAccount[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const tk = o.toolkit && typeof o.toolkit === "object" ? (o.toolkit as Record<string, unknown>).slug : undefined;
    if (typeof o.id !== "string" || typeof tk !== "string") continue;
    out.push({ id: o.id, toolkit: tk.toLowerCase(), status: typeof o.status === "string" ? o.status : "", displayName: displayNameOf(o) });
  }
  return out;
}

/* composio-accounts-api.ts parseItem: `state.val.displayName`, else Composio's own alias. */
function displayNameOf(o: Record<string, unknown>): string | null {
  const state = o.state && typeof o.state === "object" ? (o.state as Record<string, unknown>) : null;
  const val = state && state.val && typeof state.val === "object" ? (state.val as Record<string, unknown>) : null;
  for (const v of [val?.displayName, o.alias]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}
