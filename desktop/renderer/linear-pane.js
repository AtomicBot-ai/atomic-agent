/* ---------------- Settings › Connections › Linear: the pane (ATO-2464) ----------------
   Markup only, for the state renderer/linear-settings.js keeps. Loaded
   before renderer.js. `view` comes from the renderer: {status: lnStatus(…),
   mode: lnMode(…), mention: lnMention(…), owed, stale}. `h`: {esc, ic, logo?}.
   Same parts and classes as the Discord pane (discord-settings.js). */

const LNP_TUNNEL_CMD = 'cloudflared tunnel --url http://127.0.0.1:3979';
const LNP_WEBHOOK_PATH = '/linear/webhook';
const LNP_RESTART_APPLY = 'Restart the agent to apply this. The app stays open.';

function lnpSecretPrompt(st, h, which) {
  const {esc, ic} = h;
  const key = which === 'key';
  const err = key ? st.keyError : st.secretError;
  const busy = st.busy;
  const intro = key
    ? '<p>In Linear, open Settings › Account › Security & access › Personal API keys, create a key and paste it here. The agent checks it with Linear first, then saves it on this computer only. Tip: a separate Linear member for the agent keeps its comments apart from yours.</p>'
    : '<p>In Linear, open Settings › API › Webhooks › New webhook. URL: your tunnel address plus <span class="sd-mono">' + LNP_WEBHOOK_PATH + '</span>, resource types Comments and Issues. Then paste its signing secret here. Start the tunnel with <span class="sd-mono">' + esc(LNP_TUNNEL_CMD) + '</span>.</p>';
  return '<div class="tk-card pad sd-tgcard" data-ln-prompt="' + which + '">'
    + '<h3 class="sd-title">' + (key ? 'Linear API key' : 'Webhook signing secret') + '</h3>' + intro
    + '<label class="tk-inpwrap sd-tokwrap' + (err ? ' is-error' : '') + '">' + ic('key')
    + '<input id="' + (key ? 'ln-key' : 'ln-secret') + '" type="password" autocomplete="off" spellcheck="false" aria-label="' + (key ? 'Linear API key' : 'Linear webhook signing secret') + '"' + (busy ? ' disabled' : '') + '></label>'
    + (err ? '<p class="tk-help tk-help--err" data-ln-error>' + esc(err) + '</p>' : '')
    + '<div class="sd-acts">' + (busy ? '<span class="sd-cap"><span class="tk-spin"></span>' + (key ? 'checking with Linear…' : 'saving…') + '</span>' : '') + '<span class="sd-grow"></span>'
    + (key ? '<button class="btn btn-g sm" data-act="linear:keysPage">Open Linear settings</button>' : '')
    + '<button class="btn btn-g sm" data-act="linear:cancel">Cancel</button>'
    + '<button class="btn btn-p sm" data-act="' + (key ? 'linear:keySave' : 'linear:secretSave') + '"' + (busy ? ' disabled' : '') + '>Save</button></div></div>';
}

