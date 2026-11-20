import { createInterface } from "node:readline/promises";

import { getConfig, resolveStateDir } from "../config/index.js";
import { SUBSCRIPTION_OAUTH_KIND } from "../config/provider-auth-mode.js";
import {
  setActiveTextProviderInConfig,
  setProviderDefaultChatModelInConfig,
  upsertLlmProvider,
} from "../config/llm-provider-commands.js";
import { resolveLlmConfig } from "../llm/provider/registry/provider-types.js";
import { isLocalLinkWithoutModel } from "../runtime/local-link-availability.js";
import {
  ChatgptNoAccountError,
  codexDefaultModel,
  OAuthFlowError,
  chatgptAccountId,
  chatgptCredentialStore,
  chatgptPlanType,
  completeChatgptDeviceLogin,
  globalFormFetch,
  requestChatgptDeviceCode,
  signOut,
  startChatgptBrowserLogin,
  type BrowserLogin,
  type ChatgptDeviceCode,
  type FileTokenStore,
  type JsonFetchLike,
  type OAuthTokens,
} from "../llm/provider/subscription-oauth/index.js";

/**
 * ATO-1454 — `atag login chatgpt` / `atag logout chatgpt` /
 * `atag login status`: the EXPERIMENTAL ChatGPT sign-in without the
 * Codex CLI (ATO-1448). Browser sign-in by default, `--device` for a
 * machine without a browser (SSH): a link and a one-time code, the same
 * flow `codex login --device-auth` uses.
 *
 * On success the tokens go to `<stateDir>/auth/chatgpt.json` (0600; a
 * new sign-in overwrites the old one) and a `subscription-oauth` provider
 * entry is added to config.json if there is none. Nothing printed here
 * ever contains a token.
 *
 * Nadya's answers (18.11):
 *  - The entry's model is Codex's current default, read from the same
 *    catalog Codex reads (`codexDefaultModel`), not a name pinned here.
 *  - If ChatGPT is the only provider the person has, it becomes the
 *    active one at once. With other providers it asks "Use ChatGPT now?"
 *    in a terminal; without a terminal it only says how to switch.
 */

const LOGIN_HELP = [
  "Usage: atomic-agent login chatgpt [--device] [--no-browser]",
  "       atomic-agent login status [--json]",
  "",
  "EXPERIMENTAL: sign in with your ChatGPT plan without the Codex CLI.",
  "The Codex CLI provider stays the recommended way; this one may stop",
  "working if OpenAI changes its sign-in.",
  "",
  "  --device       Sign in on another device with a link and a code (for SSH)",
  "  --no-browser   Print the sign-in link instead of opening the browser",
  "  --json         (status) Print the sign-in state as JSON",
].join("\n");

const LOGOUT_HELP = [
  "Usage: atomic-agent logout chatgpt",
  "",
  "Deletes the stored ChatGPT sign-in (experimental). The provider entry stays",
  "in config.json and asks you to sign in again when it is used.",
].join("\n");

/** Matches `codex login`'s wait: the browser receiver gives up after this. */
const BROWSER_TIMEOUT_MS = 10 * 60_000;
/** The entry `atag login chatgpt` adds when none of this kind exists. */
export const CHATGPT_PROVIDER_ID = "chatgpt-sub";

export interface LoginCommandDeps {
  write?: (text: string) => void;
  stateDir?: string;
  store?: FileTokenStore;
  startBrowser?: (signal: AbortSignal) => Promise<BrowserLogin>;
  /**
   * Opens the sign-in page in the browser; without it the link is printed.
   * Injected by the CLI composition root (src/cli/index.ts): CLI commands
   * do not import src/tui directly (scripts/check-imports.mjs).
   */
  openUrl?: (url: string) => Promise<{ ok: boolean }>;
  requestDevice?: (signal: AbortSignal) => Promise<ChatgptDeviceCode>;
  completeDevice?: (code: ChatgptDeviceCode, signal: AbortSignal) => Promise<OAuthTokens>;
  /** Adds the provider entry when missing; returns its id and whether it was added. */
  ensureProviderEntry?: (model: string) => { id: string; added: boolean };
  /** Codex's current default model for this sign-in (`codexDefaultModel`). */
  defaultModel?: (tokens: OAuthTokens) => Promise<{ model: string; source: "backend" | "fallback" }>;
  /** Whether the entry is active already, the only provider, or one of several. */
  activation?: (id: string) => Activation;
  setActive?: (id: string) => void;
  /** A y/n question in the terminal; absent when there is no terminal. */
  ask?: ((question: string) => Promise<string>) | null;
  now?: () => number;
}

export type Activation = "already-active" | "only-provider" | "has-others";

const jsonFetch: JsonFetchLike = (url, init) =>
  globalThis.fetch(url, init) as unknown as ReturnType<JsonFetchLike>;

