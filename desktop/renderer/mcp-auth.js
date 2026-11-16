/* ---------------- MCP tab: browser sign-in (OAuth) ----------------
   Loaded BEFORE renderer.js and after mcp-live.js, so it only declares:
   BR, MCP, MCP_LIVE, render, mcpRefresh, mcpServers and mcpCatalogEntry
   are read when a function runs, never at load time.

   Agent routes (src/http/route-mcp.ts, src/mcp/mcp-oauth-flow.ts):
     POST /api/mcp/servers/{name}/auth/start   -> {state:"pending", authUrl} | {state:"signed_in"}
     GET  /api/mcp/servers/{name}/auth         -> {state:"signed_out"|"pending"|"signed_in", error?}
     POST /api/mcp/servers/{name}/auth/signout -> {state:"signed_out"}
   The main process opens authUrl in the person's browser (main/agent-live.ts,
   https only); the window never opens it itself. The browser comes back to
   the agent's own loopback page, so the window only polls the status every
   2 seconds until it reads signed_in, an error, or 5 minutes pass.

   Browser sign-in applies to a remote server with no key in its headers,
   the same rule as usesMcpOAuth in src/mcp/mcp-oauth-provider.ts. */

const MCP_AUTH = {byName:{}, pollMs:2000, maxMs:5 * 60 * 1000};

/* hasStaticCredentialHeader in src/mcp/mcp-oauth-provider.ts. */
const MCP_AUTH_CREDENTIAL_HEADER_RE = /^(authorization|proxy-authorization)$|api[-_]?key|token|secret|password/i;

/* True when browser sign-in can apply to this config entry. */
function mcpUsesOAuth(cfg) {
  const t = cfg && cfg.transport;
  if (!t || (t.kind !== 'streamable_http' && t.kind !== 'sse')) return false;
  const headers = t.headers && typeof t.headers === 'object' ? t.headers : {};
  return !Object.keys(headers).some((h) => MCP_AUTH_CREDENTIAL_HEADER_RE.test(h));
}

/* What the row shows about sign-in, from the config entry, the last live
   status an action reported, the cached sign-in status and whether the
   catalog marks the server as one that signs in. One of:
   'needs' (Sign in required + Sign in), 'pending' (Waiting for the browser),
   'signed_in' (Sign out), or null (nothing about sign-in). */
function mcpAuthViewOf(cfg, live, auth, catalogOauth) {
  if (!cfg || cfg.enabled === false || !mcpUsesOAuth(cfg)) return null;
  if (auth && auth.state === 'pending') return 'pending';
  // Review fix: the live state first. A refresh that failed leaves the
  // tokens on disk while the server needs a new sign-in.
  if (live && live.state === 'needs_auth') return 'needs';
  if (auth && auth.state === 'signed_in') return 'signed_in';
  if (auth && auth.state === 'signed_out' && catalogOauth) return 'needs';
  return null;
}

/* The state chip while sign-in matters; null leaves the usual chip. */
function mcpAuthChipHTML(view, auth, h) {
  if (view === 'pending') return '<span class="tk-chip tk-chip--sm tk-chip--line" title="Finish signing in in your browser"><span class="tk-spin"></span>Waiting for the browser…</span>';
  if (view === 'needs') {
    const title = auth && auth.error ? auth.error : 'This server needs you to sign in with your account';
    return '<span class="tk-chip tk-chip--sm tk-chip--amber" title="' + h.esc(title) + '">Sign in required</span>';
  }
  return null;
}

/* The row's sign-in control: spans, like the other row controls, because
   the row itself is the button that opens the detail. */
function mcpAuthRowControlHTML(name, view, h) {
  if (view === 'needs') return '<span class="btn btn-s sm" role="button" data-act="mcp:signin:' + h.esc(name) + '" title="Open your browser to sign in" aria-label="Sign in to ' + h.esc(name) + '">Sign in</span>';
  if (view === 'signed_in') return '<span class="btn btn-s sm" role="button" data-act="mcp:signout:' + h.esc(name) + '" title="Forget the saved sign-in" aria-label="Sign out of ' + h.esc(name) + '">Sign out</span>';
  return '';
}

