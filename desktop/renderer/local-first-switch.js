/* ATO-2434: the "Start on the local model" switch in Settings › Models ›
   Cloud › Fallback chain, for `llm.fallback.localFirst` (ATO-2208; the agent
   side is src/llm/fallback/local-first-head.ts, documented in
   src/llm/docs/fallback.md). On, a normal chat turn whose active provider is
   a cloud one starts on the configured local (llama-server) model and goes
   to the cloud only when the local one fails.

   The write is the pane's own: the whole `llm.fallback` object through
   llmWrite (the same whole-file `config set` the chain and the last-resort
   switch use), so the chain and appendLocal are kept as they are. Shared by
   the renderer and Node checks; no DOM, no IPC of its own. */

const LOCAL_FIRST_LABEL = 'Start on the local model';
const LOCAL_FIRST_HINT = 'Each chat turn tries your local model first and moves to the cloud model only if the local one fails.';

/* A local link the agent would skip because no model is chosen for it
   (src/runtime/local-link-availability.ts isLocalLinkWithoutModel, minus
   the on-disk check, which the window cannot make). */
function localFirstLinkWithoutModel(p, localModels) {
  const lm = localModels && typeof localModels === 'object' ? localModels : {};
  if (lm.mode !== 'managed') return false;
  if (p.url !== undefined && p.url !== lm.url) return false;
  const id = lm.managed && lm.managed.modelId;
  return typeof id !== 'string' || id === '';
}

/* What the switch shows. `fallback` is `llm.fallback` (or undefined),
   `providers` the configured providers, `activeKind` the active text
   provider's kind, `localModels` the config's localModels block. Local
   means kind `llama-server`, as the agent reads it. */
function localFirstView(fallback, providers, activeKind, localModels) {
  const fb = fallback && typeof fallback === 'object' ? fallback : {};
  const list = Array.isArray(providers) ? providers.filter((p) => p && typeof p.kind === 'string') : [];
  const on = fb.localFirst === true; // unset = off, like the agent's default
  const hasLocal = list.some((p) => p.kind === 'llama-server' && !localFirstLinkWithoutModel(p, localModels));
  const hasCloud = list.some((p) => p.kind !== 'llama-server');
  const reason = !hasLocal ? 'Set up a local model first.'
    : !hasCloud ? 'Add a cloud provider first.'
    : null;
  /* A switch that is already on can always be turned off, so a provider
     removed later never leaves it stuck on. */
  const disabled = !on && reason !== null;
  /* The agent does nothing with it while the local model is the active one. */
  const note = on && !reason && activeKind === 'llama-server'
    ? 'Your local model is already the active one, so this takes effect once a cloud model is active.'
    : null;
  return {on, disabled, reason, note};
}

/* deps: fallback() → llm.fallback now; write(next) → {ok, error?};
   refresh() reloads the live config; saved(on) says it landed; repaint(). */
function createLocalFirstSwitch(deps) {
  const st = {busy: false, error: null, detail: null};
  return {
    state: st,
    async toggle(view) {
      if (st.busy || !view || view.disabled) return {ok: false};
      const next = Object.assign({}, deps.fallback() || {}, {localFirst: !view.on});
      st.busy = true; st.error = null; st.detail = null;
      deps.repaint();
      const res = await Promise.resolve().then(() => deps.write(next))
        .catch((error) => ({ok: false, error: String((error && error.message) || error)}));
      st.busy = false;
      if (!res || res.ok === false) {
        st.error = 'Could not save this setting. Try again.';
        st.detail = (res && res.error) || 'unknown error';
        deps.repaint();
        return {ok: false};
      }
      await deps.refresh();
      deps.saved(next.localFirst);
      deps.repaint();
      return {ok: true};
    },
  };
}

/* The row, shaped like the last-resort switch above it. `esc` is the
   renderer's HTML escaper. The raw error stays behind Details. */
function localFirstSwitchHTML(view, state, esc) {
  const busy = !!(state && state.busy);
  const off = view.disabled || busy;
  const sub = view.reason && view.disabled ? view.reason : view.note || LOCAL_FIRST_HINT;
  const err = state && state.error
    ? '<div class="tk-notice tk-notice--red lf-err">' + '<span class="grow">' + esc(state.error)
      + (state.detail ? '<details class="lf-more"><summary>Details</summary><span class="mono">' + esc(state.detail) + '</span></details>' : '')
      + '</span></div>'
    : '';
  return '<div class="llm-fbl lf-row' + (view.disabled ? ' is-off' : '') + '">'
      + '<button class="tk-switch' + (view.on ? ' on' : '') + '" role="switch" aria-checked="' + view.on + '"'
      + (off ? ' disabled aria-disabled="true"' : ' data-act="llm:fb:localFirst"')
      + ' aria-label="' + LOCAL_FIRST_LABEL + '"' + (view.disabled ? ' title="' + esc(view.reason) + '"' : '') + '></button>'
      + '<span class="lf-text"><span class="llm-fbl-t">' + LOCAL_FIRST_LABEL + '</span>'
      + '<span class="llm-note">' + esc(sub) + '</span></span>'
      + '<span class="grow"></span>'
      + (busy ? '<span class="tk-spin"></span>' : '<span class="set-state' + (view.on ? ' on' : '') + '">' + (view.on ? 'On' : 'Off') + '</span>')
    + '</div>' + err;
}

if (typeof module !== 'undefined') module.exports = {localFirstView, localFirstLinkWithoutModel, createLocalFirstSwitch, localFirstSwitchHTML, LOCAL_FIRST_LABEL, LOCAL_FIRST_HINT};
