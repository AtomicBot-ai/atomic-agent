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
     and the big window, where its card is (kept there for this chat: BR.miniChatSession).
   - A reply is drawn with md-render.js (mdRender, mdSanitize), the same
     markdown as the main window, without its file chips.

   ATO-561: the same page is a sidebar chat's own window ("Open in new
   window", main/chat-popout-ipc.ts). It asks which chat it was opened for
   (BR.chatPopoutMine), draws that chat's stored messages (mcHistory) and
   goes on in it: the next message carries the chat's session id.

   The pure part (state and frames) is exported for test/mini-chat.test.mjs. */

const MC_EARLY_MAX = 400;      // frames kept while BR.chat has not answered yet
const MC_APPROVALS_MAX = 20;   // requests kept for a chat whose id is not known yet
const MC_HISTORY_MAX = 200;    // stored rows drawn in a chat's own window, newest kept

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
    loading: false,      // ATO-561: a stored chat's messages on their way
    locked: false,       // ATO-561: a chat's own window that has no chat: nothing is sent from it
    title: '',           // ATO-561: a stored chat's own title
  };
}

/** A message sent: its row and the reply row the turn will fill. False when it cannot be sent now. */
function mcSend(st, raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || st.busy || st.loading || st.locked) return false;
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

/**
 * ATO-561: a stored chat in its own window. `data` is GET /api/sessions/{id}
 * (BR.session): its user messages and replies become rows, a run of tool
 * calls one line; the newest MC_HISTORY_MAX rows are kept. The chat's id is
 * the page's from here, so the next message continues it.
 */
function mcHistory(st, sessionId, data) {
  st.loading = false;
  if (!sessionId) return false;
  st.sessionId = sessionId;
  const d = data && typeof data === 'object' ? data : {};
  st.title = typeof d.title === 'string' ? d.title.trim().slice(0, 200) : '';
  const rows = [];
  let tools = 0;
  const flushTools = () => {
    if (tools) rows.push({k: 'note', text: tools === 1 ? 'Used a tool.' : 'Used ' + tools + ' tools.'});
    tools = 0;
  };
  for (const t of Array.isArray(d.turns) ? d.turns : []) {
    if (!t || typeof t !== 'object') continue;
    if (t.kind === 'assistant_tool_call') { tools++; continue; }
    if (t.kind === 'user' && typeof t.text === 'string') { flushTools(); rows.push({k: 'user', text: t.text}); continue; }
    if (t.kind === 'assistant_reply' && !t.progressNote) {
      flushTools();
      rows.push({k: 'assistant', text: t.stopped ? '(stopped)' : String(t.text || '')});
    }
  }
  flushTools();
  const kept = rows.length > MC_HISTORY_MAX ? rows.slice(rows.length - MC_HISTORY_MAX) : rows;
  if (kept.length < rows.length) kept.unshift({k: 'note', text: 'Earlier messages are in the main window.'});
  st.rows = kept.map((r) => Object.assign({id: ++st.seq}, r));
  return true;
}

/** ATO-561: the page is a stored chat's own window (main/chat-popout.ts CHAT_POPOUT_QUERY), not the mini window. */
function mcPopout(search) {
  return /(?:^\?|&)window=chat(?:&|$)/.test(String(search || ''));
}