/* The detail header's control: the same, as a real button. */
function mcpAuthDetailControlHTML(name, view, h) {
  if (view === 'needs') return '<button class="btn btn-p sm" data-act="mcp:signin:' + h.esc(name) + '">Sign in</button>';
  if (view === 'signed_in') return '<button class="btn btn-s sm" data-act="mcp:signout:' + h.esc(name) + '">Sign out</button>';
  return '';
}

/* One poll answer -> what to do next: 'wait', 'done', 'failed' or 'timeout'. */
function mcpAuthPollStep(answer, startedAt, now, maxMs) {
  if (answer && answer.state === 'signed_in') return 'done';
  // signed_out with no error is the moment between the browser coming back
  // and the tokens being saved: keep waiting; an error ends it.
  if (answer && answer.state === 'signed_out' && answer.error) return 'failed';
  if (now - startedAt >= maxMs) return 'timeout';
  return 'wait';
}

/* ---- runtime glue (uses the renderer's globals) ---- */

function mcpAuthHelpers() { return {esc}; }

function mcpAuthCatalogOauth(name) {
  const e = typeof mcpCatalogEntry === 'function' ? mcpCatalogEntry(name) : null;
  return !!(e && e.auth === 'oauth');
}

function mcpAuthView(name) {
  const cfg = mcpServers().find((s) => s && s.name === name);
  return mcpAuthViewOf(cfg, MCP_LIVE.status[name], MCP_AUTH.byName[name], mcpAuthCatalogOauth(name));
}

function mcpAuthStateChip(name) {
  return mcpAuthChipHTML(mcpAuthView(name), MCP_AUTH.byName[name], mcpAuthHelpers());
}
function mcpAuthRowControl(name) { return mcpAuthRowControlHTML(name, mcpAuthView(name), mcpAuthHelpers()); }
function mcpAuthDetailControl(name) { return mcpAuthDetailControlHTML(name, mcpAuthView(name), mcpAuthHelpers()); }

/* After a refresh: read the sign-in status once for every enabled server
   that can sign in and has none cached yet. Later changes come from the
   window's own Sign in / Sign out, so a 5 s list poll costs nothing here. */
async function mcpAuthSync() {
  if (!BR || !BR.mcpAuthStatus) return;
  // A sign-in started elsewhere (the TUI's /mcp auth) shows as pending with no poll here: read it again.
  const stale = (a) => !a || (a.state === 'pending' && !a.local);
  const names = mcpServers().filter((s) => s && s.enabled !== false && mcpUsesOAuth(s) && stale(MCP_AUTH.byName[s.name])).map((s) => s.name);
  if (!names.length) return;
  let changed = false;
  await Promise.all(names.map(async (name) => {
    MCP_AUTH.byName[name] = {state:'checking'};
    const res = await BR.mcpAuthStatus(name);
    if (res && res.ok && res.data && typeof res.data.state === 'string') { MCP_AUTH.byName[name] = {state:res.data.state, error:res.data.error}; changed = true; }
    else MCP_AUTH.byName[name] = {state:'unknown'};   // older agent or not loaded yet; not asked again until a refresh clears it
  }));
  if (changed) render();
}

/* A Restart / enable answered: needs_auth means the saved sign-in is gone
   or no longer accepted, so a cached signed_in is stale. */
function mcpAuthNoteLive(name, st) {
  const a = MCP_AUTH.byName[name];
  if (st && st.state === 'needs_auth' && a && a.state === 'signed_in') MCP_AUTH.byName[name] = {state:'signed_out'};
  if (st && st.state === 'up' && a && a.state === 'unknown') delete MCP_AUTH.byName[name];   // ask again on the next refresh
}

function mcpAuthStopPoll(name) {
  const a = MCP_AUTH.byName[name];
  if (a && a.timer) { clearInterval(a.timer); a.timer = null; }
}

