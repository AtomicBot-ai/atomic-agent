import { getConfig, resolveStateDir } from "../config/index.js";
import { SUBSCRIPTION_OAUTH_KIND } from "../config/provider-auth-mode.js";
import { upsertLlmProvider } from "../config/llm-provider-commands.js";
import { copilotCredentialStore, globalFormFetch } from "../llm/provider/subscription-oauth/create-subscription-oauth-provider.js";
import {
  COPILOT_DEFAULT_MODEL,
  completeCopilotDeviceLogin,
  requestCopilotDeviceCode,
} from "../llm/provider/subscription-oauth/github-copilot.js";
import { signOut } from "../llm/provider/subscription-oauth/logout.js";
import { OAuthFlowError } from "../llm/provider/subscription-oauth/oauth-errors.js";
import type { DeviceAuthorization } from "../llm/provider/subscription-oauth/device-code.js";
import type { FileTokenStore } from "../llm/provider/subscription-oauth/credential-store.js";
import type { OAuthTokens } from "../llm/provider/subscription-oauth/oauth-types.js";
import { offerActivation, type LoginCommandDeps } from "./login-command.js";

/**
 * ATO-462 — `atag login copilot` / `atag logout copilot` /
 * `atag login status copilot`: the EXPERIMENTAL GitHub Copilot sign-in,
 * on the ATO-1448 sign-in framework. Nadya's decision (18.11): Copilot
 * only, not Claude, not Grok.
 *
 * GitHub's device flow only: a link (github.com/login/device) and a
 * code, the way `gh auth login`, pi, opencode, OpenClaw and Hermes sign
 * in to Copilot. GitHub offers Copilot no browser-redirect sign-in for
 * other apps, so there is no `--device` switch here.
 *
 * The GitHub token goes to `<stateDir>/auth/copilot.json` (0600) and a
 * `subscription-oauth` entry with `service: "copilot"` is added to
 * config.json when there is none. Nothing printed here contains a token.
 */

/** The entry `atag login copilot` adds when none exists. */
export const COPILOT_PROVIDER_ID = "copilot-sub";

export interface CopilotLoginDeps {
  store?: FileTokenStore;
  requestDevice?: (signal: AbortSignal) => Promise<DeviceAuthorization>;
  completeDevice?: (code: DeviceAuthorization, signal: AbortSignal) => Promise<OAuthTokens>;
  ensureProviderEntry?: (model: string) => { id: string; added: boolean };
}

function copilotStore(deps: LoginCommandDeps, write?: (t: string) => void): FileTokenStore {
  return (
    deps.copilot?.store ??
    copilotCredentialStore(deps.stateDir ?? resolveStateDir(), write ? (m) => write(`${m}\n`) : undefined)
  );
}

/** The first Copilot entry, or a new `copilot-sub` one. A model already picked stays. */
export function defaultEnsureCopilotEntry(model: string): { id: string; added: boolean } {
  const providers = getConfig().llm?.providers ?? [];
  const existing = providers.find(
    (p) => p.kind === SUBSCRIPTION_OAUTH_KIND && p.subscriptionOauth?.service === "copilot",
  );
  if (existing) return { id: existing.id, added: false };
  const taken = new Set(providers.map((p) => p.id));
  let id = COPILOT_PROVIDER_ID;
  for (let n = 2; taken.has(id); n++) id = `${COPILOT_PROVIDER_ID}-${n}`;
  upsertLlmProvider({
    id,
    kind: SUBSCRIPTION_OAUTH_KIND,
    subscriptionOauth: { service: "copilot" },
    defaultChatModel: model,
  });
  return { id, added: true };
}

/** One sentence per failure, never GitHub's own text or a token. */
export function describeCopilotLoginFailure(err: unknown): string {
  if (err instanceof OAuthFlowError) {
    switch (err.code) {
      case "cancelled":
        return "Sign-in cancelled.";
      case "device_code_expired":
        return "The code expired before it was entered. Run the command again for a new one.";
      case "authorization_denied":
        return "Sign-in was not approved on github.com.";
      case "network_error":
        return "Cannot reach github.com. Check the connection and try again.";
      default:
        return `Sign-in failed (${err.code}${err.status ? `, ${err.status}` : ""}).`;
    }
  }
  return "Sign-in failed.";
}

