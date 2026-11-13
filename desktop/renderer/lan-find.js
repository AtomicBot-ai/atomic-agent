/* ---------------- ATO-1067: find a PC on the network, check the connection ----------------
   Under a server address field (the external llama.cpp URL, `#llm-url`, and
   a custom provider's Base URL, `#wiz-url`) two buttons:
     Find on my network   lists the PCs of this network that run a model
                          server (main/lan-discovery-ipc.ts lan:find), each
                          with its kind and models; a click on one puts its
                          address into the field, as typing it would.
     Check connection     checks what the field says (lan:check): reachable,
                          which server, its models, how fast, or why not.

   View-only: nothing is saved and no prompt is sent; the field's own Save /
   Next does the rest, as before.

   renderer.js draws the panel with lanfHTML(fieldId) where it draws the
   field; the state lives here, so a redraw keeps what was found. Loaded
   before renderer.js; the pure part is exported for the unit suite. */

/** state: idle | finding | done | error */
const LANF = {state: 'idle', servers: [], networks: [], error: '', checks: {}, seq: 0};

/* ---------- pure ---------- */

function lanfEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
}

/** What goes into the field: a custom provider's Base URL ends in /v1 (its placeholder), the llama.cpp URL is the bare root. */
function lanfFillUrl(fieldId, root) {
  const r = String(root || '').replace(/\/+$/, '');
  return fieldId === 'wiz-url' ? r + '/v1' : r;
}

/** "qwen3-8b, gemma-3-4b and 4 more" / "no models loaded". */
function lanfModelsWord(models) {
  const list = Array.isArray(models) ? models.filter((m) => typeof m === 'string' && m) : [];
  if (!list.length) return 'no models listed';
  const shown = list.slice(0, 3).join(', ');
  return list.length > 3 ? shown + ' and ' + (list.length - 3) + ' more' : shown;
}

/** One found server as a list row: `{title, sub, usable, note}`. An agent is not a model server, so it is not offered for the field. */
function lanfServerView(s) {
  const title = (s.name ? s.name + ' (' + s.host + ')' : s.host) + ' · ' + s.kindWord;
  const parts = [s.url, s.latencyMs + ' ms', s.needsKey ? 'asks for an API key' : lanfModelsWord(s.models)];
  const agent = s.kind === 'atomic-agent';
  return {
    title,
    sub: parts.join(' · '),
    usable: !agent,
    note: agent ? 'This is an Atomic Agent, not a model server. Use Agent › Connect to Another Computer for it.' : '',
  };
}

/** lan:check's answer (or a found server) → `{tone: 'ok'|'warn'|'bad', text}`. */
function lanfCheckView(r) {
  if (!r || r.ok !== true) return {tone: 'bad', text: String((r && r.error) || 'The check failed. Try again, or check the address.')};
  const head = 'Answers in ' + r.latencyMs + ' ms: ' + r.kindWord;
  if (r.kind === 'atomic-agent') return {tone: 'warn', text: head + '. This is an agent, not a model server.'};
  if (r.needsKey) return {tone: 'warn', text: head + ', and it asks for an API key.'};
  if (!r.models || !r.models.length) return {tone: 'warn', text: head + ', but it lists no models. Load one on that PC first.'};
  return {tone: 'ok', text: head + ' with ' + lanfModelsWord(r.models) + '.'};
}

/** The line under the buttons while and after a search. */
function lanfFindLine(st) {
  if (st.state === 'finding') return 'Looking through this network. This takes up to about 15 seconds.';
  if (st.state === 'error') return st.error || 'The search failed.';
  if (st.state !== 'done') return '';
  if (!st.networks.length) return 'This computer is not on a home or office network, so there is nothing to look through.';
  if (st.servers.length) return 'Found on ' + st.networks.join(', ') + ':';
  return 'No model server found on ' + st.networks.join(', ') + '. The server has to listen on the network, not only on its own PC: '
    + 'llama-server --host 0.0.0.0, OLLAMA_HOST=0.0.0.0 for Ollama, "Serve on Local Network" in LM Studio.';
}

