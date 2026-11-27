/* ---------------- ATO-2500: favourite models from the keyboard ----------------
   Loaded after model-favorites.js, before renderer.js; everything it calls in
   renderer.js is looked up when a key is pressed.

   ⌘P (Ctrl+P on Windows and Linux) switches the chat to the next favourite,
   ⇧⌘P (Ctrl+Shift+P) to the previous one, wrapping, as ctrl+p does in the
   terminal (the same list: model-favorites.json). On a Mac it is ⌘, not ⌃:
   ⌃P in a Mac text field moves the caret up a line, and the composer is a
   text field. Nothing else in the app or its menu takes ⌘P or ⇧⌘P.

   ⌘D (Ctrl+D) stars or unstars the model row that has the keyboard focus in
   the picker (Tab reaches the rows), the browsers' "bookmark this" chord.
   ⌃D, a Mac text field's delete-forward, is left alone.

   The pure part is exported for test/model-favorites-keys.test.mjs. */

/** IS_MAC ? ⌘ alone : Ctrl alone, and no Alt (renderer.js apprChordOf's rule). */
function modelFavMod(e, mac) {
  if (!e || e.altKey) return false;
  return mac ? (!!e.metaKey && !e.ctrlKey) : (!!e.ctrlKey && !e.metaKey);
}

/** What a keydown asks for: {cycle: 1|-1}, {star: true} or null. `sk` is renderer.js shortcutKey(e). */
function modelFavKeyIntent(e, sk, mac) {
  if (!modelFavMod(e, mac)) return null;
  const k = String(sk || '').toLowerCase();
  if (k === 'p') return {cycle: e.shiftKey ? -1 : 1};
  if (k === 'd' && !e.shiftKey) return {star: true};
  return null;
}

/** The favourite after (or before) `current` in `keys`, wrapping; off the list the first (or last). */
function modelFavStep(keys, current, dir) {
  if (!keys || !keys.length) return null;
  const at = keys.indexOf(current);
  const index = at < 0 ? (dir > 0 ? 0 : keys.length - 1) : (at + dir + keys.length) % keys.length;
  return {key: keys[index], index, size: keys.length};
}

/** `provider|model` split on the first bar. */
function modelFavSplit(key) {
  const at = String(key || '').indexOf('|');
  return at > 0 ? {provider: key.slice(0, at), id: key.slice(at + 1)} : null;
}

/* ---- the window's side (renderer.js globals, looked up at key time) ---- */

/** The favourite key of the model the next turn runs on, or '' when it is not one (Fusion, the custom route). */
function modelFavCurrentKey() {
  const b = selBackend();
  if (b === 'local') {
    const m = (SEL.local || []).find((x) => x && x.active);
    const id = (m && m.id) || S.localModel;
    return id ? 'local-llama|' + id : '';
  }
  if (b !== 'cloud') return '';
  const pid = selActiveProviderId();
  const project = projectTurnModel(S.agentSession);
  const entry = selProviders().find((p) => p.id === pid);
  const model = project && project.providerId === pid ? project.model : entry && (entry.defaultChatModel || entry.model);
  return pid && model ? pid + '|' + model : '';
}

/** Switch to the next (`dir` 1) or previous (-1) favourite, through the picker's own path (selActivate). */
async function modelFavCycle(dir) {
  const keys = MODEL_FAV.keys;
  if (!keys.length) { toast('No favorite models yet', 'Star a model in the model picker, then ' + kbd('⌘P') + ' switches between them.'); return; }
  if (selBackend() === 'fusion') { toast('Favorite models do not switch under Fusion', 'Pick Local or Cloud first.'); return; }
  const held = restartStopsTurn();
  if (held) { restartRefusedToast(held); return; }
  const step = modelFavStep(keys, modelFavCurrentKey(), dir);
  const fav = step && modelFavSplit(step.key);
  if (!fav) return;
  const where = ' (' + (step.index + 1) + '/' + step.size + ')';
  if (fav.provider === 'local-llama') {
    if (!SEL.local || !SEL.local.length) {
      const res = BR && typeof BR.chatModelsList === 'function' ? await BR.chatModelsList() : null;
      if (res && res.ok) SEL.local = res.models;
    }
    const m = (SEL.local || []).find((x) => x && x.id === fav.id);
    // Never a download from a shortcut: a model not on this computer is said, not pulled.
    if (!m || !m.downloaded) { toast(fav.id + where, 'Not downloaded on this computer.'); return; }
    toast('Model: ' + llmModelName(m) + where);
    await selActivate({type: 'localModel', id: fav.id, label: llmModelName(m), downloaded: true, active: false});
    return;
  }
  if (!selProviders().some((p) => p.id === fav.provider)) { toast(fav.id + where, providerWord(fav.provider) + ' is not set up here.'); return; }
  if (BSW.readyLoaded && !BSW.readyIds.includes(fav.provider)) { toast(fav.id + where, providerWord(fav.provider) + ' has no API key.'); return; }
  toast('Model: ' + fav.id + where);
  await selActivate({type: 'cloudModel', id: fav.id, label: fav.id, provider: fav.provider, active: false});
}

/** The keydown hook (renderer.js, after the ctrl+g chords). True when the key was taken. */
function modelFavKeydown(e, sk) {
  const intent = modelFavKeyIntent(e, sk, IS_MAC);
  if (!intent) return false;
  if (intent.star) {
    if (!SEL.open || OB.open || !SEL.groups) return false;
    const btn = document.activeElement && document.activeElement.closest ? document.activeElement.closest('#overlays [data-sel-row]') : null;
    const at = btn ? +btn.dataset.selRow : -1;
    const key = at >= 0 ? modelFavKey(SEL.rows[at]) : '';
    if (!key) return false;
    e.preventDefault();
    /* The rows renumber when Favorites grows or shrinks: focus goes back to
       the same row (the copy when the key was pressed on one, else the original). */
    const onCopy = !!SEL.rows[at].favCopy;
    const refocus = () => {
      const rows = SEL.rows || [];
      let i = rows.findIndex((r) => modelFavKey(r) === key && !!r.favCopy === onCopy);
      if (i < 0) i = rows.findIndex((r) => modelFavKey(r) === key);
      const n = i >= 0 ? document.querySelector('#overlays [data-sel-row="' + i + '"]') : null;
      if (n) n.focus();
    };
    modelFavToggle(key, () => { render(); refocus(); });
    render();
    refocus();
    return true;
  }
  // The chat's own key: not over Settings, a sheet, the picker, setup or a dialog.
  if (S.room !== 'chat' || S.settings || S.overlay || SEL.open || WIZ.phase || OB.open || S.alert) return false;
  e.preventDefault();
  if (typeof ANX !== 'undefined' && ANX.via) ANX.via('shortcut');
  modelFavCycle(intent.cycle);
  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {modelFavMod, modelFavKeyIntent, modelFavStep, modelFavSplit};
}