/** What the line about a waiting request says. */
function mcApprovalView(payload) {
  return {
    tool: mcPick(payload, 'tool') || 'a tool',
    reason: (mcPick(payload, 'reason') || '').slice(0, 200),
    // ATO-1502: an ask_user question, answered on its card in the big window.
    question: payload.category === 'user_question',
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

const mcTitle = (st) => st.title || (st.rows.find((r) => r.k === 'user') || {}).text || '';   // the chat's title, or its first message
function mcApprovalLine(a) {
  if (a.question) return 'The agent is asking you a question. Open the main window to answer it.';
  return 'The agent is asking to use ' + a.tool + '. Open the main window to approve or deny it.';
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
  if (st.loading) return '<div class="mc-empty">Loading the chat…</div>';
  if (!st.rows.length) return '<div class="mc-empty">' + (st.sessionId ? 'No messages in this chat yet.' : 'Ask anything. This starts a new chat.') + '</div>';
  return st.rows.map((r) => {
    if (r.k === 'user') return '<div class="mc-row mc-user"><div class="prose usr">' + mcEsc(r.text) + '</div></div>';
    if (r.k === 'note') return '<div class="mc-row mc-note' + (r.tone === 'bad' ? ' bad' : '') + '">' + mcEsc(r.text) + '</div>';
    // ATO-2268: "Replace in <app>" under an answer to the selection (mini-chat-selection.js).
    const put = typeof mcReplaceHTML === 'function' ? mcReplaceHTML(r, st.replaceLabel, st.reply === r, mcEsc) : '';
    return '<div class="mc-row mc-reply"><div class="prose">' + mcReplyHTML(r.text) + '</div>' + put + '</div>';
  }).join('');
}

/* ---------- the page ---------- */

function mcBoot() {
  const BR = window.atomic;
  const $ = (id) => document.getElementById(id);
  // ATO-1609: the theme the main window was set to (renderer.js atag.theme), as the one-line box read it; System follows the OS.
  try { const t = localStorage.getItem('atag.theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) { /* follow the OS */ }
  const st = mcState();
  let painting = false;
  let stick = true, told = null;   // told: the chat id given to main (mini:session), the big window keeps its approvals for it
  // ATO-561: a stored chat's own window (main loads it with ?window=chat): nothing is sent before its chat is in.
  const own = mcPopout(location.search);
  if (own) st.loading = true;

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
    send.disabled = st.busy ? !st.turnId : (st.loading || st.locked || !$('mc-input').value.trim());
    if (own) {
      const name = mcTitle(st) || 'Chat';
      $('mc-title').textContent = name;
      document.title = name + ' · Atomic Agent';
    }
    if (stick) log.scrollTop = log.scrollHeight;
  };
  const repaint = () => {
    if (st.sessionId && told !== st.sessionId && BR.miniChatSession) BR.miniChatSession(told = st.sessionId, mcTitle(st));
    if (!painting) { painting = true; requestAnimationFrame(paint); }
  };

  $('mc-log').addEventListener('scroll', () => {
    const log = $('mc-log');
    stick = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  });
  // A link in a reply opens in the browser, as in the main window; nothing navigates this page.
  $('mc-log').addEventListener('click', (e) => {
    // ATO-2268: the answer put back in place of the selection; main hides this window when it goes.
    const put = e.target && e.target.closest ? e.target.closest('[data-replace]') : null;
    if (put) {
      const row = st.rows.find((r) => String(r.id) === put.getAttribute('data-replace'));
      if (!row || !BR.quickEntryReplace) return;
      put.disabled = true;
      BR.quickEntryReplace(row.text).then((res) => {
        if (res && (res.ok || res.hidden)) return;
        if (res && res.copy && typeof mcReplaceFailed === 'function') { put.disabled = false; mcReplaceFailed(res.error, row.text, BR); return; }   // ATO-2750
        st.rows.push({id: ++st.seq, k: 'note', tone: 'bad', text: (res && res.error) || 'The text could not be replaced.'});
        repaint();
      }, () => { put.disabled = false; });
      return;
    }
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    e.preventDefault();
    const url = a.getAttribute('data-url');
    if (url && /^https?:\/\//i.test(url) && BR.openExternal) BR.openExternal(url);
  });

  /* ATO-985: the text selected in the app in front when the hotkey opened
     this window: the quoted chip, the actions that set the message, and
     Translate's language menu (mini-chat-selection.js). It goes with the
     first message, quoted under it, then the chip goes away. */
  let selection = null;
  const putMessage = (text) => {
    const input = $('mc-input');
    input.value = text;
    input.focus();
    input.setSelectionRange(text.length, text.length);
    if (BR.quickEntryDraft) BR.quickEntryDraft(text);
    repaint();
  };
  const closeLanguages = () => {
    $('mc-lang').hidden = true;
    const t = $('mc-actions').querySelector('[data-act="translate"]');
    if (t) t.setAttribute('aria-expanded', 'false');
  };
  const actionButton = (label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mc-act';
    b.textContent = label;
    return b;
  };
  const showSelection = (sel, saved) => {
    if (typeof mcSelectionPreview !== 'function' || selection !== null) return;
    selection = sel;
    $('mc-sel-text').textContent = mcSelectionPreview(sel);
    let system = null;
    try { system = mcLanguageName(navigator.language, new Intl.DisplayNames(['en'], {type: 'language'})); } catch (e) { /* no name: the common list */ }
    const langs = mcLanguageOptions(system, saved);
    const row = $('mc-actions'), menu = $('mc-lang');
    const translate = MC_SELECTION_ACTIONS.find((a) => a.id === 'translate');
    let lang = mcDefaultLanguage(saved, langs);
    for (const a of MC_SELECTION_ACTIONS) {
      const b = actionButton(a.label);
      b.dataset.act = a.id;
      if (a === translate) {
        // Translate asks which language first; the one used last is marked.
        b.setAttribute('aria-haspopup', 'menu');
        b.setAttribute('aria-expanded', 'false');
        b.addEventListener('click', () => {
          if (!menu.hidden) { closeLanguages(); return; }
          menu.hidden = false;
          b.setAttribute('aria-expanded', 'true');
          const cur = menu.querySelector('.on') || menu.firstElementChild;
          if (cur) cur.focus();
        });
      } else {
        b.addEventListener('click', () => { closeLanguages(); putMessage(mcSelectionPrompt(a) + ' '); });
      }
      row.appendChild(b);
    }
    for (const l of langs) {
      const m = actionButton(l);
      m.setAttribute('role', 'menuitemradio');
      m.setAttribute('aria-checked', String(l === lang));
      if (l === lang) m.classList.add('on');
      m.addEventListener('click', () => {
        lang = l;
        for (const o of menu.children) { o.classList.toggle('on', o === m); o.setAttribute('aria-checked', String(o === m)); }
        closeLanguages();
        putMessage(mcSelectionPrompt(translate, l) + ' ');
        // Remembered for the next Translate (selected-text.json, main/selected-text-ipc.ts).
        if (BR.selectedTextSet) BR.selectedTextSet({translateTo: l}).catch(() => {});
      });
      menu.appendChild(m);
    }
    // Esc in the menu closes the menu, not the window.
    menu.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      closeLanguages();
      const t = row.querySelector('[data-act="translate"]');
      if (t) t.focus();
    });
    $('mc-sel').hidden = false;
    $('mc-input').placeholder = 'Ask about the selected text…';
  };
  const dropSelection = () => {
    selection = '';
    closeLanguages();
    $('mc-sel').hidden = true;
    $('mc-input').placeholder = 'Ask Atomic Agent…';
  };

  const submit = () => {
    const input = $('mc-input');
    const typed = input.value;
    const text = selection && typed.trim() && typeof mcComposeWithSelection === 'function' ? mcComposeWithSelection(typed, selection) : typed;
    const withSelection = text !== typed;
    if (!mcSend(st, text)) return;
    if (withSelection && st.reply) st.reply.replace = true;   // ATO-2268: its answer can go back in place of the selection
    if (selection) dropSelection();
    input.value = '';
    if (BR.quickEntryDraft) BR.quickEntryDraft('');
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
  $('mc-input').addEventListener('input', () => {
    // ATO-1609: what was typed and not sent comes back next time the hotkey opens this window (main keeps it).
    if (BR.quickEntryDraft) BR.quickEntryDraft($('mc-input').value);
    repaint();
  });
  $('mc-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!st.busy) submit(); }
  });
  document.addEventListener('keydown', (e) => {
    if (own) return;   // ATO-561: a chat's own window closes with its close button, as any window
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
  if (BR.quickEntryOpened) BR.quickEntryOpened().then((opened) => {
    const input = $('mc-input');
    if (!opened || st.rows.length) return;
    if (typeof mcSelectionNotice === 'function') mcSelectionNotice(opened.notice, BR);   // ATO-2736 (mini-chat-notice.js)
    if (typeof opened.draft === 'string' && opened.draft && !input.value) {
      input.value = opened.draft;
      input.setSelectionRange(input.value.length, input.value.length);
      repaint();
    }
    // ATO-985: the selection main read before this window took the keyboard, with the language Translate used last.
    if (typeof opened.selection === 'string' && opened.selection) {
      st.replaceLabel = typeof opened.replace === 'string' && opened.replace ? opened.replace : null;   // ATO-2268
      const saved = BR.selectedTextGet ? BR.selectedTextGet().catch(() => null) : Promise.resolve(null);
      saved.then((info) => { if (!st.rows.length) showSelection(opened.selection, info && info.translateTo); });
    }
  }, () => {});
  // ATO-561: opened from the sidebar for a stored chat: its messages, then it goes on here.
  if (own) {
    $('mc-input').placeholder = 'Reply…';
    const lost = (why) => { st.loading = false; st.rows.push({id: ++st.seq, k: 'note', tone: 'bad', text: why}); repaint(); };
    const ask = typeof BR.chatPopoutMine === 'function' ? BR.chatPopoutMine() : Promise.resolve(null);
    ask.then((mine) => {
      const sid = mine && typeof mine.sessionId === 'string' ? mine.sessionId : null;
      // Never a new chat in its place: a window that lost its chat sends nothing.
      if (!sid) { st.locked = true; lost('This window has no chat. Close it and open the chat again from the sidebar.'); return; }
      return BR.session(sid).then((res) => {
        mcHistory(st, sid, res && res.ok ? res.data : null);
        if (!res || !res.ok) st.rows.push({id: ++st.seq, k: 'note', tone: 'bad', text: 'Could not load this chat: ' + ((res && res.error) || 'unknown error')});
        stick = true;
        repaint();
      }, () => { mcHistory(st, sid, null); repaint(); });
    }).catch(() => { st.locked = true; lost('Could not load this chat.'); });
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById('mc-log')) {
  mcBoot();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {mcState, mcTitle, mcSend, mcHistory, mcPopout, MC_HISTORY_MAX, mcStartFailed, mcStarted, mcFrame, mcApproval, mcApprovalLine, mcReplyHTML, mcRowsHTML, mcEsc,
    MC_EARLY_MAX};
}
