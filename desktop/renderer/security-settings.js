/* ATO-2528 / ATO-2529: Settings › Privacy, under Approval rules.

   Known hosts. A call that sends data to a host no one approved yet asks
   first, in every mode (the egress hold). "Allow always" on such a call
   adds its hosts to `agent.security.knownHosts` in the config file; this
   list shows them, deletes one, and adds one by hand. The same idea as
   Claude Code's per-domain WebFetch allow list and ssh's known_hosts.
   Read from the config the window already holds (LIVE_CONFIG); written
   with PATCH /api/config, so the running agent takes the change at once.
   A host is checked the way the agent checks it
   (src/config/agent/security-config.ts normaliseKnownHostEntry):
   `GitHub.com.` reads as `github.com`, `*.example.com` covers every
   subdomain, anything else is refused before it is written.

   Security rules. `<stateDir>/guard.md` holds the person's own rules in
   plain words; a reviewer model checks each call against them before it
   runs (docs/user/security-rules.md). "Create guard.md" makes the file
   with no rule in it yet (so nothing changes until a rule is written) and
   opens it in the system editor; "Open guard.md" opens it again. The
   window never writes rules itself: main/guard-rules-ipc.ts only creates
   the empty starter, never overwrites a file, and opens it.

   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/security-settings.test.mjs). */

