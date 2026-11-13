/* ---------------- Settings › Connections › Discord (ATO-516) ----------------
   Loaded BEFORE renderer.js, so it only declares. Shared by the renderer and
   the Node checks (test/discord-settings.test.mjs). No DOM and no IPC of its
   own: the renderer hands `createDiscordSettings` the calls it may make.

   The agent's Discord channel (src/channels/discord/discord-settings.ts)
   keeps its bot token in <stateDir>/.env as DISCORD_BOT_TOKEN and two keys in
   config.json: `discord.enabled` (off by default) and `discord.ownerUserIds`,
   the Discord accounts allowed to drive the agent (an empty list refuses
   every message). Discord has no pairing step in the agent, so the tab asks
   for the owner's user id directly. The agent reads all three when it starts,
   so every change here owes a restart, as on the Telegram tab. The token is
   never put into state, markup or a message. */

const DISCORD_TOKEN_ENV = 'DISCORD_BOT_TOKEN';
const DC_PORTAL_URL = 'https://discord.com/developers/applications';
/* config-schema.ts DISCORD_SNOWFLAKE_RE: a Discord user id is 15 to 25 digits. */
const DC_ID_RE = /^\d{15,25}$/;
const DC_RESTART_APPLY = 'Restart the agent to apply this. The app stays open.';
const DC_CONFIRM_MIN_MS = 400;

/* The token as typed, or why it cannot be saved. The same rule as main's
   discordTokenValueError (agent-cli.ts), which checks it again. */
function dcTokenClean(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return {ok:false, error:'Paste the token first.'};
  if (!/^[\x21-\x7e]{20,200}$/.test(t)) return {ok:false, error:'That does not look like a Discord bot token.'};
  return {ok:true, value:t};
}

/* A user id as typed (spaces and a leading @ or <@…> mention are forgiven), or why not. */
function dcIdClean(raw) {
  const t = String(raw == null ? '' : raw).trim().replace(/^<@!?(\d+)>$/, '$1').replace(/^@/, '');
  if (!t) return {ok:false, error:'Paste a Discord user id first.'};
  if (!DC_ID_RE.test(t)) return {ok:false, error:'A Discord user id is 15 to 25 digits. In Discord, turn on Developer Mode, then right-click your name and choose Copy User ID.'};
  return {ok:true, value:t};
}

/* The `discord` block as the agent reads it (channel-config.ts parseDiscordConfig):
   a v51 scalar `ownerUserId` counts as the first owner. Anything unreadable is the default. */
function dcReadBlock(v) {
  const b = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  let ids = [];
  if (Array.isArray(b.ownerUserIds)) ids = b.ownerUserIds.filter((x) => typeof x === 'string' && DC_ID_RE.test(x));
  else if (typeof b.ownerUserId === 'string' && DC_ID_RE.test(b.ownerUserId)) ids = [b.ownerUserId];
  return {enabled: b.enabled === true, ownerUserIds: Array.from(new Set(ids))};
}

function dcInitial() {
  return {
    known:false, hasToken:null, cfg:{enabled:false, ownerUserIds:[]}, busy:false, chain:null,
    mode:'list', tokenError:null, draftId:'', idError:null,
    message:null, msgKind:'info', msgGen:0, owedGen:null, lastError:null,
    confirm:null, confirmAt:0,
    restart:{phase:'idle', text:null},
  };
}

/* What the tab says about the bot, in one line, and whether it is set up. `owed`: a restart is owed. */
function dcStatus(st, owed) {
  if (st.hasToken !== true) return {on:false, line:'Add a bot token to start.'};
  if (!st.cfg.ownerUserIds.length) return {on:false, line:'Almost there: add your Discord user id below, so the bot knows who it answers.'};
  if (!st.cfg.enabled) return {on:false, line:'Turned off: the bot does not answer until you turn it on below.'};
  if (owed) return {on:false, line:'Waiting for a restart: the agent loads the token and these settings when it starts. Press Restart agent below; the app stays open.'};
  return {on:true, line:'Send your bot a direct message, or @mention it in a server channel, to talk to Atomic Agent.'};
}

