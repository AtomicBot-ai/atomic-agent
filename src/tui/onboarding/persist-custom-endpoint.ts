/**
 * Save a custom endpoint the operator typed on the first-run
 * "Custom endpoint" screen, in whichever wire format it actually speaks.
 *
 * The screen asks for a llama-server and probes `GET /health`. A hosted
 * OpenAI-compatible endpoint (`https://models.example.com/v1`) answers
 * 404 there, and the operator used to get "local-llm /health failed at
 * …: http 404" — a message about the wrong question, with no way
 * forward from that screen. This module asks the right question
 * (`detectOpenAiCompatEndpoint`) and, when the answer is yes, saves the
 * endpoint as an `openai-compatible` provider and makes it active.
 */

import { getConfig } from "../../config/index.js";
import {
  setActiveTextProviderInConfig,
  upsertLlmProvider,
} from "../../config/llm-provider-commands.js";
import type { UserLlmProviderEntry } from "../../config/llm-config.js";
import {
  detectOpenAiCompatEndpoint,
  type OpenAiCompatDetection,
} from "../../llm/detect-openai-compat-endpoint.js";
import {
  createProvidersWizardState,
  type ProvidersWizardState,
} from "../providers/providers-wizard-state.js";

/** A provider id from a host: `models.example.com` -> `models-example-com`. */
export function providerIdForEndpoint(baseUrl: string): string {
  let host = baseUrl;
  try {
    const parsed = new URL(baseUrl);
    // The port is part of the identity: two servers on one host (a GPU
    // box running chat on 8080 and embeddings on 8081) must not collide.
    host = parsed.port ? `${parsed.hostname}-${parsed.port}` : parsed.hostname;
  } catch {
    // Keep the raw string; the caller already validated it.
  }
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // The config's provider id rule: `^[a-z][a-z0-9-]{0,31}$`.
  const prefixed = /^[a-z]/.test(slug) ? slug : `custom-${slug}`;
  const safe = prefixed.slice(0, 32).replace(/-+$/, "");
  return safe.length > 0 ? safe : "custom-endpoint";
}

/** A free id: `groq`, then `groq-2`, `groq-3`, … */
export function freeProviderId(
  base: string,
  taken: readonly string[],
): string {
  const root = providerIdForEndpoint(base);
  if (!taken.includes(root)) return root;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${root}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${root}-${Date.now()}`;
}

export interface SavedCustomEndpoint {
  readonly entry: UserLlmProviderEntry;
  readonly detection: OpenAiCompatDetection;
}

/**
 * The provider wizard a key-protected custom endpoint hands off to: the
 * operator's URL already filled in, on the key screen, so the only thing
 * left to do is paste the key.
 *
 * The custom-endpoint screen has no key field, and telling the operator
 * "not an OpenAI-compatible endpoint" when the route answered 401 sends
 * them looking for a different URL that does not exist.
 */
export function customEndpointKeyWizard(baseUrl: string): ProvidersWizardState {
  return {
    ...createProvidersWizardState("add", {
      kind: "openai-compatible",
      baseUrl,
    }),
    phase: "api_key",
  };
}

/**
 * Probe `base` for an OpenAI-compatible model list and, when it answers,
 * save it as the active text provider. Returns `null` when the endpoint
 * is not OpenAI-compatible, so the caller keeps its llama-server error.
 *
 * The model is the first id the server lists: the operator has not
 * picked one on this screen, and a provider entry needs a chat model.
 * They can change it later in the LLM tab.
 */
export async function saveCustomOpenAiCompatEndpoint(
  base: string,
  options: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    /** Bearer key, when the operator has already supplied one. */
    apiKey?: string;
  } = {},
): Promise<SavedCustomEndpoint | null> {
  const detection = await detectOpenAiCompatEndpoint(base, options);
  if (!detection) return null;
  const model = detection.models[0];
  if (!model) return null;

  const taken = (getConfig().llm?.providers ?? []).map((p) => p.id);
  const entry: UserLlmProviderEntry = {
    id: freeProviderId(detection.baseUrl, taken),
    kind: "openai-compatible",
    baseUrl: detection.baseUrl,
    defaultChatModel: model,
  };
  const saved = upsertLlmProvider(entry);
  setActiveTextProviderInConfig(saved.id);
  return { entry: saved, detection };
}
