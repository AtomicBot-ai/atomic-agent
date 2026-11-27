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
   quitting the app is main's side (chatgpt-oauth-ipc.ts). */

const CHATGPT_OAUTH = {supported: null, asking: false, running: false, error: null, startedAt: 0, watch: null, byUser: false, left: false};
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
function chatgptOauthAskSupported(br, onChange, st) {
  const s = st || CHATGPT_OAUTH;
  if (s.supported !== null || s.asking) return;
  if (!br || typeof br.chatgptOauthStatus !== 'function') { s.supported = false; return; }
  s.asking = true;
  Promise.resolve()
    .then(() => br.chatgptOauthStatus())
    .then((r) => { s.supported = !!(r && r.supported === true); })
    .catch(() => { s.supported = false; })
    .then(() => { s.asking = false; if (s.supported && onChange) onChange(); });
}

/**
 * The step's block: nothing until main says the agent can do it; then the
 * button with its Experimental label, or, while signing in, the wait line with
 * Cancel. `compact` is the composer popover's smaller buttons.
 */
function chatgptOauthBlockHTML(st, esc, compact) {
  if (!st || st.supported !== true) return '';
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
  const reason = s.byUser || s.left ? 'cancelled' : chatgptOauthReason(res);
  if (anx.subscriptionOauthEnded) anx.subscriptionOauthEnded(reason, ctx.inOnboarding);
  if (left) return;
  s.error = s.byUser ? null : chatgptOauthErrorText(reason);
  ctx.render();
}

if (typeof module !== 'undefined') {
  module.exports = {
    CHATGPT_OAUTH, CHATGPT_OAUTH_ERRORS, chatgptOauthReason, chatgptOauthErrorText, chatgptOauthAskSupported,
    chatgptOauthBlockHTML, chatgptOauthCancel, chatgptOauthStart,
  };
}