/* What the restart left: `st` is the agent status BR.restart resolved with, or null. */
function dcRestartResult(res, view) {
  if (!res || res.state !== 'connected') {
    const why = res && typeof res.error === 'string' && res.error.trim() ? res.error.trim().replace(/\.$/, '') : 'no reason given';
    return {phase:'failed', text:'The agent did not start again: ' + why + '. Press Restart agent to try again.'};
  }
  const v = view || {};
  if (v.hasToken !== true) return {phase:'done', text:'The agent restarted.'};
  if (!v.ownerUserIds || !v.ownerUserIds.length) return {phase:'done', text:'The agent restarted. Add your Discord user id for the bot to answer you.'};
  if (v.enabled !== true) return {phase:'done', text:'The agent restarted. Turn on Answer in Discord for the bot to reply.'};
  return {phase:'done', text:'The agent restarted and the bot is connected. Message it in Discord.'};
}

/* `api`:
     readConfig()      → {ok, value?, error?}   the effective `discord` block
     tokenPresent()    → {ok, has, error?}       DISCORD_BOT_TOKEN in .env or the app's env (names only)
     setToken(v|null)  → {ok, error?}           writes or removes DISCORD_BOT_TOKEN in .env
     write(entries)    → {ok, error?}           [[dotted key, value], ...] in one config write
     restart()         → agent status {state, error?}
     restartBlocked()  → true while a reply runs (a restart would end it)
     agentGen()        → the running agent's generation, to retire "restart owed" lines
   Every method answers; a thrown call is read as {ok:false, error}. */
