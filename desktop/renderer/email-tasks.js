"use strict";

/* ---------------- ATO-601: tasks that came in by e-mail ----------------
   Loaded before renderer.js; declares only, plus one click listener.

   The agent (ATO-601, src/atomic-mail/atomic-mail-trigger.ts) turns a new
   mail in its own inbox into a task, for a `webhooks` binding with
   `"source": "atomic-mail"`. Those tasks sit in GET /api/tasks with every
   other one; nothing on the record says "mail" except the task's message,
   which carries the mail framed as outside data:

     [external content from an e-mail that arrived in the agent's inbox: ...]
     <fence>
     From: Ann <ann@example.com>
     Subject: Invoice for March
     Received: 2026-11-18T09:12:00Z

   So the cards are read from that message (the From and Subject lines
   inside the frame), the way the Tasks tab already reads its rows: no new
   route and no new IPC. The Tasks tab shows them in a "From e-mail"
   section above its list.

   Each card has Start and Dismiss, as Codex and ChatGPT show their
   suggested tasks:
   - Start: a task still waiting (pending, paused) runs now, the Tasks tab's
     own Run now (POST /api/tasks/{id}/run). One that ran opens its chat.
   - Dismiss: a waiting task is cancelled (DELETE /api/tasks/{id}), so it
     never runs; a finished one only leaves this section. Either way the
     card is hidden here (localStorage, this window only); the Tasks list
     below still has the task. ATO-2744: on a waiting task Dismiss asks
     first, on the card itself ("Cancel this task? It won't run." Keep /
     Cancel task), the way My files asks before Remove; a cancel the agent
     refused keeps the card and says so.

   The agent starts a mail task as soon as it files it; it has no
   "proposed, wait for Start" state yet, so Start mostly opens the chat. */

const MAILTASK_NOTE = "[external content from an e-mail that arrived in the agent's inbox";
const MAILTASK_STORE_KEY = 'atag.mailTasksDismissed';
/* Enough dismissed ids for a busy inbox; the oldest go first past it. */
const MAILTASK_STORE_MAX = 500;
/* Cards shown at most; the Tasks list below has the rest. */
const MAILTASK_SHOW_MAX = 8;
const MAILTASK_WAITING = ['pending', 'paused'];

/* `confirm`: the id of the waiting card whose Dismiss asks "Cancel this task?". */
const MAILTASKS = {rows: [], dismissed: null, confirm: null};

/* The line `Name: value` inside the mail frame, '' when absent. Only the
   frame's header lines count: the template above the frame is the
   operator's words, and the body below the first blank line is the
   sender's. */
function mailTaskHeader(frame, name) {
  const head = frame.split(/\n\s*\n/)[0];
  const re = new RegExp('^' + name + ': ?(.*)$', 'm');
  const m = head.match(re);
  return m ? m[1].trim() : '';
}

/* A task record (GET /api/tasks) as a mail card, or null when the task
   did not come from a mail. {id, status, sessionId, from, subject,
   receivedAt, createdAt} */
function mailTaskOf(t) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string') return null;
  const msg = typeof t.userMessage === 'string' ? t.userMessage : '';
  const at = msg.indexOf(MAILTASK_NOTE);
  if (at < 0) return null;
  // Past the framing line and the fence's opening line.
  const lines = msg.slice(at).split('\n');
  const start = lines.findIndex((l) => /^From: /.test(l));
  if (start < 0) return null;
  const frame = lines.slice(start).join('\n');
  return {
    id: t.id,
    status: typeof t.status === 'string' ? t.status : 'pending',
    sessionId: typeof t.sessionId === 'string' && t.sessionId ? t.sessionId : null,
    from: mailTaskHeader(frame, 'From').slice(0, 200),
    subject: mailTaskHeader(frame, 'Subject').slice(0, 300),
    receivedAt: mailTaskHeader(frame, 'Received').slice(0, 40),
    createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0,
  };
}

/* The dismissed ids, read once from this window's storage. */
function mailTaskDismissed() {
  if (MAILTASKS.dismissed) return MAILTASKS.dismissed;
  let list = [];
  try {
    const raw = JSON.parse(localStorage.getItem(MAILTASK_STORE_KEY) || '[]');
    if (Array.isArray(raw)) list = raw.filter((v) => typeof v === 'string');
  } catch (e) { /* no storage, or a bad value: nothing dismissed */ }
  MAILTASKS.dismissed = list.slice(-MAILTASK_STORE_MAX);
  return MAILTASKS.dismissed;
}

/* Hide one card for good in this window. */
function mailTaskDismiss(id) {
  const list = mailTaskDismissed().filter((v) => v !== id);
  list.push(id);
  MAILTASKS.dismissed = list.slice(-MAILTASK_STORE_MAX);
  try { localStorage.setItem(MAILTASK_STORE_KEY, JSON.stringify(MAILTASKS.dismissed)); } catch (e) { /* kept for this session */ }
}

/* Called with every GET /api/tasks answer the Tasks tab reads. */
function emailTasksTake(tasks) {
  const rows = Array.isArray(tasks) ? tasks.map(mailTaskOf).filter(Boolean) : [];
  rows.sort((a, b) => b.createdAt - a.createdAt);
  MAILTASKS.rows = rows;
  return rows;
}

/* The cards still to show: not dismissed, newest first, at most MAILTASK_SHOW_MAX. */
function emailTasksVisible() {
  const gone = new Set(mailTaskDismissed());
  return MAILTASKS.rows.filter((r) => !gone.has(r.id)).slice(0, MAILTASK_SHOW_MAX);
}