function linearPaneHTML(st, view, h) {
  const {esc, ic} = h;
  const mark = (size, cls) => (typeof h.logo === 'function' && h.logo('linear', size, 'link')) || '<span class="tk-ico ' + cls + '">' + ic('link') + '</span>';
  const v = view || {};
  const busy = st.busy;
  const dis = busy ? ' disabled' : '';
  const restartBtn = '<button class="btn btn-p sm" data-act="linear:restart"' + (st.restart.phase === 'restarting' ? ' disabled' : '') + '>'
    + (st.restart.phase === 'restarting' ? '<span class="tk-spin"></span>Restarting…' : ic('refresh') + 'Restart agent') + '</button>';
  let body = '';
  if (st.mode === 'keyPrompt') body += lnpSecretPrompt(st, h, 'key');
  else if (st.mode === 'secretPrompt') body += lnpSecretPrompt(st, h, 'secret');
  else if (!st.known) body += '<div class="tk-empty" data-ln-loading><span class="tk-spin"></span><p>Loading…</p></div>';
  else if (st.loadFailed && st.hasKey !== true) {
    body += '<div class="tk-empty" data-ln-load-failed>' + ic('alert') + '<p>Could not read the Linear settings.</p>'
      + '<button class="btn btn-s sm" data-act="linear:refresh">Check again</button></div>';
  } else if (st.hasKey !== true) {
    body += '<div class="tk-card pad sd-tgcard sd-center" data-ln-connect>' + mark('lg', 'tk-ico--lg tk-ico--blue')
      + '<h3 class="sd-title">Connect Linear</h3>'
      + '<p>Mention the agent in a Linear issue comment and it answers in the thread. By default it checks Linear every minute, so no public address or tunnel is needed. Keys stay on this machine.</p>'
      + '<div class="sd-acts sd-center"><button class="btn btn-s sm" data-act="linear:keysPage">Open Linear settings</button>'
      + '<button class="btn btn-p" data-act="linear:key">Paste an API key</button></div>'
      + '<p class="sd-cap sd-block">To install the agent as a Linear app (delegate issues to it, live progress), run <span class="sd-mono">atag connect linear --app</span> in a terminal.</p></div>';
  } else {
    const s = v.status || {on:false, line:''};
    body += '<div class="tk-card sd-tgstatus"><div class="tk-setrow">' + mark('', 'tk-ico--blue')
      + '<div class="body"><div class="t">Linear</div><div class="d">' + esc(s.line) + '</div></div>'
      + '<span class="tk-chip tk-chip--sm ' + (s.on ? 'tk-chip--green' : 'tk-chip--amber') + '" data-ln-status="' + (s.on ? 'on' : 'off') + '">' + (s.on ? 'Set up' : 'Not set up') + '</span>'
      + '<button class="iconbtn sm" data-act="linear:refresh" title="Check again" aria-label="Check again">' + ic('refresh') + '</button></div></div>';
    const row = (title, d, tail) => '<div class="tk-setrow"><div class="body"><div class="t">' + title + '</div><div class="d">' + d + '</div></div>' + tail + '</div>';
    const owners = st.cfg.ownerIds.map((id) => '<div class="tk-setrow" data-ln-owner="' + esc(id) + '"><div class="body"><div class="t sd-mono">' + esc(id) + '</div></div>'
      + '<button class="btn btn-danger sm" data-act="linear:removeOwner:' + esc(id) + '"' + dis + '>' + (st.confirm === 'removeOwner:' + id ? 'Click again to remove' : 'Remove') + '</button></div>').join('');
    body += '<div class="sd-well" data-ln-owners><div class="sd-pairhead"><span class="tk-ico ' + (st.cfg.ownerIds.length ? 'tk-ico--blue' : 'tk-ico--amber') + '">' + ic('user') + '</span>'
      + '<b>' + (st.cfg.ownerIds.length ? 'Who the agent answers' : 'One last step: who the agent answers') + '</b></div>'
      + '<p class="sd-cap sd-block">Only these Linear users can drive the agent from Linear and answer its approvals. Saving a key adds the key\'s own user.</p>'
      + (owners || '<p class="sd-cap sd-block" data-ln-owners-empty>No one yet: the agent ignores every comment.</p>')
      + '<div class="sd-acts"><label class="tk-inpwrap sd-grow' + (st.idError ? ' is-error' : '') + '">' + ic('user')
      + '<input id="ln-owner" type="text" autocomplete="off" spellcheck="false" placeholder="Linear user id" aria-label="Linear user id" value="' + esc(st.draftId) + '"' + dis + '></label>'
      + '<button class="btn btn-s sm" data-act="linear:addOwner"' + dis + '>Add</button></div>'
      + (st.idError ? '<p class="tk-help tk-help--err" data-ln-id-error>' + esc(st.idError) + '</p>' : '') + '</div>';
    const poll = v.mode !== 'webhook';
    const seg = '<span class="tk-seg" role="tablist" aria-label="How Linear reaches the agent">'
      + '<button class="' + (poll ? 'on' : '') + '" role="tab" aria-selected="' + poll + '" data-act="linear:mode:poll"' + dis + '>Polling</button>'
      + '<button class="' + (poll ? '' : 'on') + '" role="tab" aria-selected="' + !poll + '" data-act="linear:mode:webhook"' + dis + '>Webhook</button></span>';
    const mention = st.draftMention === null ? (v.mention || 'agent') : st.draftMention;
    body += '<div class="tk-card sd-rows">'
      + row('Answer in Linear', 'When this is off, the agent ignores every comment.',
        '<button class="tk-switch" role="switch" aria-checked="' + (st.cfg.enabled === true) + '" aria-label="Answer in Linear" data-act="linear:enable"' + dis + '></button>')
      + row('How Linear reaches the agent', poll ? 'Checks Linear every minute. No public address needed.' : 'Linear calls the agent at once. Needs a tunnel: <span class="sd-mono">' + esc(LNP_TUNNEL_CMD) + '</span>', seg)
      + row('Mention handle', 'Comments that mention @' + esc(mention.split(',')[0] || 'agent') + ' go to the agent.',
        '<label class="tk-inpwrap' + (st.mentionError ? ' is-error' : '') + '"><input id="ln-mention" type="text" autocomplete="off" spellcheck="false" aria-label="Mention handle" value="' + esc(mention) + '"' + dis + '></label>'
        + '<button class="btn btn-s sm" data-act="linear:mentionSave"' + dis + '>Save</button>')
      + (st.mentionError ? '<p class="tk-help tk-help--err" data-ln-mention-error>' + esc(st.mentionError) + '</p>' : '')
      + row('API key', 'Saved on this computer.', '<button class="btn btn-s sm" data-act="linear:key">Change key</button>'
        + '<button class="btn btn-danger sm" data-act="linear:clearKey"' + dis + '>' + (st.confirm === 'clearKey' ? 'Click again to remove' : 'Remove key') + '</button>')
      + (st.hasSecret || !poll ? row('Webhook signing secret', st.hasSecret ? 'Saved on this computer.' : 'Not saved yet.',
        '<button class="btn btn-s sm" data-act="linear:secret">' + (st.hasSecret ? 'Change secret' : 'Add secret') + '</button>'
        + (st.hasSecret ? '<button class="btn btn-danger sm" data-act="linear:clearSecret"' + dis + '>' + (st.confirm === 'clearSecret' ? 'Click again to remove' : 'Remove') + '</button>' : '')) : '')
      + row('Restart the channel', 'Restarts the agent, and the Linear channel with it. The app stays open.',
        '<button class="btn btn-s sm" data-act="linear:restart"' + (st.restart.phase === 'restarting' ? ' disabled' : '') + '>Restart</button>')
      + '</div>';
  }
  const note = (text, tail) => '<div class="tk-notice tk-notice--blue">' + ic('info') + '<span class="grow">' + text + '</span>' + (tail || '') + '</div>';
  const speaks = st.restart.phase === 'restarting' || st.restart.phase === 'failed';
  const msg = st.message && !(v.stale && st.msgKind === 'owed') ? st.message : null;
  let notices = st.lastError ? '<div class="tk-notice tk-notice--red" data-ln-last-error>' + ic('alert') + '<span class="grow">' + esc(st.lastError) + '</span></div>' : '';
  if (msg && st.msgKind === 'owed' && v.owed && !speaks) notices += note(esc(msg) + ' <span class="sec">' + esc(LNP_RESTART_APPLY) + '</span>', restartBtn);
  else {
    if (msg && !(st.msgKind === 'owed' && speaks)) notices += note(esc(msg));
    if (v.owed && !speaks) notices += note(esc(LNP_RESTART_APPLY), restartBtn);
  }
  if (st.restart.phase !== 'idle' && st.restart.text) {
    const tone = st.restart.phase === 'done' ? 'green' : st.restart.phase === 'failed' ? 'red' : 'blue';
    const icon = st.restart.phase === 'done' ? ic('check') : st.restart.phase === 'failed' ? ic('alert') : '<span class="tk-spin"></span>';
    notices += '<div class="tk-notice tk-notice--' + tone + '" data-ln-restart-result="' + st.restart.phase + '">' + icon
      + '<span class="grow">' + esc(st.restart.text) + '</span>' + (st.restart.phase === 'failed' ? restartBtn : '') + '</div>';
  }
  return '<div class="sd-pane sd-tg sd-ln">' + body + notices + '</div>';
}

if (typeof module !== 'undefined') module.exports = {LNP_TUNNEL_CMD, LNP_WEBHOOK_PATH, LNP_RESTART_APPLY, linearPaneHTML};
