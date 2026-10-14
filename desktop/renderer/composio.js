/* ---------------- Settings › Connections › Composio ----------------
   Loaded BEFORE renderer.js, so it only declares. Shared by the renderer
   and the Node checks (test/composio.test.mjs): what the pane reads from
   the agent, the status it shows, and its markup. No IPC and no storage
   here, and the key never passes through: the field is emitted empty, and
   renderer.js puts a half-typed draft back from memory after a repaint.

   Composio connects the agent to 1,500+ hosted apps and brokers each app's
   sign-in. The agent mounts it as an MCP server named `composio` when it
   starts with COMPOSIO_API_KEY in its environment (src/composio/), so the
   pane is the TUI Integrations tab's Composio row: save or remove the key,
   turn `composio.enabled` on or off, and restart the agent so it takes the
   change. Apps are connected in the chat: the agent's
   COMPOSIO_MANAGE_CONNECTIONS tool answers with a sign-in link. */

const COMPOSIO_KEY_ENV = 'COMPOSIO_API_KEY';
/* The TUI's docsUrl and setup steps: "Sign up at composio.dev and copy an API key from the dashboard." */
const COMPOSIO_SIGNUP_URL = 'https://composio.dev';
/* src/prompt/composio-guidance.ts COMPOSIO_SEARCH_TOOL: offered only while a Composio session is mounted. */
const COMPOSIO_SEARCH_TOOL = 'mcp.composio.COMPOSIO_SEARCH_TOOLS';

/* A key as pasted: '' when nothing was, null when it cannot be a key
   (spaces, quotes or line breaks inside, too short or too long), else the
   key. The same rule main applies before it writes (main/composio-key.ts
   composioKeyValueError): letters, digits and `_ - . : + / =`, 8 to 512. */
function composioKeyClean(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return '';
  return /^[A-Za-z0-9_.:+\/=-]{8,512}$/.test(v) ? v : null;
}

/* Is Composio mounted in the running agent? From GET /api/capabilities'
   offered tools: true when its search tool is there, false when the list
   came back without it, null when there is no list to read. */
function composioToolsUp(caps) {
  if (!caps || !Array.isArray(caps.tools)) return null;
  return caps.tools.some((t) => t && t.name === COMPOSIO_SEARCH_TOOL);
}

/* What the pane says, from what the window knows. `st`:
   {hasKey: true|false|null, enabled: true|false|null, toolsUp: true|false|null,
    restartOwed, checkError}. Levels: loading, none, restart, off, connected,
   error, unknown. */
function composioStatus(st) {
  if (st.hasKey === null) return {level:'loading', chip:'', line:''};
  if (st.restartOwed) {
    return {level:'restart', chip:'Restart needed', line: st.hasKey === false
      ? 'The key is removed. The agent stops using Composio after a restart.'
      : st.enabled === false
        ? 'Turned off. The agent stops using Composio after a restart.'
        : 'Waiting for a restart: the agent loads the key and this setting when it starts.'};
  }
  // The TUI's "no key: Composio tools are not loaded".
  if (st.hasKey === false) return {level:'none', chip:'Not connected', line:'No key: Composio tools are not loaded.'};
  if (st.enabled === false) return {level:'off', chip:'Off', line:'Turned off: the agent does not load Composio until you turn it on below.'};
  // A failed Check again outranks what the running agent shows: Composio just refused or could not take the key.
  if (st.checkError) return {level:'error', chip:'Not connected', line: st.checkError};
  if (st.toolsUp === true) {
    return {level:'connected', chip:'Connected',
      line:'Ask the agent to use an app, for example "connect my Gmail". The first time, it replies with a sign-in link.'};
  }
  if (st.toolsUp === false) {
    // The TUI's "key saved, but the connection failed", with what to do here.
    return {level:'error', chip:'Not connected', line:'Key saved, but the connection failed when the agent started. Check the key, then restart the agent.'};
  }
  return {level:'unknown', chip:'Key saved', line:'The status shows once the agent is running.'};
}

const COMPOSIO_CHIP_CLASS = {connected:'tk-chip--green', error:'tk-chip--red', none:'tk-chip--amber', restart:'tk-chip--amber', off:'tk-chip--line', unknown:'tk-chip--line'};

