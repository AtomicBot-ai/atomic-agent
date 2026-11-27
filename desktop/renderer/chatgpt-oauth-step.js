/* ---------------- ATO-1747: "Sign in with ChatGPT" without a terminal ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/chatgpt-oauth-step.test.mjs).

   The Codex row of the provider wizard (KIND_ROWS `codex-cli`) needs the Codex
   CLI installed and signed in (ATO-845). Beside it, when the bundled agent has
   `atag login chatgpt` (main asks it once per run, chatgptOauth:status
   `supported`), the step offers a second way in: main runs the agent's own
   ChatGPT sign-in, opens the browser and waits (main/chatgpt-oauth-login.ts).
   The window sees only {ok, state, reason, providerId?}: no link, no token.

   On success the agent has already written the provider entry, so the wizard
   only activates it (renderer.js wizActivate) and never writes it again.
   Leaving the step in any way (Back, Esc, closing the wizard, another row)
   cancels the sign-in: a watch asks every second whether the step is still on
   screen, as the Codex poll does (wizSubPollTick). Closing the window or
   quitting the app is main's side (chatgpt-oauth-ipc.ts).

   ATO-2512: when the app drives an agent on another computer, main answers
   `remote` (chatgpt-oauth-remote.ts): this sign-in would land on this
   computer's agent, and the remote one cannot be signed in from here. The
   block is then one line saying to run the sign-in on that computer, as
   Codex (`codex login --device-auth`) and GitHub CLI ask on a remote machine.
   A remote answer is asked again after a while (the person may switch back),
   and a start refused as remote turns the block into that line. */

const CHATGPT_OAUTH = {supported: null, asking: false, running: false, error: null, startedAt: 0, watch: null, byUser: false, left: false, remote: false, askedAt: 0};
/** ATO-2512: how long a "remote agent" answer stands before the step asks again. */
const CHATGPT_OAUTH_REMOTE_RECHECK_MS = 15000;
/** ATO-2512: the command the line names, run on the computer the agent is on. */
const CHATGPT_OAUTH_REMOTE_COMMAND = 'atag login chatgpt --device';
const CHATGPT_OAUTH_WATCH_MS = 1000;
const CHATGPT_OAUTH_REASONS = ['timeout', 'no_account', 'cancelled', 'failed'];

/* One fixed sentence per reason; the agent's own words never reach the screen. */
const CHATGPT_OAUTH_ERRORS = {
  timeout: 'The sign-in timed out: the browser never came back. Try again.',
  no_account: 'Signed in, but this account has no ChatGPT plan. A ChatGPT plan (Plus, Pro, Team) is needed.',
  cancelled: 'The sign-in was cancelled.',
  failed: 'Could not sign in with ChatGPT. Try again, or use the Codex CLI.',
  no_entry: 'Signed in, but the provider could not be found. Pick ChatGPT in Settings, Models.',
};

/** A reason from main, or `failed` for anything off the fixed list. */
function chatgptOauthReason(res) {
  const r = res && res.reason;
  return CHATGPT_OAUTH_REASONS.includes(r) ? r : 'failed';
}

function chatgptOauthErrorText(reason) {
  return CHATGPT_OAUTH_ERRORS[reason] || CHATGPT_OAUTH_ERRORS.failed;
}

/** Ask main once whether the bundled agent can do this sign-in; redraw when it can. */
function chatgptOauthAskSupported(br, onChange, st, now) {
  const s = st || CHATGPT_OAUTH;
  const t = (now || Date.now)();
  // ATO-2512: a remote answer is asked again once it is old; the line stays on screen meanwhile.
  const stale = s.remote && !s.running && t - (s.askedAt || 0) >= CHATGPT_OAUTH_REMOTE_RECHECK_MS;
  if ((s.supported !== null && !stale) || s.asking) return;
  if (!br || typeof br.chatgptOauthStatus !== 'function') { s.supported = false; return; }
  s.asking = true;
  Promise.resolve()
    .then(() => br.chatgptOauthStatus())
    .then((r) => { s.supported = !!(r && r.supported === true); s.remote = !!(r && r.remote === true); })
    .catch(() => { s.supported = false; s.remote = false; })
    .then(() => { s.asking = false; s.askedAt = t; if (s.supported && onChange) onChange(); });
}

/**
 * The step's block: nothing until main says the agent can do it; then the
 * button with its Experimental label, or, while signing in, the wait line with
 * Cancel. `compact` is the composer popover's smaller buttons.
 */
