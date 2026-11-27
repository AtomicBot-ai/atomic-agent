/* ---------------- Settings › Connections › Telegram: the Connect card and the token field (ATO-426) ----------------
   Loaded BEFORE renderer.js, so it only declares. Shared by the renderer and
   the Node checks (test/telegram-token.test.mjs): the token's shape rule, the
   Connect card's steps, the token prompt's markup and the words a token
   check ends with. No DOM, no IPC and no storage here; the token itself never
   enters this state, a message or a log.

   U-76: the card says what Telegram is for (talking to the agent from a
   phone), lists the three steps, and @BotFather is a button that opens
   t.me/BotFather (the Composio pane's "Get an API key" and its numbered
   steps are the precedent, composio.js composioSetupHTML).
   U-77: the field shows the token's shape as a placeholder, has a Show /
   Hide eye (macOS password fields, 1Password), Save stays disabled while the
   field is empty, the shape is checked before anything is written, and the
   token is checked with Telegram's getMe before it is saved: the result says
   "@my_bot" or why Telegram refused it (Goose's "Connected successfully",
   Cherry's Check button, the Composio pane's own key check here). */

const TG_BOTFATHER_URL = 'https://t.me/BotFather';
/* What a bot token looks like: the bot's numeric id, a colon, then the secret
   (letters, digits, `_` and `-`; 35 characters today, with room either way).
   The same rule as main's telegramTokenValueError (telegram-token-check.ts),
   which checks it again because the value crosses IPC and goes into a URL. */
const TG_TOKEN_RE = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;
const TG_TOKEN_PLACEHOLDER = '123456789:AAF1x_example_token_from_BotFather';
const TG_TOKEN_EMPTY = 'Paste the token first.';
const TG_TOKEN_SHAPE = 'That does not look like a Telegram bot token. It is the bot\'s number, a colon and a long code, like ' + TG_TOKEN_PLACEHOLDER + '.';
const TG_TOKEN_REJECTED = 'Telegram did not accept this token. Open @BotFather, send /mybots, pick the bot and copy its token again.';
const TG_TOKEN_UNCHECKED = 'Could not reach Telegram to check the token, so it was saved as typed. The bot will try it when the agent starts.';

const TG_SETUP_STEPS = [
  'Open @BotFather in Telegram and send /newbot. It asks for a name and a username ending in "bot".',
  'Copy the token it answers with. It looks like ' + TG_TOKEN_PLACEHOLDER + '.',
  'Paste the token here and press Save. Then confirm it is you with a one-time code.',
];

/* The token as typed, or why it cannot be saved. */
function tgTokenClean(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return {ok:false, error:TG_TOKEN_EMPTY};
  if (!TG_TOKEN_RE.test(t)) return {ok:false, error:TG_TOKEN_SHAPE};
  return {ok:true, value:t};
}

/* The token prompt's state: `shown` is the eye's position, `hasText` whether
   the field has anything in it (so Save can be disabled without the value
   ever leaving the field), `checking` while Telegram is asked about it. */
function tgTokenInitial() { return {error:null, errorDetail:null, submitting:false, checking:false, shown:false, hasText:false}; }

/* Whether Save may be pressed for what is in the field. */
function tgTokenSaveEnabled(value) { return String(value == null ? '' : value).trim().length > 0; }

/* What a check's answer (main/telegram-token-check.ts) means for the save:
   `save` whether the token may be written, `message` what the tab says after
   it, `error` what the field says instead when it may not. */
function tgTokenCheckOutcome(res) {
  if (res && res.ok === true) {
    const name = typeof res.username === 'string' && res.username ? '@' + res.username : 'your bot';
    return {save:true, message:'Token saved. Telegram confirms the bot: ' + name + '.', error:null, bot:name};
  }
  if (res && res.rejected === true) return {save:false, message:null, error:TG_TOKEN_REJECTED, bot:null};
  // Offline, a 5xx, no bridge: the agent treats a bad token the same way at start, so the save goes ahead with a warning.
  return {save:true, message:'Token saved. ' + TG_TOKEN_UNCHECKED, error:null, bot:null};
}