/* The key field with its Save. `place` is 'setup' (the first card) or
   'replace' (Replace key on the rows); the input is always emitted empty. */
function composioKeyFieldHTML(st, h, place) {
  const busy = !!st.busy;
  return '<label class="tk-inpwrap sd-tokwrap' + (st.keyError ? ' is-error' : '') + '">' + h.ic('key')
    + '<input id="cmp-key" type="password" data-cmp-key="' + place + '" autocomplete="off" spellcheck="false"'
    + ' placeholder="Paste your Composio API key" aria-label="Composio API key"' + (busy ? ' disabled' : '') + '></label>'
    + (st.keyError ? '<p class="tk-help tk-help--err">' + h.esc(st.keyError) + '</p>' : '')
    + '<div class="sd-acts">'
      + '<button class="btn btn-s sm" data-url="' + h.esc(COMPOSIO_SIGNUP_URL) + '" title="Opens composio.dev in your browser">' + h.ic('globe') + 'Get an API key</button>'
      + '<span class="sd-grow"></span>'
      + (st.busy === 'save' ? '<span class="sd-cap"><span class="tk-spin"></span>Checking the key with Composio…</span>' : '')
      + (place === 'replace' ? '<button class="btn btn-g sm" data-act="composio:keyCancel"' + (busy ? ' disabled' : '') + '>Cancel</button>' : '')
      + '<button class="btn btn-p sm" data-act="composio:keySave" title="Enter"' + (busy ? ' disabled' : '') + '>Save</button>'
    + '</div>';
}

/* The TUI hub's setup walkthrough (src/integrations/composio-integration.ts
   setupSteps, commit 42f4e57f), with "press e on API key" and "the tools
   mount straight away" told the desktop's way: paste below, then restart. */
const COMPOSIO_SETUP_STEPS = [
  'Sign up at composio.dev and copy an API key from the dashboard.',
  'Paste it below and press Save, then restart the agent when the pane asks.',
  'Ask the agent to do something in an app ("email this to …"); it searches Composio for the tool.',
  'First use of an app returns a sign-in link in the chat. Open it to connect that account.',
];

/* No key yet: one card, one action (the Telegram tab's Connect card). */
function composioSetupHTML(st, h) {
  return '<div class="tk-card pad sd-tgcard sd-cmpcard">'
    + '<div class="sd-pairhead"><span class="tk-ico tk-ico--blue">' + h.ic('link') + '</span><h3 class="sd-title">Connect apps with Composio</h3></div>'
    // The TUI's summary ("~1500 SaaS toolkits … with OAuth handled for you"), plus where the calls go.
    + '<p>Composio connects Atomic Agent to 1,500+ apps like Gmail, Slack, Notion, Linear and GitHub, and handles each app\'s sign-in for you. '
    + 'Requests to those apps go through Composio\'s servers.</p>'
    + '<ol class="sd-steps">' + COMPOSIO_SETUP_STEPS.map((t) => '<li>' + h.esc(t) + '</li>').join('') + '</ol>'
    + composioKeyFieldHTML(st, h, 'setup')
    // The TUI field's help line, and where the key is kept.
    + '<p class="sd-cap sd-block">Free tier: 100K tool calls/month. The key is saved on this computer, in a file only your user account can read.</p>'
    + '</div>';
}

function composioStatusHTML(status, st, h) {
  const checking = st.busy === 'check';
  return '<div class="tk-card sd-tgstatus"><div class="tk-setrow">'
    + '<span class="tk-ico tk-ico--blue">' + h.ic('link') + '</span>'
    + '<div class="body"><div class="t">Composio</div><div class="d">' + h.esc(status.line) + '</div></div>'
    + '<span class="tk-chip tk-chip--sm ' + (COMPOSIO_CHIP_CLASS[status.level] || 'tk-chip--line') + '" data-cmp-status="' + status.level + '">' + h.esc(status.chip) + '</span>'
    + '<button class="iconbtn sm" data-act="composio:check" title="Check the key with Composio (R)" aria-label="Check the key"' + (st.busy ? ' disabled' : '') + '>'
      + (checking ? '<span class="tk-spin"></span>' : h.ic('refresh')) + '</button>'
    + '</div></div>';
}