function defaultEnsureProviderEntry(model: string): { id: string; added: boolean } {
  const providers = getConfig().llm?.providers ?? [];
  const existing = providers.find((p) => p.kind === SUBSCRIPTION_OAUTH_KIND);
  if (existing) {
    // A model the person picked stays; an entry with none gets Codex's default.
    if (!existing.defaultChatModel) setProviderDefaultChatModelInConfig(existing.id, model);
    return { id: existing.id, added: false };
  }
  const taken = new Set(providers.map((p) => p.id));
  let id = CHATGPT_PROVIDER_ID;
  for (let n = 2; taken.has(id); n++) id = `${CHATGPT_PROVIDER_ID}-${n}`;
  upsertLlmProvider({
    id,
    kind: SUBSCRIPTION_OAUTH_KIND,
    subscriptionOauth: { service: "chatgpt" },
    defaultChatModel: model,
  });
  return { id, added: true };
}

/**
 * Other providers are every entry but this one, except the built-in local
 * model while no model is downloaded for it: a fresh install has that
 * entry, and there is nothing to choose between yet.
 */
export function defaultActivation(id: string): Activation {
  const config = getConfig();
  const llm = resolveLlmConfig(config);
  if (llm.activeTextProvider === id) return "already-active";
  const others = llm.providers.filter((p) => p.id !== id && !isLocalLinkWithoutModel(llm, p.id, config));
  return others.length === 0 ? "only-provider" : "has-others";
}

function terminalAsk(): ((question: string) => Promise<string>) | null {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return null;
  return async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}

/** One sentence per failure, never the server's own text or a token. */
export function describeLoginFailure(err: unknown): string {
  if (err instanceof ChatgptNoAccountError) return err.message;
  if (err instanceof OAuthFlowError) {
    switch (err.code) {
      case "cancelled":
        return "Sign-in cancelled.";
      case "callback_timeout":
        return "Sign-in timed out: the browser never came back. Try again, or use --device.";
      case "callback_port_unavailable":
        return "Ports 1455 and 1457 are both in use (another sign-in still open?). Close it and try again, or use --device.";
      case "device_code_expired":
        return "The code expired before it was entered. Run the command again for a new one.";
      case "state_mismatch":
        return "Sign-in refused: the browser answer did not belong to this attempt.";
      case "authorization_denied":
        return "Sign-in was not approved in the browser.";
      case "network_error":
        return "Cannot reach auth.openai.com. Check the connection and try again.";
      default:
        if (err.oauthError === "device_login_not_enabled") {
          return "Device sign-in is not enabled for this account. Use the browser sign-in instead.";
        }
        return `Sign-in failed (${err.code}${err.status ? `, ${err.status}` : ""}).`;
    }
  }
  return "Sign-in failed.";
}

function expiryLine(tokens: OAuthTokens): string {
  if (tokens.expiresAt === undefined) return "";
  return ` Access token valid until ${new Date(tokens.expiresAt).toISOString()} (renewed automatically).`;
}

