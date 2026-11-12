/* ---------------- ATO-1063: the mini window's chat ----------------
   mini-chat.html's script: a small chat that starts a NEW chat in the agent,
   streams its reply, and hands the chat to the main window ("Open in big
   window", main/mini-chat-ipc.ts). It does not load renderer.js.

   - Sending is the main window's own route: BR.chat([{role:'user', content}],
     sessionId), no session id for the first message, the chat's id for the
     next ones (it comes in the turn's `session_id` frame).
   - Frames come on BR.onChat / BR.onApproval once the page attached
     (BR.miniChatAttach). main forwards every turn's frames, so the page keeps
     only its own turn's; the ones that land before BR.chat answers with the
     turn's id wait here and are read once it does.
   - Approvals are not answered here. A request of this chat shows one line
     and the big window, where its card is.
   - A reply is drawn with md-render.js (mdRender, mdSanitize), the same
     markdown as the main window, without its file chips.

   The pure part (state and frames) is exported for test/mini-chat.test.mjs. */

const MC_EARLY_MAX = 400;      // frames kept while BR.chat has not answered yet
const MC_APPROVALS_MAX = 20;   // requests kept for a chat whose id is not known yet

/* ---------- pure ---------- */

function mcPick(o, ...keys) {
  if (!o || typeof o !== 'object') return null;
  for (const k of keys) if (typeof o[k] === 'string' && o[k]) return o[k];
  return null;
}

function mcState() {
  return {
    sessionId: null, turnId: null, busy: false, seq: 0,
    rows: [],            // {id, k:'user'|'assistant'|'note', text, tone?}
    reply: null,         // the assistant row the turn writes into
    activity: '',        // what the turn is doing, one line
    approval: null,      // {tool, reason} of a request waiting in this chat
    early: [],           // frames before the turn's id is known
    approvals: [],       // requests seen before this chat's id is known
    failed: null,        // a step's failure, the turn's if nothing follows it
  };
}

/** A message sent: its row and the reply row the turn will fill. False when it cannot be sent now. */
function mcSend(st, raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || st.busy) return false;
  st.rows.push({id: ++st.seq, k: 'user', text});
  st.reply = {id: ++st.seq, k: 'assistant', text: '', stepFrom: 0};
  st.rows.push(st.reply);
  st.busy = true; st.turnId = null; st.activity = 'Thinking…'; st.approval = null; st.early = []; st.failed = null;
  return true;
}

/** BR.chat did not start the turn. */
function mcStartFailed(st, error) {
  st.busy = false; st.turnId = null; st.activity = ''; st.early = [];
  if (st.reply && !st.reply.text) st.rows.splice(st.rows.indexOf(st.reply), 1);
  st.reply = null;
  st.rows.push({id: ++st.seq, k: 'note', tone: 'bad', text: 'Could not start the reply: ' + (error || 'unknown error')});
}

/** BR.chat answered with the turn's id: the frames that came first are read now. */
function mcStarted(st, turnId) {
  if (!st.busy || typeof turnId !== 'string' || !turnId) return;
  st.turnId = turnId;
  const early = st.early;
  st.early = [];
  for (const ev of early) if (ev.turnId === turnId) mcFrame(st, ev);
}

function mcLearnSession(st, sid) {
  if (!sid || st.sessionId) return;
  st.sessionId = sid;
  const waiting = st.approvals.filter((a) => a.sessionId === sid);
  st.approvals = [];
  if (waiting.length && st.busy) st.approval = mcApprovalView(waiting[waiting.length - 1]);
}

function mcEnd(st) {
  st.busy = false; st.turnId = null; st.activity = ''; st.approval = null;
  const empty = st.reply && !st.reply.text.trim();
  if (empty && st.failed) {
    // Nothing came after the step's failure: it is the turn's.
    st.rows.splice(st.rows.indexOf(st.reply), 1);
    st.rows.push({id: ++st.seq, k: 'note', tone: 'bad', text: st.failed});
  } else if (empty) st.reply.text = '(no reply)';
  st.reply = null; st.failed = null;
}

