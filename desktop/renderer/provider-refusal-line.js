/* ---------------- a cloud provider that said no (ATO-1673) ----------------
   Loaded before renderer.js; declares only.

   A cloud provider that answered a turn with a refusal (no credit left, too
   many requests, a model it does not serve, a model without tools, a request
   it turned down) used to open with "Couldn't get a reply from OpenRouter.",
   which is false: it replied, with a no. The terminal now opens with the
   shared catalog phrase for the agent's verdict and keeps the agent's
   sentence, with the HTTP status and the provider's own words, under
   Details (src/tui/chat/format-provider-refusal-for-chat.ts). This is the
   window's line for the same verdicts, with the provider named, because the
   window knows which one it picked.

   Read from the turn failure frame only: `payload.failure.cause` (the
   failure catalog id, src/llm/reliability/failure-catalog.ts), plus the
   agent's own tools sentence (src/llm/provider/openai/cloud-tools-unsupported.ts),
   which the catalog files under a 404 or a 400. A refused key is already
   worded by turnFailureLine (ATO-1458); a local route keeps its own lines.
   renderer.js owns the row (turnFailure) and the Details affordance. */

/** The agent's sentence for a cloud model without tool support. */
const PROVIDER_TOOLS_UNSUPPORTED = /\bsays this model can't use tools\b/;

/** One line per refusal, named after the provider. */
const PROVIDER_REFUSAL_LINES = {
  out_of_credit: (who) => who + ' says your account is out of credit.'
    + ' Top up your balance with ' + who + ', or pick another provider in Settings › Models.',
  rate_limited: (who) => who + ' says there are too many requests right now. Try again in a moment.',
  model_not_found: (who) => who + " doesn't have this model. Pick another model in Settings › Models.",
  request_rejected: (who) => who + ' turned down this request. Try another model in Settings › Models.',
};

/** The headline for a cloud provider's refusal, or '' when the frame is not
    one (or the route is a server on this machine). `who` is the provider's
    display name, '' when the window has none. */
function providerRefusalLine(ev, who, local) {
  if (local) return '';
  const name = String(who || '').trim() || 'The provider';
  const said = String((ev && ev.error) || '');
  if (PROVIDER_TOOLS_UNSUPPORTED.test(said)) {
    return name + " says this model can't use tools, and the agent needs them to work."
      + ' Pick a model that supports tool calling in Settings › Models.';
  }
  const f = (ev && ev.payload && ev.payload.failure) || {};
  const line = Object.prototype.hasOwnProperty.call(PROVIDER_REFUSAL_LINES, f.cause)
    ? PROVIDER_REFUSAL_LINES[f.cause]
    : null;
  return line ? line(name) : '';
}

if (typeof module !== 'undefined') {
  module.exports = {PROVIDER_REFUSAL_LINES, providerRefusalLine};
}
