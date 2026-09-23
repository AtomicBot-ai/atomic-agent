/**
 * The provider's generation id (`id` on every SSE chunk and on a unary
 * response — `gen-…` on OpenRouter, `chatcmpl-…` on OpenAI), carried on
 * completions and on errors thrown after a stream had produced output.
 *
 * A 504 after 10,528 streamed tokens is still billed. Without the id in
 * the trace the cost is invisible; with it the operator can look the
 * generation up at the provider and recover the figure.
 */
export function attachGenerationId<T>(err: T, generationId: string | null): T {
  if (generationId === null || typeof err !== "object" || err === null) {
    return err;
  }
  const target = err as { generationId?: unknown };
  if (typeof target.generationId !== "string") {
    try {
      Object.defineProperty(target, "generationId", {
        value: generationId,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } catch {
      // A frozen error keeps its shape; the id is lost, nothing else.
    }
  }
  return err;
}

/** Depth cap on the `cause` walk — longer is a cycle. */
const MAX_CAUSE_DEPTH = 5;

/** The generation id on an error or any error in its `cause` chain. */
export function readGenerationId(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const id = (current as { generationId?: unknown }).generationId;
    if (typeof id === "string" && id.length > 0) return id;
    const next = (current as { cause?: unknown }).cause;
    if (next === current || next === undefined) return undefined;
    current = next;
  }
  return undefined;
}
