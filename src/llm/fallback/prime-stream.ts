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
 *
 * **The buffered first chunk is a hole in the `yield*` chain.** Every
 * later chunk is delegated, and `yield*` forwards a `.return()` to
 * `primed.rest` for us — but the first one is yielded from this
 * function's own frame, and a consumer that walks away *there* closes
 * only this generator. `primed.rest` is the still-open provider stream
 * with a live socket on the end of it; nothing else holds a reference,
 * so it would never run its own release and the llama.cpp slot behind
 * it would stay occupied until the process exits. Since the abandon is
 * likeliest at exactly this point — the first chunk is the first moment
 * a consumer has anything to react to — the hole is closed explicitly.
 *
 * `replayed` is what distinguishes the two exits: once the first yield
 * has resumed, `yield*` owns the forwarding and closing `primed.rest`
 * here would be a second, wrong close. Rejections are swallowed because
 * this runs while we are already unwinding.
 */
export async function* replayPrimedStream<TChunk, TReturn>(
  primed: PrimedStream<TChunk, TReturn>,
): AsyncGenerator<TChunk, TReturn, void> {
  if (primed.first.done) {
    return primed.first.value;
  }
  let replayed = false;
  try {
    yield primed.first.value;
    replayed = true;
    return yield* primed.rest;
  } finally {
    if (!replayed) {
      await primed.rest.return(undefined as never).catch(() => undefined);
    }
  }
}
