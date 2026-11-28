/* ---------------- ATO-2511: the sign-in provider in Settings › Models ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/subscription-oauth-row.test.mjs).

   `atag login chatgpt` (and `login copilot`) adds a provider entry of kind
   `subscription-oauth` with an id like `chatgpt-sub` and no key. Before this
   file the window drew it as its raw id with the server icon, said "No key"
   and opened the key screen on a click. Now:

   - its name is "ChatGPT (subscription)" / "GitHub Copilot (subscription)"
     everywhere a provider is named (renderer.js providerWord), and it wears
     the OpenAI / GitHub mark (providerLogoKey);
   - its row in Settings › Models says whether the ChatGPT sign-in is there
     (main asks the agent, chatgptOauth:status) and has Sign out, which runs
     `atag logout chatgpt` (chatgptOauth:signOut), or Sign in once signed out,
     which runs the same sign-in as the provider wizard (chatgptOauth:start).
     The entry stays after a sign-out, as the agent keeps it.

   Precedent: the Codex and Claude desktop apps name the account a sign-in
   uses and offer Log out beside it; no confirm, since signing in again is
   one click. Loading, error and done are one line under the row, each in
   the same place; an error is a fixed sentence and the agent's own words
   sit behind Details. Copilot gets the name and the mark only: its sign-out
   stays `atag logout copilot`.

   ATO-2512: on an agent on another computer main answers `remote`
   (chatgpt-oauth-remote.ts): this computer's sign-in says nothing about that
   agent and cannot change it, so the row has no Sign in / Sign out and its
   line says which commands to run on that computer. */

const SUB_OAUTH_KIND = 'subscription-oauth';
/** `atag login chatgpt` / `login copilot` ids (CHATGPT_PROVIDER_ID, COPILOT_PROVIDER_ID), and a second entry's `-2`. */
const SUB_OAUTH_ID_RE = /^(chatgpt|copilot)-sub(?:-\d+)?$/;
const SUB_OAUTH_NAMES = {chatgpt: 'ChatGPT (subscription)', copilot: 'GitHub Copilot (subscription)'};
const SUB_OAUTH_MARKS = {chatgpt: 'openai', copilot: 'github'};
/** How long a sign-in state stays fresh before the row asks again. */
const SUB_OAUTH_STALE_MS = 15000;
/** ATO-2512: the line on a remote agent. */
const SUB_OAUTH_REMOTE_LINE = 'This app is connected to an agent on another computer. To sign in or out there, run atag login chatgpt --device or atag logout chatgpt on that computer.';

const SUB_OAUTH = {status: null, at: 0, asking: false, busy: null, error: null, detail: null, showDetail: false, note: null};

const SUB_OAUTH_ERRORS = {
  signOut: 'Could not sign out of ChatGPT. Try again.',
  unsupported: 'This version of the agent cannot sign out here. Update the app, then try again.',
  status: 'Could not check the ChatGPT sign-in.',
  timeout: 'The sign-in timed out: the browser never came back. Try again.',
  no_account: 'Signed in, but this account has no ChatGPT plan. A ChatGPT plan (Plus, Pro, Team) is needed.',
  cancelled: 'The sign-in was cancelled.',
  failed: 'Could not sign in with ChatGPT. Try again.',
};

/** 'chatgpt' or 'copilot' for a sign-in entry; an entry with no service is a ChatGPT one (login-command.ts). */
function subOauthService(p) {
  if (!p || p.kind !== SUB_OAUTH_KIND) return '';
  const s = p.subscriptionOauth && p.subscriptionOauth.service;
  return s === 'copilot' ? 'copilot' : 'chatgpt';
}

/** The service of a provider id: from the entry when `entries` has it, else from the agent's own id. */
function subOauthServiceOf(id, entries) {
  const s = String(id || '');
  const p = (entries || []).find((x) => x && x.id === s);
  if (p) return subOauthService(p);
  const m = SUB_OAUTH_ID_RE.exec(s);
  return m ? m[1] : '';
}

/** "ChatGPT (subscription)" for a sign-in provider's id, '' for any other. */
function subOauthWord(id, entries) {
  return SUB_OAUTH_NAMES[subOauthServiceOf(id, entries)] || '';
}

/** The mark key ('openai' / 'github') for a sign-in provider's id, '' for any other. */
function subOauthLogoKey(id, entries) {
  return SUB_OAUTH_MARKS[subOauthServiceOf(id, entries)] || '';
}

