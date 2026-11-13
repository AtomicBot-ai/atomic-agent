import type { LlmProvider } from "../../llm/provider/llm-provider.js";
import type { CompletionUsage } from "../../llm/provider/completion-types.js";
import { buildCloudSubcallRequest } from "../../llm/provider/cloud-subcall.js";
import type { ResolvedLlmConfig } from "../../llm/provider/registry/provider-types.js";

/**
 * The judge for open-ended answers (ATO-1101): a `judge` check asks a
 * model to grade the reply against the task's rubric on a 1..5 scale.
 *
 * The judge is always one of the person's own models, never a built-in
 * paid endpoint:
 *
 * 1. `ATOMIC_AGENT_JUDGE_URL` (or `--judge-url`) with
 *    `ATOMIC_AGENT_JUDGE_MODEL` (or `--judge-model`): an OpenAI-compatible
 *    endpoint the person names, the same knobs as the eval harness judge
 *    (`eval/harness/judge-client.ts`). Key from `ATOMIC_AGENT_JUDGE_API_KEY`
 *    or `OPENROUTER_API_KEY`; a localhost URL needs none.
 * 2. `skills.eval.judgeProvider`: a configured provider id.
 * 3. The active text provider, when it is a cloud one.
 *
 * Nothing usable (a local model active and nothing set) is an error, and
 * `skill eval` exits 2 before running anything. A local llama-server entry
 * is never the judge: it is the model under test. The prompt and scale
 * match the harness judge so scores compare across harnesses.
 */

export type SkillEvalJudgeConfig =
  | {
      kind: "http";
      /** OpenAI-compatible base URL (`https://openrouter.ai/api/v1`, `http://127.0.0.1:8080`, or a full `/chat/completions` URL). */
      baseUrl: string;
      model: string;
      apiKey: string | null;
      timeoutMs: number;
    }
  | {
      kind: "provider";
      /** An id from `llm.providers`. */
      providerId: string;
      /** The provider's configured chat model, when the config names one. */
      model: string | null;
      /** Where the choice came from, for the error and the result file. */
      source: "judgeProvider" | "active";
      timeoutMs: number;
    };

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

/** What the judge's own calls used (eval overhead, kept apart from the runs). */
export interface SkillEvalJudgeUsage {
  calls: number;
  /** Null when no call reported usage. */
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** The service's bill when it reports one, else an estimate from model pricing; null when nothing priced any call. */
  costUsd: number | null;
}

export interface SkillEvalJudge {
  /** The model that grades, when known. */
  readonly model: string | null;
  /** The endpoint, for an `http` judge; null for a provider judge. */
  readonly baseUrl: string | null;
  /** The provider id, for a provider judge; null for an `http` judge. */
  readonly providerId: string | null;
  score(input: SkillEvalJudgeInput): Promise<SkillEvalJudgeVerdict>;
  /** Running total over every `score` call so far. */
  usage(): SkillEvalJudgeUsage;
}

const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;
const JUDGE_MAX_TOKENS = 256;

/**
 * Pick the judge, or `{ error }` when there is none `skill eval` may use.
 * `judgeProvider` is `skills.eval.judgeProvider` from config.
 */
