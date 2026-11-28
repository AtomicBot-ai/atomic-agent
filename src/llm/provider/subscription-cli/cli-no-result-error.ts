import { CODEX_UPDATE, knownCli } from "./cli-exit-hint.js";
import { SubscriptionCliInvocationError } from "./subscription-cli-errors.js";

/**
 * A streamed CLI run that exited 0 but never wrote its final `result`
 * line (ATO-2522), so there is no answer to hand the turn.
 *
 * It used to be a bare `Error("claude stream ended without a result
 * envelope")`: Sentry got no `cli_*` tag, and the person read our
 * internal word "envelope" with no next step. Now it is a
 * `SubscriptionCliInvocationError` with the fixed kind
 * `no_result_envelope`, which the report sends as `cli_failure`, and the
 * message says what happened and what to try. A run that exited non-zero
 * never gets here: `streamCliCommand` throws its own failure first, so
 * the exit code is 0.
 */
export function noResultEnvelopeError(binary: string, productName: string): SubscriptionCliInvocationError {
  const cli = knownCli(binary);
  const update =
    cli === "claude"
      ? "update it with `claude update`"
      : cli === "codex"
        ? `update it (for example ${CODEX_UPDATE})`
        : "update it the way you installed it";
  return new SubscriptionCliInvocationError(
    `${productName} finished without sending its answer (its output had no final result line). Send the message again; if it keeps happening, ${update} and restart Atomic Agent.`,
    0,
    "no_result_envelope",
  );
}
