import { LlamaServerError } from "../llama-server-client.js";
import {
  isCreditExhausted,
  OpenAiHttpError,
} from "../provider/openai/openai-http.js";
import { CREDENTIAL_WORDING } from "../provider/openai/parse-provider-error-body.js";
import { isSubscriptionCliSetupError } from "../provider/subscription-cli/subscription-cli-errors.js";
import { TransportError } from "../reliability/llm-failures.js";
import { isNetworkError } from "../reliability/network-error.js";
import { readProviderErrorVerdict } from "../reliability/provider-error-verdict.js";

/**
 * Three questions the chain asks about a link that failed, beyond
 * `shouldAdvance`'s "is another link worth a try". Every cloud failure
 * advances, so the advance decision cannot tell a service that is down
 * from one that refused what it was sent; these can.
 */

/**
 * Did the link refuse its credentials?
 *
 * A 401 from a cloud link: the key is wrong, dead, missing, or could not
 * be sent at all (`openAiFetch` types a key that cannot form a header as
 * a 401 without sending anything). Nothing about it changes until
 * someone edits the key, so it is the one failure that outranks whatever
 * the rest of the chain said: see `runWithFallback`.
 *
 * A 403 counts only when it is about the key: no key was sent, or the
 * provider's words say so. A 403 is also a provider's "no" to the
 * request itself (OpenRouter answers one for input its moderation
 * flagged), and that one must not be read out as a key problem.
 */
export function isCredentialRejection(err: unknown): boolean {
  if (!(err instanceof OpenAiHttpError) || err.timedOut) return false;
  if (err.status === 401) return true;
  if (err.status !== 403) return false;
  if (err.keyProblem !== undefined) return true;
  // "Please top up your balance or update your payment method": the
  // account, not the key (item 40), whatever else the body mentions.
  if (isCreditExhausted(err)) return false;
  // The same words the billing reading defers to (one rule for both).
  return CREDENTIAL_WORDING.test(err.message);
}

/**
 * Did the link refuse because the account cannot pay?
 *
 * A 402, or a 403 / 429 whose body says the account is out of funds or
 * credit (`isCreditExhausted`: AI/ML API's 403 "You've run out of funds",
 * OpenAI's 429 `insufficient_quota`). The link answered and said no; the
 * key is fine and waiting changes nothing until someone tops up. Like a
 * refused key it outranks the outage a later link reports when the chain
 * runs out (`runWithFallback`), so the turn ends on its sentence instead
 * of parking on a stopped local server (item 40).
 */
export function isBillingRefusal(err: unknown): boolean {
  return err instanceof OpenAiHttpError && !err.timedOut && isCreditExhausted(err);
}

/**
 * Is the link a vendor CLI that cannot run until the user acts — the
 * binary is not installed, or the CLI is signed out?
 *
 * The link's own "no", like a refused key: the fix is the user's, and
 * it outranks the outage a later link reports when the chain runs out
 * (`runWithFallback`). Seen on Windows (ATO-117): `claude` was not
 * installed, the chain fell over to a local model nobody had pulled,
 * and the turn parked on that link's refused connection as "no
 * connection" instead of saying Claude Code was missing.
 */
export function isCliSetupRefusal(err: unknown): boolean {
  return isSubscriptionCliSetupError(err);
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
  // An empty account is a "no", even on a 429.
  if (isBillingRefusal(err)) return false;
  // So is a CLI that is not installed or signed out, whatever wraps it.
  if (isCliSetupRefusal(err)) return false;
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