/** One agent:chat frame. True when the page should repaint. */
function mcFrame(st, ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.turnId !== 'string') return false;
  if (!st.turnId) {
    // Our turn's id is not known yet: any frame may be ours.
    if (st.busy && st.early.length < MC_EARLY_MAX) st.early.push(ev);
    return false;
  }
  if (ev.turnId !== st.turnId) return false;
  const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
  const r = st.reply;
  switch (ev.kind) {
    case 'session_id':
      mcLearnSession(st, mcPick(p, 'sessionId', 'session_id', 'id'));
      return true;
    case 'delta':
      if (r && ev.text) { r.text += String(ev.text); st.activity = ''; st.approval = null; }
      return true;
    case 'reply_polished': {
      // The clean text of the step's reply; an earlier step's words stay.
      const text = mcPick(p, 'text');
      if (!r || !text) return false;
      r.text = r.text.slice(0, Math.min(r.stepFrom || 0, r.text.length)) + text;
      return true;
    }
    case 'reasoning_progress':
      if (!r || !r.text) st.activity = 'Thinking…';
      return true;
    case 'tool_progress': {
      const name = mcPick(p, 'tool', 'name') || 'a tool';
      if (name === 'reply' || name === 'finish') return false;
      if (r) r.stepFrom = r.text.length;
      st.activity = 'Using ' + name + '…'; st.approval = null;
      return true;
    }
    case 'tool_result':
      st.approval = null;
      return true;
    case 'provider_waiting':
      st.activity = mcPick(p, 'reason') || 'Waiting for the model…';
      return true;
    case 'provider_recovered':
      st.activity = 'Thinking…';
      return true;
    case 'error':
      // A named error (with a payload) is followed by `done`; the turn may still go on.
      if (ev.payload) { st.failed = mcPick(p, 'message', 'error') || String(ev.error || '') || 'The reply failed.'; return false; }
      st.rows.push({id: ++st.seq, k: 'note', tone: 'bad', text: String(ev.error || 'The reply failed.')});
      mcEnd(st);
      return true;
    case 'aborted':
      st.rows.push({id: ++st.seq, k: 'note', text: 'Stopped.'});
      mcEnd(st);
      return true;
    case 'done':
      mcEnd(st);
      return true;
    default:
      return false;
  }
}

/** What the line about a waiting request says. */
function mcApprovalView(payload) {
  return {
    tool: mcPick(payload, 'tool') || 'a tool',
    reason: (mcPick(payload, 'reason') || '').slice(0, 200),
  };
}

/** One agent:approval request. True when this chat is the one waiting. */
function mcApproval(st, payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.approvalId !== 'string') return false;
  const sid = mcPick(payload, 'sessionId');
  if (!st.sessionId) {
    // A request can come before the turn names its chat: kept, and read once it does.
    if (st.busy && sid) {
      st.approvals.push(payload);
      if (st.approvals.length > MC_APPROVALS_MAX) st.approvals.shift();
    }
    return false;
  }
  if (sid !== st.sessionId || !st.busy) return false;
  st.approval = mcApprovalView(payload);
  return true;
}

function mcApprovalLine(a) {
  return 'The agent is asking to use ' + a.tool + '. Open the big window to approve or deny it.';
}

/* ---------- markup ---------- */

function mcEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

/** A reply's markdown, with md-render.js when it is loaded; plain escaped text otherwise. */
function mcReplyHTML(text) {
  if (typeof mdRender !== 'function') return mcEsc(text);
  const md = mdRender(String(text || '').replace(/[\u0000\u0001]/g, ''));
  const html = md.html.replace(/\u0000(\d+)\u0000/g, (m, i) => {
    const h = md.held[+i] || '';
    if (typeof highlightCode !== 'function' || !h.startsWith('<pre class="mdpre"')) return h;
    const lang = (/^<pre class="mdpre"[^>]*\sdata-lang="([^"]*)"/.exec(h) || [])[1] || '';
    return h.replace(/(<code>)([\s\S]*)(<\/code><\/pre>)$/, (x, open, code, close) => open + highlightCode(code, lang) + close);
  });
  return typeof mdSanitize === 'function' ? mdSanitize(html) : html;
}

