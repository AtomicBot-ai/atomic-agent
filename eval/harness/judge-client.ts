import { buildJudgeMessages } from "./build-judge-prompt.js";
import type {
  JudgeClient,
  JudgeConfig,
  JudgeInput,
  JudgeVerdict,
} from "./judge-types.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_REFERER = "https://github.com/atomicbot/atomic-agent";
const DEFAULT_APP_TITLE = "atomic-agent eval";

/**
 * Resolve judge configuration from the environment.
 *
 * Defaults target OpenRouter (`https://openrouter.ai/api/v1`,
 * `openai/gpt-4o-mini`). A key is required for hosted providers:
 * `OPENROUTER_API_KEY` is checked first, then the legacy
 * `ATOMIC_AGENT_JUDGE_API_KEY`.
 *
 * Behaviour matrix:
 * - `ATOMIC_AGENT_JUDGE_DISABLED=1`      → `null`, silent (CI escape hatch).
 * - Remote base URL + no key            → `null` with a stderr explanation.
 *                                         Every `judge` expectation then
 *                                         fails as "judge unavailable".
 * - Localhost base URL (e.g. llama)     → no key required.
 *
 * Additional knobs:
 * - `ATOMIC_AGENT_JUDGE_URL`          override base URL.
 * - `ATOMIC_AGENT_JUDGE_MODEL`        override model slug.
 * - `ATOMIC_AGENT_JUDGE_TIMEOUT_MS`   per-call timeout.
 * - `ATOMIC_AGENT_JUDGE_REFERER`      OpenRouter HTTP-Referer attribution.
 * - `ATOMIC_AGENT_JUDGE_TITLE`        OpenRouter X-Title attribution.
 */
export function loadJudgeConfigFromEnv(): JudgeConfig | null {
  if (process.env.ATOMIC_AGENT_JUDGE_DISABLED === "1") return null;
  const baseUrl = normaliseBaseUrl(
    process.env.ATOMIC_AGENT_JUDGE_URL ?? DEFAULT_BASE_URL,
  );
  const apiKey =
    process.env.OPENROUTER_API_KEY ??
    process.env.ATOMIC_AGENT_JUDGE_API_KEY ??
    null;
  if (requiresApiKey(baseUrl) && !apiKey) {
    process.stderr.write(
      `[eval] judge disabled: ${baseUrl} requires an API key. ` +
        "Set OPENROUTER_API_KEY (preferred) or ATOMIC_AGENT_JUDGE_API_KEY, " +
        "or point ATOMIC_AGENT_JUDGE_URL at a local llama-server.\n",
    );
    return null;
  }
  const timeoutRaw = process.env.ATOMIC_AGENT_JUDGE_TIMEOUT_MS;
  const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : NaN;
  return {
    baseUrl,
    model: process.env.ATOMIC_AGENT_JUDGE_MODEL ?? DEFAULT_MODEL,
    apiKey,
    maxTokens: DEFAULT_MAX_TOKENS,
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_TIMEOUT_MS,
    refererUrl: process.env.ATOMIC_AGENT_JUDGE_REFERER ?? DEFAULT_REFERER,
    appTitle: process.env.ATOMIC_AGENT_JUDGE_TITLE ?? DEFAULT_APP_TITLE,
  };
}

export function createJudgeClient(config: JudgeConfig): JudgeClient {
  const endpoint = resolveChatCompletionsUrl(config.baseUrl);
  const isOpenRouter = isOpenRouterHost(endpoint);
  return {
    async score(input: JudgeInput): Promise<JudgeVerdict> {
      const messages = buildJudgeMessages(input);
      const body = JSON.stringify({
        model: config.model,
        messages,
        temperature: 0,
        max_tokens: config.maxTokens,
        // OpenAI/OpenRouter honour this; llama.cpp ignores and we parse
        // the raw content as a fallback.
        response_format: { type: "json_object" },
      });
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      if (isOpenRouter) {
        if (config.refererUrl) headers["http-referer"] = config.refererUrl;
        if (config.appTitle) headers["x-title"] = config.appTitle;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      const startedAt = Date.now();
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(
            `judge HTTP ${response.status}: ${text.slice(0, 200)}`,
          );
        }
        const json = (await response.json()) as ChatCompletionResponse;
        const raw = extractContent(json);
        const parsed = parseJudgeJson(raw);
        return {
          score: parsed.score,
          reason: parsed.reason,
          durationMs: Date.now() - startedAt,
          raw,
          parseFallback: parsed.fallback,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function normaliseBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * Accept both short forms (`http://host:port`) and fully qualified ones
 * (`https://.../v1` or even `.../chat/completions`). Returns the full
 * POST target.
 */
function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = normaliseBaseUrl(baseUrl);
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function requiresApiKey(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return false;
    }
    if (url.hostname.endsWith(".local")) return false;
    return true;
  } catch {
    // Malformed URL — let the HTTP layer surface the error rather than
    // silently disabling the judge.
    return false;
  }
}

function isOpenRouterHost(url: string): boolean {
  try {
    return /(^|\.)openrouter\.ai$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

function extractContent(json: ChatCompletionResponse): string {
  const content = json.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  return "";
}

interface ParsedJudgeJson {
  score: number;
  reason: string;
  fallback: boolean;
}

const JSON_BLOCK_RE = /\{[^{}]*"score"[^{}]*\}/m;

/**
 * Best-effort JSON parser: tries the whole string first, then falls
 * back to grepping for the first `{...}` blob containing "score".
 * Final fallback yields score=1 with the raw text as the reason so the
 * verdict is still actionable (a 1 means "judge failed to parse" — read
 * the reason).
 */
function parseJudgeJson(raw: string): ParsedJudgeJson {
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];
  const match = trimmed.match(JSON_BLOCK_RE);
  if (match) candidates.push(match[0]);

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as { score?: unknown; reason?: unknown };
      const score = clampScore(obj.score);
      const reason = typeof obj.reason === "string" ? obj.reason : "";
      if (score !== null) {
        return { score, reason: reason.slice(0, 400), fallback: false };
      }
    } catch {
      // try the next candidate
    }
  }
  return {
    score: 1,
    reason: `judge parse failed; raw: ${raw.slice(0, 180)}`,
    fallback: true,
  };
}

function clampScore(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(5, Math.round(n)));
}