function lanfBodyHTML(fieldId) {
  const finding = LANF.state === 'finding';
  const check = LANF.checks[fieldId];
  let html = '<div class="lanf-acts">'
    + '<button type="button" class="btn btn-s sm" data-lanf-find' + (finding ? ' disabled' : '') + '>' + (finding ? 'Looking…' : 'Find on my network') + '</button>'
    + '<button type="button" class="btn btn-g sm" data-lanf-check' + (check && check.state === 'checking' ? ' disabled' : '') + '>Check connection</button>'
    + '</div>';
  if (check && check.state === 'checking') html += '<p class="lanf-line">Checking ' + lanfEsc(check.url) + '…</p>';
  else if (check && check.view) html += '<p class="lanf-line is-' + check.view.tone + '" role="status">' + lanfEsc(check.view.text) + '</p>';
  const line = lanfFindLine(LANF);
  if (line) html += '<p class="lanf-line' + (LANF.state === 'error' ? ' is-bad' : '') + '">' + lanfEsc(line) + '</p>';
  if (LANF.state === 'done' && LANF.servers.length) {
    html += '<ul class="lanf-list">' + LANF.servers.map((s) => {
      const v = lanfServerView(s);
      const inner = '<span class="lanf-t">' + lanfEsc(v.title) + '</span><span class="lanf-s mono">' + lanfEsc(v.sub) + '</span>'
        + (v.note ? '<span class="lanf-s">' + lanfEsc(v.note) + '</span>' : '');
      return '<li>' + (v.usable
        ? '<button type="button" class="lanf-item" data-lanf-use="' + lanfEsc(s.url) + '" title="Put this address into the field">' + inner + '</button>'
        : '<div class="lanf-item is-off">' + inner + '</div>') + '</li>';
    }).join('') + '</ul>';
  }
  return html;
}

function lanfHTML(fieldId) {
  return '<div class="lanf" data-lanf-for="' + lanfEsc(fieldId) + '">' + lanfBodyHTML(fieldId) + '</div>';
}

/* ---------- the page ---------- */

/** Redraws every panel on the page, after the click that asked for it has been handled. */
function lanfPaint() {
  setTimeout(() => {
    for (const el of document.querySelectorAll('.lanf[data-lanf-for]')) el.innerHTML = lanfBodyHTML(el.getAttribute('data-lanf-for'));
  }, 0);
}

async function lanfFind() {
  const BRG = window.atomic;
  if (LANF.state === 'finding' || !BRG || !BRG.lanFind) return;
  LANF.state = 'finding'; LANF.error = ''; lanfPaint();
  const seq = ++LANF.seq;
  let res = null;
  try { res = await BRG.lanFind(); } catch (err) { res = null; }
  if (seq !== LANF.seq) return;
  if (res && res.ok && Array.isArray(res.servers)) {
    LANF.state = 'done'; LANF.servers = res.servers; LANF.networks = Array.isArray(res.networks) ? res.networks : [];
  } else {
    LANF.state = 'error'; LANF.error = 'The search failed. Try again.';
  }
  lanfPaint();
}

async function lanfCheck(fieldId) {
  const BRG = window.atomic;
  const input = document.getElementById(fieldId);
  const url = input ? input.value.trim() : '';
  if (!url) { LANF.checks[fieldId] = {state: 'done', url: '', view: {tone: 'bad', text: 'Type an address first, or find one on your network.'}}; lanfPaint(); return; }
  if (!BRG || !BRG.lanCheck) return;
  LANF.checks[fieldId] = {state: 'checking', url, view: null}; lanfPaint();
  let res = null;
  try { res = await BRG.lanCheck(url); } catch (err) { res = null; }
  const now = LANF.checks[fieldId];
  if (!now || now.url !== url) return;   // the field was filled from the list meanwhile
  LANF.checks[fieldId] = {state: 'done', url, view: lanfCheckView(res)};
  lanfPaint();
}

/** A found server's address into the field, through its own input event (renderer.js keeps the draft from it). */
function lanfUse(fieldId, root) {
  const input = document.getElementById(fieldId);
  if (!input) return;
  const value = lanfFillUrl(fieldId, root);
  input.value = value;
  input.dispatchEvent(new Event('input', {bubbles: true}));
  const s = LANF.servers.find((x) => x.url === root);
  LANF.checks[fieldId] = {state: 'done', url: value, view: s ? lanfCheckView(Object.assign({ok: true}, s)) : null};
  lanfPaint();
  setTimeout(() => { const n = document.getElementById(fieldId); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 0);
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const box = t.closest('.lanf[data-lanf-for]');
    if (!box) return;
    const fieldId = box.getAttribute('data-lanf-for');
    if (t.closest('[data-lanf-find]')) { e.preventDefault(); lanfFind(); return; }
    if (t.closest('[data-lanf-check]')) { e.preventDefault(); lanfCheck(fieldId); return; }
    const use = t.closest('[data-lanf-use]');
    if (use) { e.preventDefault(); lanfUse(fieldId, use.getAttribute('data-lanf-use')); }
  });
}

if (typeof module !== 'undefined') {
  module.exports = {LANF, lanfEsc, lanfFillUrl, lanfModelsWord, lanfServerView, lanfCheckView, lanfFindLine, lanfBodyHTML, lanfHTML};
}