function chatgptOauthBlockHTML(st, esc, compact) {
  if (!st || st.supported !== true) return '';
  if (st.remote) return chatgptOauthRemoteHTML(esc);   // ATO-2512
  const btn = compact ? 'btn btn-s xs' : 'btn btn-s';
  if (st.running) {
    return '<div class="ob-help wiz-chatgpt-oauth" role="status">'
      + '<span class="tk-spin"></span>Finish signing in in your browser. '
      + '<button class="' + btn + '" data-act="wiz:chatgptOauthCancel">Cancel</button></div>';
  }
  return '<div class="ob-help wiz-chatgpt-oauth">'
    + 'No Codex CLI? Sign in with your ChatGPT account in the browser instead. '
    + '<button class="' + btn + '" data-act="wiz:chatgptOauth">Sign in with ChatGPT</button> '
    + '<span class="tk-chip tk-chip--sm tk-chip--amber">Experimental</span>'
    + (st.error ? '<div class="ob-err">' + esc(st.error) + '</div>' : '')
    + '</div>';
}

/** ATO-2512: the block on a remote agent: no button, the command to run there. */
function chatgptOauthRemoteHTML(esc) {
  return '<div class="ob-help wiz-chatgpt-oauth" role="note">'
    + 'This app is connected to an agent on another computer, so it cannot sign in with ChatGPT from here. '
    + 'On that computer, run <code>' + esc(CHATGPT_OAUTH_REMOTE_COMMAND) + '</code> and follow the code it shows.'
    + '</div>';
}

function chatgptOauthStopWatch(st) {
  if (st.watch) clearInterval(st.watch);
  st.watch = null;
}

/**
 * Stop the running sign-in. `byUser`: the Cancel button, so no error line
 * follows; otherwise the step was left.
 */
function chatgptOauthCancel(br, byUser, st) {
  const s = st || CHATGPT_OAUTH;
  if (!s.running) return false;
  if (byUser) s.byUser = true; else s.left = true;
  chatgptOauthStopWatch(s);
  if (br && typeof br.chatgptOauthCancel === 'function') Promise.resolve().then(() => br.chatgptOauthCancel()).catch(() => {});
  return true;
}

/**
 * The click. ctx: {br, render, onStep() -> still on this step, activate(id),
 * anx (renderer/analytics.js ANX), inOnboarding, now?, setInterval?}.
 * Resolves once main answers; never throws.
 */
async function chatgptOauthStart(ctx, st) {
  const s = st || CHATGPT_OAUTH;
  const br = ctx && ctx.br;
  if (s.running || !br || typeof br.chatgptOauthStart !== 'function') return;
  const now = ctx.now || Date.now;
  const every = ctx.setInterval || setInterval;
  const anx = ctx.anx || {};
  Object.assign(s, {running: true, error: null, byUser: false, left: false, startedAt: now()});
  if (anx.subscriptionLoginClicked) anx.subscriptionLoginClicked('chatgpt-oauth', ctx.inOnboarding);
  s.watch = every(() => { if (!ctx.onStep()) chatgptOauthCancel(br, false, s); }, CHATGPT_OAUTH_WATCH_MS);
  ctx.render();
  let res = null;
  try { res = await br.chatgptOauthStart(); } catch { res = null; }
  chatgptOauthStopWatch(s);
  s.running = false;
  const left = s.left || !ctx.onStep();
  if (res && res.ok === true) {
    if (anx.subscriptionLoginSucceeded) anx.subscriptionLoginSucceeded('chatgpt-oauth', ctx.inOnboarding, Math.round((now() - s.startedAt) / 1000));
    // Signed in, but the wizard is gone: the entry stays for the person to pick later.
    if (left) return;
    if (typeof res.providerId === 'string' && res.providerId) { ctx.activate(res.providerId); return; }
    s.error = chatgptOauthErrorText('no_entry');
    ctx.render();
    return;
  }
  // ATO-2512: main refused, the agent is on another computer: the block becomes that line, no error and no event.
  if (!s.byUser && !s.left && res && res.reason === 'remote') { s.remote = true; s.askedAt = now(); s.error = null; if (!left) ctx.render(); return; }
  const reason = s.byUser || s.left ? 'cancelled' : chatgptOauthReason(res);
  if (anx.subscriptionOauthEnded) anx.subscriptionOauthEnded(reason, ctx.inOnboarding);
  if (left) return;
  s.error = s.byUser ? null : chatgptOauthErrorText(reason);
  ctx.render();
}

if (typeof module !== 'undefined') {
  module.exports = {
    CHATGPT_OAUTH, CHATGPT_OAUTH_ERRORS, chatgptOauthReason, chatgptOauthErrorText, chatgptOauthAskSupported,
    chatgptOauthBlockHTML, chatgptOauthCancel, chatgptOauthStart, chatgptOauthRemoteHTML, CHATGPT_OAUTH_REMOTE_COMMAND,
  };
}