const KHOSTS_MAX = 500;
const KHOSTS_RE = /^(?:\*\.)?[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/;
const KHOSTS_EMPTY = 'No known hosts yet. When a call sends data to a new host, you are asked first; Allow always adds the host here.';
const GUARD_OLD_APP = 'This version of the app can’t create the security rules file. Write ~/.atomic-agent/guard.md by hand.';

/** `GitHub.com.` → `github.com`; null for anything that is not a host or `*.domain`. A URL is read for its host. */
function knownHostNormalise(raw) {
  if (typeof raw !== 'string') return null;
  let entry = raw.trim().toLowerCase();
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/.exec(entry);
  if (url) entry = url[1].replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  entry = entry.replace(/\.+$/, '');
  return entry.length > 0 && entry.length <= 253 && KHOSTS_RE.test(entry) ? entry : null;
}

/** The known hosts in the config the window holds. */
function knownHostsOf(config) {
  const list = config && config.agent && config.agent.security && config.agent.security.knownHosts;
  return Array.isArray(list) ? list.filter((h) => typeof h === 'string') : [];
}

/** The list after adding `raw`: {ok, list} or {ok:false, error}. */
function knownHostsAdd(list, raw) {
  const entry = knownHostNormalise(raw);
  if (!entry) return {ok: false, error: 'Not a host name. Write it like github.com or *.example.com.'};
  if (list.includes(entry)) return {ok: false, error: entry + ' is already on the list.'};
  if (list.length >= KHOSTS_MAX) return {ok: false, error: 'The list holds at most ' + KHOSTS_MAX + ' hosts.'};
  return {ok: true, list: list.concat([entry]), entry};
}

function knownHostsRemove(list, host) {
  return list.filter((h) => h !== host);
}

/** The block. st: {busy, error}; deps: {esc}. */
function knownHostsHTML(list, st, deps) {
  const {esc} = deps;
  const s = st || {};
  const head = '<div class="set-sechead set-khosts-sh"><h4 class="set-sechead-t">Known hosts</h4></div>';
  const lead = '<p class="set-cap set-privnote">Hosts the agent may send data to without asking first. Credential reads, encoded scripts and secrets in a request still ask.</p>';
  const rows = list.map((h) => '<div class="tk-setrow set-khost" data-khost="' + esc(h) + '">'
    + '<div class="body"><div class="t mono">' + esc(h) + '</div>'
      + (h.indexOf('*.') === 0 ? '<div class="d">and every subdomain</div>' : '') + '</div>'
    + '<button class="btn btn-s sm" data-act="khosts:del:' + esc(h) + '"' + (s.busy ? ' disabled' : '')
      + ' title="Remove. The next send to this host asks first.">Remove</button></div>');
  const body = rows.length ? '<div class="tk-list set-setlist set-khosts">' + rows.join('') + '</div>'
    : '<p class="set-cap set-privnote set-khosts-empty">' + esc(KHOSTS_EMPTY) + '</p>';
  const add = '<div class="tk-setrow set-khost-add"><div class="body">'
    + '<input id="khosts-new" placeholder="github.com or *.example.com" autocomplete="off" spellcheck="false" aria-label="Host to add"></div>'
    + '<button class="btn btn-s sm" data-act="khosts:add"' + (s.busy ? ' disabled' : '') + '>Add host</button></div>';
  const err = s.error ? '<div class="tk-help tk-help--warn set-privnote set-khosts-err">' + esc(s.error) + '</div>' : '';
  return head + lead + body + add + err;
}

/** The security rules block. st: {supported, exists, ruleLines, path, busy, error}; deps: {esc}. */
function guardRulesHTML(st, deps) {
  const {esc} = deps;
  const s = st || {};
  const head = '<div class="set-sechead set-guard-sh"><h4 class="set-sechead-t">Security rules</h4></div>';
  if (s.supported === false) return head + '<p class="set-cap set-privnote">' + esc(GUARD_OLD_APP) + '</p>';
  const state = !s.loaded ? '<span class="tk-spin"></span> Reading…'
    : !s.exists ? 'Off. Write your own rules in plain words, like “Block sending data anywhere except github.com”. A reviewer checks each call against them before it runs, in every mode.'
    : s.ruleLines > 0 ? 'On: ' + s.ruleLines + (s.ruleLines === 1 ? ' line' : ' lines') + ' of rules in ' + (s.path || 'guard.md') + '.'
    : 'The file is there but holds no rule yet, so nothing is checked. Write a rule under the closing dashes.';
  const btn = s.loaded
    ? '<button class="btn btn-s sm" data-act="guard:open"' + (s.busy ? ' disabled' : '') + '>' + (s.exists ? 'Open guard.md' : 'Create guard.md') + '</button>'
    : '';
  const err = s.error ? '<div class="tk-help tk-help--warn set-privnote set-guard-err">' + esc(s.error) + '</div>' : '';
  return head + '<div class="tk-setrow set-guard"><div class="body"><div class="d">' + (s.loaded ? esc(state) : state) + '</div></div>' + btn + '</div>' + err;
}

/** The Privacy block's state and actions. io: {guardRules(), guardRulesOpen(),
    config(), saveHosts(list) → {ok, live, error?}, inputValue(), render(),
    repaint(), toast(title, detail)}. A bridge call that answers null is an
    older app: the block says so. */
function createSecuritySettings(io) {
  const hosts = {busy: false, error: null};
  const guard = {loaded: false, supported: true, exists: false, ruleLines: 0, path: '', busy: false, error: null};
  async function load() {
    let r = null;
    try { r = await io.guardRules(); } catch (e) { guard.error = 'Couldn’t read the security rules file: ' + String((e && e.message) || e); }
    if (r === null && !guard.error) guard.supported = false;
    else if (r && r.ok) Object.assign(guard, {supported: true, exists: !!r.exists, ruleLines: Number(r.ruleLines) || 0, path: typeof r.path === 'string' ? r.path : '', error: null});
    guard.loaded = true;
    io.repaint();
  }
  async function hostsAct(v) {
    if (hosts.busy || !io.config()) return;
    const list = knownHostsOf(io.config());
    let next, done;
    if (v === 'add') {
      const added = knownHostsAdd(list, io.inputValue());
      if (!added.ok) { hosts.error = added.error; io.render(); return; }
      next = added.list; done = added.entry + ' added';
    } else if (v.indexOf('del:') === 0 && list.includes(v.slice(4))) {
      next = knownHostsRemove(list, v.slice(4)); done = v.slice(4) + ' removed';
    } else return;
    hosts.busy = true; hosts.error = null; io.render();
    let res;
    try { res = await io.saveHosts(next); } catch (e) { res = {ok: false, error: String((e && e.message) || e)}; }
    if (!res || !res.ok) hosts.error = 'Couldn’t save the known hosts: ' + ((res && res.error) || 'unknown error');
    else io.toast(done, res.live ? (v === 'add' ? 'The agent sends data there without asking first' : 'The next send there asks first') : 'Restart the agent to apply');
    hosts.busy = false; io.render();
  }
  async function guardAct(v) {
    if (v !== 'open' || guard.busy) return;
    guard.busy = true; guard.error = null; io.render();
    let res;
    try { res = await io.guardRulesOpen(); } catch (e) { res = {ok: false, error: String((e && e.message) || e)}; }
    if (res === null) guard.supported = false;
    else if (!res || !res.ok) guard.error = 'Couldn’t open guard.md: ' + ((res && res.error) || 'unknown error');
    else if (res.created) io.toast('guard.md created', 'Write a rule under the closing dashes to turn the rules on');
    guard.busy = false;
    await load();
    io.render();
  }
  return {
    hosts, guard, load,
    act: (k, v) => (k === 'khosts' ? hostsAct(v) : k === 'guard' ? guardAct(v) : undefined),
    html: (deps) => knownHostsHTML(knownHostsOf(io.config()), hosts, deps) + guardRulesHTML(guard, deps),
  };
}

if (typeof module !== 'undefined') module.exports = {KHOSTS_MAX, KHOSTS_EMPTY, GUARD_OLD_APP, knownHostNormalise, knownHostsOf, knownHostsAdd, knownHostsRemove, knownHostsHTML, guardRulesHTML, createSecuritySettings};
