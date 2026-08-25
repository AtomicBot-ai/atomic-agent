import { assertProviderStatus } from "./assert-provider-status.js";
import { searchHttp } from "../transport/search-http.js";
import type {
  WebSearchHttpDeps,
  WebSearchProvider,
  WebSearchResult,
} from "../web-search-provider.js";

export interface ExaProviderConfig {
  endpoint: string;
  apiEndpoint: string;
  apiKeyEnv: string;
}

interface ExaRpcContent {
  type?: unknown;
  text?: unknown;
}

interface ExaRpcEnvelope {
  result?: {
    content?: ExaRpcContent[];
    isError?: boolean;
  };
  error?: {
    message?: unknown;
  };
}

interface ExaApiResult {
  title?: unknown;
  url?: unknown;
  text?: unknown;
  highlights?: unknown;
  publishedDate?: unknown;
  published_date?: unknown;
}

export function createExaProvider(
  config: ExaProviderConfig,
  deps: WebSearchHttpDeps = {},
): WebSearchProvider {
  return {
    name: "exa",
    async search(options) {
      const apiKey = process.env[config.apiKeyEnv]?.trim();
      if (apiKey) {
        const response = await searchHttp({
          url: config.apiEndpoint,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            query: options.query,
            numResults: options.maxResults,
            contents: {
              text: true,
              highlights: true,
            },
          }),
          timeoutMs: options.timeoutMs,
          cwd: options.cwd,
          signal: options.signal,
          runCommand: deps.runCommand,
          lookup: deps.lookup,
        });
        assertProviderStatus(response, "exa", "Exa API");
        return parseExaApiJson(response.body, options.maxResults);
      }

      const response = await searchHttp({
        url: config.endpoint,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "web_search_exa",
            arguments: {
              query: options.query,
              numResults: options.maxResults,
            },
          },
        }),
        timeoutMs: options.timeoutMs,
        cwd: options.cwd,
        signal: options.signal,
        runCommand: deps.runCommand,
        lookup: deps.lookup,
      });
      assertProviderStatus(response, "exa", "Exa");
      const text = extractExaText(response.body);
      return parseExaTextResults(text, options.maxResults);
    },
  };
}

export function parseExaApiJson(
  body: string,
  maxResults: number,
): WebSearchResult[] {
  const parsed = JSON.parse(body) as { results?: unknown };
  if (!Array.isArray(parsed.results)) return [];
  const results: WebSearchResult[] = [];
  for (const raw of parsed.results as ExaApiResult[]) {
    if (typeof raw.title !== "string" || typeof raw.url !== "string") continue;
    results.push({
      title: raw.title.trim(),
      url: raw.url.trim(),
      snippet: extractApiSnippet(raw),
      ...(readPublished(raw) ? { published: readPublished(raw)! } : {}),
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

export function extractExaText(body: string): string {
  const dataLines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]");
  const payload = dataLines.at(-1) ?? body.trim();
  const parsed = JSON.parse(payload) as ExaRpcEnvelope;
  if (parsed.error) {
    throw new Error(
      typeof parsed.error.message === "string"
        ? parsed.error.message
        : "Exa returned an error",
    );
  }
  if (parsed.result?.isError) {
    throw new Error("Exa returned an error result");
  }
  const content = parsed.result?.content ?? [];
  const firstText = content.find(
    (entry) => entry.type === "text" && typeof entry.text === "string",
  );
  if (!firstText || typeof firstText.text !== "string") return "";
  return firstText.text;
}

function extractApiSnippet(raw: ExaApiResult): string {
  if (Array.isArray(raw.highlights)) {
    const first = raw.highlights.find((entry) => typeof entry === "string");
    if (typeof first === "string") return first.trim();
  }
  return typeof raw.text === "string"
    ? raw.text.replace(/\s+/g, " ").trim().slice(0, 500)
    : "";
}

function readPublished(raw: ExaApiResult): string | null {
  if (typeof raw.publishedDate === "string") return raw.publishedDate.trim();
  if (typeof raw.published_date === "string") return raw.published_date.trim();
  return null;
}

export function parseExaTextResults(
  text: string,
  maxResults: number,
): WebSearchResult[] {
  const blocks = text
    .split(/\n\s*\n|\n(?=Title:\s*)/i)
    .map((block) => block.trim())
    .filter(Boolean);
  const results: WebSearchResult[] = [];
  for (const block of blocks) {
    const title = readField(block, "Title");
    const url = readField(block, "URL");
    if (!title || !url) continue;
    results.push({
      title,
      url,
      snippet: readMultiLineField(block, "Highlights") ?? "",
      ...(readField(block, "Published") ? { published: readField(block, "Published")! } : {}),
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

function readField(block: string, name: string): string | null {
  const match = new RegExp(`^${name}:\\s*(.+)$`, "im").exec(block);
  return match ? match[1]!.trim() : null;
}

function readMultiLineField(block: string, name: string): string | null {
  const marker = `${name}:`;
  const idx = block.toLowerCase().indexOf(marker.toLowerCase());
  if (idx === -1) return null;
  return block
    .slice(idx + marker.length)
    .split(/\n[A-Z][A-Za-z ]*:/)[0]!
    .replace(/\s+/g, " ")
    .trim();
}
