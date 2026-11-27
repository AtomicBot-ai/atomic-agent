/* ---------------- Model servers running here: the setup step (ATO-2489) ----------------
   Loaded after local-servers.js and before renderer.js; declares only. Uses
   local-servers.js (LSV, lsvDetect, lsvName, lsvFacts, lsvHost, lsvMark,
   lsvModelsLine, lsvFoundSentence, lsvSameUrl) and renderer.js globals
   (OB, OB_CHOICES, obDispatch, obRow, obBtn, WIZ, ...) at run time, so the
   Node tests can load it (test/local-servers.test.mjs).

   Setup: the Custom card says what it found, the cursor starts on it, and
   picking it opens a step of its own that lists what runs (a choice when
   several do), with "Something else" for the full Custom list. */

/** After an answer: setup's cursor goes to Custom once, as the TUI's choice screen does (PR #1872). */
function lsvAfterDetect() {
  if (typeof OB === 'undefined' || !OB || !OB.open || OB.step !== 'choose') return;
  if (LSV.obCursorSet || !LSV.servers.length || OB.cursor !== 0) return;
  const at = typeof OB_CHOICES !== 'undefined' ? OB_CHOICES.findIndex((c) => c.id === 'custom') : -1;
  if (at < 0 || typeof obDispatch !== 'function') return;
  LSV.obCursorSet = true;
  obDispatch({type: 'onboarding_cursor_set', cursor: at});
}

/** renderer.js obChooseHTML: the Custom card's line when something runs here, else ''. Starts the probe. */
function lsvChoiceDetail(choice) {
  if (LSV.phase === 'idle') void lsvDetect(false);
  if (!choice || choice.id !== 'custom' || LSV.phase !== 'ready') return '';
  return lsvFoundSentence(LSV.servers);
}

/** renderer.js obPickBackend('custom'): the found step instead of the full list, when something runs. */
function lsvObOffer() {
  if (LSV.phase !== 'ready' || !LSV.servers.length || typeof obDispatch !== 'function') return false;
  LSV.obPicked = null;
  obDispatch({type: 'onboarding_step_set', step: 'found_server'});
  return true;
}

/** The found step's rows: every server, then the full Custom list. */
function lsvObRows() {
  return LSV.servers.map((s) => ({kind: 'server', server: s})).concat([{kind: 'other'}]);
}

function lsvObHTML() {
  const e = typeof esc === 'function' ? esc : String;
  const rows = lsvObRows();
  const machine = typeof THIS_MACHINE === 'string' ? THIS_MACHINE : 'this computer';
  const tick = typeof obTickHTML === 'function' ? obTickHTML() : '';
  const list = rows.map((r, i) => {
    const on = OB.cursor === i;
    if (r.kind === 'other') {
      return obRow(i, on, e('Something else'), e('Another app, your own llama.cpp server or any address'), '',
        ' title="' + e('Something else · press ' + (i + 1)) + '"',
        '<span class="tk-ico tk-ico--lg tk-ico--blue">' + ic('server') + '</span>', on ? tick : '');
    }
    const s = r.server;
    const models = lsvModelsLine(s, 3);
    return obRow(i, on, e(lsvName(s)) + ' <span class="ann lit lsv-on">Running</span>',
      e(lsvFacts(s) + ' · ' + lsvHost(s.baseUrl)) + (models ? '<br>' + e(models) : ''), '',
      ' title="' + e(lsvName(s) + ' · press ' + (i + 1)) + '"', lsvMark(s, 'lg'), on ? tick : '');
  }).join('');
  return '<div class="ob-explain">' + e((LSV.servers.length > 1 ? 'These are' : 'This is') + ' already running on ' + machine
      + '. Pick ' + (LSV.servers.length > 1 ? 'one' : 'it') + ' to use it. Nothing to download.') + '</div>'
    + '<div class="ob-list ob-routes lsv-ob">' + list + '</div>'
    + '<div class="ob-foot ob-actions">' + obBtn('nav:back', 'Back', 'btn-g', false, 'chevL')
    + '<span class="grow"></span>' + obBtn('nav:go', 'Continue', 'btn-p', false, '', 'arrowR') + '</div>';
}