function composioRowsHTML(st, h) {
  const busy = !!st.busy;
  const row = (title, d, tail) => '<div class="tk-setrow"><div class="body"><div class="t">' + title + '</div><div class="d">' + d + '</div></div>' + tail + '</div>';
  return '<div class="tk-card sd-rows">'
    + row('Use Composio', 'When this is off, the agent does not load Composio, even with a key saved.',
      '<button class="tk-switch' + (st.enabled === true ? ' on' : '') + '" role="switch" aria-checked="' + (st.enabled === true) + '" aria-label="Use Composio" title="Turn ' + (st.enabled === true ? 'off' : 'on') + ' (e)" data-act="composio:enable"'
        + (busy || st.enabled === null ? ' disabled' : '') + '></button>')
    + row('API key', st.shadowed
        ? 'This app was started with ' + COMPOSIO_KEY_ENV + ' set in its environment, and the agent uses that key, not the one saved here.'
        : 'Saved on this computer.',
      '<button class="btn btn-s sm" data-act="composio:key" title="Replace key (t)"' + (busy ? ' disabled' : '') + '>Replace key</button>'
      + '<button class="btn btn-danger sm" data-act="composio:removeKey" title="Remove key (T)"' + (busy ? ' disabled' : '') + '>Remove key</button>')
    // src/prompt/composio-guidance.ts: the agent puts the sign-in link in a reply, waits for a confirmation, then retries; connections persist.
    + row('Connect an app', 'Ask the agent to do something in an app, for example "connect my Gmail". The first time, it replies with a sign-in link: open it, sign in, then tell the agent you are done. Each app is connected once.', '')
    + '</div>';
}

/* What the last action left: an error, its message, and the restart a change is still owed. */
function composioNoticesHTML(st, h) {
  const restartBtn = st.running
    ? '<span class="sd-cap">Restart when the running reply is done.</span>'
    : '<button class="btn btn-t sm" data-act="agent:restart">' + h.ic('refresh') + 'Restart Agent Runtime</button>';
  const note = (text, tail) => '<div class="tk-notice tk-notice--blue">' + h.ic('info') + '<span class="grow">' + text + '</span>' + (tail || '') + '</div>';
  return (st.lastError ? '<div class="tk-notice tk-notice--red">' + h.ic('alert') + '<span class="grow">' + h.esc(st.lastError) + '</span></div>' : '')
    + (st.warning ? '<div class="tk-notice tk-notice--amber">' + h.ic('warn') + '<span class="grow">' + h.esc(st.warning) + '</span></div>' : '')
    + (st.message ? note(h.esc(st.message), st.restartOwed ? restartBtn : '')
      : st.restartOwed ? note('A change here takes effect after a restart.', restartBtn) : '');
}

/* The whole pane. `st` adds to composioStatus's input: {mode: 'list'|'key',
   busy: null|'save'|'remove'|'check'|'enable', keyError, message, warning,
   lastError, shadowed, running}; `h`: the renderer's {esc, ic}. */
function composioPaneHTML(st, h) {
  const status = composioStatus(st);
  let body = '';
  if (status.level === 'loading') body = '<div class="tk-empty"><span class="tk-spin"></span><p>Loading…</p></div>';
  else if (st.hasKey === false && !st.restartOwed) body = composioSetupHTML(st, h);
  else {
    body = composioStatusHTML(status, st, h);
    if (st.mode === 'key') {
      body += '<div class="tk-card pad sd-tgcard sd-cmpcard"><h3 class="sd-title">Replace the API key</h3>'
        + '<p>The new key is checked with Composio before it replaces the saved one.</p>'
        + composioKeyFieldHTML(st, h, 'replace') + '</div>';
    }
    if (st.hasKey !== false) body += composioRowsHTML(st, h);
    else body += '<div class="tk-card pad sd-tgcard sd-cmpcard"><p>No key is saved. Paste a new one to connect again.</p>' + composioKeyFieldHTML(st, h, 'setup') + '</div>';
  }
  return '<div class="sd-pane sd-cmp">' + body + composioNoticesHTML(st, h) + '</div>';
}

if (typeof module !== 'undefined') {
  module.exports = {COMPOSIO_KEY_ENV, COMPOSIO_SIGNUP_URL, COMPOSIO_SEARCH_TOOL, composioKeyClean, composioToolsUp,
    composioStatus, composioPaneHTML};
}
