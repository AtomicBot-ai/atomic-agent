/* ---------------- Settings › Connections › Monid (ATO-1630) ----------------
   Loaded BEFORE renderer.js and after mcp-auth.js / mcp-catalog.js, so it
   only declares: BR, MCP_AUTH, MCP_LIVE, LIVE_CAPS, render, mcpServers,
   mcpRefresh, mcpAuthSignIn, mcpCatalogJson, mcpParseAddInput, configPatchOr
   and homeDir are read when a function runs, never at load time. Shared
   with the Node checks (test/monid.test.mjs): the server lookup, the status
   and the markup are pure.

   Monid's MCP server takes a browser sign-in only (an API key is refused),
   so this pane has no key field. "Sign in with Monid" is the TUI hub's
   Monid row (src/integrations/monid-integration.ts): add the MCP catalog
   card's `monid` server when no server points at Monid yet, then run the
   MCP tab's own browser sign-in (mcp-auth.js). The catalog card stays; both
   lead to one server, so pressing Sign in again never adds a second one.

   The status reads what the MCP tab already keeps: the config entry, the
   sign-in state from GET /api/mcp/servers/{name}/auth (MCP_AUTH) and the
   last live state an action reported (MCP_LIVE). */

const MONID_CATALOG_ID = 'monid';
/* The catalog card's server.url (src/mcp/mcp-catalog-data.ts). */
const MONID_SERVER_URL = 'https://mcp.monid.ai/v1';
const MONID_HOME_URL = 'https://monid.ai';

/* Window state: busy while the server is being added / the sign-in starts. */
const MONID = {busy:false, lastError:null, msg:null};

function monidSameUrl(a, b) {
  const norm = (raw) => {
    try { const u = new URL(String(raw)); return u.protocol + '//' + u.host.toLowerCase() + u.pathname.replace(/\/+$/, ''); }
    catch (e) { return null; }
  };
  const na = norm(a);
  return na !== null && na === norm(b);
}

/* The configured server this pane drives: one at Monid's URL whatever its
   name, else one named `monid` (a second `monid` could not be added). The
   agent side is findMonidServer in src/integrations/monid-integration.ts. */
function monidServerOf(servers) {
  if (!Array.isArray(servers)) return null;
  let byName = null;
  for (const s of servers) {
    if (!s || typeof s !== 'object' || typeof s.name !== 'string') continue;
    const t = s.transport || {};
    const url = t.kind !== 'stdio' && typeof t.url === 'string' ? t.url : null;
    if (url !== null && monidSameUrl(url, MONID_SERVER_URL)) return {name:s.name, url, enabled:s.enabled !== false};
    if (s.name === MONID_CATALOG_ID && !byName) byName = {name:s.name, url, enabled:s.enabled !== false};
  }
  return byName;
}

/* What the pane shows. `server`: monidServerOf's answer; `live`: the last
   live status ({state}); `auth`: the cached sign-in ({state, error}).
   Levels: none (no server), checking, signed_out, pending, signed_in,
   expired (a saved sign-in the server no longer accepts), off. */
function monidStatus(server, live, auth) {
  if (!server) return {level:'none', chip:'Not connected', line:'Sign in with your Monid account. No API key is needed.'};
  if (!server.enabled) return {level:'off', chip:'Off', line:'The Monid server is turned off in Settings › MCP servers.'};
  const a = auth || null;
  if (a && a.state === 'pending') return {level:'pending', chip:'Waiting for the browser…', line:'Finish signing in in your browser, then come back here.'};
  if (a && a.state === 'checking') return {level:'checking', chip:'', line:''};
  const needsAuth = !!(live && live.state === 'needs_auth');
  if (a && a.state === 'signed_in') {
    if (needsAuth) return {level:'expired', chip:'Sign-in expired', line:'Monid no longer accepts the saved sign-in. Sign in again to use its tools.'};
    return {level:'signed_in', chip:'Signed in', line:'Ask the agent to use Monid. Its tools load on their own.'};
  }
  if (a && a.state === 'signed_out') return {level:'signed_out', chip:'Not signed in', line: a.error ? String(a.error) : 'Sign in with your Monid account to load its tools.'};
  // No sign-in status from this agent yet (older agent, or not loaded).
  return {level:'signed_out', chip:'Not signed in', line:'Sign in with your Monid account to load its tools.'};
}

const MONID_CHIP_CLASS = {none:'tk-chip--amber', signed_out:'tk-chip--amber', pending:'tk-chip--line', signed_in:'tk-chip--green', expired:'tk-chip--red', off:'tk-chip--line'};

/* The Monid mark (renderer/logos/monid.svg, the same file ATO-1634 adds to LOGO_FILES). */
function monidMarkHTML(h) {
  const viaTable = typeof h.logo === 'function' ? h.logo('monid', 'sm') : '';
  return viaTable || '<span class="logo logo--sm"><img src="logos/monid.svg" alt=""></span>';
}

