/**
 * Contract for the LLM-as-judge layer. The eval harness only depends on
 * `JudgeClient`; the concrete HTTP implementation lives in
 * `judge-client.ts` and can be swapped (e.g. with a fake for unit tests
 * of the harness itself, when we get there).
 *
 * Why a thin interface: the harness is sometimes invoked without a
 * judge (CSV-only run, judge URL unreachable, or `eval:judge` pass over
 * saved data). Code paths that may run without a judge guard with
 * `judge ?? null` and surface a structured failure when a judge
 * expectation is encountered without a client.
 */

export interface JudgeInput {
  /** Verbatim user prompt that was fed to the agent. */
  prompt: string;
  /** Verbatim assistant reply produced by the agent. */
  reply: string;
  /** Case-specific rubric: the criteria the judge must apply. */
  rubric: string;
}

export interface JudgeVerdict {
  /** Integer score 1..5 (1 = wrong, 3 = partial, 5 = fully correct). */
  score: number;
  /** Free-form reason, capped at ~200 chars by the prompt template. */
  reason: string;
  /** Wall-clock duration of the judge HTTP call. */
  durationMs: number;
  /** Raw model output for debugging when JSON parsing falls back. */
  raw: string;
  /** True when the judge response could not be parsed as JSON. */
  parseFallback: boolean;
}

export interface JudgeClient {
  score(input: JudgeInput): Promise<JudgeVerdict>;
}

export interface JudgeConfig {
  /**
   * OpenAI-compatible base URL. Accepted forms:
   *   https://openrouter.ai/api/v1        (OpenRouter, default)
   *   https://api.openai.com/v1
   *   http://127.0.0.1:8080                (llama-server, no /v1 needed)
   *   https://host/path/chat/completions   (fully qualified)
   * Trailing slashes are stripped; `/chat/completions` is auto-appended
   * when absent.
   */
  baseUrl: string;
  /** Model id sent to the endpoint. Required by hosted providers. */
  model: string;
  apiKey: string | null;
  /** Bound for `max_tokens` in the chat call. */
  maxTokens: number;
  /** Hard timeout per judge call (ms). */
  timeoutMs: number;
  /** OpenRouter attribution header (HTTP-Referer). Ignored by other providers. */
  refererUrl?: string;
  /** OpenRouter attribution header (X-Title). Ignored by other providers. */
  appTitle?: string;
}
