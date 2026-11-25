/**
 * Ask one question to several models (ATO-487, folded into ATO-1092):
 * the same prompt, no tools, every model at once, answers kept in the
 * order the models were named.
 */

/** Send a plain prompt to one model and return its text. May throw. */
export type AskComplete = (model: string, prompt: string) => Promise<string>;

export interface ModelAnswer {
  model: string;
  /** The answer text; absent when the request failed. */
  text?: string;
  error?: string;
  ms: number;
}

export async function askManyModels(options: {
  models: readonly string[];
  prompt: string;
  complete: AskComplete;
  now?: () => number;
}): Promise<ModelAnswer[]> {
  const now = options.now ?? Date.now;
  // Concurrent on purpose: the models usually sit on different services,
  // and the point is to compare them side by side without waiting for
  // each in turn. Two models on one local server simply queue there.
  return Promise.all(
    options.models.map(async (model): Promise<ModelAnswer> => {
      const started = now();
      try {
        const text = await options.complete(model, options.prompt);
        return { model, text, ms: now() - started };
      } catch (err) {
        return {
          model,
          error: err instanceof Error ? err.message : String(err),
          ms: now() - started,
        };
      }
    }),
  );
}
