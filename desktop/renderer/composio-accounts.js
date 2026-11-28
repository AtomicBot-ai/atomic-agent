/* ---------------- Settings › Connections › Composio › Accounts (ATO-1494) ----------------
   Loaded BEFORE composio.js and renderer.js, so it only declares (plus one
   `input` listener that keeps half-typed names). Shared by the renderer and
   the Node checks (test/composio-accounts.test.mjs). No IPC of its own: the
   renderer hands `createComposioAccounts` the bridge and its repaint.

   Several accounts for one app (a work and a personal Gmail), the way the
   Claude and ChatGPT connectors and Raycast list them: every account
   Composio has signed in for this install, a short name for the ones you
   keep, and one default per app that every call for that app goes through.
   The list is the agent's `composio.accounts` (main/composio-accounts.ts);
   the agent pins the defaults when it starts, so each change owes a restart,
   as a saved key does. */

/* src/config/composio-accounts-config.ts COMPOSIO_ALIAS_RE, checked again in main. */
const CMPA_ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CMPA_ALIAS_RULE = "A name is 1 to 32 lowercase letters, digits or '-', not starting with '-'.";

/* A name as typed: lowercased and trimmed, spaces become '-'. '' when empty, null when it still breaks the rule. */
function cmpaAliasClean(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase().replace(/\s+/g, '-');
  if (!v) return '';
  return CMPA_ALIAS_RE.test(v) ? v : null;
}

/* One row per account, grouped by app: saved ones (with what Composio says
   about them) and signed-in ones not saved yet. `connected` null: unknown. */
function cmpaRows(accounts, connected) {
  const saved = Array.isArray(accounts) ? accounts : [];
  const live = Array.isArray(connected) ? connected : [];
  const byId = new Map(live.map((c) => [c.id, c]));
  const rows = saved.map((a) => ({
    toolkit: a.toolkit, id: a.connectedAccountId, alias: a.alias, isDefault: !!a.isDefault,
    who: byId.has(a.connectedAccountId) ? (byId.get(a.connectedAccountId).displayName || null) : null,
    missing: Array.isArray(connected) && !byId.has(a.connectedAccountId),
  }));
  const savedIds = new Set(saved.map((a) => a.connectedAccountId));
  for (const c of live) {
    if (!savedIds.has(c.id)) rows.push({toolkit: c.toolkit, id: c.id, alias: null, isDefault: false, who: c.displayName || null, missing: false});
  }
  return rows.sort((x, y) => (x.toolkit === y.toolkit
    ? (x.alias === null) - (y.alias === null) || String(x.alias || x.id).localeCompare(String(y.alias || y.id))
    : x.toolkit.localeCompare(y.toolkit)));
}

/* ATO-2745: main's "Could not save the accounts: <what the write said>" as a plain line and the raw
   part for Details; a sentence without a raw part (the list rules' own words) stays as it is. */
function cmpaSplit(text, fallback, raw) {
  const t = String(text || '');
  const m = /^(Could not [^:]+): ([\s\S]+)$/.exec(t);
  if (m) return {line: m[1] + '.', detail: m[2]};
  return {line: t || fallback, detail: raw || null};
}
/* The Details fold under a line, only when it belongs to that line. */
function cmpaDetailsHTML(line, d, h) {
  return line && d && d.for === line && d.text ? '<details class="set-errmore"><summary>Details</summary><span>' + h.esc(d.text) + '</span></details>' : '';
}

