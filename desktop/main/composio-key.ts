/**
 * Settings › Connections › Composio: the API key the window saves, checks
 * and removes.
 *
 * The agent mounts Composio as one more MCP server when it starts
 * (src/runtime/composition/runtime-tool-catalog.ts → src/composio/
 * resolve-composio-server.ts), and only when `COMPOSIO_API_KEY` is in its
 * environment, which `atag serve` loads from `<stateDir>/.env` at start. So
 * the desktop's whole job is the TUI Integrations tab's: put the key in that
 * file, keep `composio.*` in config.json consistent with it, and let a
 * restart pick it up.
 *
 * The check is the core's own call (src/composio/composio-api.ts
 * createComposioSession): create a tool-router session for the install's
 * user id, with the remote workbench off. There is no cheaper endpoint the
 * agent uses, and the session it returns is exactly what the agent would
 * mint at boot, so it is cached in config.json the way
 * ensure-composio-session.ts does: the restart that follows costs no API
 * call. A key Composio refuses (401/403) is never written; a key that could
 * not be checked (offline, a 5xx) is written with a warning, since the agent
 * itself treats Composio as soft and would simply start without it.
 *
 * The key goes to the .env file and to Composio's `x-api-key` header and
 * nowhere else: no log line, no analytics property, no error message and
 * no answer to the window ever carries it. Everything here takes its
 * effects as arguments, so the suite drives it without a network, an agent
 * or a real state dir.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** src/composio/resolve-composio-key.ts COMPOSIO_API_KEY_ENV: the name the TUI's Integrations tab writes. */
export const COMPOSIO_API_KEY_ENV = "COMPOSIO_API_KEY";
/** src/composio/composio-api.ts COMPOSIO_API_BASE. */
export const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3.1";
/** Composio authenticates with this header, not `Authorization: Bearer`. */
const COMPOSIO_API_KEY_HEADER = "x-api-key";
const CHECK_TIMEOUT_MS = 15_000;

export const COMPOSIO_KEY_INVALID = "That does not look like a Composio API key.";

/* Why a key cannot be written as given, or null. Letters, digits and
   `_ - . : + / =`, 8 to 512 characters: the window's composioKeyClean rule
   (renderer/composio.js), checked again here because the value crosses IPC.
   A line break would end the .env line and start another variable; the core
   sends the key as a header value, which must be ASCII
   (src/integrations/composio-integration.ts); and a quote, `#` or backslash
   would be quoted or escaped by the dotenv writer in a way load-dotenv.ts
   does not undo, so the agent would load a different string than the one
   Composio accepted. The value is never quoted back. */
const COMPOSIO_KEY_RE = /^[A-Za-z0-9_.:+\/=-]{8,512}$/;
export function composioKeyValueError(value: unknown): string | null {
  return typeof value === "string" && COMPOSIO_KEY_RE.test(value) ? null : COMPOSIO_KEY_INVALID;
}

export type ComposioCheck =
  | { ok: true; sessionId: string; mcpUrl: string }
  /** `rejected`: Composio refused the key itself (401/403). Otherwise it could not be checked. */
  | { ok: false; rejected: boolean; status: number; error: string };

