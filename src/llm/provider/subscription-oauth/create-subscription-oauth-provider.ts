import type { LlmProviderConfigEntry } from "../registry/provider-types.js";
import { CHATGPT_SERVICE, createChatgptTokenRefresher } from "./chatgpt-codex.js";
import { createFileTokenStore, subscriptionTokenPath, type FileTokenStore } from "./credential-store.js";
import type { FetchLike } from "./oauth-types.js";
import {
  SubscriptionOAuthProvider,
  type ResponsesFetch,
} from "./subscription-oauth-provider.js";

/** The ChatGPT token file for a state dir, shared by the provider and `atag login`. */
export function chatgptCredentialStore(
  stateDir: string,
  onWarning?: (message: string) => void,
): FileTokenStore {
  return createFileTokenStore({
    path: subscriptionTokenPath(stateDir, CHATGPT_SERVICE),
    ...(onWarning ? { onWarning } : {}),
  });
}

/** `globalThis.fetch` in the primitives' narrower form-POST shape. */
export const globalFormFetch: FetchLike = (url, init) =>
  globalThis.fetch(url, init) as unknown as ReturnType<FetchLike>;

export interface CreateSubscriptionOAuthProviderOptions {
  entry: LlmProviderConfigEntry;
  stateDir: string;
  onWarning?: (message: string) => void;
  /** Test seams. */
  fetch?: ResponsesFetch;
  formFetch?: FetchLike;
}

/** Builds the EXPERIMENTAL `subscription-oauth` provider for a config entry. */
export function createSubscriptionOAuthProvider(
  options: CreateSubscriptionOAuthProviderOptions,
): SubscriptionOAuthProvider {
  const service = options.entry.subscriptionOauth?.service ?? CHATGPT_SERVICE;
  if (service !== CHATGPT_SERVICE) {
    throw new Error(`subscription-oauth provider "${options.entry.id}" names an unknown service "${service}"`);
  }
  const store = chatgptCredentialStore(options.stateDir, options.onWarning);
  const refresher = createChatgptTokenRefresher({
    store,
    fetch: options.formFetch ?? globalFormFetch,
  });
  return new SubscriptionOAuthProvider({
    id: options.entry.id,
    store,
    refresher,
    ...(options.entry.defaultChatModel ? { model: options.entry.defaultChatModel } : {}),
    // `entry.baseUrl` is ignored on purpose: the ChatGPT tokens are only
    // ever sent to the ChatGPT Codex backend, never to a URL a config
    // file names.
    ...(options.entry.requestTimeoutMs ? { requestTimeoutMs: options.entry.requestTimeoutMs } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