/* The card. `st`: {loading, accounts, connected, connectedError, busy, drafts, error, errorDetail}; `h`: {esc, ic}. */
function composioAccountsHTML(st, h) {
  const busy = !!st.busy;
  const rows = cmpaRows(st.accounts, st.connected);
  const head = '<div class="tk-setrow"><div class="body"><div class="t">Accounts</div><div class="d">'
    + 'Several accounts for one app, like a work and a personal Gmail. The default account of an app is the one the agent uses for it.'
    + '</div></div><button class="iconbtn sm" data-act="composio:acct:refresh" title="Ask Composio again" aria-label="Refresh accounts"' + (busy ? ' disabled' : '') + '>'
    + (st.loading ? '<span class="tk-spin"></span>' : h.ic('refresh')) + '</button></div>';
  let body = '';
  if (st.loading && !rows.length) body = '<div class="tk-setrow"><div class="body"><div class="d">Loading accounts…</div></div></div>';
  else if (!rows.length) body = '<div class="tk-setrow"><div class="body"><div class="d">No accounts yet. Ask the agent to connect an app; to add a second account for it, ask it to connect that app again.</div></div></div>';
  const appsWithDefault = new Set(rows.filter((r) => r.isDefault).map((r) => r.toolkit));
  for (const r of rows) {
    /* ATO-2745: Composio's account id is for support, not for reading: it moved from a <code> in the
       line to the line's tooltip (Raycast and the Claude connectors show the account, not its id). */
    const idTip = ' title="' + h.esc('Composio account id: ' + r.id) + '"';
    const where = h.esc(r.toolkit) + (r.who ? ' · ' + h.esc(r.who) : '');
    if (r.alias === null) {
      const draft = st.drafts && st.drafts[r.id] ? st.drafts[r.id] : '';
      // A signed-in account with no name yet is headed by who it is, not by "Not saved".
      body += '<div class="tk-setrow" data-cmpa-row="' + h.esc(r.id) + '"><div class="body"><div class="t">' + (r.who ? h.esc(r.who) : h.esc(r.toolkit) + ' account') + '</div>'
        + '<div class="d"' + idTip + '>' + h.esc(r.toolkit) + ' · No name yet. Give it a name to keep it.</div></div>'
        + '<label class="tk-inpwrap sm"><input id="cmpa-name-' + h.esc(r.id) + '" data-cmpa-name="' + h.esc(r.id) + '" value="' + h.esc(draft) + '" placeholder="Name, e.g. work" aria-label="Name for this account" autocomplete="off" spellcheck="false"' + (busy ? ' disabled' : '') + '></label>'
        + '<button class="btn btn-s sm" data-act="composio:acct:save:' + h.esc(r.toolkit) + ':' + h.esc(r.id) + '"' + (busy ? ' disabled' : '') + '>Save</button></div>';
      continue;
    }
    const chip = r.isDefault ? '<span class="tk-chip tk-chip--sm tk-chip--green">Default</span>'
      : '<button class="btn btn-s sm" data-act="composio:acct:default:' + h.esc(r.toolkit) + ':' + h.esc(r.alias) + '"' + (busy ? ' disabled' : '') + '>Make default</button>';
    const clear = r.isDefault ? '<button class="btn btn-g sm" data-act="composio:acct:clear:' + h.esc(r.toolkit) + '" title="Let Composio use the account connected last"' + (busy ? ' disabled' : '') + '>No default</button>' : '';
    body += '<div class="tk-setrow" data-cmpa-row="' + h.esc(r.id) + '"><div class="body"><div class="t">' + h.esc(r.alias) + '</div><div class="d"' + idTip + '>' + where
      + (r.missing ? ' · <span class="tk-help--err">not signed in on Composio any more</span>' : '') + '</div></div>'
      + chip + clear
      // ATO-2745: it only forgets the name, so it says that and is not red (nothing is signed out or deleted).
      + '<button class="btn btn-g sm" data-act="composio:acct:remove:' + h.esc(r.toolkit) + ':' + h.esc(r.alias) + '" title="The account stays signed in on Composio"' + (busy ? ' disabled' : '') + '>Forget name</button></div>';
  }
  const apps = Array.from(new Set(rows.map((r) => r.toolkit))).filter((t) => rows.filter((r) => r.toolkit === t).length > 1 && !appsWithDefault.has(t));
  const notes = (apps.length ? '<p class="sd-cap sd-block">' + h.esc(apps.join(', ')) + ': no default, so the agent uses the account connected last.</p>' : '')
    + (st.connectedError ? (() => { const c = cmpaSplit(st.connectedError, ''); return '<p class="sd-cap sd-block">' + h.esc(c.line) + '</p>' + cmpaDetailsHTML(c.line, c.detail && {for: c.line, text: c.detail}, h); })() : '')
    + (st.error ? '<p class="tk-help tk-help--err">' + h.esc(st.error) + '</p>' + cmpaDetailsHTML(st.error, st.errorDetail, h) : '');
  return '<div class="tk-card sd-rows sd-cmpaccts">' + head + body + notes + '</div>';
}