/* The whole pane. `st`: {server, live, auth, busy, lastError, msg}; `h`: {esc, ic, logo?}. */
function monidPaneHTML(st, h) {
  const status = monidStatus(st.server, st.live, st.auth);
  if (status.level === 'checking') return '<div class="sd-pane sd-cmp sd-monid"><div class="tk-empty"><span class="tk-spin"></span><p>Loading…</p></div></div>';
  const busy = !!st.busy || status.level === 'pending';
  const signIn = status.level === 'none' || status.level === 'signed_out' || status.level === 'expired' || status.level === 'pending';
  const label = status.level === 'expired' ? 'Sign in again' : 'Sign in with Monid';
  const acts = '<div class="sd-acts">'
    + '<button class="btn btn-s sm" data-url="' + h.esc(MONID_HOME_URL) + '" title="Opens monid.ai in your browser">' + h.ic('globe') + 'About Monid</button>'
    + '<span class="sd-grow"></span>'
    + (st.busy ? '<span class="sd-cap"><span class="tk-spin"></span>Starting sign-in…</span>' : '')
    + (signIn ? '<button class="btn btn-p sm" data-act="monid:signin"' + (busy ? ' disabled' : '') + '>' + h.esc(label) + '</button>' : '')
    + (status.level === 'signed_in' || status.level === 'off' ? '<button class="btn btn-s sm" data-act="settings:mcp" title="Settings › MCP servers">Manage in MCP servers</button>' : '')
    + '</div>';
  const head = '<div class="tk-card sd-tgstatus"><div class="tk-setrow">'
    + monidMarkHTML(h)
    + '<div class="body"><div class="t">Monid</div><div class="d">' + h.esc(status.line) + '</div></div>'
    + '<span class="tk-chip tk-chip--sm ' + (MONID_CHIP_CLASS[status.level] || 'tk-chip--line') + '" data-monid-status="' + status.level + '">' + h.esc(status.chip) + '</span>'
    + '</div></div>';
  const about = '<div class="tk-card pad sd-tgcard sd-cmpcard">'
    + '<p>Monid gives the agent pay-as-you-go access to data and automation tools. You sign in with your Monid account in the browser; there is no key to paste.</p>'
    + acts + '</div>';
  const notices = (st.lastError ? '<div class="tk-notice tk-notice--red">' + h.ic('alert') + '<span class="grow">' + h.esc(st.lastError) + '</span></div>' : '')
    + (st.msg ? '<div class="tk-notice tk-notice--blue">' + h.ic('info') + '<span class="grow">' + h.esc(st.msg) + '</span></div>' : '');
  return '<div class="sd-pane sd-cmp sd-monid">' + head + about + notices + '</div>';
}

/* ---- runtime glue (uses the renderer's globals) ---- */

function monidState() {
  const server = monidServerOf(mcpServers());
  const name = server && server.name;
  return {
    server,
    live: name && typeof MCP_LIVE !== 'undefined' ? MCP_LIVE.status[name] : null,
    auth: name && typeof MCP_AUTH !== 'undefined' ? MCP_AUTH.byName[name] : null,
    busy: MONID.busy, lastError: MONID.lastError, msg: MONID.msg,
  };
}

function monidTab() {
  return monidPaneHTML(monidState(), {esc, ic, logo: typeof logoHTML === 'function' ? logoHTML : null});
}

/* Entry: re-read the config, the tools and the sign-in state (mcpRefresh runs mcpAuthSync). */
function monidTabEntered() {
  MONID.lastError = null; MONID.msg = null;
  if (typeof MCP_AUTH !== 'undefined') {
    const s = monidServerOf(mcpServers());
    const a = s && MCP_AUTH.byName[s.name];
    if (a && a.state !== 'pending') delete MCP_AUTH.byName[s.name];   // read it again
  }
  mcpRefresh();
}

/* The catalog card's config entry, through the MCP tab's own parser. */
function monidCatalogServer() {
  const json = typeof mcpCatalogJson === 'function' ? mcpCatalogJson(MONID_CATALOG_ID) : null;
  if (!json) return null;
  const r = mcpParseAddInput(json, {home: typeof homeDir === 'function' ? homeDir() : ''});
  return r && r.ok ? r.server : null;
}

async function monidSignIn() {
  if (!BR || MONID.busy) return {ok:false, error:'busy'};
  MONID.busy = true; MONID.lastError = null; MONID.msg = null; render();
  try {
    const cfg = await BR.config();
    const servers = cfg && cfg.ok && cfg.data && cfg.data.config && cfg.data.config.mcp && Array.isArray(cfg.data.config.mcp.servers) ? cfg.data.config.mcp.servers : mcpServers();
    let ref = monidServerOf(servers);
    if (!ref) {
      const entry = monidCatalogServer();
      if (!entry) { MONID.lastError = 'This build has no Monid entry in the MCP catalog.'; return {ok:false, error:MONID.lastError}; }
      const list = servers.concat([entry]);
      const res = await configPatchOr({mcp:{servers:list}}, () => BR.configSetPath('mcp.servers', list));
      if (!res.ok) { MONID.lastError = 'Could not add the Monid server: ' + (res.error || 'config write failed'); return {ok:false, error:MONID.lastError}; }
      await mcpRefresh(true);
      ref = {name:entry.name};
    }
    if (ref.enabled === false) { MONID.lastError = 'The Monid server is turned off. Turn it on in Settings › MCP servers, then sign in.'; return {ok:false, error:MONID.lastError}; }
    const res = await mcpAuthSignIn(ref.name);
    if (!res || !res.ok) {
      if (res && res.error === 'pending') { MONID.msg = 'A sign-in is already open in your browser.'; return {ok:false, error:'pending'}; }
      const a = typeof MCP_AUTH !== 'undefined' ? MCP_AUTH.byName[ref.name] : null;
      MONID.lastError = (a && a.error) ? 'Could not start sign-in: ' + a.error : ((res && res.error) || 'Could not start sign-in.');
      return {ok:false, error:MONID.lastError};
    }
    if (res.state === 'pending') MONID.msg = 'Your browser opened to sign in to Monid. Come back here when it says you are signed in.';
    return {ok:true, name:ref.name};
  } finally {
    MONID.busy = false;
    render();
  }
}

function monidAct(what) {
  if (what === 'signin') { monidSignIn(); return; }
}

if (typeof module !== 'undefined') {
  module.exports = {MONID_CATALOG_ID, MONID_SERVER_URL, monidServerOf, monidStatus, monidPaneHTML};
}
