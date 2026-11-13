/* ---------------- ATO-556: atomicagent:// links ----------------
   Loaded before renderer.js; declares only. The pure half is shared with the
   Node checks (test/deeplink.test.mjs); the renderer half reads renderer.js
   globals at call time, as handoff.js does.

   A link (an "Add to Atomic Agent" button on a website) is checked in main
   (main/deeplink.ts) and comes here as a request. This draws ONE card: what
   would be installed, the exact command and settings, and the warnings.
   Nothing is installed until Install is pressed, and the install runs
   through the same paths Settings uses:
   - an MCP server: mcpAddSubmit (renderer.js), the Settings › MCP write,
     which checks for a duplicate name and lets the agent validate the entry;
   - a skill: `atag skill install` (BR.skillInstall) with its security scan.
     A CAUTION verdict asks again here; a DANGEROUS one is refused from a
     link (the Skills Hub in Settings can still install it on purpose). */

/** A command line as the card prints it: arguments with spaces are quoted. */
function deeplinkCommandLine(command, args) {
  const q = (a) => (a === '' || /[\s']/.test(a) ? "'" + String(a).replace(/'/g, "'\\''") + "'" : String(a));
  return [command].concat(Array.isArray(args) ? args : []).map(q).join(' ');
}

/** The card's rows for an MCP server: [label, value] pairs, nothing hidden. */
function deeplinkMcpRows(server) {
  if (!server || typeof server !== 'object') return [];
  const rows = [['name', server.name]];
  const t = server.transport || {};
  if (t.kind === 'stdio') {
    rows.push(['runs', deeplinkCommandLine(t.command, t.args)]);
    const env = server.env && typeof server.env === 'object' ? server.env : {};
    for (const k of Object.keys(env)) rows.push(['setting', k + '=' + env[k]]);
  } else if (typeof t.url === 'string') {
    rows.push(['address', t.url]);
    rows.push(['type', t.kind === 'sse' ? 'remote server (SSE)' : 'remote server (streamable HTTP)']);
  }
  if (server.description) rows.push(['about', server.description]);
  return rows;
}

/** The `@owner/slug` to install: the link's own, else the owner ClawHub reports for the slug. */
function deeplinkSkillIdentifier(req, detail) {
  if (!req) return null;
  if (req.identifier) return req.identifier;
  const owner = detail && typeof detail.ownerHandle === 'string' ? detail.ownerHandle : '';
  return owner && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) ? '@' + owner + '/' + req.slug : null;
}

function deeplinkTitle(req) {
  if (!req) return '';
  if (req.route === 'mcp-install') return 'Add this MCP server?';
  if (req.route === 'skill-install') return 'Install this skill?';
  if (req.route === 'error') return 'This link can’t be opened';
  return 'Open this link?';
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

const DLINK = {req: null, busy: false, error: null, confirm: null, detail: null, detailLoading: false, seq: 0,
  queue: [], showTimer: null, armAt: 0, armTimer: null};

/* A link that comes in while a card is open waits for it to close (review F08-7):
   swapping the card in place would put link B's Install under a click aimed at A.
   And after any change to what the card shows, Install stays off for a moment,
   so a click already on its way cannot land on content the person has not seen. */
const DLINK_ARM_MS = 1000;
const DLINK_QUEUE_MAX = 5;

/** Other cards (ATO-1071 recipes) draw through this: route → {html(req), install(req)}. */
const DLINK_CARDS = {};

function deeplinkWire() {
  if (!BR || !BR.deeplinkTake) return;
  if (BR.onDeeplink) BR.onDeeplink(() => { deeplinkPull(); });
  deeplinkPull();
}

function deeplinkCardOpen() {
  return !!DLINK.req && (S.overlay === 'deeplink' || DLINK.busy);
}

/** The card's content just changed: Install waits DLINK_ARM_MS before it works again. */
function deeplinkArm() {
  DLINK.armAt = Date.now() + DLINK_ARM_MS;
  if (DLINK.armTimer) clearTimeout(DLINK.armTimer);
  DLINK.armTimer = setTimeout(() => { DLINK.armTimer = null; if (S.overlay === 'deeplink') render(); }, DLINK_ARM_MS + 20);
}

function deeplinkArmed() {
  return Date.now() >= DLINK.armAt;
}

async function deeplinkPull() {
  const list = await BR.deeplinkTake().catch(() => []);
  if (!Array.isArray(list) || !list.length) return;
  const req = list[list.length - 1];   // several at once: the newest one is the one just clicked
  if (deeplinkCardOpen()) {
    const same = (q) => !!req.link && q.link === req.link;
    if (same(DLINK.req) || DLINK.queue.some(same)) return;   // the same link twice is one card
    DLINK.queue.push(req);
    if (DLINK.queue.length > DLINK_QUEUE_MAX) DLINK.queue.shift();
    toast('Another link is waiting', 'It opens when you close this card.');
    return;
  }
  deeplinkShow(req);
}

function deeplinkShow(req) {
  DLINK.req = req; DLINK.error = null; DLINK.confirm = null; DLINK.detail = null; DLINK.detailLoading = false;
  const seq = ++DLINK.seq;
  deeplinkArm();
  S.overlay = 'deeplink';
  S.settings = null;   // as handoff: the card is the one thing on screen, so Escape and the scrim close it
  render();
  if (req.route === 'skill-install') deeplinkLoadSkill(req, seq);
}

/** Called from overlaysHTML when the card is not on screen: the next waiting link, once nothing else is up. */
function deeplinkWhenClosed() {
  if (!DLINK.queue.length || DLINK.busy || S.overlay || DLINK.showTimer) return;
  DLINK.showTimer = setTimeout(() => {
    DLINK.showTimer = null;
    if (!DLINK.queue.length || DLINK.busy || S.overlay) return;
    deeplinkShow(DLINK.queue.shift());
  }, 0);
}

async function deeplinkLoadSkill(req, seq) {
  if (!BR.clawhubSkillDetail) return;
  DLINK.detailLoading = true; render();
  const apiBase = await skpClawhubApiBase().catch(() => null);
  const res = apiBase ? await BR.clawhubSkillDetail(apiBase, req.slug, req.owner).catch((e) => ({ok:false, error:String((e && e.message) || e)}))
    : {ok:false, error:'the Skills Hub address is not known'};
  if (seq !== DLINK.seq) return;
  DLINK.detailLoading = false;
  deeplinkArm();   // the rows just changed
  if (res && res.ok && res.detail) DLINK.detail = res.detail;
  else DLINK.error = 'ClawHub did not answer for this skill: ' + ((res && res.error) || 'no answer') + '.';
  if (S.overlay === 'deeplink') render();
}

function deeplinkRowsHTML(rows) {
  if (!rows.length) return '';
  return '<dl class="tk-plate sd-detect">' + rows.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v == null ? '' : v) + '</dd>').join('') + '</dl>';
}

