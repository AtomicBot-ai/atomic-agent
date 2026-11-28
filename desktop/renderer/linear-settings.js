/* ---------------- Settings › Connections › Linear (ATO-2464) ----------------
   Loaded BEFORE renderer.js, so it only declares. Shared by the renderer and
   the Node checks (test/linear-settings.test.mjs). No DOM and no IPC of its
   own: the renderer hands `createLinearSettings` the calls it may make.

   The agent's Linear channel (src/channels/linear) keeps its API key and the
   webhook signing secret in the key store (<stateDir>/.env or the keychain)
   as LINEAR_API_KEY and LINEAR_WEBHOOK_SECRET, and the rest in config.json
   under `channels.linear`: `enabled`, `ownerIds` (the Linear users it
   answers; an empty list answers no one) and `options` (`mode` poll or
   webhook, `mention`). The tab does what `atag connect linear` does: the key
   is checked with Linear first and its own user becomes the owner. The agent
   reads all of it when it starts, so each change owes a restart. No key,
   secret or server text is put into state, markup or a message. The pane's
   markup is renderer/linear-pane.js. */

const LINEAR_KEY_ENV = 'LINEAR_API_KEY';
const LINEAR_SECRET_ENV = 'LINEAR_WEBHOOK_SECRET';
const LN_KEYS_URL = 'https://linear.app/settings/account/security';
/* src/channels/linear/linear-setup.ts LINEAR_USER_ID_RE. */
const LN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/* main/linear-key-check.ts LINEAR_SECRET_RE, checked again there. */
const LN_KEY_RE = /^[\x21-\x7e]{20,512}$/;
const LN_CONFIRM_MIN_MS = 400;
const LN_SAVE_FAILED = 'Could not save that. Try again in a moment.';

/* A key or signing secret as typed, or why it cannot be saved. */
function lnSecretClean(raw, what) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return {ok:false, error:'Paste the ' + what + ' first.'};
  if (!LN_KEY_RE.test(t)) return {ok:false, error:'That does not look like a Linear ' + what + '.'};
  return {ok:true, value:t};
}

function lnIdClean(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return {ok:false, error:'Paste a Linear user id first.'};
  if (!LN_ID_RE.test(t)) return {ok:false, error:'A Linear user id looks like 2f1c0a4e-1b2c-4d5e-8f90-123456789abc. Run atag connect linear --help for how to find it.'};
  return {ok:true, value:t.toLowerCase()};
}

/* src/channels/linear/linear-types.ts readLinearMentions: handles, without @, comma separated. */
function lnMentionClean(raw) {
  const out = [];
  for (const part of String(raw == null ? '' : raw).split(',')) {
    const h = part.trim().replace(/^@/, '').toLowerCase();
    if (!h) continue;
    if (!/^[a-z0-9._-]{1,64}$/.test(h)) return {ok:false, error:'A handle is letters, digits, dots, dashes or underscores, like agent.'};
    if (!out.includes(h)) out.push(h);
  }
  return out.length ? {ok:true, value:out.join(',')} : {ok:false, error:'Type a handle, like agent.'};
}

/* The `channels.linear` block as the agent reads it. Anything unreadable is the default. */
function lnReadBlock(channels) {
  const c = channels && typeof channels === 'object' && !Array.isArray(channels) ? channels : {};
  const b = c.linear && typeof c.linear === 'object' && !Array.isArray(c.linear) ? c.linear : {};
  const options = b.options && typeof b.options === 'object' && !Array.isArray(b.options) ? Object.assign({}, b.options) : {};
  const ids = Array.isArray(b.ownerIds) ? b.ownerIds.filter((x) => typeof x === 'string' && LN_ID_RE.test(x)) : [];
  return {enabled: b.enabled === true, ownerIds: Array.from(new Set(ids)), options};
}
/* src/channels/linear/linear-types.ts resolveLinearMode: an explicit mode, else webhook when the secret is saved. */
function lnMode(cfg, hasSecret) { const m = cfg.options.mode; return m === 'webhook' || m === 'poll' ? m : (hasSecret ? 'webhook' : 'poll'); }
function lnMention(cfg) { return typeof cfg.options.mention === 'string' && cfg.options.mention ? cfg.options.mention : 'agent'; }