async function mcpAuthSignIn(name) {
  if (!BR || !name) return {ok:false, error:'no name'};
  if (!BR.mcpAuthStart) { MCP.lastError = 'This build cannot sign in to MCP servers.'; render(); return {ok:false, error:MCP.lastError}; }
  const cur = MCP_AUTH.byName[name];
  if (cur && cur.state === 'pending') return {ok:false, error:'pending'};
  mcpAuthStopPoll(name);
  const startedAt = Date.now();
  MCP_AUTH.byName[name] = {state:'pending', startedAt, timer:null, local:true};
  MCP.lastError = null; MCP.msg = null; render();
  const res = await BR.mcpAuthStart(name);
  if (!res || !res.ok) {
    const why = (res && res.error) || 'unknown error';
    MCP_AUTH.byName[name] = {state:'signed_out', error:why};
    MCP.lastError = res && res.unsupported ? 'This agent cannot sign in to MCP servers. Update Atomic Agent.' : 'Could not start sign-in for ' + name + ': ' + why;
    render();
    return {ok:false, error:MCP.lastError};
  }
  if (res.data && res.data.state === 'signed_in') { mcpAuthFinished(name); return {ok:true, state:'signed_in'}; }
  MCP.msg = {text:'Your browser opened to sign in to ' + name + '. Come back here when it says you are signed in.'};
  render();
  const a = MCP_AUTH.byName[name];
  a.timer = setInterval(async () => {
    if (a.polling) return;
    a.polling = true;
    let answer = null;
    try {
      const s = await BR.mcpAuthStatus(name);
      answer = s && s.ok ? s.data : null;
    } finally { a.polling = false; }
    if (MCP_AUTH.byName[name] !== a) { clearInterval(a.timer); return; }   // a newer sign-in or a sign-out took over
    const step = mcpAuthPollStep(answer, startedAt, Date.now(), MCP_AUTH.maxMs);
    if (step === 'wait') return;
    mcpAuthStopPoll(name);
    if (step === 'done') { mcpAuthFinished(name); return; }
    const why = step === 'timeout' ? 'Sign-in timed out. Start it again.' : (answer && answer.error) || 'Sign-in did not finish.';
    MCP_AUTH.byName[name] = {state:'signed_out', error:why};
    MCP.lastError = name + ': ' + why;
    render();
  }, MCP_AUTH.pollMs);
  return {ok:true, state:'pending'};
}

function mcpAuthFinished(name) {
  mcpAuthStopPoll(name);
  MCP_AUTH.byName[name] = {state:'signed_in'};
  // The agent reconnects the server itself once the browser comes back.
  if (MCP_LIVE.status[name] && MCP_LIVE.status[name].state === 'needs_auth') delete MCP_LIVE.status[name];
  MCP.lastError = null;
  MCP.msg = {text:'You are signed in to ' + name + '.'};
  mcpRefresh();
}

async function mcpAuthSignOut(name) {
  if (!BR || !name) return {ok:false, error:'no name'};
  if (!BR.mcpAuthSignOut) { MCP.lastError = 'This build cannot sign out of MCP servers.'; render(); return {ok:false, error:MCP.lastError}; }
  mcpAuthStopPoll(name);
  MCP.lastError = null; MCP.msg = null;
  const res = await BR.mcpAuthSignOut(name);
  if (!res || !res.ok) {
    MCP.lastError = res && res.unsupported ? 'This agent cannot sign out of MCP servers. Update Atomic Agent.' : 'Could not sign out of ' + name + ': ' + ((res && res.error) || 'unknown error');
    render();
    return {ok:false, error:MCP.lastError};
  }
  MCP_AUTH.byName[name] = {state:'signed_out'};
  // It was signed in, so it is a server that wants a sign-in.
  MCP_LIVE.status[name] = {name, state:'needs_auth', authRequired:true, ts:Date.now()};
  MCP.msg = {text:'Signed out of ' + name + '. Sign in again to use its tools.'};
  await mcpRefresh();
  return {ok:true};
}

if (typeof window !== 'undefined') {
  // --smoke: the cached sign-in states.
  window.__mcpAuth = () => {
    const out = {};
    for (const [k, v] of Object.entries(MCP_AUTH.byName)) out[k] = {state:v.state, error:v.error};
    return out;
  };
}

if (typeof module !== 'undefined') {
  module.exports = {MCP_AUTH, mcpUsesOAuth, mcpAuthViewOf, mcpAuthChipHTML, mcpAuthRowControlHTML, mcpAuthDetailControlHTML, mcpAuthPollStep};
}
