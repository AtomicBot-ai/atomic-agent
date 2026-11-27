/* ---------------- ATO-2413: the cloud model list in Settings › Models ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/llm-model-list.test.mjs).

   Settings › Models, Cloud, OpenRouter sat on "Fetching the model list…"
   with only the current model listed, and never left it. Two ways led there:

   - The section said "loading" for any provider whose list had not been
     asked for (LLMP.modelsFor naming another one). The provider the section
     shows follows the live config, which several screens re-read (a provider
     added, the capabilities poll), so a switch to OpenRouter painted the
     spinner and nothing ever asked OpenRouter.
   - The ask itself had no deadline in the renderer, and a rejected IPC call
     left modelsBusy set for good, which also blocks every later ask.

   So: a section with no ask behind it starts one (llmListScheduleAsk), the
   ask has a deadline and turns a throw into an error (llmListAsk), the
   error has a Try again, and the last good list per provider is kept for
   the session (llmListCachePut / llmListCacheGet) and shown while the list
   is asked again. Precedent in this app: the composer's model picker
   already keeps a live list per provider for the session (SEL_LIVE_MODELS)
   and shows it at once when reopened. */

/* The agent's own OpenRouter fetch gives up after 20 s; this leaves room
   for the process start and the built-in list read beside it. */
const LLM_LIST_DEADLINE_MS = 30 * 1000;

/* The last good list per provider id, for this window's life. */
const LLM_LIST_CACHE = new Map();
function llmListCachePut(providerId, models) {
  if (!providerId || !Array.isArray(models) || !models.length) return;
  LLM_LIST_CACHE.set(providerId, models.slice());
}
function llmListCacheGet(providerId) {
  const hit = providerId ? LLM_LIST_CACHE.get(providerId) : null;
  return hit ? hit.slice() : null;
}

/* What the error line says when the deadline passed. */
function llmListDeadlineLine(word, ms) {
  return 'no answer from ' + (word || 'the provider') + ' within ' + Math.round((ms || LLM_LIST_DEADLINE_MS) / 1000) + ' s';
}

/**
 * Ask for a provider's list with a deadline. `ask` returns the bridge's
 * promise. Resolves, never rejects:
 *  - the bridge's answer when it comes in time;
 *  - {ok:false, error, deadline:true, late} when it does not: `late` is the
 *    same answer, still on its way, for a caller that wants to use it
 *    when it lands;
 *  - {ok:false, error} when the bridge threw.
 */
function llmListAsk(ask, word, ms, timers) {
  /* The window's timers called bare: as methods of a plain object Chromium
     throws "Illegal invocation", which rejected the ask before modelsBusy cleared. */
  const t = timers || {setTimeout: (fn, delay) => setTimeout(fn, delay), clearTimeout: (id) => clearTimeout(id)};
  const limit = typeof ms === 'number' && ms > 0 ? ms : LLM_LIST_DEADLINE_MS;
  let answer;
  try { answer = Promise.resolve(ask()); }
  catch (err) { answer = Promise.reject(err); }
  const settled = answer.then((res) => res || {ok:false, error:'no answer'}, llmListAskFailed);
  return new Promise((resolve) => {
    const timer = t.setTimeout(() => resolve({ok:false, deadline:true, error:llmListDeadlineLine(word, limit), late:settled}), limit);
    settled.then((res) => { t.clearTimeout(timer); resolve(res); });
  });
}

/* ATO-2739: the Settings error banner's sentence. The reason (one of
   renderer.js modelListFailLine's sentences, or a short line of ours) sat in
   parentheses with its own period and status code: "Couldn't fetch the model
   list (OpenRouter did not accept the saved key (401).). Showing ...". Now it
   follows a colon, and a status or certificate code moves to the hover detail. */
const LLM_LIST_CODE = /\s*\(((?:HTTP )?[1-5]\d\d|[A-Z][A-Z0-9_]{3,})\)/g;
function llmListErrorBanner(error) {
  const codes = [];
  const reason = String(error || 'unknown error').trim()
    .replace(LLM_LIST_CODE, (_, code) => { codes.push(/^\d/.test(code) ? 'HTTP ' + code : code); return ''; })
    .replace(/[.\s]+$/, '');
  return {text: 'Couldn\u2019t fetch the model list: ' + reason + '. Showing the current model only.', detail: codes.join(', ')};
}
function llmListErrorSpanHTML(error, esc, extra) {
  const b = llmListErrorBanner(error);
  const detail = [b.detail, extra || ''].filter(Boolean).join(', ');
  return '<span class="grow"' + (detail ? ' title="' + esc(detail) + '"' : '') + '>' + esc(b.text) + '</span>';
}

/* ATO-2739: the ask itself failed inside the app (the bridge threw, or
   Chromium's "Illegal invocation"): a fixed sentence on screen, the raw
   message only as `detail`, for the banner's hover title. */
const LLM_LIST_ASK_FAILED = 'something went wrong inside the app';
function llmListAskFailed(err) {
  return {ok:false, error:LLM_LIST_ASK_FAILED, detail:String((err && err.message) || err || '')};
}

/* A section that shows a provider nobody asked about asks for it, once,
   after the paint that found it (never from inside the paint). */
const LLM_LIST_KICK = {pending:false};
function llmListScheduleAsk(run, defer) {
  if (LLM_LIST_KICK.pending) return false;
  LLM_LIST_KICK.pending = true;
  (defer || ((fn) => setTimeout(fn, 0)))(() => { LLM_LIST_KICK.pending = false; run(); });
  return true;
}

if (typeof module !== 'undefined') module.exports = {LLM_LIST_DEADLINE_MS, LLM_LIST_CACHE, LLM_LIST_KICK, llmListCachePut, llmListCacheGet, llmListDeadlineLine, llmListAsk, llmListScheduleAsk, llmListErrorBanner, llmListErrorSpanHTML, LLM_LIST_ASK_FAILED, llmListAskFailed};