function createDiscordSettings(api) {
  const st = dcInitial();
  const call = (fn) => Promise.resolve().then(fn).catch((e) => ({ok:false, error:String((e && e.message) || e)}));
  const gen = () => { try { return api.agentGen(); } catch { return 0; } };
  const say = (text, kind) => {
    st.message = text; st.msgKind = kind || 'info'; st.msgGen = gen(); st.lastError = null;
    if (st.restart.phase !== 'restarting') st.restart = {phase:'idle', text:null};
    if (kind === 'owed') st.owedGen = gen();
  };
  const fail = (what, res) => { st.lastError = what + ': ' + ((res && res.error) || 'unknown error'); };

  async function refreshOnce() {
    const [cfg, tok] = await Promise.all([call(() => api.readConfig()), call(() => api.tokenPresent())]);
    if (cfg && cfg.ok) st.cfg = dcReadBlock(cfg.value);
    else st.lastError = 'Could not read the Discord settings: ' + ((cfg && cfg.error) || 'unknown error');
    if (tok && tok.ok) st.hasToken = tok.has === true;
    else if (st.hasToken === null) st.hasToken = false;
    st.known = true;
  }
  /* Serialized, like the Telegram tab's refresh: one asked for during another runs after it. */
  function refresh() {
    st.chain = (st.chain || Promise.resolve()).then(refreshOnce, refreshOnce);
    return st.chain;
  }
  async function writeOwners(ids, okText) {
    const entries = [['discord.ownerUserIds', ids]];
    // The setup is complete with a token and an owner: turn the bot on, as the Telegram tab does after its token.
    const turnOn = ids.length > 0 && st.hasToken === true && !st.cfg.enabled;
    if (turnOn) entries.push(['discord.enabled', true]);
    const res = await call(() => api.write(entries));
    if (!res || res.ok === false) { fail('Could not save the owners', res); return {ok:false}; }
    say(turnOn ? okText + ' Discord turned on.' : okText, 'owed');
    await refresh();
    return {ok:true};
  }

  return {
    state: st,
    refresh,
    restartOwed() { return st.owedGen !== null && st.owedGen === gen(); },
    entered() { st.confirm = null; st.idError = null; if (st.restart.phase !== 'restarting') st.restart = {phase:'idle', text:null}; return refresh(); },
    openToken() { st.mode = 'tokenPrompt'; st.tokenError = null; },
    cancelToken() { st.mode = 'list'; st.tokenError = null; },
    async saveToken(raw) {
      const c = dcTokenClean(raw);
      if (!c.ok) { st.tokenError = c.error; return {ok:false, error:c.error}; }
      if (st.busy) return {ok:false};
      st.busy = true;
      const res = await call(() => api.setToken(c.value));
      st.busy = false;
      if (!res || res.ok === false) { st.tokenError = 'Could not save the token: ' + ((res && res.error) || 'unknown error'); return {ok:false, error:st.tokenError}; }
      st.mode = 'list'; st.tokenError = null;
      say('Token saved.', 'owed');
      await refresh();
      if (st.cfg.ownerUserIds.length && !st.cfg.enabled) {
        const w = await call(() => api.write([['discord.enabled', true]]));
        if (!w || w.ok === false) fail('Could not turn Discord on', w);
        else say('Token saved and Discord turned on.', 'owed');
        await refresh();
      }
      return {ok:true};
    },
    async clearToken() {
      if (st.busy) return;
      st.busy = true;
      const res = await call(() => api.setToken(null));
      st.busy = false;
      if (!res || res.ok === false) fail('Could not remove the token', res);
      else say('Token removed.', 'owed');
      await refresh();
    },
    async setEnabled(on) {
      if (st.busy) return;
      st.busy = true;
      const res = await call(() => api.write([['discord.enabled', !!on]]));
      st.busy = false;
      if (!res || res.ok === false) fail('Could not turn Discord ' + (on ? 'on' : 'off'), res);
      else say(on ? 'Discord turned on.' : 'Discord turned off.', 'owed');
      await refresh();
    },
    setDraftId(v) { st.draftId = String(v == null ? '' : v); },
    async addOwner(raw) {
      const c = dcIdClean(raw === undefined ? st.draftId : raw);
      if (!c.ok) { st.idError = c.error; return {ok:false, error:c.error}; }
      if (st.busy) return {ok:false};
      if (st.cfg.ownerUserIds.includes(c.value)) { st.idError = 'That account is already on the list.'; return {ok:false, error:st.idError}; }
      st.busy = true; st.idError = null;
      const res = await writeOwners(st.cfg.ownerUserIds.concat([c.value]), 'Owner added.');
      st.busy = false;
      if (res.ok) st.draftId = '';
      return res;
    },
    async removeOwner(id) {
      if (st.busy || !st.cfg.ownerUserIds.includes(id)) return {ok:false};
      st.busy = true;
      const left = st.cfg.ownerUserIds.filter((x) => x !== id);
      const res = await writeOwners(left, left.length ? 'Owner removed.' : 'Owner removed. The bot ignores every message until you add one.');
      st.busy = false;
      return res;
    },
    /* A second click on the same button confirms (Remove token, Remove an owner); a double-click does not. */
    arm(verb, now) {
      const t = typeof now === 'number' ? now : Date.now();
      if (st.confirm === verb) {
        if (t - st.confirmAt < DC_CONFIRM_MIN_MS) return false;
        st.confirm = null; return true;
      }
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
      try { res = await api.restart(); } catch (e) { res = {state:'error', error:String((e && e.message) || e)}; }
      if (res && res.state === 'connected') await refresh();
      st.restart = dcRestartResult(res, {hasToken:st.hasToken, ownerUserIds:st.cfg.ownerUserIds, enabled:st.cfg.enabled});
    },
  };
}

