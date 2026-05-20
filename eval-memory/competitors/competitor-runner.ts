/**
 * Generic competitor recall harness.
 *
 * Given a `CompetitorAdapter` and a list of `CompetitorTurn`s (the
 * "haystack" — every prior user/assistant turn in the conversation),
 * the harness ingests every turn, then issues a single `recall()`
 * for each question. The retrieved memories are formatted as a
 * plain `### memories` block and fed into a stock chat completion
 * on the same llama-server we benchmark ourselves on.
 *
 * Apples-to-apples contract:
 *
 *  - Same `model` (the chat daemon's active model).
 *  - Same `temperature` / `top_p` / `seed` (`CAMPAIGN_SAMPLING`).
 *  - Same question text fed verbatim — no per-adapter prompt
 *    tweaking.
 *  - Adapter is fed every turn in order; recall is a single shot per
 *    question with `k = recallK`.
 *
 * The harness deliberately does NOT execute tools — competitor
 * memory products only own the memory layer. Comparing them on tool
 * outcomes would conflate "wrong memory" with "wrong tool choice".
 */

import { CAMPAIGN_SAMPLING } from "../config/environment.js";
import {
  type CompetitorAdapter,
  type CompetitorTurn,
} from "./competitor-adapter.js";

export interface CompetitorRunQuestion {
  /** Stable id for the question (`<scenarioId>:<qIdx>`). */
  id: string;
  /** Free-text question (`What city did Alice grow up in?`). */
  text: string;
  /** Optional gold answers used by the harness's naive substring
   *  scorer. The campaign's full LLM judge runs separately and uses
   *  its own grading rubric — these golds are only the cheap pre-
   *  filter equivalent to the existing LoCoMo / LongMemEval runners. */
  gold?: readonly string[];
}

export interface CompetitorRunRequest {
  scenarioId: string;
  /** Conversation turns to ingest before any question is asked. */
  haystack: readonly CompetitorTurn[];
  /** Questions to ask, in order. */
  questions: readonly CompetitorRunQuestion[];
  /** `k` parameter forwarded to `adapter.recall`. */
  recallK: number;
  /** URL of the chat daemon (`http://localhost:19091`). */
  llamaUrl: string;
  /** Optional override for per-completion timeout (ms). */
  completionTimeoutMs?: number;
}

export interface CompetitorRunQuestionOutcome {
  questionId: string;
  question: string;
  reply: string;
  /** Naive substring scoring against the question's `gold`. Matches
   *  the cheap pre-filter shape used by LoCoMo / LongMemEval runners
   *  before the LLM judge runs. */
  substringMatch: boolean | null;
  /** Whether the adapter surfaced any memories at all for the
   *  question — useful for diagnosing competitors that ingested
   *  successfully but recall nothing. */
  retrievedCount: number;
  recallDurationMs: number;
  completionDurationMs: number;
}

export interface CompetitorRunResult {
  scenarioId: string;
  adapterName: string;
  adapterLabel: string;
  ingestDurationMs: number;
  /** Per-question outcomes in input order. */
  outcomes: readonly CompetitorRunQuestionOutcome[];
}

export async function runCompetitorScenario(
  adapter: CompetitorAdapter,
  req: CompetitorRunRequest,
): Promise<CompetitorRunResult> {
  await adapter.reset(req.scenarioId);
  await adapter.ensureSession(req.scenarioId);

  const ingestStart = Date.now();
  for (const turn of req.haystack) {
    await adapter.ingest(turn);
  }
  const ingestDurationMs = Date.now() - ingestStart;

  const outcomes: CompetitorRunQuestionOutcome[] = [];
  for (const q of req.questions) {
    const recallStart = Date.now();
    const recall = await adapter.recall({
      sessionId: req.scenarioId,
      query: q.text,
      k: req.recallK,
    });
    const recallDurationMs = Date.now() - recallStart;

    const completionStart = Date.now();
    const reply = await runStockCompletion({
      llamaUrl: req.llamaUrl,
      question: q.text,
      memories: recall.items.map((it) => it.text),
      timeoutMs: req.completionTimeoutMs ?? 60_000,
    });
    const completionDurationMs = Date.now() - completionStart;

    outcomes.push({
      questionId: q.id,
      question: q.text,
      reply,
      substringMatch: scoreSubstring(reply, q.gold),
      retrievedCount: recall.items.length,
      recallDurationMs,
      completionDurationMs,
    });
  }

  return {
    scenarioId: req.scenarioId,
    adapterName: adapter.name,
    adapterLabel: adapter.label,
    ingestDurationMs,
    outcomes,
  };
}

/**
 * Naive substring scorer, identical in spirit to the one used by
 * the LoCoMo / LongMemEval runners. Returns `null` when no gold is
 * provided so the campaign's LLM judge owns the truth.
 */
function scoreSubstring(reply: string, gold?: readonly string[]): boolean | null {
  if (!gold || gold.length === 0) return null;
  const r = reply.toLowerCase();
  for (const g of gold) {
    if (!g.trim()) continue;
    if (r.includes(g.toLowerCase())) return true;
  }
  return false;
}

interface StockCompletionRequest {
  llamaUrl: string;
  question: string;
  memories: readonly string[];
  timeoutMs: number;
}

/**
 * The shared chat-completion call used for every competitor. The
 * memories block is concatenated verbatim — no truncation here, the
 * orchestrator decides per-scenario whether a token budget is
 * needed.
 */
async function runStockCompletion(req: StockCompletionRequest): Promise<string> {
  const memoriesBlock = req.memories.length === 0
    ? "(no memories surfaced)"
    : req.memories.map((m, i) => `[${i + 1}] ${m}`).join("\n");
  const system = [
    "You are a helpful assistant answering questions based on the",
    "memories block below. Answer concisely. If the memories do not",
    "contain enough information, reply with 'I don't know.'",
  ].join(" ");
  const user = `### memories\n${memoriesBlock}\n\n### question\n${req.question}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const response = await fetch(`${req.llamaUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: CAMPAIGN_SAMPLING.temperature,
        top_p: CAMPAIGN_SAMPLING.topP,
        seed: CAMPAIGN_SAMPLING.seed,
        stream: false,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `competitor stock completion failed: HTTP ${response.status} ${await response.text()}`,
      );
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}
