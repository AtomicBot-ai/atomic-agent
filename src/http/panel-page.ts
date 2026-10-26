/**
 * ATO-1128: the phone panel's page and script, served by `route-panel.ts`.
 * Kept as strings because `atag` ships as one binary with no files beside it.
 * The page holds no data: it asks for the agent's API key and keeps it in
 * the browser (localStorage), and every call carries it as a bearer token.
 */

export const PANEL_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Atomic Agent</title>
<style>
:root{color-scheme:light dark;--ink:#16181c;--ink2:#5b616b;--line:#d9dce1;--paper:#fff;--well:#f3f4f6;--acc:#2f6bff;--bad:#c4342f}
@media (prefers-color-scheme:dark){:root{--ink:#eceef1;--ink2:#9aa1ab;--line:#2c3038;--paper:#15171b;--well:#1e2127;--acc:#6a95ff;--bad:#ff6a5c}}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 -apple-system,system-ui,sans-serif;background:var(--paper);color:var(--ink)}
header{position:sticky;top:0;display:flex;gap:8px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--paper)}
header h1{font-size:16px;margin:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
main{padding:12px 16px 120px}button{font:inherit;border:1px solid var(--line);background:var(--well);color:var(--ink);border-radius:10px;padding:8px 12px}
button.p{background:var(--acc);border-color:var(--acc);color:#fff}button.bad{color:var(--bad)}
input,textarea{font:inherit;width:100%;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--well);color:var(--ink)}
.row{padding:12px 0;border-bottom:1px solid var(--line)}.row small{color:var(--ink2)}
.msg{margin:10px 0;padding:10px 12px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}
.user{background:var(--well);margin-left:15%}.asst{border:1px solid var(--line)}.tool{color:var(--ink2);font-size:13px}
.card{border:1px solid var(--acc);border-radius:12px;padding:12px;margin:10px 0}.card pre{white-space:pre-wrap;font-size:12px;max-height:200px;overflow:auto}
footer{position:fixed;left:0;right:0;bottom:0;padding:10px 16px calc(10px + env(safe-area-inset-bottom));display:flex;gap:8px;background:var(--paper);border-top:1px solid var(--line)}
.err{color:var(--bad)}
</style></head><body>
<header><button id="back" hidden aria-label="Back">‹</button><h1 id="title">Atomic Agent</h1><button id="new" hidden>New</button></header>
<main id="main"></main>
<footer id="composer" hidden><textarea id="text" rows="1" placeholder="Message"></textarea><button id="send" class="p">Send</button></footer>
<script src="/panel/app.js"></script>
</body></html>
`;

export const PANEL_JS = `(() => {
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let key = ''; try { key = localStorage.getItem('atomic.panel.key') || ''; } catch (e) {}
let open = null, timer = null, approvals = new Map();
const api = async (path, init) => {
  const res = await fetch(path, Object.assign({}, init, {headers: Object.assign({'content-type': 'application/json', authorization: 'Bearer ' + key}, (init && init.headers) || {})}));
  if (res.status === 401) { forget(); throw new Error('The key was not accepted.'); }
  if (!res.ok) throw new Error('The agent answered ' + res.status);
  return res.json();
};
function forget() { key = ''; try { localStorage.removeItem('atomic.panel.key'); } catch (e) {} login('The key was not accepted. Type it again.'); }
function login(note) {
  clearInterval(timer); open = null; $('back').hidden = true; $('new').hidden = true; $('composer').hidden = true; $('title').textContent = 'Atomic Agent';
  $('main').innerHTML = '<p>Type the API key this agent runs with (the --api-key of atag serve).</p><input id="key" type="password" autocomplete="off"><p class="err">' + esc(note || '') + '</p><button id="go" class="p">Open</button>';
  $('go').onclick = () => { key = $('key').value.trim(); try { localStorage.setItem('atomic.panel.key', key); } catch (e) {} list(); };
}
async function list() {
  clearInterval(timer); open = null; $('back').hidden = true; $('new').hidden = false; $('composer').hidden = true; $('title').textContent = 'Chats';
  try {
    const r = await api('/api/sessions?limit=50');
    $('main').innerHTML = approvalsHTML() + (r.sessions.length ? '' : '<p>No chats yet.</p>') + r.sessions.map((s) =>
      '<div class="row" data-id="' + esc(s.id) + '"><div>' + esc(s.title || s.id) + '</div><small>' + esc(s.status) + ' · ' + new Date(s.updatedAt).toLocaleString() + '</small></div>').join('');
    for (const el of document.querySelectorAll('.row')) el.onclick = () => show(el.dataset.id);
    wireApprovals();
  } catch (e) { $('main').innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }
  timer = setInterval(() => { if (!open) list(); }, 10000);
}
async function show(id) {
  clearInterval(timer); open = id; $('back').hidden = false; $('new').hidden = true; $('composer').hidden = false;
  const paint = async () => {
    try {
      const s = await api('/api/sessions/' + encodeURIComponent(id));
      $('title').textContent = (s.metadata && s.metadata.title) || 'Chat';
      $('main').innerHTML = approvalsHTML(id) + (s.turns || []).map((t) =>
        t.kind === 'user' ? '<div class="msg user">' + esc(t.text) + '</div>'
        : t.kind === 'assistant_reply' ? '<div class="msg asst">' + esc(t.text) + '</div>'
        : t.kind === 'assistant_tool_call' ? '<div class="tool">⚙ ' + esc(t.tool) + '</div>' : '').join('')
        + (s.status === 'running' ? '<p class="tool">Working…</p>' : '');
      wireApprovals();
    } catch (e) { $('main').innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }
  };
  await paint(); window.scrollTo(0, document.body.scrollHeight);
  timer = setInterval(() => { if (open === id) paint(); }, 3000);
}
async function send() {
  const text = $('text').value.trim(); if (!text) return;
  $('text').value = '';
  const body = {model: 'atomic-agent', stream: false, messages: [{role: 'user', content: text}]};
  if (open) body.session_id = open;
  const pending = api('/v1/chat/completions', {method: 'POST', body: JSON.stringify(body)});
  if (!open) { const r = await pending.catch(() => null); if (r && r.session_id) show(r.session_id); }
  else setTimeout(() => show(open), 500);
}
function approvalsHTML(sessionId) {
  return [...approvals.values()].filter((a) => !sessionId || a.sessionId === sessionId).map((a) =>
    '<div class="card"><b>' + esc(a.tool) + '</b> wants to run<div>' + esc(a.reason) + '</div>' + (a.preview ? '<pre>' + esc(a.preview) + '</pre>' : '')
    + '<button class="p" data-ok="' + esc(a.approvalId) + '">Allow once</button> <button class="bad" data-no="' + esc(a.approvalId) + '">Deny</button></div>').join('');
}
function wireApprovals() {
  const answer = async (id, decision) => { try { await api('/api/approval/resolve', {method: 'POST', body: JSON.stringify({approvalId: id, decision})}); } catch (e) {} approvals.delete(id); open ? show(open) : list(); };
  for (const b of document.querySelectorAll('[data-ok]')) b.onclick = () => answer(b.dataset.ok, 'allow-once');
  for (const b of document.querySelectorAll('[data-no]')) b.onclick = () => answer(b.dataset.no, 'deny');
}
async function watchApprovals() {
  for (;;) {
    if (!key) { await new Promise((r) => setTimeout(r, 2000)); continue; }
    try {
      const res = await fetch('/api/events', {headers: {authorization: 'Bearer ' + key}});
      if (!res.ok || !res.body) throw new Error('events');
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const {value, done} = await reader.read(); if (done) break;
        buf += dec.decode(value, {stream: true});
        let i; while ((i = buf.indexOf('\\n\\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = frame.split('\\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          try { const a = JSON.parse(data); if (a && a.approvalId) { approvals.set(a.approvalId, a); open ? show(open) : list(); } } catch (e) {}
        }
      }
    } catch (e) { await new Promise((r) => setTimeout(r, 3000)); }
  }
}
$('back').onclick = () => list();
$('new').onclick = () => { open = null; $('title').textContent = 'New chat'; $('main').innerHTML = ''; $('composer').hidden = false; $('back').hidden = false; $('new').hidden = true; clearInterval(timer); };
$('send').onclick = () => send();
if (key) list(); else login('');
watchApprovals();
})();
`;
