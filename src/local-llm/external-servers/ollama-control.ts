/**
 * Ollama's own HTTP API, for the actions the setup screens and Settings
 * offer on a running Ollama (ATO-2490). Every call goes to the address the
 * probe found (`detectLocalServers`, 127.0.0.1:11434 by default).
 *
 * - load:   `POST /api/generate {model}` with no prompt loads it into memory.
 * - unload: the same with `keep_alive: 0`, which Ollama documents as the way
 *           to free a model's memory now (what `ollama stop` does).
 * - pull:   `POST /api/pull {model, stream: true}`, NDJSON progress lines.
 * - delete: `DELETE /api/delete {model}` (`ollama rm`).
 * - show:   `POST /api/show {model}`; its `modelfile` names the GGUF blob on
 *           disk (`FROM /…/blobs/sha256-…`), which "use in Atomic Agent" links.
 *
 * Errors are short sentences meant for a screen; Ollama's own words stay in
 * `detail` for a Details disclosure.
 */

export const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";

export class OllamaError extends Error {
  constructor(message: string, readonly detail: string | null = null) {
    super(message);
    this.name = "OllamaError";
  }
}

export interface OllamaCallOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** A model name as Ollama takes it: no spaces, no leading dash. */
export function isOllamaModelName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/.test(name);
}

function signalFor(opts: OllamaCallOptions, fallbackMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? fallbackMs);
  return opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // not JSON: the raw text is the detail
  }
  return text.trim() || `HTTP ${res.status}`;
}

async function call(
  path: string,
  method: "POST" | "DELETE",
  body: unknown,
  opts: OllamaCallOptions,
  fallbackMs: number,
): Promise<Response> {
  const fetchImpl = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? OLLAMA_DEFAULT_URL).replace(/\/+$/, "");
  try {
    return await fetchImpl(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: signalFor(opts, fallbackMs),
    });
  } catch (err) {
    throw new OllamaError("Ollama is not answering. Start it and try again.", err instanceof Error ? err.message : String(err));
  }
}

function requireName(model: string): void {
  if (!isOllamaModelName(model)) throw new OllamaError(`That is not an Ollama model name: ${JSON.stringify(model)}`);
}

/** Load a model into memory (the first message would otherwise wait for it). */
export async function loadOllamaModel(model: string, opts: OllamaCallOptions = {}): Promise<void> {
  requireName(model);
  const res = await call("/api/generate", "POST", { model, stream: false }, opts, 300_000);
  if (!res.ok) throw new OllamaError(`Ollama could not load ${model}.`, await errorText(res));
  await res.body?.cancel().catch(() => {});
}

/** Free a model's memory now: `keep_alive: 0`. */
export async function unloadOllamaModel(model: string, opts: OllamaCallOptions = {}): Promise<void> {
  requireName(model);
  const res = await call("/api/generate", "POST", { model, keep_alive: 0, stream: false }, opts, 30_000);
  if (!res.ok) throw new OllamaError(`Ollama could not unload ${model}.`, await errorText(res));
  await res.body?.cancel().catch(() => {});
}

/** `ollama rm`. A model that is not there is an error in words. */
export async function deleteOllamaModel(model: string, opts: OllamaCallOptions = {}): Promise<void> {
  requireName(model);
  const res = await call("/api/delete", "DELETE", { model }, opts, 30_000);
  if (res.status === 404) throw new OllamaError(`Ollama has no model called ${model}.`, await errorText(res));
  if (!res.ok) throw new OllamaError(`Ollama could not delete ${model}.`, await errorText(res));
  await res.body?.cancel().catch(() => {});
}

export interface OllamaPullProgress {
  /** Ollama's step: `pulling manifest`, `pulling <digest>`, `verifying sha256 digest`, `success`. */
  readonly status: string;
  readonly completed: number | null;
  readonly total: number | null;
}

/** One NDJSON line of `/api/pull`, or null for a blank or broken line. Throws for an `error` line. */
export function readPullLine(line: string): OllamaPullProgress | null {
  const text = line.trim();
  if (!text) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof body.error === "string" && body.error) {
    throw new OllamaError("Ollama could not download that model.", body.error);
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  return {
    status: typeof body.status === "string" ? body.status : "",
    completed: num(body.completed),
    total: num(body.total),
  };
}

/** `ollama pull`, with each progress line handed to `onProgress`. Resolves once Ollama says `success`. */
export async function pullOllamaModel(
  model: string,
  onProgress: (p: OllamaPullProgress) => void,
  opts: OllamaCallOptions = {},
): Promise<void> {
  requireName(model);
  // A pull of a large model runs for many minutes; only the caller's signal stops it.
  const res = await call("/api/pull", "POST", { model, stream: true }, { ...opts, timeoutMs: opts.timeoutMs ?? 6 * 60 * 60_000 }, 0);
  if (!res.ok) throw new OllamaError(`Ollama could not download ${model}.`, await errorText(res));
  if (!res.body) throw new OllamaError(`Ollama could not download ${model}.`, "empty answer");
  const decoder = new TextDecoder();
  let buffered = "";
  let succeeded = false;
  const take = (line: string) => {
    const p = readPullLine(line);
    if (!p) return;
    if (p.status === "success") succeeded = true;
    onProgress(p);
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true });
    let nl = buffered.indexOf("\n");
    while (nl >= 0) {
      take(buffered.slice(0, nl));
      buffered = buffered.slice(nl + 1);
      nl = buffered.indexOf("\n");
    }
  }
  take(buffered + decoder.decode());
  if (!succeeded) throw new OllamaError(`The download of ${model} stopped before it finished.`, null);
}

/**
 * The GGUF file behind a model, from `/api/show`'s modelfile: the first
 * `FROM` line that is an absolute path (a `FROM qwen3` line names a base
 * model, not a file). Null when the server does not say.
 */
export function blobPathFromModelfile(modelfile: string): string | null {
  for (const raw of modelfile.split(/\r?\n/)) {
    const m = /^\s*FROM\s+(.+?)\s*$/i.exec(raw);
    if (!m) continue;
    const path = m[1]!.replace(/^"(.*)"$/, "$1");
    if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  }
  return null;
}

/** Ask Ollama where a model's weights are. */
export async function ollamaModelBlobPath(model: string, opts: OllamaCallOptions = {}): Promise<string | null> {
  requireName(model);
  const res = await call("/api/show", "POST", { model }, opts, 15_000);
  if (res.status === 404) throw new OllamaError(`Ollama has no model called ${model}.`, await errorText(res));
  if (!res.ok) throw new OllamaError(`Ollama could not describe ${model}.`, await errorText(res));
  const body = (await res.json().catch(() => null)) as { modelfile?: unknown } | null;
  return body && typeof body.modelfile === "string" ? blobPathFromModelfile(body.modelfile) : null;
}
