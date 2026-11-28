/* ---------------- Share this model (ATO-2483) ----------------
   Loaded before renderer.js; declares only, reads renderer.js globals (esc,
   copyText, llmRepaint, IS_WIN) at run time, guarded, so the Node tests can
   load it (test/model-share.test.mjs).

   Settings › Models › Local models gets one card: Off / This computer /
   Local network, like LM Studio's "Serve on Local Network" and Ollama's
   "Expose to the network". When on, it shows the OpenAI-compatible address
   and the API key to paste into the other app, each with Copy; on the
   network it also warns that the traffic is plain http. The agent does the
   work (POST /api/model-share); main relays it (main/model-share-ipc.ts)
   and announces the model on the network so "Find on my network" on
   another computer lists it. The card is hidden for an agent without the
   route and for a remote agent. */

const MSH = {
  view: null, askedAt: 0, supported: true,
  busy: false, error: null, detail: null, note: null, showKey: false, rotateAsk: false,
};

/* ---------- pure helpers ---------- */

const MSH_MODES = [
  {mode: 'off', label: 'Off', tip: 'Nothing else can use the model'},
  {mode: 'local', label: 'This computer', tip: 'Other apps on this computer only (127.0.0.1)'},
  {mode: 'network', label: 'Local network', tip: 'Other devices on your network too (plain http)'},
];

/** The key with all but its last four characters hidden. */
function mshMaskKey(key) {
  const k = String(key || '');
  return k.length > 4 ? '•'.repeat(12) + k.slice(-4) : '•'.repeat(12);
}

/** What the listener's state means, in words; '' when all is well. */
function mshProblemWords(view, isWin) {
  const l = view && view.listener;
  if (!view || view.mode === 'off' || !l) return '';
  if (l.state === 'failed') {
    if (l.problem === 'port-busy') {
      return 'Port ' + l.port + ' is already used by another app on this computer, so nothing listens yet. '
        + 'Close that app, or set another port in Settings › Diagnostics › All settings (localModels.managed.sharePort).';
    }
    if (l.problem === 'not-allowed') {
      return 'This computer did not let the app listen on port ' + l.port + '.'
        + (isWin ? ' Check that Windows Firewall allows Atomic Agent on private networks.' : '');
    }
    return 'Sharing could not start listening on port ' + l.port + '. Try again, or restart the app.';
  }
  if (l.state === 'main' && view.mode === 'network' && !l.network) {
    return 'The agent on port ' + l.port + ' listens on this computer only, so other devices cannot reach it. '
      + 'Set another port in Settings › Diagnostics › All settings (localModels.managed.sharePort).';
  }
  return '';
}

/** Whether something listens where the mode says, so the addresses work. */
function mshListening(view) {
  const l = view && view.listener;
  if (!view || view.mode === 'off') return false;
  if (!l) return true; // an agent that does not say: trust the setting
  return l.state === 'listening' || l.state === 'main';
}

function mshCopyRow(label, value, act, h, shown) {
  return '<div class="llm-tune-row msh-row"><span class="llm-tune-body"><span class="llm-tune-t">' + h.esc(label) + '</span>'
    + '<code class="msh-val" data-msh-val="' + h.esc(act) + '">' + h.esc(shown == null ? value : shown) + '</code></span>'
    + '<span class="fit-acts">'
    + (act === 'key' ? '<button class="btn btn-g sm" type="button" data-msh="reveal">' + (MSH.showKey ? 'Hide' : 'Show') + '</button>' : '')
    + '<button class="btn btn-s sm" type="button" data-msh="copy" data-msh-copy="' + h.esc(act) + '" title="Copy ' + h.esc(label.toLowerCase()) + '">Copy</button>'
    + '</span></div>';
}