/* The controller. `deps`: {bridge() → BR, stateDir() → string|null, repaint(), changed(text)}. */
function createComposioAccounts(deps) {
  const st = {loading:false, accounts:[], connected:null, connectedError:null, busy:null, drafts:{}, error:null, errorDetail:null, chain:null};
  // A thrown call has no sentence of its own: the caller's plain line, its message as the detail.
  const call = async (fn) => { try { return await fn(); } catch (e) { return {ok:false, thrown: e && e.message ? e.message : String(e)}; } };
  const fail = (res, fallback) => {
    const c = cmpaSplit(res && res.error, fallback, res && res.thrown);
    st.error = c.line; st.errorDetail = c.detail ? {for: c.line, text: c.detail} : null;
  };
  async function refreshOnce() {
    const br = deps.bridge();
    if (!br || !br.composioListAccounts) return;
    st.loading = true; deps.repaint();
    const res = await call(() => br.composioListAccounts(deps.stateDir()));
    st.loading = false;
    if (res && res.ok) {
      st.accounts = Array.isArray(res.accounts) ? res.accounts : [];
      st.connected = Array.isArray(res.connected) ? res.connected : null;
      st.connectedError = res.connectedError || null;
      if (st.error && st.error.startsWith('Could not read')) st.error = null;
    } else fail(res, 'Could not read the accounts.');
    deps.repaint();
  }
  function refresh() {
    st.chain = (st.chain || Promise.resolve()).then(refreshOnce, refreshOnce);
    return st.chain;
  }
  async function edit(run, said) {
    if (st.busy) return false;
    const br = deps.bridge();
    if (!br) return false;
    st.busy = 'edit'; st.error = null; deps.repaint();
    const res = await call(() => run(br));
    st.busy = null;
    if (!res || !res.ok) { fail(res, 'Could not save the accounts.'); deps.repaint(); return false; }
    if (Array.isArray(res.accounts)) st.accounts = res.accounts;
    deps.changed(said);
    deps.repaint();
    return true;
  }
  function act(what) {
    const [verb, toolkit, arg] = String(what || '').split(':');
    if (verb === 'refresh') return refresh();
    if (verb === 'save') {
      const alias = cmpaAliasClean(st.drafts[arg]);
      if (alias === '' || alias === null) { st.error = alias === '' ? 'Type a name for the account first.' : CMPA_ALIAS_RULE; deps.repaint(); return; }
      const first = !st.accounts.some((a) => a.toolkit === toolkit);
      return edit((br) => br.composioAddAccount({toolkit, alias, connectedAccountId: arg, isDefault: first}), first
        ? toolkit + ' account saved as "' + alias + '" and made the default.'
        : toolkit + ' account saved as "' + alias + '".').then((done) => { if (done) { delete st.drafts[arg]; deps.repaint(); } });
    }
    if (verb === 'default') return edit((br) => br.composioSetDefault(toolkit, arg), toolkit + ' now acts through "' + arg + '".');
    if (verb === 'clear') return edit((br) => br.composioSetDefault(toolkit, null), toolkit + ' has no default now: Composio uses the account connected last.');
    if (verb === 'remove') return edit((br) => br.composioRemoveAccount(toolkit, arg), 'The name "' + arg + '" is forgotten. The ' + toolkit + ' account stays signed in on Composio.');
  }
  function draft(id, value) { st.drafts[id] = String(value == null ? '' : value); }
  return {state: st, refresh, act, draft, view: () => st};
}

/* Names typed into the card survive a repaint: the markup puts the draft back as the field's value. */
if (typeof document !== 'undefined') {
  document.addEventListener('input', (e) => {
    const id = e.target && e.target.getAttribute && e.target.getAttribute('data-cmpa-name');
    if (id && typeof CMPA !== 'undefined') CMPA.draft(id, e.target.value);
  });
}

if (typeof module !== 'undefined') {
  module.exports = {CMPA_ALIAS_RE, cmpaAliasClean, cmpaRows, cmpaSplit, composioAccountsHTML, createComposioAccounts};
}
