/**
 * Studio › "Improve prompt" (ATO-809): one rewrite of the prompt in the box
 * by the chat model the agent uses, without a chat session.
 *
 * `agent:chat` runs a full agent turn and keeps it as a chat, so this asks
 * the active text provider's OpenAI-compatible chat endpoint directly, once,
 * the way the key check does (agent-cli.ts verifyProviderKey). Which provider
 * and model: the active text provider (Fusion: its orchestrator) and that
 * entry's `defaultChatModel ?? model`; a local llama-server is asked on its
 * own URL with the key the agent launched it with (local-llama-key.ts).
 *
 * The window sends only the prompt and the page's kind; the key and the URL
 * stay here. `improveRoute` and `improveRequestBody` / `improvedPromptOf`
 * are pure and tested in test/studio-improve-prompt.test.mjs.
 */

import {
  apiKeyCharsOk,
  chatCompletionsUrl,
  localLlamaUrlFromFile,
  providerIsUsable,
  resolveKeyValue,
  type ProviderEntry,
  type UserConfigShape,
} from "./agent-cli.js";
import { isLocalServerUrl } from "./local-server-url.js";

export type ImproveKind = "image" | "video";

/** CONTRACT.md: a prompt is at most 8000 characters. */
export const IMPROVE_PROMPT_MAX = 8000;

/** The rewrite's own room, and the reserve a thinking pass may spend before it. */
export const IMPROVE_ANSWER_TOKENS = 1024;
export const IMPROVE_THINKING_RESERVE = 3072;

/** A reply with reasoning and no text: the whole budget went on thinking. */
export const IMPROVE_ALL_THINKING = "The model spent its whole answer thinking. Try again or pick a model without thinking.";

/** The line under a greyed button when there is no chat model to ask. */
export const IMPROVE_NO_MODEL = "Set up a chat model in Settings to improve prompts.";

export interface ImproveTarget {
  /** The chat completions endpoint. */
  url: string;
  model: string;
  entry: ProviderEntry;
  /**
   * A server that renders its own chat template (a llama-server, Atomic Core,
   * or an OpenAI-compatible server on this machine or the local network):
   * the request may carry `chat_template_kwargs`. Never a public cloud host.
   */
  local: boolean;
}

export type ImproveRoute = { ok: true; target: ImproveTarget } | { ok: false; why: string };

const llamaChatUrl = (url: string) => `${url.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/chat/completions`;

/**
 * Where an improve request goes for this config, or why it cannot go.
 * `usable` is providerIsUsable (a key, or a keyless local server), passed in
 * so a test does not read the environment.
 */
export function improveRoute(
  cfg: UserConfigShape | null | undefined,
  usable: (entry: ProviderEntry) => boolean = (e) => providerIsUsable(e),
): ImproveRoute {
  const c: UserConfigShape = cfg ?? {};
  const llm = c.llm;
  const run = llm?.runMode;
  const fusion = run?.mode === "fusion" ? run.fusion : undefined;
  const activeId = fusion?.orchestratorProvider || llm?.activeTextProvider || "local-llama";
  const providers = llm?.providers ?? [];
  let entry = providers.find((p) => p.id === activeId);
  // A file with no llm block runs on the local-llama entry the agent synthesizes.
  if (!entry && activeId === "local-llama") entry = { id: "local-llama", kind: "llama-server" };
  if (!entry) return { ok: false, why: IMPROVE_NO_MODEL };

  if (entry.kind === "llama-server") {
    const lm = c.localModels ?? {};
    if (lm.mode === "managed" && !lm.managed?.modelId) return { ok: false, why: "Pick a local chat model in Settings to improve prompts." };
    const url = entry.url || localLlamaUrlFromFile(c);
    const model = entry.defaultChatModel || entry.model || lm.managed?.modelId || "local";
    return { ok: true, target: { url: llamaChatUrl(url), model, entry, local: true } };
  }
  if (entry.kind === "subscription-cli") {
    return { ok: false, why: "Improve prompt needs a cloud provider with an API key or a local model, not a subscription." };
  }
  const url = chatCompletionsUrl(entry.kind, entry.baseUrl);
  const model = (fusion?.orchestratorProvider === entry.id && fusion.orchestratorModel) || entry.defaultChatModel || entry.model;
  if (!url || !model) return { ok: false, why: IMPROVE_NO_MODEL };
  if (!usable(entry)) return { ok: false, why: "Add an API key for the chat model in Settings to improve prompts." };
  return { ok: true, target: { url, model, entry, local: isLocalServerUrl(url) } };
}

function instructions(kind: ImproveKind): string {
  const what = kind === "video" ? "a short video clip" : "a picture";
  const extra = kind === "video" ? " Say what moves and how the camera moves." : "";
  return `You rewrite prompts for an AI model that makes ${what}. Keep the person's idea, subject and language. `
    + `Add concrete visual detail: subject, setting, composition, light, colour and style.${extra} `
    + "Stay under 120 words. Answer with the improved prompt only: no title, no quotes, no notes.";
}

/** The output budget: the rewrite plus a thinking reserve, never above the entry's own cap. */
export function improveMaxTokens(maxOutputTokens?: number): number {
  const want = IMPROVE_ANSWER_TOKENS + IMPROVE_THINKING_RESERVE;
  return typeof maxOutputTokens === "number" && Number.isInteger(maxOutputTokens) && maxOutputTokens > 0
    ? Math.min(want, maxOutputTokens)
    : want;
}

/**
 * The chat completions body for one rewrite. `local` (ImproveTarget.local):
 * ask the server's chat template not to think, which a local reasoning model
 * honours; a public endpoint may reject the unknown field, so it never gets it.
 */
