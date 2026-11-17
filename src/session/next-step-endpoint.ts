import type { SessionState } from "./session-state.js";
import {
  NEXT_STEP_MAX_TOKENS,
  NEXT_STEP_SYSTEM,
  buildNextStepPrompt,
  lastExchangeOf,
  sanitizeNextStep,
} from "./session-next-step.js";

/**
 * A separate model for next-step suggestions (ATO-1097, epic ATO-995).
 *
 * By default the suggestion is written by the chat model itself, in its
 * side-call slot. On a small machine that side call competes with the
 * next turn for the same weights. This lets the operator point the
 * suggestion at a second, smaller model they already run (a second
 * llama-server, LM Studio, Ollama): any OpenAI-compatible
 * `/chat/completions` endpoint.
 *
 * Same idea as Continue's separate `tabAutocompleteModel` and Claude
 * Code's `ANTHROPIC_SMALL_FAST_MODEL`: the main model answers, a small
 * one does the cheap helper call. First slice: environment variables
 * only, so nothing in the config file changes. A managed second
 * process started by the agent itself is the follow-up.
 *
 * - `ATOMIC_AGENT_NEXT_STEP_URL`   base URL, e.g. `http://127.0.0.1:8081/v1`
 * - `ATOMIC_AGENT_NEXT_STEP_MODEL` model name sent in the request (optional)
 * - `ATOMIC_AGENT_NEXT_STEP_API_KEY` bearer key (optional)
 *
 * The switch `tui.nextStepSuggestions` still decides whether any call
 * runs; these only choose where it goes.
 */
export interface NextStepEndpoint {
  /** Full URL of the `/chat/completions` route. */
  url: string;
  model: string | null;
  apiKey: string | null;
}

export const NEXT_STEP_URL_ENV = "ATOMIC_AGENT_NEXT_STEP_URL";
export const NEXT_STEP_MODEL_ENV = "ATOMIC_AGENT_NEXT_STEP_MODEL";
export const NEXT_STEP_API_KEY_ENV = "ATOMIC_AGENT_NEXT_STEP_API_KEY";

function nonEmpty(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value ? value : null;
}

/**
 * `http://host:port`, `http://host:port/v1` or a full
 * `.../chat/completions` URL, normalised to the completions route.
 * `null` for anything that is not an http(s) URL.
 */
export function chatCompletionsUrl(base: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.search = "";
  parsed.hash = "";
  let path = parsed.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/chat/completions")) {
    if (!/\/v\d+$/.test(path)) path = `${path}/v1`;
    path = `${path}/chat/completions`;
  }
  parsed.pathname = path;
  return parsed.toString();
}

/** The endpoint from the environment, or `null` when none (or a bad URL) is set. */
export function readNextStepEndpoint(env: NodeJS.ProcessEnv = process.env): NextStepEndpoint | null {
  const base = nonEmpty(env[NEXT_STEP_URL_ENV]);
  if (base === null) return null;
  const url = chatCompletionsUrl(base);
  if (url === null) return null;
  return {
    url,
    model: nonEmpty(env[NEXT_STEP_MODEL_ENV]),
    apiKey: nonEmpty(env[NEXT_STEP_API_KEY_ENV]),
  };
}

export interface NextStepEndpointDeps {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onError?: (err: unknown) => void;
}

/** The answer text of an OpenAI-style chat completion body, or "". */
export function chatCompletionText(body: unknown): string {
  const choices = (body as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as { message?: { content?: unknown } } | null)?.message;
  return typeof message?.content === "string" ? message.content : "";
}

/**
 * Ask the separate model for the suggestion. Same prompt, same
 * clean-up and same `null` contract as `generateNextStep`. Never throws.
 */
export async function generateNextStepViaEndpoint(
  state: SessionState,
  endpoint: NextStepEndpoint,
  deps: NextStepEndpointDeps = {},
): Promise<string | null> {
  const exchange = lastExchangeOf(state);
  if (exchange === null) return null;
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
      },
      body: JSON.stringify({
        ...(endpoint.model ? { model: endpoint.model } : {}),
        messages: [
          { role: "system", content: NEXT_STEP_SYSTEM },
          { role: "user", content: buildNextStepPrompt(exchange.request, exchange.reply) },
        ],
        max_tokens: NEXT_STEP_MAX_TOKENS,
        temperature: 0.2,
        stream: false,
      }),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    if (!response.ok) throw new Error(`next-step endpoint answered HTTP ${response.status}`);
    return sanitizeNextStep(chatCompletionText(await response.json()));
  } catch (err) {
    deps.onError?.(err);
    return null;
  }
}
