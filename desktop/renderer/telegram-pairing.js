/* ---------------- Settings › Connections › Telegram: pairing (ATO-859) ----------------
   Loaded BEFORE renderer.js, so it only declares. Shared by the renderer and
   the Node checks (test/telegram-pairing.test.mjs): what a reply from the
   agent's /api/telegram/pairing routes (main/telegram-pairing.ts, IPC
   `agent:telegramPairing`) does to the pairing state, and the pairing card's
   markup. No IPC, no timers and no storage here.

   Nadya's decision on ATO-718: a 6-digit code on the screen, the owner sends
   `/start 123456` to the bot, the code lives 5 minutes, a paired owner is
   replaced only after confirmation, and the result says who paired. The code
   lives in this state while its window is open and is dropped the moment the
   window ends; it is never logged. */

/* How often the tab asks the agent whether the code was claimed. */
const TG_PAIR_POLL_MS = 2000;
/* A window the agent still calls open is ended here this long after it should have expired. */
const TG_PAIR_GRACE_MS = 5000;
const TG_PAIR_EXPIRED = 'The code expired. Press Pair for a new one.';
const TG_PAIR_NOT_RUNNING = 'Telegram is not running in the agent yet. Restart the agent, then press Pair. The app stays open.';

/* ATO-516: the code as a t.me deep link. Opening it in Telegram shows a Start
   button that sends `/start <code>` from that account, the same claim as
   typing it. The agent sends it as `link`; an agent from before that field
   gets the same link built here from its botUsername and code. Null when
   either part is not the shape a working link needs. */
const TG_BOT_USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;
function tgPairLink(botUsername, code, given) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  if (typeof given === 'string' && /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\?start=\d{6}$/.test(given) && given.endsWith('=' + code)) return given;
  if (typeof botUsername !== 'string' || !TG_BOT_USERNAME_RE.test(botUsername)) return null;
  return 'https://t.me/' + botUsername + '?start=' + code;
}
/* "4:59" until the window ends, "0:00" after; null without an expiry. */
function tgPairCountdown(expiresAt, now) {
  if (typeof expiresAt !== 'number' || typeof now !== 'number') return null;
  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
}

function tgPairInitial() {
  return {phase:'idle', supported:null, code:null, link:null, expiresAt:null, instruction:null, botUsername:null, pairedLine:null,
    error:null, askReplace:false};
}

/* What a reply (`{ok, data}` or `{ok:false, error, code?, unsupported?}`) to `op`
   ('start' | 'status' | 'cancel') does to `pair`. Returns a new object. */
function tgPairApply(pair, op, res, now) {
  const p = Object.assign({}, pair, {askReplace:false});
  const ended = (phase, extra) => Object.assign(p, {phase, code:null, link:null, expiresAt:null, instruction:null}, extra || {});
  const pastExpiry = p.phase === 'waiting' && typeof p.expiresAt === 'number' && typeof now === 'number' && now > p.expiresAt + TG_PAIR_GRACE_MS;
  if (res && res.unsupported) return ended('idle', {supported:false, error:null});
  if (!res || res.ok !== true) {
    // A poll that fails (the agent restarting, a timeout) changes nothing and the next one tries again,
    // until the window is past its expiry: then it ends here, so an agent that never answers again
    // does not keep the code on screen and the tab polling forever.
    if (op === 'status') return pastExpiry ? ended('expired', {error:null}) : p;
    const code = res && res.code;
    if (code === 'owner_already_paired') return Object.assign(p, {supported:true, error:null, askReplace:true});
    if (code === 'telegram_not_running') return ended('idle', {supported:true, error:TG_PAIR_NOT_RUNNING});
    const why = (res && res.error) || 'no reason given';
    return Object.assign(p, {error:(op === 'cancel' ? 'Could not cancel pairing: ' : 'Could not start pairing: ') + why});
  }
  const d = res.data || {};
  p.supported = true;
  if (op === 'start') {
    if (typeof d.code !== 'string' || !d.code) return Object.assign(p, {error:'Could not start pairing: the agent sent no code.'});
    const bot = typeof d.botUsername === 'string' ? d.botUsername : null;
    return Object.assign(p, {phase:'waiting', code:d.code, link:tgPairLink(bot, d.code, d.link), expiresAt:typeof d.expiresAt === 'number' ? d.expiresAt : null,
      instruction:typeof d.instruction === 'string' ? d.instruction : null,
      botUsername:bot, pairedLine:null, error:null});
  }
  if (op === 'cancel') return ended('idle', {error:null});
  // status: only the window this tab opened moves; a claim from an earlier visit is not news.
  if (p.phase !== 'waiting') return p;
  if (d.status === 'claimed') {
    const line = typeof d.pairedLine === 'string' && d.pairedLine ? d.pairedLine : 'Paired.';
    return ended('paired', {pairedLine:line, error:null});
  }
  if (d.status === 'expired' || d.status === 'idle') return ended('expired', {error:null});
  if (d.status === 'cancelled') return ended('idle', {error:null});
  if (d.status === 'failed') return ended('idle', {error:'Pairing failed: ' + (typeof d.error === 'string' && d.error ? d.error : 'no reason given')});
  if (pastExpiry) return ended('expired', {error:null});
  return p;
}