/* The tab. `owed`: a restart is owed; `stale`: the last message was said to an earlier agent. `h`: {esc, ic}. */
function discordPaneHTML(st, view, h) {
  const {esc, ic} = h;
  const v = view || {};
  const busy = st.busy;
  const restartBtn = '<button class="btn btn-p sm" data-act="discord:restart"' + (st.restart.phase === 'restarting' ? ' disabled' : '') + '>'
    + (st.restart.phase === 'restarting' ? '<span class="tk-spin"></span>Restarting…' : ic('refresh') + 'Restart agent') + '</button>';
  let body = '';
  if (st.mode === 'tokenPrompt') {
    body += '<div class="tk-card pad sd-tgcard">'
      + '<h3 class="sd-title">Bot token</h3>'
      + '<p>Paste the token of your bot from the Discord Developer Portal (your application › Bot › Reset Token). It is saved on this computer, in a file only your user account can read.</p>'
      + '<label class="tk-inpwrap sd-tokwrap' + (st.tokenError ? ' is-error' : '') + '">' + ic('key')
      + '<input id="dc-token" type="password" autocomplete="off" spellcheck="false" aria-label="Discord bot token"' + (busy ? ' disabled' : '') + '></label>'
      + (st.tokenError ? '<p class="tk-help tk-help--err">' + esc(st.tokenError) + '</p>' : '')
      + '<div class="sd-acts">' + (busy ? '<span class="sd-cap">saving…</span>' : '') + '<span class="sd-grow"></span>'
      + '<button class="btn btn-g sm" data-act="discord:tokenCancel">Cancel</button>'
      + '<button class="btn btn-p sm" data-act="discord:tokenSave"' + (busy ? ' disabled' : '') + '>Save</button></div></div>';
  } else if (!st.known) {
    body += '<div class="tk-empty"><span class="tk-spin"></span><p>Loading…</p></div>';
  } else if (st.hasToken !== true) {
    body += '<div class="tk-card pad sd-tgcard sd-center" data-dc-connect>'
      + '<span class="tk-ico tk-ico--lg tk-ico--blue">' + ic('chat') + '</span>'
      + '<h3 class="sd-title">Connect Discord</h3>'
      + '<p>Create an application in the Discord Developer Portal, add a bot to it, copy the bot token and paste it here. Then invite the bot to your server, or message it directly. The token is stored only on this machine.</p>'
      + '<div class="sd-acts sd-center"><button class="btn btn-s sm" data-act="discord:portal">Open Developer Portal</button>'
      + '<button class="btn btn-p" data-act="discord:token">Paste a bot token</button></div></div>';
  } else {
    const s = dcStatus(st, v.owed);
    body += '<div class="tk-card sd-tgstatus"><div class="tk-setrow">'
      + '<span class="tk-ico tk-ico--blue">' + ic('chat') + '</span>'
      + '<div class="body"><div class="t">Discord</div><div class="d">' + esc(s.line) + '</div></div>'
      + '<span class="tk-chip tk-chip--sm ' + (s.on ? 'tk-chip--green' : 'tk-chip--amber') + '" data-dc-status="' + (s.on ? 'connected' : 'not-connected') + '">'
        + (s.on ? 'Connected' : 'Not connected') + '</span>'
      + '<button class="iconbtn sm" data-act="discord:refresh" title="Check again" aria-label="Check again">' + ic('refresh') + '</button>'
      + '</div></div>';
    const row = (title, d, tail) => '<div class="tk-setrow"><div class="body"><div class="t">' + title + '</div><div class="d">' + d + '</div></div>' + tail + '</div>';
    const owners = st.cfg.ownerUserIds.map((id) => '<div class="tk-setrow" data-dc-owner="' + esc(id) + '"><div class="body"><div class="t sd-mono">' + esc(id) + '</div></div>'
      + '<button class="btn btn-danger sm" data-act="discord:removeOwner:' + esc(id) + '"' + (busy ? ' disabled' : '') + '>'
      + (st.confirm === 'removeOwner:' + id ? 'Click again to remove' : 'Remove') + '</button></div>').join('');
    body += '<div class="sd-well" data-dc-owners><div class="sd-pairhead"><span class="tk-ico ' + (st.cfg.ownerUserIds.length ? 'tk-ico--blue' : 'tk-ico--amber') + '">' + ic('user') + '</span>'
      + '<b>' + (st.cfg.ownerUserIds.length ? 'Who the bot answers' : 'One last step: who the bot answers') + '</b></div>'
      + '<p class="sd-cap sd-block">Only these Discord accounts can talk to the bot and answer its approvals. Each one can drive the agent on this computer, so add only accounts you trust. To find an id, turn on Developer Mode in Discord (User Settings › Advanced), then right-click a name and choose Copy User ID.</p>'
      + owners
      + '<div class="sd-acts"><label class="tk-inpwrap sd-grow' + (st.idError ? ' is-error' : '') + '">' + ic('user')
      + '<input id="dc-owner" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="Discord user id" aria-label="Discord user id" value="' + esc(st.draftId) + '"' + (busy ? ' disabled' : '') + '></label>'
      + '<button class="btn btn-s sm" data-act="discord:addOwner"' + (busy ? ' disabled' : '') + '>Add</button></div>'
      + (st.idError ? '<p class="tk-help tk-help--err" data-dc-id-error>' + esc(st.idError) + '</p>' : '')
      + '</div>';
    body += '<div class="tk-card sd-rows">'
      + row('Answer in Discord', 'When this is off, the bot ignores every message.',
        '<button class="tk-switch" role="switch" aria-checked="' + (st.cfg.enabled === true) + '" aria-label="Answer in Discord" data-act="discord:enable"' + (busy ? ' disabled' : '') + '></button>')
      + row('Bot token', 'Saved on this computer.',
        '<button class="btn btn-s sm" data-act="discord:token">Change token</button>'
        + '<button class="btn btn-danger sm" data-act="discord:clearToken"' + (busy ? ' disabled' : '') + '>' + (st.confirm === 'clearToken' ? 'Click again to remove' : 'Remove token') + '</button>')
      + row('Restart the bot', 'Restarts the agent, and the bot with it. The app stays open.',
        '<button class="btn btn-s sm" data-act="discord:restart"' + (st.restart.phase === 'restarting' ? ' disabled' : '') + '>Restart</button>')
      + '</div>';
  }
  const note = (text, tail) => '<div class="tk-notice tk-notice--blue">' + ic('info') + '<span class="grow">' + text + '</span>' + (tail || '') + '</div>';
  const speaks = st.restart.phase === 'restarting' || st.restart.phase === 'failed';
  const msg = st.message && !(v.stale && st.msgKind === 'owed') ? st.message : null;
  let notices = st.lastError ? '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(st.lastError) + '</span></div>' : '';
  if (msg && st.msgKind === 'owed' && v.owed && !speaks) notices += note(esc(msg) + ' <span class="sec">' + esc(DC_RESTART_APPLY) + '</span>', restartBtn);
  else {
    if (msg && !(st.msgKind === 'owed' && speaks)) notices += note(esc(msg));
    if (v.owed && !speaks) notices += note(esc(DC_RESTART_APPLY), restartBtn);
  }
  if (st.restart.phase !== 'idle' && st.restart.text) {
    const tone = st.restart.phase === 'done' ? 'green' : st.restart.phase === 'failed' ? 'red' : 'blue';
    const icon = st.restart.phase === 'done' ? ic('check') : st.restart.phase === 'failed' ? ic('alert') : '<span class="tk-spin"></span>';
    notices += '<div class="tk-notice tk-notice--' + tone + '" data-dc-restart-result="' + st.restart.phase + '">' + icon
      + '<span class="grow">' + esc(st.restart.text) + '</span>' + (st.restart.phase === 'failed' ? restartBtn : '') + '</div>';
  }
  return '<div class="sd-pane sd-tg sd-dc">' + body + notices + '</div>';
}

if (typeof module !== 'undefined') {
  module.exports = {DISCORD_TOKEN_ENV, DC_PORTAL_URL, DC_RESTART_APPLY, dcTokenClean, dcIdClean, dcReadBlock, dcInitial, dcStatus,
    dcRestartResult, createDiscordSettings, discordPaneHTML};
}
