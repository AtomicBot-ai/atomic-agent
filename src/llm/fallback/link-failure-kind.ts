import { LlamaServerError } from "../llama-server-client.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { TransportError } from "../reliability/llm-failures.js";
import { isNetworkError } from "../reliability/network-error.js";
import { readProviderErrorVerdict } from "../reliability/provider-error-verdict.js";

/**
 * Two questions the chain asks about a link that failed, beyond
 * `shouldAdvance`'s "is another link worth a try". Every cloud failure
 * advances, so the advance decision cannot tell a service that is down
 * from one that refused what it was sent; these two can.
 */

/**
 * Did the link refuse its credentials?
 *
 * A 401 or 403 from a cloud link: the key is wrong, dead, missing, or
 * could not be sent at all (`openAiFetch` types a key that cannot form a
 * header as a 401 without sending anything). Nothing about it changes
 * until someone edits the key, so it is the one failure that outranks
 * whatever the rest of the chain said: see `runWithFallback`.
 */
export function isCredentialRejection(err: unknown): boolean {
  return (
    err instanceof OpenAiHttpError &&
    !err.timedOut &&
    (err.status === 401 || err.status === 403)
  );
}

/**
 * Is the link not answering right now, as opposed to answering "no"?
 *
 * No response at all (DNS, refused connection, TLS, a socket reset, a
 * request timeout), a server error, "busy, later" (408 / 429), or a
 * provider that asked for a cooldown. The same line the agent loop draws
 * for its outage wait (`isWaitableOutage`), read off the raw link error
 * rather than the loop's wrapped one. Everything else that advances the
 * chain (a refused key, an unknown model, exhausted credit, a defective
 * completion) is the link saying no, and waiting does not change it.
 */
export function isOutageFailure(err: unknown): boolean {
  const status = statusOf(err);
  if (status === null) return true;
  if (status !== undefined) {
    return (
      status >= 500 ||
      status === 408 ||
      status === 429 ||
      readProviderErrorVerdict(err)?.kind === "retry_after"
    );
  }
  return isNetworkError(err);
}

function statusOf(err: unknown): number | null | undefined {
  if (err instanceof OpenAiHttpError) return err.status;
  if (err instanceof LlamaServerError) return err.status;
  if (err instanceof TransportError) return err.status;
  return undefined;
}