/** One row picked: the server's own setup path, or the full Custom list. */
function lsvObPick(index) {
  const row = lsvObRows()[index];
  if (!row) return;
  if (typeof obOpenCloudWizard !== 'function') return;
  if (row.kind === 'other') {
    LSV.obPicked = null;
    obOpenCloudWizard('custom');
    obDispatch({type: 'onboarding_step_set', step: 'cloud'});
    return;
  }
  const server = row.server;
  LSV.obPicked = server;
  if (!server.presetId) {
    // The Llama app: the llama.cpp address step, its address filled in (the TUI does the same).
    OB_WIZ_ROUTE = 'custom';
    obDispatch({type: 'onboarding_step_set', step: 'custom_chat_url'});
    obDispatch({type: 'onboarding_url_changed', field: 'chat', value: server.baseUrl});
    return;
  }
  // Ollama / LM Studio: their row on the Custom list, opened as Enter opens it, then
  // checked at once like Settings' Add (a server on this computer needs no key).
  obOpenCloudWizard('custom');
  obDispatch({type: 'onboarding_step_set', step: 'cloud'});
  const rows = obWizRows();
  const at = rows.findIndex((r) => r.k && r.k.id === server.presetId);
  if (at < 0) return;
  WIZ.cur = at;
  obCloudKey('', {return: true});
  if (WIZ.phase === 'configure' && WIZ.row && WIZ.row.local && typeof wizNext === 'function') void wizNext();
}

/** renderer.js obKey 'found_server'. */
function lsvObKey(input, key) {
  const rows = lsvObRows();
  if (key.ctrl && input === 'c') return false;
  if (key.escape) { LSV.obPicked = null; obDispatch({type: 'onboarding_step_set', step: 'choose'}); return true; }
  if (key.upArrow || input === 'k') { obDispatch({type: 'onboarding_cursor_moved', delta: -1, length: rows.length}); return true; }
  if (key.downArrow || input === 'j') { obDispatch({type: 'onboarding_cursor_moved', delta: 1, length: rows.length}); return true; }
  if (key.return) { lsvObPick(OB.cursor); return true; }
  const digit = parseInt(input, 10);
  if (Number.isInteger(digit) && digit >= 1 && digit <= rows.length) {
    obDispatch({type: 'onboarding_cursor_set', cursor: digit - 1});
    lsvObPick(digit - 1);
    return true;
  }
  return true;
}

/**
 * renderer.js obConfiguredLabel: "Ollama connected" when setup ended on the
 * server picked from the found step, '' otherwise (the usual line).
 */
function lsvObConfiguredLabel(outcome) {
  const s = LSV.obPicked;
  if (!s) return '';
  if (s.presetId) {
    const saved = typeof WIZ !== 'undefined' && WIZ && (WIZ.savedId === s.presetId || (WIZ.row && WIZ.row.id === s.presetId));
    return outcome === 'cloud' && saved ? lsvName(s) + ' connected' : '';
  }
  return outcome === 'custom' && typeof OB !== 'undefined' && lsvSameUrl(OB.chatUrl, s.baseUrl) ? lsvName(s) + ' connected' : '';
}

/** renderer.js obWizardHTML: a "Running" badge on an Ollama / LM Studio row of the Custom list. */
function lsvRunningBadge(presetId) {
  if (LSV.phase !== 'ready' || !LSV.servers.some((s) => s.presetId === presetId)) return '';
  return '<span class="ann lit">Running</span>';
}

/** A new run of setup asks again and may move the cursor again. */
function lsvObReset() {
  LSV.obPicked = null; LSV.obCursorSet = false;
  if (LSV.phase !== 'loading') LSV.phase = lsvBridge() ? 'idle' : 'hidden';
}

if (typeof module !== 'undefined') {
  module.exports = {
    lsvAfterDetect, lsvChoiceDetail, lsvObOffer, lsvObRows, lsvObHTML, lsvObPick, lsvObKey,
    lsvObConfiguredLabel, lsvRunningBadge, lsvObReset,
  };
}