export function resolveJudgeConfig(
  flags: { url?: string | null; model?: string | null },
  llm: Pick<ResolvedLlmConfig, "activeTextProvider" | "providers">,
  judgeProvider: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SkillEvalJudgeConfig | { error: string } {
  const timeout = Number.parseInt(env.ATOMIC_AGENT_JUDGE_TIMEOUT_MS ?? "", 10);
  const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_JUDGE_TIMEOUT_MS;
  const url = (flags.url ?? env.ATOMIC_AGENT_JUDGE_URL)?.trim();
  if (url) {
    const baseUrl = url.replace(/\/+$/, "");
    const model = (flags.model ?? env.ATOMIC_AGENT_JUDGE_MODEL)?.trim();
    if (!model) return { error: `the judge at ${baseUrl} needs a model: set ATOMIC_AGENT_JUDGE_MODEL or pass --judge-model` };
    const apiKey = env.ATOMIC_AGENT_JUDGE_API_KEY ?? env.OPENROUTER_API_KEY ?? null;
    if (requiresApiKey(baseUrl) && !apiKey) {
      return { error: `the judge at ${baseUrl} needs an API key: set ATOMIC_AGENT_JUDGE_API_KEY (or OPENROUTER_API_KEY)` };
    }
    return { kind: "http", baseUrl, model, apiKey, timeoutMs };
  }
  const ids = llm.providers.map((p) => p.id);
  const pick = (id: string, source: "judgeProvider" | "active"): SkillEvalJudgeConfig | { error: string } => {
    const entry = llm.providers.find((p) => p.id === id);
    if (!entry) return { error: `skills.eval.judgeProvider "${id}" is not one of your providers (${ids.join(", ") || "none"})` };
    if (entry.kind === "llama-server") {
      return { error: `skills.eval.judgeProvider "${id}" is the local model, the one under test: name a cloud provider` };
    }
    return { kind: "provider", providerId: id, model: entry.model ?? entry.defaultChatModel ?? null, source, timeoutMs };
  };
  if (judgeProvider) return pick(judgeProvider, "judgeProvider");
  const active = llm.providers.find((p) => p.id === llm.activeTextProvider);
  if (active && active.kind !== "llama-server") return pick(active.id, "active");
  return {
    error:
      "there is no judge: the active model is local. Set skills.eval.judgeProvider to one of your cloud providers " +
      `(${ids.filter((id) => llm.providers.find((p) => p.id === id)?.kind !== "llama-server").join(", ") || "none configured"}), ` +
      "or ATOMIC_AGENT_JUDGE_URL and ATOMIC_AGENT_JUDGE_MODEL",
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

export interface SkillEvalJudgeDeps {
  /** The live provider for a `provider` judge (`runtime.providerRegistry.getProvider`). */
  provider?: LlmProvider | null;
  /** Cost of one call's usage when the service did not bill it; null when the model has no pricing. */
  priceUsage?: (usage: CompletionUsage, modelId: string | null) => number | null;
  fetchImpl?: typeof fetch;
}

/** The emit function a provider judge answers through (native tools links answer in `tool_calls`). */
const JUDGE_EMIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 1, maximum: 5 },
    reason: { type: "string", description: "At most 200 characters." },
  },
  required: ["score", "reason"],
  additionalProperties: false,
};

export function createSkillEvalJudge(config: SkillEvalJudgeConfig, deps: SkillEvalJudgeDeps = {}): SkillEvalJudge {
  const total = { calls: 0, prompt: 0, completion: 0, withUsage: 0, cost: 0, priced: 0 };
  const record = (usage: CompletionUsage | undefined, modelId: string | null): void => {
    total.calls += 1;
    if (!usage) return;
    total.withUsage += 1;
    total.prompt += usage.promptTokens;
    total.completion += usage.completionTokens;
    const billed = typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0 ? usage.costUsd : null;
    const cost = billed ?? deps.priceUsage?.(usage, modelId) ?? null;
    if (cost !== null) {
      total.cost += cost;
      total.priced += 1;
    }
  };
  const usage = (): SkillEvalJudgeUsage => ({
    calls: total.calls,
    promptTokens: total.withUsage > 0 ? total.prompt : null,
    completionTokens: total.withUsage > 0 ? total.completion : null,
    totalTokens: total.withUsage > 0 ? total.prompt + total.completion : null,
    costUsd: total.priced > 0 ? total.cost : null,
  });

  if (config.kind === "provider") {
    const provider = deps.provider;
    if (!provider) throw new Error(`judge provider "${config.providerId}" is not loaded`);
    return {
      model: provider.chatModelId ?? config.model,
      baseUrl: null,
      providerId: config.providerId,
      usage,
      async score(input) {
        const [system, user] = buildJudgeMessages(input);
        const request = buildCloudSubcallRequest({
          prompt: `${system!.content}\n\n${user!.content}`,
          emitFunctionName: "emit_verdict",
          argsSchema: JUDGE_EMIT_SCHEMA,
          description: "Emit the score and the reason",
          // Its own partition, like the other side calls: a judge the
          // provider refuses must not reroute anything else.
          sessionId: "skill-eval-judge",
          maxTokens: JUDGE_MAX_TOKENS,
        });
        const result = await provider.complete({
          ...request,
          temperature: 0,
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        record(result.usage, result.modelId ?? provider.chatModelId ?? config.model);
        const args = result.toolCalls?.[0]?.function?.arguments;
        return parseJudgeVerdict(typeof args === "string" && args.length > 0 ? args : result.content);
      },
    };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const endpoint = chatCompletionsUrl(config.baseUrl);
  return {
    model: config.model,
    baseUrl: config.baseUrl,
    providerId: null,
    usage,
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
        const json = (await response.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
        };
        const u = json.usage;
        record(
          u && typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number"
            ? {
                promptTokens: u.prompt_tokens,
                completionTokens: u.completion_tokens,
                totalTokens: u.prompt_tokens + u.completion_tokens,
                ...(typeof u.cost === "number" ? { costUsd: u.cost } : {}),
              }
            : undefined,
          config.model,
        );
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