/** Ask main for the ChatGPT sign-in state when it is unknown or stale; redraw once it answers. */
function subOauthEnsureStatus(br, repaint, st, now) {
  const s = st || SUB_OAUTH;
  const t = (now || Date.now)();
  if (s.asking || s.busy || (s.status && t - s.at < SUB_OAUTH_STALE_MS)) return;
  if (!br || typeof br.chatgptOauthStatus !== 'function') { s.status = {ok: true, signedIn: false, plan: null, supported: false}; s.at = t; return; }
  s.asking = true;
  Promise.resolve()
    .then(() => br.chatgptOauthStatus())
    .then((r) => { s.status = r && typeof r === 'object' ? r : {ok: false}; })
    .catch(() => { s.status = {ok: false}; })
    .then(() => { s.asking = false; s.at = (now || Date.now)(); if (repaint) repaint(); });
}

/** The chip under the name: [tone, words]. */
function subOauthChip(service, st) {
  if (service !== 'chatgpt') return ['line', 'Uses your Copilot plan'];
  const s = st.status;
  if (!s) return ['line', 'Checking sign-in…'];
  if (s.remote === true) return ['line', 'On the other computer'];   // ATO-2512
  if (s.ok === false) return ['line', 'Sign-in unknown'];
  if (s.supported === false) return ['line', 'Uses your ChatGPT plan'];
  // The token's plan is lower case ("plus"); ChatGPT names it "Plus".
  if (s.signedIn) return ['green', s.plan ? 'Signed in · ' + s.plan.charAt(0).toUpperCase() + s.plan.slice(1) : 'Signed in'];
  return ['amber', 'Signed out'];
}

/** The one line under the row: busy, error or done, in that order; null for none. {text, cls, spin?} */
function subOauthLine(service, st) {
  if (service !== 'chatgpt') return null;
  if (st.busy === 'signOut') return {text: 'Signing out…', cls: '', spin: true};
  if (st.busy === 'signIn') return {text: 'Finish signing in in your browser.', cls: '', spin: true};
  if (st.error) return {text: st.error, cls: ' is-err'};
  if (st.note) return {text: st.note, cls: ''};
  const s = st.status;
  if (s && s.remote === true) return {text: SUB_OAUTH_REMOTE_LINE, cls: ''};   // ATO-2512
  if (s && s.ok !== false && s.supported !== false && !s.signedIn) return {text: 'Sign in again to use your ChatGPT plan here.', cls: ''};
  return null;
}

/** The row's own buttons, by state: [act, label] pairs (renderer.js draws them as `llm-rowact`). */
function subOauthActions(service, st) {
  if (service !== 'chatgpt') return [];
  if (st.busy === 'signIn') return [['llm:subOauth:cancel', 'Cancel']];
  if (st.busy) return [];
  const out = [];
  if (st.error && st.detail) out.push(['llm:subOauth:details', st.showDetail ? 'Hide details' : 'Details']);
  const s = st.status;
  if (!s || s.supported === false || s.remote === true) return out;
  if (s.ok === false) { out.push(['llm:subOauth:check', 'Check again']); return out; }
  out.push(s.signedIn ? ['llm:subOauth:signOut', 'Sign out'] : ['llm:subOauth:signIn', 'Sign in']);
  return out;
}

/**
 * The row in Settings › Models. ctx: {open, radio, mark, name, id, index,
 * effect, rowAct(act, label), chip(tone, html), esc, br, repaint}. The
 * parts renderer.js already drew (open tag, radio, mark, pill) come in, so
 * the row is the same shape as its neighbours.
 */
function subOauthRowHTML(p, ctx, st) {
  const s = st || SUB_OAUTH;
  const service = subOauthService(p);
  if (service === 'chatgpt') subOauthEnsureStatus(ctx.br, ctx.repaint, s);
  const [tone, words] = subOauthChip(service, s);
  const line = subOauthLine(service, s);
  const esc = ctx.esc;
  const t = '<span class="llm-name">' + esc(ctx.name) + '</span>'
    + (ctx.name !== p.id ? ' <span class="llm-id mono">' + esc(p.id) + '</span>' : '')
    + ' ' + ctx.chip(tone, esc(words));
  const sub = line
    ? '<span class="d llm-sub' + line.cls + '" role="status">' + (line.spin ? '<span class="tk-spin"></span>' : '') + esc(line.text) + '</span>'
    : '';
  const detail = s.error && s.detail && s.showDetail ? '<span class="d llm-sub mono">' + esc(s.detail) + '</span>' : '';
  const acts = subOauthActions(service, s).map(([a, label]) => ctx.rowAct(a, label)).join('');
  return ctx.open + ctx.radio + ctx.mark + '<span class="body"><span class="t">' + t + '</span>' + sub + detail + '</span>'
    + acts + ctx.rowAct('llm:removeAt:' + ctx.index, 'Remove') + ctx.effect + '</button>';
}