export function improveRequestBody(
  model: string,
  kind: ImproveKind,
  prompt: string,
  opts: { local?: boolean; maxOutputTokens?: number } = {},
): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: "system", content: instructions(kind) },
      { role: "user", content: prompt.trim().slice(0, IMPROVE_PROMPT_MAX) },
    ],
    // Room for a reasoning model's thinking before the answer.
    max_tokens: improveMaxTokens(opts.maxOutputTokens),
    temperature: 0.7,
    stream: false,
    ...(opts.local ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  };
}

/** Whether a reply with no prompt in it still carried reasoning (separate field, or only <think> text). */
export function improveReplyOnlyThought(body: unknown): boolean {
  const message = (body as { choices?: Array<{ message?: Record<string, unknown> }> } | null)?.choices?.[0]?.message;
  if (!message) return false;
  const said = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (said(message.reasoning_content) || said(message.reasoning)) return true;
  return typeof message.content === "string" && /<think>|<\/think>/i.test(message.content);
}

/** The rewritten prompt in a chat completions answer, cleaned; '' when there is none. */
export function improvedPromptOf(body: unknown): string {
  const choice = (body as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0];
  const raw = choice?.message?.content;
  let text = typeof raw === "string"
    ? raw
    : Array.isArray(raw)
      ? raw.map((p) => (p && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("")
      : "";
  // Closed blocks, a close whose opening the server stripped, and a block cut off by the budget.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "").replace(/<think>[\s\S]*$/i, "");
  text = text.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
  text = text.replace(/^(?:improved prompt|prompt)\s*:\s*/i, "").trim();
  const pairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ["“", "”"]];
  for (const [a, b] of pairs) {
    if (text.length > 1 && text.startsWith(a) && text.endsWith(b)) text = text.slice(a.length, -b.length).trim();
  }
  return text.slice(0, IMPROVE_PROMPT_MAX);
}

export interface ImproveDeps {
  readConfig: () => Promise<{ ok: boolean; config?: UserConfigShape; error?: string }>;
  /** A local Studio generation holds the memory and the local chat model is paused (studio-gpu-share.ts). */
  localPaused?: () => boolean;
  localKey?: (url: string) => string | null;
  request?: typeof fetch;
  timeoutMs?: number;
}

export type ImproveAnswer =
  | { ok: true; data: { prompt: string } }
  | { ok: false; error: { code: string; message: string } };

const fail = (code: string, message: string): ImproveAnswer => ({ ok: false, error: { code, message } });

/** The route for now: the config's, unless the local chat model is paused for a local generation. */
async function routeNow(deps: ImproveDeps): Promise<ImproveRoute> {
  const read = await deps.readConfig().catch(() => ({ ok: false as const, config: undefined }));
  const route = improveRoute(read.ok ? read.config : null);
  if (route.ok && route.target.entry.kind === "llama-server" && deps.localPaused?.()) {
    return { ok: false, why: "The local chat model is paused while a local picture or clip is made." };
  }
  return route;
}

/** Whether Improve prompt can run now: `{ready, why}` for the button. */
export async function improveReady(deps: ImproveDeps): Promise<{ ready: boolean; why: string }> {
  const route = await routeNow(deps);
  return route.ok ? { ready: true, why: "" } : { ready: false, why: route.why };
}

/** One rewrite of `prompt` for the `kind` page. Never throws. */
export async function improvePrompt(deps: ImproveDeps, kind: unknown, prompt: unknown): Promise<ImproveAnswer> {
  const k: ImproveKind = kind === "video" ? "video" : "image";
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (!text) return fail("INVALID_REQUEST", "Type a prompt first.");
  const route = await routeNow(deps);
  if (!route.ok) return fail("NO_CHAT_MODEL", route.why);
  const { url, model, entry, local } = route.target;

  const headers: Record<string, string> = { "content-type": "application/json", ...(entry.headers ?? {}) };
  const key = entry.kind === "llama-server" ? (deps.localKey?.(url) ?? null) : resolveKeyValue(entry);
  if (key && !apiKeyCharsOk(key)) return fail("NO_CHAT_MODEL", "The chat model's API key has a character keys do not have. Check it in Settings.");
  if (key && entry.apiKeyHeader) headers[entry.apiKeyHeader] = key;
  else if (key) headers.authorization = `Bearer ${key}`;

  const timeoutMs = deps.timeoutMs ?? 60_000;
  let res: Response;
  try {
    res = await (deps.request ?? fetch)(url, {
      method: "POST",
      headers,
      body: JSON.stringify(improveRequestBody(model, k, text, { local, maxOutputTokens: entry.maxOutputTokens })),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = !!err && typeof err === "object" && (err as { name?: unknown }).name === "TimeoutError";
    return fail("IMPROVE_FAILED", timedOut
      ? `The chat model did not answer within ${Math.round(timeoutMs / 1000)} s. Try again.`
      : "Could not reach the chat model. Check that it is running, then try again.");
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return fail("IMPROVE_FAILED", "The chat model's provider refused the API key. Check it in Settings.");
    if (res.status === 429) return fail("IMPROVE_FAILED", "The chat model is rate limited. Try again in a minute.");
    return fail("IMPROVE_FAILED", `The chat model answered HTTP ${res.status}. Try again.`);
  }
  let body: unknown;
  try { body = await res.json(); } catch { body = null; }
  const improved = improvedPromptOf(body);
  if (!improved) return fail("IMPROVE_FAILED", improveReplyOnlyThought(body) ? IMPROVE_ALL_THINKING : "The chat model gave no prompt back. Try again.");
  return { ok: true, data: { prompt: improved } };
}