function deeplinkNotices(list, cls) {
  return (list || []).map((w) => '<div class="tk-notice ' + cls + '">' + ic('alert') + '<span class="grow">' + esc(w) + '</span></div>').join('');
}

function deeplinkSheetHTML() {
  const req = DLINK.req;
  if (!req) return '';
  const custom = DLINK_CARDS[req.route];
  let body = '';
  let canInstall = false;
  if (req.route === 'error') {
    body += '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(req.error || 'The link is not one Atomic Agent can open.') + '</span></div>'
      + '<p class="sd-cap">Nothing was installed or changed.</p>';
  } else if (custom && typeof custom.html === 'function') {
    body += custom.html(req);
    canInstall = !!custom.install;
  } else {
    body += '<p class="sd-cap">A website or another app asked Atomic Agent to install this. Nothing is installed unless you press Install. Only go on if you trust where the link came from.</p>';
    if (req.route === 'mcp-install') {
      body += deeplinkRowsHTML(deeplinkMcpRows(req.server));
      canInstall = !!req.server;
    } else if (req.route === 'skill-install') {
      const d = DLINK.detail;
      const id = deeplinkSkillIdentifier(req, d);
      const rows = [['skill', (d && d.displayName) || req.slug], ['from', id ? 'ClawHub, ' + id : 'ClawHub, ' + req.slug]];
      if (d && d.version) rows.push(['version', d.version]);
      if (d && typeof d.downloads === 'number') rows.push(['downloads', String(d.downloads)]);
      if (d && d.summary) rows.push(['about', d.summary]);
      body += deeplinkRowsHTML(rows);
      if (DLINK.detailLoading) body += '<div class="tk-empty"><span class="tk-spin"></span><p>Asking ClawHub about this skill…</p></div>';
      if (!id && !DLINK.detailLoading) body += '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">The link does not say whose skill this is, and ClawHub did not either, so it cannot be installed from here.</span></div>';
      canInstall = !!id && !DLINK.detailLoading;
    }
    body += deeplinkNotices(req.warnings, 'tk-notice--amber');
  }
  if (DLINK.confirm) body += '<div class="tk-notice tk-notice--amber">' + ic('alert') + '<span class="grow">' + esc(DLINK.confirm.message || 'The security scan asks for a confirmation.') + '</span></div>';
  if (DLINK.error) body += '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(DLINK.error) + '</span></div>';
  if (req.link) body += '<p class="sd-cap">Link: <span class="sd-mono">' + esc(req.link) + '</span></p>';
  const installLabel = DLINK.confirm ? 'Install anyway' : (req.route === 'mcp-install' ? 'Add server' : 'Install');
  const foot = '<span class="grow"></span>'
    + '<button class="btn btn-s sm" data-act="close">' + (req.route === 'error' ? 'Close' : 'Cancel') + '</button>'
    + (req.route === 'error' ? '' : '<button class="btn btn-p sm" data-act="dlink:install"' + (canInstall && !DLINK.busy && deeplinkArmed() ? '' : ' disabled') + '>'
      + (DLINK.busy ? '<span class="tk-spin"></span>' : '') + esc(installLabel) + '</button>');
  return sheet(deeplinkTitle(req), body, foot, 'sheet-deeplink');
}

