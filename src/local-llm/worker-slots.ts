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
 * **What actually bounds it.** llama.cpp divides `--ctx-size` between
 * `--parallel` slots: each slot gets `ctx / parallel` tokens, and a
 * worker whose slot is smaller than its own prompt cannot run at all. A
 * worker's prompt is the same stable prefix every turn carries (persona,
 * tool catalog, capabilities — ~5.2k tokens on its own) plus the brief
 * and whatever it reads, and it generates against
 * `completionMaxTokens`. So the honest ceiling is how many times
 * `MIN_SLOT_CONTEXT` fits in the context the daemon was actually given —
 * which is itself already sized from VRAM by `context-size.ts`. Bigger
 * machine, bigger context, more slots, with no new hardware probe and
 * nothing for the operator to decide.
 *
 * The context is the binding constraint rather than VRAM directly
 * because the KV cache for the whole context is allocated up front:
 * splitting it four ways costs nothing extra in memory, it just makes
 * each share smaller.
 */

/**
 * Tokens a worker slot needs to be useful.
 *
 * Measured, not guessed: a worker's stable prefix in a real session was
 * 7,388 tokens, and its brief plus the file it is working on is the
 * rest. 8k is that floor with room to finish a tool call.
 *
 * It was 16,384 — `MIN_AUTO_CONTEXT`, borrowed on the assumption that a
 * worker needs what a chat session needs. It does not, and the
 * borrowed number did real damage: a 12B model whose auto-context
 * lands at ~16-24k divided to exactly ONE slot, so every fan-out ran
 * sequentially. In the session that exposed it, three tasks queued
 * behind each other and two died on the worker timeout — after which
 * the orchestrator gave up on the workers and built everything itself.
 * A conservative number in the wrong place is not conservative.
 */
export const MIN_SLOT_CONTEXT = 8_192;

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

/**
 * Floor for a GPU launch.
 *
 * A fan-out of one is not a fan-out — it is the orchestrator waiting in
 * a queue it built itself, paying the delegation overhead for none of
 * the parallelism. Two slots on a context that can only really afford
 * one is the better failure: each worker gets a smaller share and may
 * truncate, which comes back as a task to re-delegate, where being
 * serialised comes back as a timeout and a mode that looks broken.
 */
export const MIN_GPU_SLOTS = 2;

export interface WorkerSlotsInput {
  /**
   * The context the daemon is being launched with, in tokens. `null`
   * when it is left to llama.cpp (no `--ctx-size` flag), where the model
   * decides and this process does not know the number.
   */
  contextSize: number | null;
  /** CPU-only launch (`-ngl 0`). */
  cpuOnly: boolean;
}

/**
 * The slot count for a managed launch.
 *
 * CPU-only is always one: concurrent slots there share the same cores,
 * so two workers do not finish sooner than two in a row — they finish at
 * the same time, both late, having doubled the memory traffic.
 */
export function resolveWorkerSlots(input: WorkerSlotsInput): number {
  if (input.cpuOnly) return 1;
  const ctx = input.contextSize;
  if (ctx === null || !Number.isFinite(ctx) || ctx <= 0) return DEFAULT_SLOTS;
  const fits = Math.floor(ctx / MIN_SLOT_CONTEXT);
  return Math.max(MIN_GPU_SLOTS, Math.min(fits, MAX_AUTO_SLOTS));
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
