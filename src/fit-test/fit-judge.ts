/**
 * The judge that scores a fit-test reply 1..5 (ATO-1090).
 *
 * The same prompt and parsing as the eval harness's judge
 * (`eval/harness/build-judge-prompt.ts`, `judge-client.ts`), copied
 * because the shipped `src/` tree cannot import `eval/`. Any
 * OpenAI-compatible chat endpoint works: a local llama-server, or a
 * cloud one the user names. There is no default endpoint on purpose:
 * the judge reads the user's own prompts, so where they go is the
 * user's choice (`--judge-url`).
 */
import type { JudgeOutcome } from "./fit-test-types.js";

export interface FitJudgeConfig {
  url: string;
  model: string;
  apiKey: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const JUDGE_SYSTEM = [
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

export function judgeMessages(prompt: string, reply: string, rubric: string): Array<{ role: string; content: string }> {
  const body = [
    "== TASK GIVEN TO ASSISTANT ==",
    prompt.trim(),
    "",
    "== ASSISTANT REPLY ==",
    reply.trim() === "" ? "(empty reply)" : reply.trim(),
    "",
    "== RUBRIC ==",
    rubric.trim(),
    "",
    "Now respond with the JSON object only.",
  ].join("\n");
  return [
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: body },
  ];
}

export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function clampScore(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(5, Math.round(n)));
}

/** The verdict in a judge's raw text; `null` when it has none. */
export function parseJudgeVerdict(raw: string): JudgeOutcome | null {
  const trimmed = raw.trim();
  const candidates = [trimmed, ...(trimmed.match(/\{[^{}]*"score"[^{}]*\}/m) ?? [])];
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as { score?: unknown; reason?: unknown };
      const score = clampScore(obj.score);
      if (score !== null) return { score, reason: typeof obj.reason === "string" ? obj.reason.slice(0, 400) : "" };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export function createFitJudge(config: FitJudgeConfig): (prompt: string, reply: string, rubric: string) => Promise<JudgeOutcome> {
  const endpoint = chatCompletionsUrl(config.url);
  const doFetch = config.fetchImpl ?? fetch;
  return async (prompt, reply, rubric) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    const response = await doFetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: judgeMessages(prompt, reply, rubric),
        temperature: 0,
        max_tokens: 256,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 60_000),
    });
    if (!response.ok) throw new Error(`judge HTTP ${response.status}`);
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = json.choices?.[0]?.message?.content;
    const verdict = parseJudgeVerdict(typeof content === "string" ? content : "");
    if (verdict === null) throw new Error("judge gave no score");
    return verdict;
  };
}
