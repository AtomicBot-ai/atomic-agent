/**
 * How many workers this machine can actually serve at once.
 *
 * The count used to be an operator setting — `localModels.managed.parallel`,
 * default 2, edited from a list in the composer. That is the wrong party
 * to ask. The number is not a preference: it is a property of the
 * machine and the model loaded on it, and the operator choosing it means
 * either a timid two on hardware that could serve six, or six on a
 * server whose context cannot hold them.
 *
 * **What actually bounds it.** The managed daemon launches with `-kvu`, a
 * unified KV cache: `--ctx-size` is ONE pool of tokens every `--parallel`
 * slot draws from, not `ctx / parallel` private shares. Nothing stops N
 * slots from each accepting a prompt the pool can only hold once — the
 * server finds out when the sum crosses the ceiling, and then every
 * request still running fails together with HTTP 500 "Context size has
 * been exceeded". So the honest ceiling is how many whole worker
 * footprints (`workerSlotFootprint`) fit in the context the daemon was
 * actually given — which is itself sized from memory by `context-size.ts`.
 * Bigger machine, bigger context, more slots, with no new hardware probe
 * and nothing for the operator to decide.
 *
 * The context is the binding constraint rather than VRAM directly
 * because the KV cache for the whole context is allocated up front: more
 * slots cost nothing extra in memory, they only compete for the same
 * pool.
 */

/**
 * Tokens a worker's prompt carries before it generates anything: the
 * stable prefix (persona, the worker tool catalog, capabilities) plus the
 * framing of its brief.
 *
 * Measured, not guessed. It was taken as 7,388 from one session, and the
 * old per-slot floor of 8,192 was built on that. A Gemma 4 31B fan-out on
 * a 64 GB M1 Max then put four workers' prompts at 8,121 / 8,292 / 8,147 /
 * 8,212 tokens before any of them produced a token — 32,772 together on a
 * 32,768-token unified pool — and all four died on the same HTTP 500
 * after 590 s. A second fan-out's prompts reached 9,300 and 10,295. Ten
 * thousand is the stable part of that, rounded to what was seen.
 */
export const WORKER_PROMPT_BASE_TOKENS = 10_000;

/**
 * What a worker adds to its own context while it works: the brief's
 * content and the files and tool results it reads back.
 */
export const WORKER_READS_ALLOWANCE_TOKENS = 6_000;

/**
 * The reply allowance when `localModels.completionMaxTokens` is unknown or
 * `0` ("no client-side cap"). A `0` really means a reply may run until the
 * context fills, which no finite footprint can honour; the schema default
 * is the number the rest of the local path already plans against, and
 * `worker-slots.test.ts` pins that the two stay equal.
 */
export const DEFAULT_WORKER_COMPLETION_TOKENS = 16_384;

/**
 * Tokens one worker occupies in the shared pool at its peak: its prompt,
 * what it reads, and its reply — ~32k at the default reply cap.
 */
export function workerSlotFootprint(completionMaxTokens?: number): number {
  const reply =
    completionMaxTokens !== undefined &&
    Number.isFinite(completionMaxTokens) &&
    completionMaxTokens > 0
      ? Math.floor(completionMaxTokens)
      : DEFAULT_WORKER_COMPLETION_TOKENS;
  return WORKER_PROMPT_BASE_TOKENS + WORKER_READS_ALLOWANCE_TOKENS + reply;
}

/**
 * Ceiling on the derived count. Past a handful of slots the local server
 * is sharing one set of weights and one memory bus between all of them:
 * each leg gets slower in proportion, so the wall-clock win flattens
 * while the failure modes (evicted KV, queued requests timing out) do
 * not. Eight is generous for a single-GPU or unified-memory machine,
 * which is what a managed daemon runs on.
 */
export const MAX_AUTO_SLOTS = 8;

/** What a launch with nothing known falls back to — the historical default. */
export const DEFAULT_SLOTS = 2;

export interface WorkerSlotsInput {
  /**
   * The context the daemon is being launched with, in tokens. `null`
   * when it is left to llama.cpp (no `--ctx-size` flag), where the model
   * decides and this process does not know the number.
   */
  contextSize: number | null;
  /** CPU-only launch (`-ngl 0`). */
  cpuOnly: boolean;
  /**
   * `localModels.completionMaxTokens` — the reply part of a worker's
   * footprint. Omitted (or `0`) uses `DEFAULT_WORKER_COMPLETION_TOKENS`.
   */
  completionMaxTokens?: number;
}

/**
 * The slot count for a managed launch.
 *
 * At least one, never a floor of two. There used to be one ("a fan-out
 * of one is not a fan-out"), on the theory that two narrow slots fail
 * softer than one wide one because a truncated worker can be
 * re-delegated. On a unified pool that is backwards: two workers that
 * each need most of the pool do not truncate, they overflow it together
 * and both fail — the run that measured the footprint lost every worker
 * to one 500. One worker at a time is slow; it also finishes.
 *
 * CPU-only is always one: concurrent slots there share the same cores,
 * so two workers do not finish sooner than two in a row — they finish at
 * the same time, both late, having doubled the memory traffic.
 */
export function resolveWorkerSlots(input: WorkerSlotsInput): number {
  if (input.cpuOnly) return 1;
  const ctx = input.contextSize;
  if (ctx === null || !Number.isFinite(ctx) || ctx <= 0) return DEFAULT_SLOTS;
  const fits = Math.floor(ctx / workerSlotFootprint(input.completionMaxTokens));
  return Math.max(1, Math.min(fits, MAX_AUTO_SLOTS));
}

/**
 * Resolve the configured value, where `"auto"` means "ask the machine".
 * A number the operator pinned is honoured as written — the escape hatch
 * for an external server, an unusual model, or a benchmark.
 */
export function resolveConfiguredSlots(
  configured: number | "auto",
  input: WorkerSlotsInput,
): number {
  return configured === "auto" ? resolveWorkerSlots(input) : configured;
}