async function deeplinkInstallMcp(req) {
  const json = JSON.stringify(req.server);
  // mcpAddSubmit is the Settings › MCP add; it reads its text from the add box's state.
  MCP.addModal = {json, error:null, submitting:false, name:null, auto:null}; MCP.removeConfirm = null;
  const res = await mcpAddSubmit(json).catch((e) => ({ok:false, error:String((e && e.message) || e)}));
  MCP.addModal = null;   // a failed add must not leave the box open in Settings
  if (!res || !res.ok) return {ok:false, error:(res && res.error) || 'The server could not be added.'};
  const how = MCP.msg && MCP.msg.text ? MCP.msg.text : 'Open Settings › MCP to connect it.';
  return {ok:true, title:'MCP server added', text:how};
}

async function deeplinkInstallSkill(req) {
  const id = deeplinkSkillIdentifier(req, DLINK.detail);
  if (!id) return {ok:false, error:'There is no skill to install.'};
  const caution = !!DLINK.confirm && DLINK.confirm.verdict === 'caution';
  const res = await BR.skillInstall(id, false, caution).catch((e) => ({ok:false, error:String((e && e.message) || e)}));
  if (res && res.ok) {
    if (typeof skpReloadRows === 'function') skpReloadRows().catch(() => {});
    return {ok:true, title:'Skill installed', text:(res.line || ('Installed ' + id + '.')) + ' Restart the agent for it to be used.'};
  }
  if (res && res.blocked && res.caution && !caution) {
    DLINK.confirm = {verdict:'caution', message:res.message || ''};
    return {ok:false, again:true};
  }
  if (res && res.blocked) {
    return {ok:false, error:'The security scan flagged this skill as dangerous, so a link cannot install it. ' + (res.message || '')
      + ' If you still want it, find it in Settings › Skills › Browse Skills Hub.'};
  }
  return {ok:false, error:(res && res.error) || 'The install failed.'};
}

async function deeplinkInstall() {
  const req = DLINK.req;
  if (!req || DLINK.busy || !BR || !deeplinkArmed()) return;
  const custom = DLINK_CARDS[req.route];
  const run = req.route === 'mcp-install' ? deeplinkInstallMcp
    : req.route === 'skill-install' ? deeplinkInstallSkill
    : custom && typeof custom.install === 'function' ? custom.install : null;
  if (!run) return;
  DLINK.busy = true; DLINK.error = null; render();
  const res = await run(req);
  DLINK.busy = false;
  if (DLINK.req !== req) { deeplinkWhenClosed(); return; }
  if (S.overlay !== 'deeplink' && !(res && res.ok)) {   // the card was closed while it ran: say how it ended, then the next link
    DLINK.req = null; DLINK.confirm = null;
    if (!(res && res.again)) toast('The link’s install did not finish', (res && res.error) || 'The install failed.', 'bad');
    deeplinkWhenClosed();
    return;
  }
  if (res && res.ok) {
    DLINK.req = null; DLINK.confirm = null;
    if (S.overlay === 'deeplink') S.overlay = null;
    render();
    if (res.title) toast(res.title, res.text || '');
    deeplinkWhenClosed();
    return;
  }
  if (!(res && res.again)) { DLINK.confirm = null; DLINK.error = (res && res.error) || 'The install failed.'; }
  deeplinkArm();   // "Install anyway" or a new error now sits under the pointer
  render();
}

/** `dlink:<verb>` from act(): install. Cancel is the shared `close`. */
function deeplinkAct(v) {
  if (v === 'install') { deeplinkInstall(); return; }
}

if (typeof module !== 'undefined') module.exports = {deeplinkCommandLine, deeplinkMcpRows, deeplinkSkillIdentifier, deeplinkTitle};