function lnInitial() {
  return {
    known:false, loadFailed:false, hasKey:null, hasSecret:false, cfg:{enabled:false, ownerIds:[], options:{}}, busy:false, chain:null,
    mode:'list', keyError:null, secretError:null, pendingWebhook:false, draftId:'', idError:null, draftMention:null, mentionError:null,
    viewerName:null, message:null, msgKind:'info', msgGen:0, owedGen:null, lastError:null, confirm:null, confirmAt:0,
    restart:{phase:'idle', text:null},
  };
}

/* One line about the channel, and whether it is set up. `owed`: a restart is owed. */
function lnStatus(st, owed) {
  const off = (line) => ({on:false, line});
  if (st.hasKey !== true) return off('Add a Linear API key to start.');
  if (!st.cfg.ownerIds.length) return off('Almost there: add the Linear user the agent answers.');
  const mode = lnMode(st.cfg, st.hasSecret);
  if (mode === 'webhook' && !st.hasSecret) return off('Webhook mode needs the signing secret. Add it below, or switch to polling.');
  if (!st.cfg.enabled) return off('Turned off: the agent does not answer in Linear until you turn it on below.');
  if (owed) return off('Waiting for a restart: the agent loads the key and these settings when it starts. Press Restart agent below.');
  const ask = 'In a Linear issue, comment @' + lnMention(st.cfg).split(',')[0] + ' and what you need.';
  return {on:true, line:(mode === 'poll' ? 'Checks Linear every minute. ' : 'Answers when Linear calls the webhook; keep the tunnel running. ') + ask};
}

function lnRestartResult(res, st) {
  if (!res || res.state !== 'connected') return {phase:'failed', text:'The agent did not start again. Press Restart agent to try again, or open Diagnostics.'};
  return {phase:'done', text:'The agent restarted. ' + lnStatus(st, false).line};
}

/* `api`:
     readConfig()          → {ok, value?}         the effective `channels` block
     secretsPresent()      → {ok, names?}         which of LINEAR_API_KEY / LINEAR_WEBHOOK_SECRET are saved (names only)
     setSecret(name, v|null) → {ok}               writes or removes one of them
     checkKey(v)           → {ok, viewer?:{id,name}, reason?}  main/linear-key-check.ts
     write(block)          → {ok}                 the whole `channels.linear` block in one config write
     restart() / restartBlocked() / agentGen()    as on the Discord tab
   Every method answers; a thrown call is read as {ok:false}. */