export interface CheckComposioKeyOptions {
  apiKey: string;
  /** The stable install id connected accounts hang off (`composio.userId`). */
  userId: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * createComposioSession, as a verdict instead of a throw: the same request
 * and the same error texts (minus the TUI's "Check the key in the
 * Integrations tab"). The agent has no CLI verb or HTTP route that checks a
 * Composio key (its only caller is the boot path and the TUI, in process),
 * so main repeats the one call rather than spawning an agent for it.
 */
export async function checkComposioKey(opts: CheckComposioKeyOptions): Promise<ComposioCheck> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${opts.baseUrl ?? COMPOSIO_API_BASE}/tool_router/session`, {
      method: "POST",
      headers: { [COMPOSIO_API_KEY_HEADER]: opts.apiKey, "Content-Type": "application/json" },
      // The workbench stays off, as in the core: it would route shell work through a third party.
      body: JSON.stringify({ user_id: opts.userId, workbench: { enable: false } }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, rejected: false, status: 0, error: `Could not reach Composio: ${reachError(err)}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, rejected: true, status: res.status, error: `Composio rejected the API key (HTTP ${res.status}).` };
  }
  if (!res.ok) {
    return { ok: false, rejected: false, status: res.status, error: `Composio returned HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, rejected: false, status: res.status, error: "Composio returned a non-object session body." };
  }
  // composio-api.ts parseSessionResponse: session_id and mcp.url, both non-empty.
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const sessionId = obj.session_id;
  const mcp = obj.mcp && typeof obj.mcp === "object" ? (obj.mcp as Record<string, unknown>) : {};
  const mcpUrl = mcp.url;
  if (typeof sessionId !== "string" || !sessionId || typeof mcpUrl !== "string" || !mcpUrl) {
    return {
      ok: false, rejected: false, status: res.status,
      error: typeof sessionId !== "string" || !sessionId ? "Composio session response carried no session_id." : "Composio session response carried no mcp.url.",
    };
  }
  return { ok: true, sessionId, mcpUrl };
}

/* A network failure in words, without the request: a timeout says so,
   anything else is the error's own message (fetch's are about the host and
   the socket, never the headers). */
function reachError(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "the request timed out.";
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : null;
  const msg = cause || (err instanceof Error ? err.message : String(err));
  return msg.endsWith(".") ? msg : `${msg}.`;
}

/* The value `<stateDir>/.env` holds for `key`, read the way
   src/config/load-dotenv.ts parseLine reads it (trimmed, `#` comments, the
   first `=`, one pair of surrounding quotes stripped). Undefined when the
   file or the key is missing, or the value is empty. */
export function readDotenvValue(stateDir: string, key: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(stateDir, ".env"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1 || trimmed.slice(0, eq).trim() !== key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    // The first non-empty line wins: load-dotenv.ts skips a name once it is set, and dotenvSet edits the first match.
    if (value.trim()) return value.trim();
  }
  return undefined;
}

/** The effects saveComposioKey / removeComposioKey / checkSavedComposioKey need. */
export interface ComposioDeps {
  stateDir: string;
  /** This app's environment: a key set there wins over `.env` in the agent (load-dotenv.ts skips it). */
  env: NodeJS.ProcessEnv;
  /** agent-cli.ts dotenvSet: atomic, 0600, null removes. */
  dotenvSet: (stateDir: string, key: string, value: string | null) => { ok: boolean; error?: string };
  /** The effective `composio` block (`atag config get composio`). */
  readComposio: () => Promise<{ ok: boolean; value?: unknown; error?: string }>;
  /** Writes `composio.<leaf>` for each entry, in one config write. */
  writeComposio: (patch: Record<string, string | null>) => Promise<{ ok: boolean; error?: string }>;
  check?: (opts: CheckComposioKeyOptions) => Promise<ComposioCheck>;
  mintId?: () => string;
}

export interface ComposioKeyResult {
  ok: boolean;
  /** Composio accepted the key just now. */
  verified: boolean;
  /** Composio refused the key (only on a failed save or check). */
  rejected?: boolean;
  error?: string;
  /** The key is saved, but something after it did not go through. */
  warning?: string;
  /** COMPOSIO_API_KEY is set in this app's environment, so the agent uses that one, not the file's. */
  shadowed: boolean;
}

/* load-dotenv.ts skips a .env line whenever the variable is already non-empty in the environment. */
function shadowedBy(env: NodeJS.ProcessEnv): boolean {
  const v = env[COMPOSIO_API_KEY_ENV];
  return typeof v === "string" && v.length > 0;
}

/* The install's user id: the saved one, else a new random UUID (never an
   email: ensure-composio-session.ts). Null when the config cannot be read,
   because minting a second id then would orphan every connected account. */
async function userIdOf(deps: ComposioDeps): Promise<{ userId: string; minted: boolean } | { error: string }> {
  const cfg = await deps.readComposio();
  if (!cfg.ok) return { error: `Could not read the settings: ${cfg.error ?? "unknown error"}` };
  const block = cfg.value && typeof cfg.value === "object" ? (cfg.value as Record<string, unknown>) : {};
  const saved = typeof block.userId === "string" ? block.userId.trim() : "";
  return saved ? { userId: saved, minted: false } : { userId: (deps.mintId ?? randomUUID)(), minted: true };
}

/**
 * Save Composio API key: check it, write it to `.env`, then cache the new
 * session in config.json (or drop the old one: a session belongs to the key
 * that created it, integrations-orchestrator.ts applyComposio).
 */
export async function saveComposioKey(deps: ComposioDeps, value: unknown): Promise<ComposioKeyResult> {
  const shadowed = shadowedBy(deps.env);
  const invalid = composioKeyValueError(value);
  if (invalid) return { ok: false, verified: false, error: invalid, shadowed };
  const apiKey = value as string;
  const id = await userIdOf(deps);
  if ("error" in id) return { ok: false, verified: false, error: id.error, shadowed };
  const verdict = await (deps.check ?? checkComposioKey)({ apiKey, userId: id.userId });
  if (!verdict.ok && verdict.rejected) return { ok: false, verified: false, rejected: true, error: verdict.error, shadowed };
  const wrote = deps.dotenvSet(deps.stateDir, COMPOSIO_API_KEY_ENV, apiKey);
  if (!wrote.ok) return { ok: false, verified: false, error: `Could not save the key: ${wrote.error ?? "unknown error"}`, shadowed };
  /* The session belongs to the key that made it. With COMPOSIO_API_KEY in
     this app's environment the agent loads that key, not this one, so the
     typed key's session is not cached; the agent mints one for its own key. */
  const persisted = await deps.writeComposio(verdict.ok && !shadowed
    ? { userId: id.userId, sessionId: verdict.sessionId, mcpUrl: verdict.mcpUrl }
    : { userId: id.userId, sessionId: null, mcpUrl: null });
  const warnings: string[] = [];
  if (!verdict.ok) warnings.push(`The key is saved, but it could not be checked. ${verdict.error}`);
  if (!persisted.ok) warnings.push(`The key is saved, but the Composio settings could not be updated: ${persisted.error ?? "unknown error"}`);
  return { ok: true, verified: verdict.ok, shadowed, ...(warnings.length ? { warning: warnings.join(" ") } : {}) };
}

/** Remove the key from `.env` and forget the session it made; the user id stays (clearComposioSession). */
export async function removeComposioKey(deps: ComposioDeps): Promise<ComposioKeyResult> {
  const shadowed = shadowedBy(deps.env);
  const wrote = deps.dotenvSet(deps.stateDir, COMPOSIO_API_KEY_ENV, null);
  if (!wrote.ok) return { ok: false, verified: false, error: `Could not remove the key: ${wrote.error ?? "unknown error"}`, shadowed };
  const persisted = await deps.writeComposio({ sessionId: null, mcpUrl: null });
  return {
    ok: true, verified: false, shadowed,
    ...(persisted.ok ? {} : { warning: `The key is removed, but the Composio settings could not be updated: ${persisted.error ?? "unknown error"}` }),
  };
}

/**
 * Check again: the key the agent would load (this app's environment first,
 * then `.env`), checked the same way. A good answer is cached as the
 * session, so a restart after a dropped session (the core's forceRefresh)
 * starts on a fresh one.
 */
export async function checkSavedComposioKey(deps: ComposioDeps): Promise<ComposioKeyResult> {
  const shadowed = shadowedBy(deps.env);
  const fromEnv = shadowed ? deps.env[COMPOSIO_API_KEY_ENV]!.trim() : "";
  const apiKey = shadowed ? fromEnv : readDotenvValue(deps.stateDir, COMPOSIO_API_KEY_ENV);
  if (!apiKey) return { ok: false, verified: false, error: "No Composio API key is saved.", shadowed };
  const id = await userIdOf(deps);
  if ("error" in id) return { ok: false, verified: false, error: id.error, shadowed };
  const verdict = await (deps.check ?? checkComposioKey)({ apiKey, userId: id.userId });
  if (!verdict.ok) return { ok: false, verified: false, rejected: verdict.rejected, error: verdict.error, shadowed };
  const persisted = await deps.writeComposio({ userId: id.userId, sessionId: verdict.sessionId, mcpUrl: verdict.mcpUrl });
  return {
    ok: true, verified: true, shadowed,
    ...(persisted.ok ? {} : { warning: `The key works, but the Composio settings could not be updated: ${persisted.error ?? "unknown error"}` }),
  };
}
