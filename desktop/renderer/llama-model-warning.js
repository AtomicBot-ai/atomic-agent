/* ATO-2012: the line under a llama.cpp address that answers /health but has
   no model to chat with. main's llamaProbe sets `noModels` (an empty
   /v1/models list, a router started with no model) or `loading` (503
   "Loading model") on a probe that still passes. The address is accepted
   either way, as LM Studio and Open WebUI accept a server with nothing
   loaded and list its models later; this only says why chats will wait. */

/** The host:port the person typed, for the sentence; the whole URL if it does not parse. */
function llamaWarnHost(url) {
  try { return new URL(String(url)).host || String(url); } catch (err) { return String(url || 'the server'); }
}

/** The warning for a passing probe, or null when the server has a model. */
function llamaModelWarning(probe, url) {
  if (!probe || probe.reachable !== true) return null;
  const host = llamaWarnHost(url);
  if (probe.loading === true) return host + ' is still loading its model. You can continue; it will answer once the model is loaded.';
  if (probe.noModels === true) return host + ' has no model loaded. Load a model into the server; the agent will use it once it is loaded.';
  return null;
}

/** First run: the warning shows on the first Enter, the same address on the next Enter goes on. */
const LLAMA_WARN_CONTINUE = 'Press Enter again to continue.';

/** True when this Enter is the second one on an address already warned about on this step. */
function llamaWarnAcknowledged(seen, step, url) {
  return !!seen && seen.step === step && seen.url === url;
}

if (typeof module !== 'undefined') module.exports = { llamaModelWarning, llamaWarnHost, llamaWarnAcknowledged, LLAMA_WARN_CONTINUE };