/** The card's frame: the same heading and intro in every state. */
function mshFrameHTML(st, h, inner) {
  return '<section class="llm-section msh-entry"><div class="tk-sh llm-sh"><span class="llm-sh-t">Share this model</span>'
    + (st.busy ? '<span class="tk-spin"></span>' : '') + '</div>'
    + '<div class="fit-card">'
    + '<p class="llm-note">Other apps and devices can use the local model through an OpenAI-compatible address and an API key. '
    + 'They get the model only: no tools, chats, memory or files. One request at a time, while the model runs here.</p>'
    + inner
    + (st.error ? '<p class="llm-note fit-err" role="alert">' + h.esc(st.error) + '</p>'
      + (st.detail ? '<details class="msh-detail"><summary>Details</summary><code>' + h.esc(st.detail) + '</code></details>' : '') : '')
    + (st.note ? '<p class="llm-note" role="status">' + h.esc(st.note) + '</p>' : '')
    + '</div></section>';
}

function mshCardHTML(st, h) {
  const v = st.view;
  if (!st.supported) return '';
  // Loading and a failed first read keep the card's shape; a failed read offers Try again.
  if (!v) {
    return mshFrameHTML(st, h, st.error
      ? '<div class="fit-acts"><button class="btn btn-s sm" type="button" data-msh="retry">Try again</button></div>'
      : '<p class="fit-line"><span class="tk-spin"></span>Checking whether this model is shared…</p>');
  }
  const esc = h.esc;
  const seg = '<span class="tk-seg llm-tuneseg" role="group" aria-label="Share this model">'
    + MSH_MODES.map((o) => '<button type="button" class="' + (v.mode === o.mode ? 'on' : '') + '" aria-pressed="' + (v.mode === o.mode) + '"'
      + ' data-msh="mode" data-msh-mode="' + o.mode + '" title="' + esc(o.tip) + '"' + (st.busy ? ' disabled' : '') + '>' + esc(o.label) + '</button>').join('')
    + '</span>';
  let body = '';
  if (v.mode !== 'off') {
    const problem = mshProblemWords(v, h.isWin);
    if (problem) body += '<p class="llm-note fit-err" role="alert">' + esc(problem) + '</p>';
    if (mshListening(v)) {
      body += '<div class="llm-tune-card msh-card">'
        + mshCopyRow('Address on this computer', v.local, 'local', h)
        + v.lan.map((url, i) => mshCopyRow(i === 0 ? 'Address for other devices' : 'Or', url, 'lan:' + i, h)).join('')
        + (v.key ? mshCopyRow('API key', v.key, 'key', h, st.showKey ? v.key : mshMaskKey(v.key)) : '')
        + '</div>';
      if (v.mode === 'network' && !v.lan.length) {
        body += '<p class="llm-note">This computer is on no home or office network right now, so only apps on it can connect.</p>';
      }
      body += '<div class="fit-acts">'
        + (st.rotateAsk
          ? '<button class="btn btn-s sm" type="button" data-msh="rotate-yes"' + (st.busy ? ' disabled' : '') + '>Make a new key</button>'
            + '<button class="btn btn-g sm" type="button" data-msh="rotate-no">Keep this one</button>'
            + '<span class="llm-note">Apps that use the old key stop working until you paste the new one.</span>'
          : '<button class="btn btn-g sm" type="button" data-msh="rotate"' + (st.busy ? ' disabled' : '') + '>New key…</button>')
        + '</div>';
    }
    if (v.mode === 'network') {
      body += '<p class="llm-note msh-warn" role="note">Plain http: anyone on the same network can read the prompts and answers. '
        + 'Use it on a network you trust, like your home Wi-Fi. Other computers with Atomic Agent find it with Find on my network.'
        + (h.isWin ? ' Windows may ask to let Atomic Agent through the firewall: allow it for private networks.' : '') + '</p>';
    }
  }
  return mshFrameHTML(st, h, seg + body);
}

/* ---------- wiring ---------- */

