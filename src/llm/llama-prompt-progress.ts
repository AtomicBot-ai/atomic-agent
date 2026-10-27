import type { PromptProgress } from "./provider/completion-types.js";

/**
 * llama.cpp's prompt-evaluation progress on a streamed completion
 * (ATO-1027). A request that sets `return_progress` gets, before its
 * first token, one event per evaluated batch carrying
 * `prompt_progress: { total, cache, processed, time_ms }` and no text.
 * On a local model the first message of a session can sit there for
 * minutes; this is the only measured word on how far it got.
 */

/** The event's `prompt_progress`, or `null` when it carries none (or a malformed one). */
export function readPromptProgress(
  event: Record<string, unknown>,
): PromptProgress | null {
  const raw = event.prompt_progress;
  if (raw === null || typeof raw !== "object") return null;
  const fields = raw as Record<string, unknown>;
  const total = count(fields.total);
  const processed = count(fields.processed);
  if (total === null || processed === null || total <= 0) return null;
  return {
    processed: Math.min(processed, total),
    total,
    cached: Math.min(count(fields.cache) ?? 0, total),
    elapsedMs: count(fields.time_ms) ?? 0,
  };
}

/**
 * Report an event's progress to `onProgress` and say whether the event
 * was progress and nothing else. Such an event is not the reply
 * starting: it must not end the first-token wait, and it is never
 * yielded as a chunk (the fallback chain reads the first yielded chunk
 * as "this link is serving"). Without a listener nothing asked for
 * progress, and every event is read as it always was.
 *
 * A listener that throws is ignored: progress is a courtesy to the host,
 * never a reason to lose the completion.
 */
export function takePromptProgress(
  event: Record<string, unknown>,
  onProgress: ((progress: PromptProgress) => void) | undefined,
): boolean {
  if (onProgress === undefined) return false;
  const progress = readPromptProgress(event);
  if (progress === null) return false;
  try {
    onProgress(progress);
  } catch {
    // see above
  }
  const content = typeof event.content === "string" ? event.content : "";
  const reasoning =
    typeof event.reasoning_content === "string" ? event.reasoning_content : "";
  return content.length === 0 && reasoning.length === 0 && event.stop !== true;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
