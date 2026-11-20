/* ---------------- ATO-631: the KV-cache share next to a reply's speed ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/kv-cache-share.test.mjs).

   The agent sends `event: step_speed` after every model completion
   (src/http/stream-turn-phase.ts): `{prompt_tokens, cached_tokens,
   prefill_ms, decode_ms, decode_tokens_per_second, ...}`. The terminal
   shows it in its composer bar as `12 tok/s · cache 92%`
   (src/llm/step-speed.ts formatStepSpeedParts). The window already shows
   the reply's tok/s under the last reply (status-line.js); this adds the
   cache share beside it, worded as the terminal words it.

   The reading is the turn's LAST step, as in the terminal: that is the
   step that wrote the reply, and its prompt is the whole chat so far, so
   its share answers "did the model re-read everything this time".
   An agent without ATO-631 sends no such frame, and nothing is shown. */

/* {prompt, cached} from a step_speed frame, or null when it tells no
   prompt size. `cached` is clamped to the prompt, as the agent does. */
function stepCacheOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const prompt = Number(payload.prompt_tokens);
  if (!Number.isFinite(prompt) || prompt <= 0) return null;
  const raw = Number(payload.cached_tokens);
  const cached = Number.isFinite(raw) && raw > 0 ? Math.min(prompt, raw) : 0;
  return {prompt, cached};
}

/* "cache 92%", '' when there is no reading. Never rounds a partial hit up
   to 100% or a small one down to 0%: those would read as "all" and "none". */
function cacheShareWord(cache) {
  if (!cache || !(cache.prompt > 0)) return '';
  const share = cache.cached / cache.prompt;
  let pct = Math.round(share * 100);
  if (pct === 100 && cache.cached < cache.prompt) pct = 99;
  if (pct === 0 && cache.cached > 0) pct = 1;
  return 'cache ' + pct + '%';
}

/* The figure as HTML, beside the reply's tok/s; its tooltip the exact
   counts. '' when there is no reading. */
function cacheShareHTML(cache) {
  const word = cacheShareWord(cache);
  if (!word) return '';
  const tip = cache.cached + ' of ' + cache.prompt + ' prompt tokens served from the KV cache on the last step';
  return '<span class="msgtps msgcache" title="' + tip + '" aria-label="KV cache: ' + word.slice(6) + '">' + word + '</span>';
}

if (typeof module !== 'undefined') module.exports = {stepCacheOf, cacheShareWord, cacheShareHTML};