/** ATO-2512: main refused because the agent is on another computer: the row turns into that line, no error. */
function subOauthTookRemote(res, s) {
  if (!res || res.reason !== 'remote') return false;
  s.status = {ok: true, signedIn: false, plan: null, supported: true, remote: true};
  s.at = Date.now();
  s.error = null; s.detail = null; s.note = null;
  return true;
}

/** A sign-out answer from main, as the row's state. Never the agent's words outside `detail`. */
function subOauthTakeSignOut(res, st) {
  const s = st || SUB_OAUTH;
  s.busy = null;
  if (res && res.ok === true) {
    s.status = Object.assign({}, s.status || {ok: true, supported: true}, {ok: true, signedIn: false, plan: null});
    s.at = Date.now();
    s.note = 'Signed out. Chats that use ChatGPT will ask you to sign in again.';
    return;
  }
  if (subOauthTookRemote(res, s)) return;
  s.error = res && res.reason === 'unsupported' ? SUB_OAUTH_ERRORS.unsupported : SUB_OAUTH_ERRORS.signOut;
  s.detail = res && typeof res.detail === 'string' && res.detail ? res.detail : null;
}

/** A sign-in answer from main (chatgptOauth:start), as the row's state. */
function subOauthTakeSignIn(res, st) {
  const s = st || SUB_OAUTH;
  s.busy = null;
  if (res && res.ok === true) {
    s.status = null; s.at = 0;   // asked again on the next paint, for the plan
    s.note = 'Signed in.';
    return;
  }
  if (subOauthTookRemote(res, s)) { s.cancelled = false; return; }
  const reason = res && SUB_OAUTH_ERRORS[res.reason] && ['timeout', 'no_account', 'cancelled', 'failed'].includes(res.reason) ? res.reason : 'failed';
  // Cancel from this row is the person's own choice: no error line follows it.
  s.error = s.cancelled ? null : SUB_OAUTH_ERRORS[reason];
  s.cancelled = false;
}

/** The row's buttons. ctx: {br, repaint}. Resolves once main answers; never throws. */
async function subOauthAct(what, ctx, st) {
  const s = st || SUB_OAUTH;
  const br = ctx && ctx.br;
  const repaint = (ctx && ctx.repaint) || (() => {});
  if (what === 'details') { s.showDetail = !s.showDetail; repaint(); return; }
  if (what === 'check') { s.status = null; s.at = 0; s.error = null; repaint(); return; }
  if (what === 'cancel') {
    if (s.busy !== 'signIn') return;
    s.cancelled = true;
    if (br && typeof br.chatgptOauthCancel === 'function') Promise.resolve().then(() => br.chatgptOauthCancel()).catch(() => {});
    return;
  }
  if (s.busy) return;
  if (what === 'signOut') {
    if (!br || typeof br.chatgptOauthSignOut !== 'function') { s.error = SUB_OAUTH_ERRORS.unsupported; s.detail = null; repaint(); return; }
    Object.assign(s, {busy: 'signOut', error: null, detail: null, showDetail: false, note: null});
    repaint();
    let res = null;
    try { res = await br.chatgptOauthSignOut(); } catch { res = null; }
    subOauthTakeSignOut(res, s);
    repaint();
    return;
  }
  if (what === 'signIn') {
    if (!br || typeof br.chatgptOauthStart !== 'function') { s.error = SUB_OAUTH_ERRORS.failed; repaint(); return; }
    Object.assign(s, {busy: 'signIn', error: null, detail: null, showDetail: false, note: null, cancelled: false});
    repaint();
    let res = null;
    try { res = await br.chatgptOauthStart(); } catch { res = null; }
    subOauthTakeSignIn(res, s);
    repaint();
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    SUB_OAUTH, SUB_OAUTH_ERRORS, subOauthService, subOauthServiceOf, subOauthWord, subOauthLogoKey, subOauthEnsureStatus,
    subOauthChip, subOauthLine, subOauthActions, subOauthRowHTML, subOauthTakeSignOut, subOauthTakeSignIn, subOauthAct,
    SUB_OAUTH_REMOTE_LINE,
  };
}
