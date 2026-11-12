import {
  isErrorFinishMessage,
  OpenAiHttpError,
} from "../provider/openai/openai-http.js";

/** Depth cap on the `cause` walk; longer is a cycle. */
const MAX_CAUSE_DEPTH = 5;

/** Timeout answers a gateway reports inside a stream: 524 is Cloudflare's. */
const TIMEOUT_STATUSES = new Set([408, 504, 524]);

const TIMEOUT_WORDS = /\btime(?:d)?[ -]?out\b/i;

export interface MidReplyTimeout {
  /** The name to show for the provider that timed out. */
  provider: string;
  status: number | null;
  url: string;
}

/**
 * Did a provider end an open stream by reporting a time limit? Only an
 * error reported inside the stream counts: a 504 on the open means no
 * reply was started, and a dropped connection says nothing about a limit.
 */
export function readMidReplyTimeout(err: unknown): MidReplyTimeout | null {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return null;
    if (current instanceof OpenAiHttpError && current.streamError !== undefined) {
      if (isErrorFinishMessage(current.streamError)) return null;
      const timedOut =
        (current.status !== null && TIMEOUT_STATUSES.has(current.status)) ||
        TIMEOUT_WORDS.test(current.streamError);
      if (!timedOut) return null;
      return {
        provider: current.providerLabel || "The provider",
        status: current.status,
        url: current.url,
      };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