/* What Start does for a card: 'run' (still waiting), 'open' (has a
   chat), or null (nothing to do yet). */
function mailTaskStartVerb(row) {
  if (!row) return null;
  if (MAILTASK_WAITING.includes(row.status)) return 'run';
  return row.sessionId ? 'open' : null;
}

const MAILTASK_STATUS_WORDS = {
  pending: 'Waiting', paused: 'Paused', running: 'Running', completed: 'Done',
  failed: 'Failed', blocked: 'Needs you', cancelled: 'Cancelled',
};

function mailTaskEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

/* One card as HTML. */
function mailTaskCardHTML(row) {
  const verb = mailTaskStartVerb(row);
  const waiting = MAILTASK_WAITING.includes(row.status);
  const when = typeof relTime === 'function' && row.createdAt ? relTime(row.createdAt) : '';
  const meta = [row.from, MAILTASK_STATUS_WORDS[row.status] || row.status, when].filter(Boolean).map(mailTaskEsc).join(' · ');
  const start = verb
    ? '<button class="btn btn-p xs" data-mailtask="start" data-id="' + mailTaskEsc(row.id) + '" title="'
      + (verb === 'run' ? 'Run this task now' : 'Open the chat this task ran in') + '">' + (verb === 'run' ? 'Start' : 'Open') + '</button>'
    : '';
  const dismiss = '<button class="btn btn-g xs" data-mailtask="dismiss" data-id="' + mailTaskEsc(row.id) + '" title="'
    + (waiting ? 'Cancel this task so it never runs, and hide it here' : 'Hide it here; the task stays in the list below') + '">Dismiss</button>';
  const asking = waiting && MAILTASKS.confirm === row.id;
  const acts = asking
    ? '<span class="mailtask-ask">Cancel this task? It won\'t run.</span>'
      + '<button class="btn btn-s xs" data-mailtask="keep" data-id="' + mailTaskEsc(row.id) + '">Keep</button>'
      + '<button class="btn btn-df xs" data-mailtask="cancel" data-id="' + mailTaskEsc(row.id) + '">Cancel task</button>'
    : start + dismiss;
  return '<div class="mailtask" data-mailtask-id="' + mailTaskEsc(row.id) + '">'
    + '<div class="mailtask-text"><div class="mailtask-subject">' + mailTaskEsc(row.subject || '(no subject)') + '</div>'
    + '<div class="mailtask-meta">' + meta + '</div></div>'
    + '<div class="mailtask-acts">' + acts + '</div></div>';
}

/* The Tasks tab's "From e-mail" section, '' when no mail task is left to show. */
function emailTasksHTML() {
  const rows = emailTasksVisible();
  if (!rows.length) return '';
  return '<section class="mailtasks" aria-label="Tasks from e-mail">'
    + '<div class="mailtasks-head">From e-mail<span class="mailtasks-sub">Tasks the agent filed from mail sent to its inbox</span></div>'
    + rows.map(mailTaskCardHTML).join('') + '</section>';
}

/* Start / Dismiss. Uses the renderer's own task helpers (tkRunNow,
   tasksRefresh, openSession), present once renderer.js has loaded. */
async function mailTaskAct(action, id) {
  const row = MAILTASKS.rows.find((r) => r.id === id);
  if (!row) return;
  if (action === 'start') {
    const verb = mailTaskStartVerb(row);
    if (verb === 'run' && typeof tkRunNow === 'function') { await tkRunNow(id); return; }
    if (verb === 'open' && typeof openSession === 'function') {
      if (typeof S !== 'undefined') S.settings = null;
      if (typeof TK !== 'undefined') TK.mode = 'list';
      openSession(row.sessionId);
    }
    return;
  }
  const repaint = () => { if (typeof render === 'function') render(); };
  if (action === 'keep') { MAILTASKS.confirm = null; repaint(); return; }
  // A waiting task is cancelled for good: Dismiss asks first, Cancel task does it.
  if (action === 'dismiss' && MAILTASK_WAITING.includes(row.status)) { MAILTASKS.confirm = id; repaint(); return; }
  if (action === 'dismiss' || action === 'cancel') {
    MAILTASKS.confirm = null;
    const br = typeof BR !== 'undefined' ? BR : null;
    if (action === 'cancel' && MAILTASK_WAITING.includes(row.status) && br && typeof br.cancelTask === 'function') {
      let res = null;
      try { res = await br.cancelTask(id); } catch (e) { res = null; }
      if (!res || res.ok === false) {
        repaint();
        if (typeof toast === 'function') toast("Couldn't cancel this task", 'It is still waiting. Try again, or cancel it in the list below.', 'bad');
        return;
      }
    }
    mailTaskDismiss(id);
    if (typeof tasksRefresh === 'function') await tasksRefresh(); else repaint();
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-mailtask]') : null;
    if (!btn) return;
    e.preventDefault();
    void mailTaskAct(btn.dataset.mailtask, btn.dataset.id || '');
  });
}

if (typeof module !== 'undefined') module.exports = {
  MAILTASKS, MAILTASK_NOTE, MAILTASK_STORE_MAX, MAILTASK_SHOW_MAX, mailTaskOf, mailTaskHeader, emailTasksTake,
  emailTasksVisible, emailTasksHTML, mailTaskCardHTML, mailTaskStartVerb, mailTaskDismiss, mailTaskDismissed, mailTaskAct,
};
