import type { LlmStreamParams } from "../agent/step-executor.js";
import type { CompletionResult } from "../llm/provider/completion-types.js";

/** What a memory sub-call sends, minus the signal — the helper owns that. */
export type SubcallRequest = Omit<LlmStreamParams, "signal">;

export type SubcallComplete = (
  params: LlmStreamParams,
) => Promise<CompletionResult>;

/**
 * Adapt the runtime's `llmComplete` for a memory sub-call runner
 * (reflection, link generator, vote, query rewriter, distill).
 *
 * Every one of those runners enforces its timeout by aborting the signal
 * it passes in. The wrappers used to race the completion against that
 * abort without handing the signal to `llmComplete`, so the runner gave
 * up while the HTTP request kept going: still billing on a cloud
 * provider, still holding a llama-server slot, and — because an orphan
 * that later fails runs through the fallback chain like any request —
 * able to trip a breaker or flip the sticky override minutes after
 * anyone stopped caring about it.
 *
 * So the signal is forwarded into the request, which is what actually
 * cancels it (the fallback seam turns that abort into a `cancelled`
 * failure the chain never advances on). The race stays as a backstop:
 * the returned promise rejects the moment the signal aborts even if a
 * provider ignores the signal, so a runner's timeout is never hostage
 * to one.
 *
 * `shape` builds the request fields each runner sends today; it is kept
 * per call site so no wrapper's payload changes shape.
 */
export function abortableSubcall<P extends { signal: AbortSignal }>(
  complete: SubcallComplete,
  shape: (params: P) => SubcallRequest,
): (params: P) => Promise<CompletionResult> {
  return async (params) => {
    const { signal } = params;
    if (signal.aborted) throw subcallAbortError();
    const request: LlmStreamParams = { ...shape(params), signal };
    return new Promise<CompletionResult>((resolve, reject) => {
      const onAbort = (): void => reject(subcallAbortError());
      signal.addEventListener("abort", onAbort, { once: true });
      const detach = (): void => signal.removeEventListener("abort", onAbort);
      let pending: Promise<CompletionResult>;
      try {
        pending = complete(request);
      } catch (err) {
        detach();
        reject(err);
        return;
      }
      pending.then(
        (result) => {
          detach();
          resolve(result);
        },
        (err: unknown) => {
          detach();
          reject(err);
        },
      );
    });
  };
}

/** The same rejection the inline wrappers threw, so runners see no change. */
function subcallAbortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}