export async function loginCommand(args: string[], deps: LoginCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const [target, ...rest] = args;
  if (!target || target === "-h" || target === "--help") {
    write(`${LOGIN_HELP}\n`);
    return target ? 0 : 2;
  }
  if (target === "status") return loginStatus(rest, deps, write);
  if (target !== "chatgpt") {
    write(`unknown sign-in "${target}" (only chatgpt is supported)\n\n${LOGIN_HELP}\n`);
    return 2;
  }
  let device = false;
  let openBrowser = true;
  for (const a of rest) {
    if (a === "--device" || a === "--device-auth") device = true;
    else if (a === "--no-browser") openBrowser = false;
    else {
      write(`unknown option "${a}"\n\n${LOGIN_HELP}\n`);
      return 2;
    }
  }

  const store = deps.store ?? chatgptCredentialStore(deps.stateDir ?? resolveStateDir(), (m) => write(`${m}\n`));
  const abort = new AbortController();
  const onSigint = (): void => abort.abort();
  process.once("SIGINT", onSigint);
  write("ChatGPT sign-in (experimental; the Codex CLI provider stays the recommended way).\n");
  try {
    let tokens: OAuthTokens;
    if (device) {
      const requestDevice = deps.requestDevice ?? ((signal) => requestChatgptDeviceCode({ fetch: jsonFetch, signal }));
      const completeDevice =
        deps.completeDevice ??
        ((code, signal) => completeChatgptDeviceLogin({ fetch: jsonFetch, formFetch: globalFormFetch, signal }, code));
      const code = await requestDevice(abort.signal);
      write(
        [
          "",
          `1. Open ${code.verificationUrl} on any device and sign in.`,
          `2. Enter this code (expires in 15 minutes): ${code.userCode}`,
          "",
          "Only continue if you started this sign-in. If someone else gave you this code, stop.",
          "Waiting for approval... (Ctrl+C to cancel)",
          "",
        ].join("\n"),
      );
      tokens = await completeDevice(code, abort.signal);
    } else {
      const startBrowser =
        deps.startBrowser ??
        ((signal) => startChatgptBrowserLogin({ fetch: globalFormFetch, timeoutMs: BROWSER_TIMEOUT_MS, signal }));
      const login = await startBrowser(abort.signal);
      const opened = openBrowser && deps.openUrl ? await deps.openUrl(login.authorizationUrl) : { ok: false };
      write(
        opened.ok
          ? "Opened the sign-in page in your browser. Waiting... (Ctrl+C to cancel)\n"
          : `Open this link in a browser on this computer to sign in:\n\n${login.authorizationUrl}\n\nWaiting... (Ctrl+C to cancel; on another machine use --device)\n`,
      );
      tokens = await login.tokens;
    }
    await store.save(tokens);
    const picked = await (deps.defaultModel ?? ((t) => codexDefaultModel({ tokens: t, signal: abort.signal })))(tokens);
    const entry = (deps.ensureProviderEntry ?? defaultEnsureProviderEntry)(picked.model);
    const plan = chatgptPlanType(tokens);
    write(
      `Signed in${plan ? ` (ChatGPT ${plan})` : ""}.${expiryLine(tokens)}\n` +
        (entry.added
          ? `Added provider "${entry.id}" (ChatGPT subscription, experimental), model ${picked.model} (${picked.source === "backend" ? "Codex's current default" : "Codex's default; the live list could not be read"}).\n`
          : `Provider "${entry.id}" now uses this sign-in.\n`),
    );
    await offerActivation(entry.id, deps, write);
    return 0;
  } catch (err) {
    write(`${describeLoginFailure(err)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

async function offerActivation(id: string, deps: LoginCommandDeps, write: (t: string) => void): Promise<void> {
  const state = (deps.activation ?? defaultActivation)(id);
  if (state === "already-active") return;
  const setActive = deps.setActive ?? setActiveTextProviderInConfig;
  const activate = (): void => {
    try {
      setActive(id);
      write(`"${id}" is now the active provider.\n`);
    } catch {
      write(`Signed in, but "${id}" could not be made active. Pick it in the Providers panel.\n`);
    }
  };
  if (state === "only-provider") {
    activate();
    return;
  }
  const ask = deps.ask === undefined ? terminalAsk() : deps.ask;
  if (ask === null) {
    write(`To use it, pick "${id}" in the Providers panel.\n`);
    return;
  }
  const answer = await ask("Use ChatGPT now? [y/N] ");
  if (/^y(es)?$/i.test(answer.trim())) {
    activate();
  } else {
    write(`Kept your current provider. To switch later, pick "${id}" in the Providers panel.\n`);
  }
}

async function loginStatus(rest: string[], deps: LoginCommandDeps, write: (t: string) => void): Promise<number> {
  let json = false;
  for (const a of rest) {
    if (a === "--json") json = true;
    else {
      write(`unknown option "${a}"\n\n${LOGIN_HELP}\n`);
      return 2;
    }
  }
  const store = deps.store ?? chatgptCredentialStore(deps.stateDir ?? resolveStateDir());
  let tokens: OAuthTokens | null = null;
  try {
    tokens = await store.load();
  } catch {
    tokens = null;
  }
  const signedIn = tokens !== null && chatgptAccountId(tokens) !== null;
  const report = {
    service: "chatgpt",
    experimental: true,
    signedIn,
    plan: tokens ? chatgptPlanType(tokens) : null,
    accessTokenExpiresAt: tokens?.expiresAt ?? null,
    canRenew: Boolean(tokens?.refreshToken),
    tokenFile: store.path,
  };
  if (json) {
    write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    write(
      signedIn
        ? `ChatGPT (experimental)  signed in${report.plan ? ` (${report.plan})` : ""}.${expiryLine(tokens!)}\n`
        : "ChatGPT (experimental)  not signed in. Run: atomic-agent login chatgpt\n",
    );
  }
  return signedIn ? 0 : 1;
}

export async function logoutCommand(args: string[], deps: LoginCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const [target, ...rest] = args;
  if (!target || target === "-h" || target === "--help") {
    write(`${LOGOUT_HELP}\n`);
    return target ? 0 : 2;
  }
  if (target !== "chatgpt" || rest.length > 0) {
    write(`${LOGOUT_HELP}\n`);
    return 2;
  }
  const store = deps.store ?? chatgptCredentialStore(deps.stateDir ?? resolveStateDir());
  try {
    // No server-side revoke: the token is only deleted here, as
    // opencode's sign-out does. Codex's revoke endpoint is left out
    // until it is checked against the live server.
    const result = await signOut(store);
    write(result.hadTokens ? "Signed out of ChatGPT (experimental). The stored sign-in was deleted.\n" : "Not signed in to ChatGPT; nothing to delete.\n");
    return 0;
  } catch {
    write(`Could not delete ${store.path}. Delete it by hand to sign out.\n`);
    return 1;
  }
}
