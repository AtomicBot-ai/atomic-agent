/**
 * The judge for open-ended answers (ATO-1101): a `judge` check asks a
 * model to grade the reply against the task's rubric on a 1..5 scale.
 *
 * Same endpoint, environment knobs, prompt and scale as the eval harness
 * judge (`eval/harness/judge-client.ts`, `build-judge-prompt.ts`), so a
 * person learns one judge and scores compare across harnesses. That code
 * lives outside `src/` and cannot be imported by the shipped CLI, hence
 * this small copy. The judge is an OpenAI-compatible endpoint of its
 * own, not the agent's active model: the model under test does not
 * grade itself, and judging never touches the person's memory.
 */

export interface SkillEvalJudgeConfig {
  /** OpenAI-compatible base URL (`https://openrouter.ai/api/v1`, `http://127.0.0.1:8080`, or a full `/chat/completions` URL). */
  baseUrl: string;
  model: string;
  apiKey: string | null;
  timeoutMs: number;
}

export interface SkillEvalJudgeInput {
  /** The prompt the agent was given. */
  prompt: string;
  /** The agent's reply. */
  reply: string;
  rubric: string;
  /** A model answer to compare against, when the task has one. */
  reference: string | null;
}

export interface SkillEvalJudgeVerdict {
  /** 1 = wrong, 3 = partly right, 5 = fully right. */
  score: number;
  reason: string;
  /** The judge's output could not be read as `{score, reason}`; the score is then 1. */
  parseFallback: boolean;
}

export interface SkillEvalJudge {
  readonly model: string;
  readonly baseUrl: string;
  score(input: SkillEvalJudgeInput): Promise<SkillEvalJudgeVerdict>;
}

export const DEFAULT_JUDGE_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_JUDGE_MODEL = "openai/gpt-4o-mini";
const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;
const JUDGE_MAX_TOKENS = 256;

/**
 * Judge settings from flags first, then the eval harness's environment:
 * `ATOMIC_AGENT_JUDGE_URL`, `ATOMIC_AGENT_JUDGE_MODEL`,
 * `ATOMIC_AGENT_JUDGE_TIMEOUT_MS`, and the key from `OPENROUTER_API_KEY`
 * or `ATOMIC_AGENT_JUDGE_API_KEY`. Returns `{ error }` when a hosted URL
 * has no key; a localhost URL needs none.
 */
export function resolveJudgeConfig(
  flags: { url?: string | null; model?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): SkillEvalJudgeConfig | { error: string } {
  const baseUrl = (flags.url ?? env.ATOMIC_AGENT_JUDGE_URL ?? DEFAULT_JUDGE_BASE_URL).trim().replace(/\/+$/, "");
  const apiKey = env.OPENROUTER_API_KEY ?? env.ATOMIC_AGENT_JUDGE_API_KEY ?? null;
  if (requiresApiKey(baseUrl) && !apiKey) {
    return {
      error:
        `the judge at ${baseUrl} needs an API key: set OPENROUTER_API_KEY or ATOMIC_AGENT_JUDGE_API_KEY, ` +
        "or point --judge-url (ATOMIC_AGENT_JUDGE_URL) at a local OpenAI-compatible server",
    };
  }
  const timeout = Number.parseInt(env.ATOMIC_AGENT_JUDGE_TIMEOUT_MS ?? "", 10);
  return {
    baseUrl,
    model: flags.model ?? env.ATOMIC_AGENT_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
    apiKey,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_JUDGE_TIMEOUT_MS,
  };
}

export const JUDGE_SYSTEM = [
  "You are a strict evaluator scoring an AI assistant's response.",
  "Output ONLY a single JSON object on one line, with no surrounding text and no code fence.",
  'Schema: {"score": <integer 1..5>, "reason": "<max 200 chars>"}',
  "Scoring guide:",
  "  1 = completely wrong, missed the task, or hallucinated.",
  "  2 = attempted but mostly wrong.",
  "  3 = partially correct; key facts present but with notable errors.",
  "  4 = correct content with minor format/clarity issues.",
  "  5 = fully correct, well-formatted, follows the rubric precisely.",
  "Be strict. If the response is empty or refuses, score 1.",
].join("\n");

export function buildJudgeMessages(input: SkillEvalJudgeInput): Array<{ role: "system" | "user"; content: string }> {
  const body = [
    "== TASK GIVEN TO ASSISTANT ==",
    input.prompt.trim(),
    "",
    "== ASSISTANT REPLY ==",
    input.reply.trim() === "" ? "(empty reply)" : input.reply.trim(),
    "",
    ...(input.reference ? ["== REFERENCE ANSWER ==", input.reference.trim(), ""] : []),
    "== RUBRIC ==",
    input.rubric.trim(),
    "",
    "Now respond with the JSON object only.",
  ].join("\n");
  return [
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: body },
  ];
}

export function createSkillEvalJudge(
  config: SkillEvalJudgeConfig,
  fetchImpl: typeof fetch = fetch,
): SkillEvalJudge {
  const endpoint = chatCompletionsUrl(config.baseUrl);
  return {
    model: config.model,
    baseUrl: config.baseUrl,
    async score(input) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            messages: buildJudgeMessages(input),
            temperature: 0,
            max_tokens: JUDGE_MAX_TOKENS,
            response_format: { type: "json_object" },
          }),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`judge HTTP ${response.status}: ${text.slice(0, 200)}`);
        }
        const json = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
        const content = json.choices?.[0]?.message?.content;
        return parseJudgeVerdict(typeof content === "string" ? content : "");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const JSON_BLOCK = /\{[^{}]*"score"[^{}]*\}/m;

/** The whole text as JSON, else the first `{...}` holding "score", else score 1 with the raw text as the reason. */
export function parseJudgeVerdict(raw: string): SkillEvalJudgeVerdict {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const block = trimmed.match(JSON_BLOCK);
  if (block) candidates.push(block[0]);
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as { score?: unknown; reason?: unknown };
      const n = typeof obj.score === "number" ? obj.score : Number.parseInt(String(obj.score), 10);
      if (!Number.isFinite(n)) continue;
      return {
        score: Math.max(1, Math.min(5, Math.round(n))),
        reason: typeof obj.reason === "string" ? obj.reason.slice(0, 400) : "",
        parseFallback: false,
      };
    } catch {
      // next candidate
    }
  }
  return { score: 1, reason: `judge output not readable: ${raw.slice(0, 180)}`, parseFallback: true };
}

function chatCompletionsUrl(baseUrl: string): string {
  if (/\/chat\/completions$/.test(baseUrl)) return baseUrl;
  if (/\/v\d+$/.test(baseUrl)) return `${baseUrl}/chat/completions`;
  return `${baseUrl}/v1/chat/completions`;
}

function requiresApiKey(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return !(host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".local"));
  } catch {
    return false;
  }
}
