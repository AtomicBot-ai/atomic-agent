/**
 * The context window an Ollama server will really give a model (ATO-1276).
 *
 * Ollama does not run a model at the window the model supports. It
 * allocates `num_ctx` tokens: the modelfile's `PARAMETER num_ctx` when
 * one is set, else the server's default (4096 on the builds we have
 * seen, unless the operator raised it with `OLLAMA_CONTEXT_LENGTH`).
 * A prompt sized against the model's nominal window (or the catalogue's
 * 128k) is refused with a 400 once it outgrows that.
 *
 * We do not send a bigger `options.num_ctx`: that makes Ollama reload
 * the model and can run the machine out of memory. Instead the window
 * read here is fed to the learned-window path, so the context budget
 * and compaction keep each request under it.
 *
 * Sources, best first:
 *
 *  - `GET /api/ps`: a loaded model's `context_length` is the window it
 *    was loaded with, `OLLAMA_CONTEXT_LENGTH` included. Older builds do
 *    not report it, and a model that is not loaded is not listed.
 *  - `POST /api/show`: the modelfile's `num_ctx` (the `parameters` text
 *    block, a `num_ctx <n>` line), capped by the model's own
 *    `<arch>.context_length` from `model_info`.
 *  - Neither: unknown (null). The server's own default (4096 on many
 *    builds, larger on newer ones or with `OLLAMA_CONTEXT_LENGTH`) cannot
 *    be read from here while the model is not loaded. Guessing 4096
 *    would stick: the learned window only takes the minimum, and a
 *    budget packed under 4096 never sends the larger request that would
 *    raise it again. So nothing is learned; the caller probes again
 *    later, when `/api/ps` lists the loaded model, and the overflow
 *    recovery covers a first request that is too long.
 *
 * Every failure (unreachable, timeout, not Ollama, garbage) is null:
 * the caller keeps its current behaviour.
 */

import { normalizeOpenAiBaseUrl } from "../openai/normalize-openai-base-url.js";

/** Per-request cap: a local server answers these in milliseconds. */
export const OLLAMA_PROBE_TIMEOUT_MS = 1500;

/** Below this a "window" is a parsing accident, not a context length. */
const MIN_PLAUSIBLE_WINDOW = 256;

export type OllamaShowWindow = {
  /** `num_ctx` from the modelfile's parameters, when set. */
  numCtx?: number;
  /** The model's own maximum, `model_info["<arch>.context_length"]`. */
  contextLength?: number;
};

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= MIN_PLAUSIBLE_WINDOW ? n : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The `num_ctx <n>` line of `/api/show`'s `parameters` text block. */
export function parseNumCtxParameter(parameters: unknown): number | undefined {
  if (typeof parameters !== "string") return undefined;
  for (const line of parameters.split(/\r?\n/)) {
    const match = /^\s*num_ctx\s+"?(\d+)"?\s*$/.exec(line);
    if (match) return positiveInt(Number(match[1]));
  }
  return undefined;
}

/** What a `/api/show` body says about the window. Empty for garbage. */
export function parseOllamaShow(body: unknown): OllamaShowWindow {
  const root = asObject(body);
  if (root === undefined) return {};
  const numCtx = parseNumCtxParameter(root.parameters);
  const info = asObject(root.model_info);
  let contextLength: number | undefined;
  if (info !== undefined) {
    const arch = info["general.architecture"];
    if (typeof arch === "string" && arch.length > 0) {
      contextLength = positiveInt(info[`${arch}.context_length`]);
    }
    if (contextLength === undefined) {
      for (const [key, value] of Object.entries(info)) {
        if (!key.endsWith(".context_length")) continue;
        contextLength = positiveInt(value);
        if (contextLength !== undefined) break;
      }
    }
  }
  return {
    ...(numCtx !== undefined ? { numCtx } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
  };
}

function sameModel(listed: unknown, model: string): boolean {
  if (typeof listed !== "string") return false;
  const withTag = (name: string) => (name.includes(":") ? name : `${name}:latest`);
  return listed === model || withTag(listed) === withTag(model);
}

/** A loaded model's `context_length` from a `/api/ps` body, when reported. */
export function parseOllamaPsContextLength(body: unknown, model: string): number | undefined {
  const models = asObject(body)?.models;
  if (!Array.isArray(models)) return undefined;
  for (const entry of models) {
    const row = asObject(entry);
    if (row === undefined) continue;
    if (!sameModel(row.name, model) && !sameModel(row.model, model)) continue;
    return positiveInt(row.context_length);
  }
  return undefined;
}

/**
 * The window Ollama gives the model, when the server tells us: the
 * loaded window, else the modelfile's `num_ctx`; never above the model's
 * own maximum. Undefined when neither is known (see the header: the
 * server default is not guessed).
 */
export function knownOllamaWindow(show: OllamaShowWindow, loaded?: number): number | undefined {
  const allocated = loaded ?? show.numCtx;
  if (allocated === undefined) return undefined;
  return show.contextLength !== undefined ? Math.min(allocated, show.contextLength) : allocated;
}

/** Ollama's native API root: the provider URL without the OpenAI `/v1`. */
export function ollamaApiBase(baseUrl: string): string {
  return normalizeOpenAiBaseUrl(baseUrl);
}

/** Whether a provider entry is a local Ollama server. */
export function isOllamaEntry(entry: { id: string; baseUrl?: string; url?: string }): boolean {
  const url = entry.baseUrl ?? entry.url;
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Ollama Cloud (`ollama.com`) serves its own windows; only a server
  // on this machine or network allocates `num_ctx` this way.
  if (parsed.hostname.toLowerCase().endsWith("ollama.com")) return false;
  return parsed.port === "11434" || entry.id === "ollama";
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function readJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  try {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Ask the Ollama server at `baseUrl` for `model`'s real window. Null when
 * `/api/show` does not answer like Ollama, or when neither the loaded
 * model nor the modelfile names a window (the caller keeps what it had).
 */
export async function readOllamaContextWindow(
  baseUrl: string,
  model: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<number | null> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? OLLAMA_PROBE_TIMEOUT_MS;
  const base = ollamaApiBase(baseUrl);
  const [showBody, psBody] = await Promise.all([
    readJson(fetchImpl, `${base}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    }, timeoutMs),
    readJson(fetchImpl, `${base}/api/ps`, { method: "GET" }, timeoutMs),
  ]);
  const showRoot = asObject(showBody);
  // Not an Ollama `/api/show` answer: do not invent a 4096 window for a
  // server that merely listens on the port.
  if (showRoot === undefined || (showRoot.model_info === undefined && showRoot.parameters === undefined && showRoot.modelfile === undefined)) {
    return null;
  }
  return knownOllamaWindow(parseOllamaShow(showRoot), parseOllamaPsContextLength(psBody, model)) ?? null;
}