function mshBridge() { return typeof window !== 'undefined' && window.atomic && window.atomic.modelShare ? window.atomic : null; }
function mshRepaint() { if (typeof llmRepaint === 'function') llmRepaint(); }
function mshHelpers() {
  return {esc: typeof esc === 'function' ? esc : (s) => String(s), isWin: typeof IS_WIN !== 'undefined' && IS_WIN === true};
}

/** One answer of main's modelShare:get / modelShare:set into the state. */
function mshTake(res) {
  if (!res || res.supported === false) { MSH.supported = false; MSH.view = null; return; }
  MSH.supported = true;
  if (res.ok && res.view) { MSH.view = res.view; MSH.error = null; MSH.detail = null; return; }
  MSH.error = 'The sharing setting could not be ' + (MSH.view ? 'changed' : 'read') + '. Try again in a moment.';
  MSH.detail = typeof res.error === 'string' ? res.error : null;
}

/** How old an answer may be before a repaint of the pane asks again (a change made in a terminal). */
const MSH_FRESH_MS = 30000;

async function mshLoad() {
  const br = mshBridge();
  if (!br) { MSH.supported = false; return; }
  const res = await br.modelShare().catch(() => null);
  if (res) mshTake(res);
  else MSH.error = 'The sharing setting could not be read. Try again in a moment.';
  mshRepaint();
}

/** renderer.js llmLocalHTML: the card. Asks the agent on the first paint and again once the answer is older than MSH_FRESH_MS. */
function modelShareHTML() {
  const now = Date.now();
  if (!MSH.busy && now - MSH.askedAt > MSH_FRESH_MS) { MSH.askedAt = now; void mshLoad(); }
  return mshCardHTML(MSH, mshHelpers());
}

async function mshSet(mode, rotate) {
  const br = mshBridge();
  if (!br || MSH.busy) return;
  MSH.busy = true; MSH.error = null; MSH.note = null; MSH.rotateAsk = false;
  mshRepaint();
  const res = await br.modelShareSet(mode, rotate === true).catch(() => null);
  MSH.busy = false;
  if (!res) MSH.error = 'The sharing setting could not be changed. Try again in a moment.';
  else mshTake(res);
  if (res && res.ok && rotate) { MSH.note = 'New key made. Paste it into every app that used the old one.'; MSH.showKey = true; }
  if (res && res.ok && mode === 'off') MSH.showKey = false;
  mshRepaint();
}

function mshCopyValue(which) {
  const v = MSH.view;
  if (!v) return '';
  if (which === 'local') return v.local;
  if (which === 'key') return v.key || '';
  const m = /^lan:(\d+)$/.exec(which);
  return m ? (v.lan[Number(m[1])] || '') : '';
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const el = t.closest('[data-msh]');
    if (!el) return;
    e.preventDefault();
    const act = el.getAttribute('data-msh');
    if (act === 'mode') {
      const mode = el.getAttribute('data-msh-mode');
      if (MSH.view && mode !== MSH.view.mode) void mshSet(mode, false);
    } else if (act === 'copy') {
      const which = el.getAttribute('data-msh-copy') || '';
      const value = mshCopyValue(which);
      if (value && typeof copyText === 'function') void copyText(value, which === 'key' ? 'API key copied' : 'Address copied');
    } else if (act === 'reveal') { MSH.showKey = !MSH.showKey; mshRepaint(); }
    else if (act === 'rotate') { MSH.rotateAsk = true; mshRepaint(); }
    else if (act === 'rotate-no') { MSH.rotateAsk = false; mshRepaint(); }
    else if (act === 'rotate-yes' && MSH.view) void mshSet(MSH.view.mode, true);
    else if (act === 'retry') { MSH.error = null; MSH.askedAt = Date.now(); mshRepaint(); void mshLoad(); }
  });
}

if (typeof module !== 'undefined') {
  module.exports = {MSH, MSH_MODES, mshFrameHTML, mshMaskKey, mshProblemWords, mshListening, mshCardHTML, mshTake, mshCopyValue, modelShareHTML};
}