/* Whether the tab should ask again in TG_PAIR_POLL_MS. */
function tgPairPolling(pair) { return !!pair && pair.phase === 'waiting'; }

/* The pairing card's inside. `ctx`: {howto, note, busy, label, restart?, now?}; `h`: {esc}.
   `now` (epoch ms) shows how long the code has left; the renderer ticks
   [data-tg-countdown] in place between repaints (ATO-516).
   `label` names the start button ('Pair', or the replace wording). `restart` is the
   Restart agent button's markup (telegram-restart.js): when the agent said Telegram
   is not running, it stands beside Pair as the step to take first (ATO-900 item 6). */
function tgPairCardHTML(pair, ctx, h) {
  const esc = h.esc;
  const p = pair || tgPairInitial();
  const err = p.error ? '<p class="tk-help tk-help--err" data-tg-pair-error>' + esc(p.error) + '</p>' : '';
  if (p.supported === false) return '<p data-tg-pair-note>' + esc(ctx.note) + '</p>';
  const startBtn = (label) => '<button class="btn btn-p sm" data-act="telegram:pairStart"' + (ctx.busy ? ' disabled' : '') + '>' + esc(label) + '</button>';
  if (p.phase === 'waiting') {
    const left = tgPairCountdown(p.expiresAt, ctx.now);
    // ATO-516: one click instead of typing: the link opens the bot with the code filled in.
    const link = p.link ? '<p class="sd-cap">Or open the bot with the code filled in, then press Start:</p>'
      + '<div class="sd-acts" data-tg-link><span class="sd-mono sd-grow" title="' + esc(p.link) + '">' + esc(p.link.replace(/^https:\/\//, '')) + '</span>'
      + '<button class="btn btn-s sm" data-act="telegram:pairCopy">Copy link</button>'
      + '<button class="btn btn-p sm" data-act="telegram:pairOpen">Open in Telegram</button></div>' : '';
    return '<div class="sd-paircode" data-tg-code aria-label="Pairing code">' + esc(p.code || '') + '</div>'
      + '<p>' + esc(p.instruction || ('Send /start ' + (p.code || '') + ' to your bot in Telegram.')) + '</p>'
      + link
      + err
      + '<div class="sd-acts"><span class="sd-cap">Waiting for your message…</span>'
      + (left ? '<span class="sd-cap">Expires in <b data-tg-countdown>' + esc(left) + '</b></span>' : '') + '<span class="sd-grow"></span>'
      + '<button class="btn btn-g sm" data-act="telegram:pairCancel"' + (ctx.busy ? ' disabled' : '') + '>Cancel</button>'
      + '<button class="btn btn-s sm" data-act="telegram:pairStart"' + (ctx.busy ? ' disabled' : '') + '>New code</button></div>';
  }
  if (p.phase === 'paired') return '<p data-tg-paired>' + esc(p.pairedLine || 'Paired.') + '</p>';
  const lead = p.phase === 'expired' ? TG_PAIR_EXPIRED : ctx.howto;
  if (p.error === TG_PAIR_NOT_RUNNING && ctx.restart) {
    const pairBtn = '<button class="btn btn-s sm" data-act="telegram:pairStart"' + (ctx.busy ? ' disabled' : '') + '>' + esc(ctx.label || 'Pair') + '</button>';
    return '<p>' + esc(lead) + '</p>' + err + '<div class="sd-acts"><span class="sd-grow"></span>' + pairBtn + ctx.restart + '</div>';
  }
  return '<p>' + esc(lead) + '</p>' + err
    + '<div class="sd-acts"><span class="sd-grow"></span>' + startBtn(ctx.label || 'Pair') + '</div>';
}

if (typeof module !== 'undefined') {
  module.exports = {TG_PAIR_POLL_MS, TG_PAIR_GRACE_MS, TG_PAIR_EXPIRED, TG_PAIR_NOT_RUNNING,
    tgPairLink, tgPairCountdown, tgPairInitial, tgPairApply, tgPairPolling, tgPairCardHTML};
}
