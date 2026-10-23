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
const TG_PAIR_NOT_RUNNING = 'Telegram is not running in the agent yet. Restart the agent, then press Pair.';

function tgPairInitial() {
  return {phase:'idle', supported:null, code:null, expiresAt:null, instruction:null, botUsername:null, pairedLine:null,
    error:null, askReplace:false};
}

/* What a reply (`{ok, data}` or `{ok:false, error, code?, unsupported?}`) to `op`
   ('start' | 'status' | 'cancel') does to `pair`. Returns a new object. */
function tgPairApply(pair, op, res, now) {
  const p = Object.assign({}, pair, {askReplace:false});
  const ended = (phase, extra) => Object.assign(p, {phase, code:null, expiresAt:null, instruction:null}, extra || {});
  if (res && res.unsupported) return ended('idle', {supported:false, error:null});
  if (!res || res.ok !== true) {
    // A poll that fails (the agent restarting, a timeout) changes nothing; the next one tries again.
    if (op === 'status') return p;
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
    return Object.assign(p, {phase:'waiting', code:d.code, expiresAt:typeof d.expiresAt === 'number' ? d.expiresAt : null,
      instruction:typeof d.instruction === 'string' ? d.instruction : null,
      botUsername:typeof d.botUsername === 'string' ? d.botUsername : null, pairedLine:null, error:null});
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
  if (typeof p.expiresAt === 'number' && typeof now === 'number' && now > p.expiresAt + TG_PAIR_GRACE_MS) return ended('expired', {error:null});
  return p;
}

/* Whether the tab should ask again in TG_PAIR_POLL_MS. */
function tgPairPolling(pair) { return !!pair && pair.phase === 'waiting'; }

/* The pairing card's inside. `ctx`: {howto, note, busy, label}; `h`: {esc}.
   `label` names the start button ('Pair', or the replace wording). */
function tgPairCardHTML(pair, ctx, h) {
  const esc = h.esc;
  const p = pair || tgPairInitial();
  const err = p.error ? '<p class="tk-help tk-help--err" data-tg-pair-error>' + esc(p.error) + '</p>' : '';
  if (p.supported === false) return '<p data-tg-pair-note>' + esc(ctx.note) + '</p>';
  const startBtn = (label) => '<button class="btn btn-p sm" data-act="telegram:pairStart"' + (ctx.busy ? ' disabled' : '') + '>' + esc(label) + '</button>';
  if (p.phase === 'waiting') {
    return '<div class="sd-paircode" data-tg-code aria-label="Pairing code">' + esc(p.code || '') + '</div>'
      + '<p>' + esc(p.instruction || ('Send /start ' + (p.code || '') + ' to your bot in Telegram.')) + '</p>'
      + err
      + '<div class="sd-acts"><span class="sd-cap">Waiting for your message…</span><span class="sd-grow"></span>'
      + '<button class="btn btn-g sm" data-act="telegram:pairCancel"' + (ctx.busy ? ' disabled' : '') + '>Cancel</button>'
      + '<button class="btn btn-s sm" data-act="telegram:pairStart"' + (ctx.busy ? ' disabled' : '') + '>New code</button></div>';
  }
  if (p.phase === 'paired') return '<p data-tg-paired>' + esc(p.pairedLine || 'Paired.') + '</p>';
  const lead = p.phase === 'expired' ? TG_PAIR_EXPIRED : ctx.howto;
  return '<p>' + esc(lead) + '</p>' + err
    + '<div class="sd-acts"><span class="sd-grow"></span>' + startBtn(ctx.label || 'Pair') + '</div>';
}

if (typeof module !== 'undefined') {
  module.exports = {TG_PAIR_POLL_MS, TG_PAIR_GRACE_MS, TG_PAIR_EXPIRED, TG_PAIR_NOT_RUNNING,
    tgPairInitial, tgPairApply, tgPairPolling, tgPairCardHTML};
}
