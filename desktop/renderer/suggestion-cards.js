/* ---------------- ATO-458: suggested tasks on the empty chat screen ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/suggestion-cards.test.mjs).

   The agent builds "ideas" by fixed rules from what it already has on
   disk (src/tasks/idea-rules.ts): a task that failed and was never run
   again ("Retry"), a chat goal that stopped with items still open
   ("Resume"). This file shows the ones still undecided as a short row of
   cards under the start screen's starters, each with Start and Dismiss.

   When: as Codex and ChatGPT do with their suggested tasks, the list is
   asked for when the app starts and again each time the person opens a
   new chat. No background timer: a refresh costs a read of the local task
   store, and cards that changed while someone is reading them would move
   under the pointer.

   Start accepts the idea: the agent files it as an ordinary task (a Retry
   keeps the original's limits and folder) and the window opens the chat
   it runs in, or the Tasks tab when the agent has not given it a chat yet.
   Dismiss retires the card for good; the agent never offers the same
   source again. An agent without the routes, or with tasks turned off,
   shows nothing. */

const IDEA_CARDS_MAX = 3;
/* A window that asked while the agent was still starting asks again on a
   later paint of the empty screen, at most this often, until it gets an
   answer. Not a timer: only a paint that is already happening asks. */
const IDEA_RETRY_MS = 30 * 1000;

const IDEAS = {ideas: [], loaded: false, unsupported: false, pending: null, askedAt: 0, busy: null};

function ideaEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

/* The undecided ideas of a refresh answer, cleaned; [] for anything else. */
function ideasOf(data) {
  const list = data && Array.isArray(data.ideas) ? data.ideas : [];
  return list.filter((i) => i && typeof i.id === 'string' && i.id && typeof i.title === 'string' && i.title
    && (i.status === undefined || i.status === 'new'))
    .map((i) => ({id: i.id, kind: i.kind === 'resume_goal' ? 'resume_goal' : 'retry_task', title: i.title,
      reason: typeof i.reason === 'string' ? i.reason : '', sessionId: typeof i.sessionId === 'string' ? i.sessionId : null}));
}

/* The chat an accepted idea's task runs in, or null (the agent opens one when it runs). */
function ideaTaskSession(data) {
  const t = data && data.task;
  return t && typeof t.sessionId === 'string' && t.sessionId ? t.sessionId : null;
}

/* Ask the agent for the cards again. Resolves when done; never rejects.
   `br` is the preload bridge; one without `ideasRefresh` shows nothing. */
function ideaCardsRefresh(br, now) {
  const b = br || (typeof BR !== 'undefined' ? BR : null);
  if (IDEAS.pending) return IDEAS.pending;
  if (!b || typeof b.ideasRefresh !== 'function') return Promise.resolve(IDEAS.ideas);
  IDEAS.askedAt = typeof now === 'number' ? now : Date.now();
  IDEAS.pending = Promise.resolve().then(() => b.ideasRefresh()).then((res) => {
    if (res && res.ok) { IDEAS.ideas = ideasOf(res.data); IDEAS.loaded = true; IDEAS.unsupported = false; }
    else if (res && res.unsupported) { IDEAS.ideas = []; IDEAS.loaded = true; IDEAS.unsupported = true; }
    // Any other failure (agent still starting): keep what was shown, ask on a later paint.
    ideaRepaint();
    return IDEAS.ideas;
  }, () => IDEAS.ideas).finally(() => { IDEAS.pending = null; });
  return IDEAS.pending;
}

function ideaRepaint() {
  if (typeof render === 'function' && typeof S !== 'undefined' && S && S.room === 'chat' && !(S.log && S.log.length)) render();
}

function ideaCardHTML(i, busy) {
  const label = i.kind === 'resume_goal' ? 'Resume' : 'Retry';
  const off = busy ? ' disabled' : '';
  return '<div class="ideacard" data-idea="' + ideaEsc(i.id) + '">'
    + '<span class="ic-kind">' + label + '</span>'
    + '<span class="ic-t" title="' + ideaEsc(i.title) + '">' + ideaEsc(i.title) + '</span>'
    + (i.reason ? '<span class="ic-d">' + ideaEsc(i.reason) + '</span>' : '')
    + '<span class="ic-acts">'
    + '<button class="btn btn-s sm" data-act="idea:start:' + ideaEsc(i.id) + '"' + off + '>Start</button>'
    + '<button class="btn btn-g sm" data-act="idea:dismiss:' + ideaEsc(i.id) + '"' + off + ' aria-label="Dismiss: ' + ideaEsc(i.title) + '">Dismiss</button>'
    + '</span></div>';
}

/* The start screen's section, '' when there is nothing to suggest. Also
   asks again when the first ask found no agent yet (see IDEA_RETRY_MS). */
function ideaCardsHTML(now) {
  const t = typeof now === 'number' ? now : Date.now();
  if (!IDEAS.loaded && !IDEAS.pending && t - IDEAS.askedAt >= IDEA_RETRY_MS) ideaCardsRefresh(null, t);
  const list = IDEAS.ideas.slice(0, IDEA_CARDS_MAX);
  if (!list.length) return '';
  return '<section class="ideacards" aria-label="Suggested tasks">'
    + '<div class="ideacards-h">Suggested from your recent work</div>'
    + list.map((i) => ideaCardHTML(i, IDEAS.busy === i.id)).join('')
    + '</section>';
}

/* `start:<id>` and `dismiss:<id>` (renderer act, `idea:` prefix). */
async function ideaCardsAct(verb, br) {
  const b = br || (typeof BR !== 'undefined' ? BR : null);
  const m = /^(start|dismiss):(.+)$/.exec(String(verb || ''));
  if (!m || !b || IDEAS.busy) return;
  const [, what, id] = m;
  const idea = IDEAS.ideas.find((i) => i.id === id);
  if (!idea) return;
  IDEAS.busy = id;
  ideaRepaint();
  let res = null;
  try {
    res = what === 'start' ? await b.ideaAccept(id) : await b.ideaDismiss(id);
  } catch (err) {
    res = {ok: false, error: err && err.message ? err.message : String(err)};
  }
  IDEAS.busy = null;
  const decided = res && (res.ok || /already|decided/i.test(String(res.error || '')));
  if (decided) IDEAS.ideas = IDEAS.ideas.filter((i) => i.id !== id);
  if (!res || !res.ok) {
    if (!decided && typeof toast === 'function') toast(what === 'start' ? 'Could not start the task' : 'Could not dismiss it', String((res && res.error) || ''), 'bad');
    ideaRepaint();
    return;
  }
  if (what === 'dismiss') { ideaRepaint(); return; }
  const sid = ideaTaskSession(res.data);
  if (sid && typeof openSession === 'function') { openSession(sid); return; }
  if (typeof act === 'function') act('room:tasks');
  if (typeof toast === 'function') toast('Task started', idea.title, 'info');
}

if (typeof module !== 'undefined') module.exports = {IDEAS, IDEA_CARDS_MAX, IDEA_RETRY_MS, ideasOf, ideaTaskSession, ideaCardsRefresh, ideaCardsHTML, ideaCardsAct};