/* The Connect card (no token yet): why, the steps, the two actions. `h`: {esc, ic, logo?}. */
function tgConnectCardHTML(h) {
  const mark = (typeof h.logo === 'function' && h.logo('telegram', 'lg', 'send')) || '<span class="tk-ico tk-ico--lg tk-ico--blue">' + h.ic('send') + '</span>';
  return '<div class="tk-card pad sd-tgcard sd-center" data-tg-connect>'
    + mark
    + '<h3 class="sd-title">Connect Telegram</h3>'
    + '<p>Talk to Atomic Agent from your phone: message your own Telegram bot and it answers from this computer. The token is stored only on this machine.</p>'
    + '<ol class="sd-steps sd-steps--left">' + TG_SETUP_STEPS.map((t) => '<li>' + h.esc(t) + '</li>').join('') + '</ol>'
    + '<div class="sd-acts"><button class="btn btn-s" data-act="telegram:botfather" title="Opens t.me/BotFather in Telegram">' + h.ic('open') + 'Open @BotFather</button>'
    + '<button class="btn btn-p" data-act="telegram:token">Paste a bot token</button></div></div>';
}

/* The token prompt: a password field with the shape as its placeholder, the
   Show / Hide eye, Cancel and a Save that waits for text. `t`: tgTokenInitial(). `h`: {esc, ic}. */
function tgTokenPromptCardHTML(t, h) {
  const st = t || tgTokenInitial();
  const busy = !!(st.submitting || st.checking);
  const eye = st.shown ? 'eyeOff' : 'eye';
  return '<div class="tk-card pad sd-tgcard" data-tg-token-prompt>'
    + '<h3 class="sd-title">Bot token</h3>'
    // ATO-2745: where it lands (keychain or file) is said after the save, from main's answer (key-stored-note.js).
    + '<p>Paste the token @BotFather gave you. It is checked with Telegram once, then saved only on this computer.</p>'
    + '<label class="tk-inpwrap sd-tokwrap' + (st.error ? ' is-error' : '') + '">' + h.ic('key')
    + '<input id="tg-token" type="' + (st.shown ? 'text' : 'password') + '" autocomplete="off" spellcheck="false" aria-label="Bot token"'
    + ' placeholder="' + h.esc(TG_TOKEN_PLACEHOLDER) + '"' + (busy ? ' disabled' : '') + '>'
    + '<button type="button" class="iconbtn sm" data-act="telegram:tokenReveal" aria-pressed="' + (st.shown ? 'true' : 'false') + '" title="' + (st.shown ? 'Hide the token' : 'Show the token') + '" aria-label="' + (st.shown ? 'Hide the token' : 'Show the token') + '">' + h.ic(eye) + '</button>'
    + '</label>'
    + (st.error ? '<p class="tk-help tk-help--err" data-tg-token-error>' + h.esc(st.error) + '</p>' : '')
    + (st.error && st.errorDetail ? '<details class="set-errmore"><summary>Details</summary><span>' + h.esc(st.errorDetail) + '</span></details>' : '')
    + '<div class="sd-acts">' + (st.checking ? '<span class="sd-cap">checking with Telegram…</span>' : st.submitting ? '<span class="sd-cap">saving…</span>' : '') + '<span class="sd-grow"></span>'
    + '<button class="btn btn-g sm" data-act="telegram:tokenCancel">Cancel</button>'
    + '<button class="btn btn-p sm" data-act="telegram:tokenSave"' + (busy || !st.hasText ? ' disabled' : '') + '>Save</button></div></div>';
}

if (typeof module !== 'undefined') {
  module.exports = {TG_BOTFATHER_URL, TG_TOKEN_RE, TG_TOKEN_PLACEHOLDER, TG_TOKEN_EMPTY, TG_TOKEN_SHAPE, TG_TOKEN_REJECTED, TG_TOKEN_UNCHECKED, TG_SETUP_STEPS,
    tgTokenClean, tgTokenInitial, tgTokenSaveEnabled, tgTokenCheckOutcome, tgConnectCardHTML, tgTokenPromptCardHTML};
}
