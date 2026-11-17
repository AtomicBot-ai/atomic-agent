import type { runCommand as defaultRunCommand } from "../../../sandbox/command-runner.js";
import { searchHttp } from "../web-search/transport/index.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";

/**
 * Third-party page readers, the last step of the `os.web.fetch` ladder
 * (ATO-968). They render the page on their own servers, so the URL leaves
 * the machine: each one runs only when the user turned it on or put its
 * key in the environment (`web.fetch.jinaReader`, `*ApiKeyEnv`). Keys are
 * read from the environment per call and sent as headers through the
 * same guarded curl transport as web search (never on the command line).
 */
export type ReaderName = "jina" | "firecrawl";

export interface ReaderSettings {
  /** Jina Reader runs without a key (rate-limited) when this is on. */
  jinaReader: boolean;
  jinaApiKeyEnv: string;
  firecrawlApiKeyEnv: string;
}

export interface ReaderPage {
  reader: ReaderName;
  markdown: string;
  title?: string;
  finalUrl: string;
}

export interface ReaderRequest {
  url: string;
  timeoutMs: number;
  cwd: string;
  signal: AbortSignal;
  runCommand?: typeof defaultRunCommand;
  lookup?: HostLookup;
}

const JINA_ENDPOINT = "https://r.jina.ai/";
const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";
const MAX_READER_BYTES = 2_000_000;

function envKey(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/** The readers the user enabled, in ladder order (Jina, then Firecrawl). */
export function enabledReaders(
  settings: ReaderSettings,
  env: NodeJS.ProcessEnv = process.env,
): ReaderName[] {
  const out: ReaderName[] = [];
  if (settings.jinaReader || envKey(env, settings.jinaApiKeyEnv)) {
    out.push("jina");
  }
  if (envKey(env, settings.firecrawlApiKeyEnv)) out.push("firecrawl");
  return out;
}

/** Read `request.url` through one reader. Throws with a short reason. */
export async function readWithReader(
  reader: ReaderName,
  settings: ReaderSettings,
  request: ReaderRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReaderPage> {
  return reader === "jina"
    ? readWithJina(request, envKey(env, settings.jinaApiKeyEnv))
    : readWithFirecrawl(request, envKey(env, settings.firecrawlApiKeyEnv));
}

async function readWithJina(
  request: ReaderRequest,
  apiKey: string | null,
): Promise<ReaderPage> {
  const response = await searchHttp({
    url: `${JINA_ENDPOINT}${request.url}`,
    headers: {
      Accept: "application/json",
      "X-Return-Format": "markdown",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    timeoutMs: request.timeoutMs,
    cwd: request.cwd,
    signal: request.signal,
    maxResponseBytes: MAX_READER_BYTES,
    runCommand: request.runCommand,
    lookup: request.lookup,
    retryPolicy: { maxRetries: 0, baseDelayMs: 0 },
  });
  if (response.status !== 200) {
    throw new Error(`Jina Reader answered HTTP ${response.status}`);
  }
  const data = (parseJson(response.body) as { data?: Record<string, unknown> })
    ?.data;
  const content = typeof data?.content === "string" ? data.content.trim() : "";
  if (!content) throw new Error("Jina Reader returned no content");
  return {
    reader: "jina",
    markdown: content,
    ...(typeof data?.title === "string" && data.title
      ? { title: data.title }
      : {}),
    finalUrl:
      typeof data?.url === "string" && data.url ? data.url : request.url,
  };
}

async function readWithFirecrawl(
  request: ReaderRequest,
  apiKey: string | null,
): Promise<ReaderPage> {
  if (!apiKey) throw new Error("Firecrawl needs an API key");
  const response = await searchHttp({
    url: FIRECRAWL_ENDPOINT,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ url: request.url, formats: ["markdown"] }),
    timeoutMs: request.timeoutMs,
    cwd: request.cwd,
    signal: request.signal,
    maxResponseBytes: MAX_READER_BYTES,
    runCommand: request.runCommand,
    lookup: request.lookup,
    retryPolicy: { maxRetries: 0, baseDelayMs: 0 },
  });
  if (response.status !== 200) {
    throw new Error(`Firecrawl answered HTTP ${response.status}`);
  }
  const parsed = parseJson(response.body) as {
    success?: unknown;
    data?: { markdown?: unknown; metadata?: Record<string, unknown> };
  } | null;
  const markdown =
    typeof parsed?.data?.markdown === "string" ? parsed.data.markdown.trim() : "";
  if (parsed?.success === false || !markdown) {
    throw new Error("Firecrawl returned no content");
  }
  const meta = parsed?.data?.metadata ?? {};
  const rawTitle = Array.isArray(meta.title) ? meta.title[0] : meta.title;
  const finalUrl =
    typeof meta.url === "string" && meta.url
      ? meta.url
      : typeof meta.sourceURL === "string" && meta.sourceURL
        ? meta.sourceURL
        : request.url;
  return {
    reader: "firecrawl",
    markdown,
    ...(typeof rawTitle === "string" && rawTitle ? { title: rawTitle } : {}),
    finalUrl,
  };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