function minutesLeft(code: DeviceAuthorization, now: number): number {
  return Math.max(1, Math.round((code.expiresAt - now) / 60_000));
}

export async function loginCopilot(
  rest: string[],
  deps: LoginCommandDeps,
  write: (t: string) => void,
  help: string,
): Promise<number> {
  if (rest.length > 0) {
    write(`unknown option "${rest[0]}"\n\n${help}\n`);
    return 2;
  }
  const store = copilotStore(deps, write);
  const abort = new AbortController();
  const onSigint = (): void => abort.abort();
  process.once("SIGINT", onSigint);
  write("GitHub Copilot sign-in (experimental; needs an active Copilot plan on the GitHub account).\n");
  try {
    const requestDevice =
      deps.copilot?.requestDevice ?? ((signal) => requestCopilotDeviceCode({ fetch: globalFormFetch, signal }));
    const completeDevice =
      deps.copilot?.completeDevice ??
      ((code, signal) => completeCopilotDeviceLogin({ fetch: globalFormFetch, signal }, code));
    const code = await requestDevice(abort.signal);
    const now = (deps.now ?? Date.now)();
    write(
      [
        "",
        `1. Open ${code.verificationUri} on any device and sign in to GitHub.`,
        `2. Enter this code (expires in ${minutesLeft(code, now)} minutes): ${code.userCode}`,
        "",
        "Only continue if you started this sign-in. If someone else gave you this code, stop.",
        "Waiting for approval... (Ctrl+C to cancel)",
        "",
      ].join("\n"),
    );
    const tokens = await completeDevice(code, abort.signal);
    await store.save(tokens);
    const entry = (deps.copilot?.ensureProviderEntry ?? defaultEnsureCopilotEntry)(COPILOT_DEFAULT_MODEL);
    write(
      "Signed in to GitHub.\n" +
        (entry.added
          ? `Added provider "${entry.id}" (GitHub Copilot subscription, experimental), model ${COPILOT_DEFAULT_MODEL}.\n`
          : `Provider "${entry.id}" now uses this sign-in.\n`),
    );
    await offerActivation(entry.id, deps, write, "GitHub Copilot");
    return 0;
  } catch (err) {
    write(`${describeCopilotLoginFailure(err)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

export async function copilotLoginStatus(
  rest: string[],
  deps: LoginCommandDeps,
  write: (t: string) => void,
  help: string,
): Promise<number> {
  let json = false;
  for (const a of rest) {
    if (a === "--json") json = true;
    else {
      write(`unknown option "${a}"\n\n${help}\n`);
      return 2;
    }
  }
  const store = copilotStore(deps);
  let tokens: OAuthTokens | null = null;
  try {
    tokens = await store.load();
  } catch {
    tokens = null;
  }
  // Signed in to GitHub; whether the account has Copilot shows on the first request.
  const signedIn = tokens !== null && tokens.accessToken.length > 0;
  if (json) {
    write(`${JSON.stringify({ service: "copilot", experimental: true, signedIn, tokenFile: store.path }, null, 2)}\n`);
  } else {
    write(
      signedIn
        ? "GitHub Copilot (experimental)  signed in to GitHub.\n"
        : "GitHub Copilot (experimental)  not signed in. Run: atomic-agent login copilot\n",
    );
  }
  return signedIn ? 0 : 1;
}

export async function logoutCopilot(deps: LoginCommandDeps, write: (t: string) => void): Promise<number> {
  const store = copilotStore(deps);
  try {
    // Local delete only, as for ChatGPT: the GitHub grant itself is
    // revoked at github.com/settings/applications.
    const result = await signOut(store);
    write(
      result.hadTokens
        ? "Signed out of GitHub Copilot (experimental). The stored sign-in was deleted. To revoke it on GitHub too, see github.com/settings/applications.\n"
        : "Not signed in to GitHub Copilot; nothing to delete.\n",
    );
    return 0;
  } catch {
    write(`Could not delete ${store.path}. Delete it by hand to sign out.\n`);
    return 1;
  }
}