function createLinearSettings(api) {
  const st = lnInitial();
  const call = (fn) => Promise.resolve().then(fn).catch(() => ({ok:false}));
  const gen = () => { try { return api.agentGen(); } catch { return 0; } };
  const say = (text, kind) => {
    st.message = text; st.msgKind = kind || 'info'; st.msgGen = gen(); st.lastError = null;
    if (st.restart.phase !== 'restarting') st.restart = {phase:'idle', text:null};
    if (kind === 'owed') st.owedGen = gen();
  };
  const ok = (res) => !!res && res.ok !== false;

  async function refreshOnce() {
    const [cfg, sec] = await Promise.all([call(() => api.readConfig()), call(() => api.secretsPresent())]);
    if (ok(cfg)) { st.cfg = lnReadBlock(cfg.value); st.loadFailed = false; }
    else { st.loadFailed = true; st.lastError = 'Could not read the Linear settings. Press Check again.'; }
    if (ok(sec) && Array.isArray(sec.names)) { st.hasKey = sec.names.includes(LINEAR_KEY_ENV); st.hasSecret = sec.names.includes(LINEAR_SECRET_ENV); }
    else if (st.hasKey === null) st.hasKey = false;
    st.known = true;
  }
  function refresh() { st.chain = (st.chain || Promise.resolve()).then(refreshOnce, refreshOnce); return st.chain; }
  /* The block with `patch` laid over it: {enabled?, ownerIds?, options?}. Other options are kept. */
  async function writeBlock(patch, okText) {
    const block = {enabled: patch.enabled !== undefined ? patch.enabled : st.cfg.enabled, ownerIds: patch.ownerIds || st.cfg.ownerIds,
      options: Object.assign({}, st.cfg.options, patch.options || {})};
    const res = await call(() => api.write(block));
    if (!ok(res)) { st.lastError = LN_SAVE_FAILED; return false; }
    say(okText, 'owed');
    await refresh();
    return true;
  }
  async function guarded(fn) { if (st.busy) return {ok:false}; st.busy = true; try { return await fn(); } finally { st.busy = false; } }

  return {
    state: st,
    refresh,
    restartOwed() { return st.owedGen !== null && st.owedGen === gen(); },
    entered() { st.confirm = null; st.idError = null; st.mentionError = null; if (st.restart.phase !== 'restarting') st.restart = {phase:'idle', text:null}; return refresh(); },
    openKey() { st.mode = 'keyPrompt'; st.keyError = null; },
    openSecret() { st.mode = 'secretPrompt'; st.secretError = null; },
    cancelPrompt() { st.mode = 'list'; st.keyError = null; st.secretError = null; st.pendingWebhook = false; },
    /* Checked with Linear first; a refused or unchecked key is not saved. The key's user becomes the owner when there is none. */
    saveKey(raw) {
      const c = lnSecretClean(raw, 'API key');
      if (!c.ok) { st.keyError = c.error; return Promise.resolve({ok:false}); }
      return guarded(async () => {
        const chk = await call(() => api.checkKey(c.value));
        if (!ok(chk) || !chk.viewer) {
          st.keyError = chk && chk.reason === 'rejected' ? 'Linear did not accept this key. Check it and paste it again.'
            : chk && chk.reason === 'invalid' ? 'That does not look like a Linear API key.'
            : 'Could not reach Linear to check the key. Check the connection and try again.';
          return {ok:false};
        }
        if (!ok(await call(() => api.setSecret(LINEAR_KEY_ENV, c.value)))) { st.keyError = LN_SAVE_FAILED; return {ok:false}; }
        st.mode = 'list'; st.keyError = null; st.viewerName = chk.viewer.name || null;
        const owners = st.cfg.ownerIds.length ? st.cfg.ownerIds : [String(chk.viewer.id).toLowerCase()];
        const options = st.cfg.options.mode ? {} : {mode: 'poll'};
        const who = st.viewerName ? 'Connected as ' + st.viewerName + '.' : 'Key saved.';
        await writeBlock({enabled: true, ownerIds: owners, options}, who + ' Linear turned on.');
        return {ok:true};
      });
    },
    clearKey() { return guarded(async () => {
      if (!ok(await call(() => api.setSecret(LINEAR_KEY_ENV, null)))) st.lastError = LN_SAVE_FAILED; else say('Key removed.', 'owed');
      await refresh();
    }); },
    saveSecret(raw) {
      const c = lnSecretClean(raw, 'webhook signing secret');
      if (!c.ok) { st.secretError = c.error; return Promise.resolve({ok:false}); }
      return guarded(async () => {
        if (!ok(await call(() => api.setSecret(LINEAR_SECRET_ENV, c.value)))) { st.secretError = LN_SAVE_FAILED; return {ok:false}; }
        st.mode = 'list'; st.secretError = null;
        const toWebhook = st.pendingWebhook; st.pendingWebhook = false;
        if (toWebhook) await writeBlock({options: {mode: 'webhook'}}, 'Signing secret saved. Linear now reaches the agent through the webhook.');
        else { say('Signing secret saved.', 'owed'); await refresh(); }
        return {ok:true};
      });
    },
    clearSecret() { return guarded(async () => {
      if (!ok(await call(() => api.setSecret(LINEAR_SECRET_ENV, null)))) { st.lastError = LN_SAVE_FAILED; return; }
      if (lnMode(st.cfg, true) === 'webhook') await writeBlock({options: {mode: 'poll'}}, 'Signing secret removed. Switched to polling.');
      else { say('Signing secret removed.', 'owed'); await refresh(); }
    }); },
    /* Webhook without a saved secret asks for it first and switches once it is saved. */
    setMode(m) {
      if (m === 'webhook' && !st.hasSecret) { st.pendingWebhook = true; st.mode = 'secretPrompt'; st.secretError = null; return Promise.resolve(); }
      return guarded(() => writeBlock({options: {mode: m === 'webhook' ? 'webhook' : 'poll'}}, m === 'webhook' ? 'Switched to the webhook.' : 'Switched to polling.'));
    },
    setEnabled(on) { return guarded(() => writeBlock({enabled: !!on}, on ? 'Linear turned on.' : 'Linear turned off.')); },
    setDraftId(v) { st.draftId = String(v == null ? '' : v); },
    setDraftMention(v) { st.draftMention = String(v == null ? '' : v); },
    addOwner(raw) {
      const c = lnIdClean(raw === undefined ? st.draftId : raw);
      if (!c.ok) { st.idError = c.error; return Promise.resolve({ok:false}); }
      if (st.cfg.ownerIds.includes(c.value)) { st.idError = 'That user is already on the list.'; return Promise.resolve({ok:false}); }
      st.idError = null;
      return guarded(async () => { const done = await writeBlock({ownerIds: st.cfg.ownerIds.concat([c.value])}, 'Owner added.'); if (done) st.draftId = ''; return {ok:done}; });
    },
    removeOwner(id) {
      if (!st.cfg.ownerIds.includes(id)) return Promise.resolve({ok:false});
      const left = st.cfg.ownerIds.filter((x) => x !== id);
      return guarded(async () => ({ok: await writeBlock({ownerIds: left}, left.length ? 'Owner removed.' : 'Owner removed. The agent answers no one until you add one.')}));
    },
    saveMention() {
      const c = lnMentionClean(st.draftMention === null ? lnMention(st.cfg) : st.draftMention);
      if (!c.ok) { st.mentionError = c.error; return Promise.resolve({ok:false}); }
      st.mentionError = null;
      return guarded(async () => { const done = await writeBlock({options: {mention: c.value}}, 'Handle saved.'); if (done) st.draftMention = null; return {ok:done}; });
    },
    arm(verb, now) {
      const t = typeof now === 'number' ? now : Date.now();
      if (st.confirm === verb) { if (t - st.confirmAt < LN_CONFIRM_MIN_MS) return false; st.confirm = null; return true; }
      st.confirm = verb; st.confirmAt = t; return false;
    },
    disarm() { st.confirm = null; },
    async restart() {
      if (st.restart.phase === 'restarting') return;
      let blocked = false;
      try { blocked = !!api.restartBlocked(); } catch { blocked = false; }
      if (blocked) { st.restart = {phase:'failed', text:'A reply is still running. Restart the agent when it finishes.'}; return; }
      st.restart = {phase:'restarting', text:'Restarting the agent… The app stays open.'};
      let res = null;
      try { res = await api.restart(); } catch { res = null; }
      if (res && res.state === 'connected') await refresh();
      st.restart = lnRestartResult(res, st);
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = {LINEAR_KEY_ENV, LINEAR_SECRET_ENV, LN_KEYS_URL, LN_SAVE_FAILED,
    lnSecretClean, lnIdClean, lnMentionClean, lnReadBlock, lnMode, lnMention, lnInitial, lnStatus, lnRestartResult, createLinearSettings};
}