function mcRowsHTML(st) {
  if (!st.rows.length) return '<div class="mc-empty">Ask anything. This starts a new chat.</div>';
  return st.rows.map((r) => {
    if (r.k === 'user') return '<div class="mc-row mc-user"><div class="prose usr">' + mcEsc(r.text) + '</div></div>';
    if (r.k === 'note') return '<div class="mc-row mc-note' + (r.tone === 'bad' ? ' bad' : '') + '">' + mcEsc(r.text) + '</div>';
    return '<div class="mc-row mc-reply"><div class="prose">' + mcReplyHTML(r.text) + '</div></div>';
  }).join('');
}

/* ---------- the page ---------- */

function mcBoot() {
  const BR = window.atomic;
  const $ = (id) => document.getElementById(id);
  const st = mcState();
  let painting = false;
  let stick = true;

  const paint = () => {
    painting = false;
    const log = $('mc-log');
    log.innerHTML = mcRowsHTML(st);
    const wait = $('mc-wait');
    wait.hidden = !(st.busy && (st.activity || st.approval));
    wait.className = 'mc-wait' + (st.approval ? ' approval' : '');
    $('mc-wait-text').textContent = st.approval ? mcApprovalLine(st.approval) : st.activity;
    $('mc-open').disabled = !st.sessionId;
    $('mc-open').title = st.sessionId ? 'Open this chat in the main window' : 'Available once the chat has started';
    const send = $('mc-send');
    send.textContent = st.busy ? 'Stop' : 'Send';
    send.classList.toggle('stop', st.busy);
    send.disabled = st.busy ? !st.turnId : !$('mc-input').value.trim();
    if (stick) log.scrollTop = log.scrollHeight;
  };
  const repaint = () => { if (!painting) { painting = true; requestAnimationFrame(paint); } };

  $('mc-log').addEventListener('scroll', () => {
    const log = $('mc-log');
    stick = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  });
  // A link in a reply opens in the browser, as in the main window; nothing navigates this page.
  $('mc-log').addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    e.preventDefault();
    const url = a.getAttribute('data-url');
    if (url && /^https?:\/\//i.test(url) && BR.openExternal) BR.openExternal(url);
  });

  const submit = () => {
    const input = $('mc-input');
    const text = input.value;
    if (!mcSend(st, text)) return;
    input.value = '';
    stick = true;
    repaint();
    BR.chat([{role: 'user', content: text.trim()}], st.sessionId || undefined).then((res) => {
      if (res && res.ok && res.turnId) mcStarted(st, res.turnId);
      else mcStartFailed(st, res && res.error);
      repaint();
    }, (err) => { mcStartFailed(st, err && err.message); repaint(); });
  };
  const stop = () => { if (st.busy && st.turnId) BR.cancel(st.turnId); };

  $('mc-send').addEventListener('click', () => (st.busy ? stop() : submit()));
  $('mc-input').addEventListener('input', repaint);
  $('mc-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!st.busy) submit(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) window.close();
  });
  $('mc-open').addEventListener('click', async () => {
    if (!st.sessionId) return;
    const res = await BR.miniChatOpenInMain(st.sessionId).catch(() => null);
    if (!res || !res.ok) {
      st.rows.push({id: ++st.seq, k: 'note', tone: 'bad', text: (res && res.error) || 'The main window could not be opened.'});
      repaint();
    }
  });

  BR.onChat((ev) => { if (mcFrame(st, ev)) repaint(); });
  BR.onApproval((payload) => { if (mcApproval(st, payload)) repaint(); });
  if (BR.miniChatAttach) BR.miniChatAttach().catch(() => {});
  paint();
  $('mc-input').focus();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById('mc-log')) {
  mcBoot();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {mcState, mcSend, mcStartFailed, mcStarted, mcFrame, mcApproval, mcApprovalLine, mcReplyHTML, mcRowsHTML, mcEsc,
    MC_EARLY_MAX};
}
