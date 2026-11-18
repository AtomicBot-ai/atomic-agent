import type { LlmProvider } from "../llm-provider.js";
import { OpenAiProvider } from "../openai/openai-provider.js";
import type { LlmProviderConfigEntry } from "../registry/provider-types.js";
import { CHATGPT_SERVICE, createChatgptTokenRefresher } from "./chatgpt-codex.js";
import { createFileTokenStore, subscriptionTokenPath, type FileTokenStore } from "./credential-store.js";
import {
  COPILOT_API_BASE_URL,
  COPILOT_DEFAULT_MODEL,
  COPILOT_EDITOR_HEADERS,
  COPILOT_SERVICE,
  createCopilotTokenSource,
  sharedCopilotTokenSource,
  type CopilotGetFetch,
} from "./github-copilot.js";
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

/** The GitHub Copilot sign-in file for a state dir (ATO-462). */
export function copilotCredentialStore(
  stateDir: string,
  onWarning?: (message: string) => void,
): FileTokenStore {
  return createFileTokenStore({
    path: subscriptionTokenPath(stateDir, COPILOT_SERVICE),
    ...(onWarning ? { onWarning } : {}),
  });
}

const globalGetFetch: CopilotGetFetch = (url, init) =>
  globalThis.fetch(url, init) as unknown as ReturnType<CopilotGetFetch>;

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
  /** Copilot token exchange; replaces the shared per-file token source. */
  copilotTokenFetch?: CopilotGetFetch;
  /** Copilot chat requests. */
  copilotChatFetch?: typeof fetch;
}

/** Builds the EXPERIMENTAL `subscription-oauth` provider for a config entry. */
export function createSubscriptionOAuthProvider(
  options: CreateSubscriptionOAuthProviderOptions,
): LlmProvider {
  const service = options.entry.subscriptionOauth?.service ?? CHATGPT_SERVICE;
  if (service === COPILOT_SERVICE) return createCopilotProvider(options);
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

/**
 * EXPERIMENTAL (ATO-462): a GitHub Copilot plan signed in by `atag login
 * copilot`. Copilot speaks OpenAI chat completions, so this is the
 * ordinary OpenAI-compatible client with a key that is the short-lived
 * Copilot token (`github-copilot.ts`). `entry.baseUrl` is ignored on
 * purpose, as for ChatGPT: the GitHub sign-in is only ever exchanged at
 * api.github.com and the Copilot token only sent to api.githubcopilot.com.
 */
function createCopilotProvider(options: CreateSubscriptionOAuthProviderOptions): LlmProvider {
  const store = copilotCredentialStore(options.stateDir, options.onWarning);
  const create = () =>
    createCopilotTokenSource({ store, fetch: options.copilotTokenFetch ?? globalGetFetch });
  const apiKeySource = options.copilotTokenFetch
    ? create()
    : sharedCopilotTokenSource(store.path, create);
  return new OpenAiProvider({
    id: options.entry.id,
    providerKind: "openai-compatible",
    baseUrl: COPILOT_API_BASE_URL,
    apiKey: "",
    apiKeySource,
    headers: { ...COPILOT_EDITOR_HEADERS, "openai-intent": "conversation-agent" },
    defaultChatModel: options.entry.defaultChatModel ?? COPILOT_DEFAULT_MODEL,
    supportsParallelTools: true,
    ...(options.entry.requestTimeoutMs ? { requestTimeoutMs: options.entry.requestTimeoutMs } : {}),
    ...(options.copilotChatFetch ? { fetchImpl: options.copilotChatFetch } : {}),
  });
}
