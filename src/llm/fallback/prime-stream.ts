/**
 * A stream whose first step has already been pulled. Splitting "open the
 * stream" from "consume the stream" lets the fallback chain treat a
 * failure to OPEN (an error thrown before the first `yield`) as a
 * fallover-worthy event, while a stream that has already emitted output
 * is never restarted.
 */
export interface PrimedStream<TChunk, TReturn> {
  /** The first step: either a yielded chunk or an immediate return. */
  first: IteratorResult<TChunk, TReturn>;
  /** The still-open generator, positioned just after `first`. */
  rest: AsyncGenerator<TChunk, TReturn, void>;
}

/**
 * Pull the first step of `stream`. If opening the stream throws (HTTP
 * error before any chunk), the error propagates to the caller — this is
 * the point the fallback chain uses to decide whether to advance. On
 * success the generator is returned positioned after its first step.
 */
export async function primeStream<TChunk, TReturn>(
  stream: AsyncGenerator<TChunk, TReturn, void>,
): Promise<PrimedStream<TChunk, TReturn>> {
  const first = await stream.next();
  return { first, rest: stream };
}

/**
 * Replay a primed stream: yield the buffered first chunk, then delegate
 * to the rest of the generator. A generator that returned on its first
 * step (empty stream) surfaces that return value directly.
 */
export async function* replayPrimedStream<TChunk, TReturn>(
  primed: PrimedStream<TChunk, TReturn>,
): AsyncGenerator<TChunk, TReturn, void> {
  if (primed.first.done) {
    return primed.first.value;
  }
  yield primed.first.value;
  return yield* primed.rest;
}
