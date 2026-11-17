/* ---------------- Settings › Plugins (ATO-954; the TUI's /plugins panel) ----------------
   Loaded BEFORE renderer.js, so it only declares: everything it touches
   (BR, S, esc, ic, render, settingsPaneId) is read when a function runs,
   never at load time.

   Rows are the agent's own `PluginOverview` (src/plugins/plugin-overview.ts),
   read with `atag plugin list --json` through main/plugins-ipc.ts, so this
   screen and the terminal's /plugins panel count and label a plugin the same
   way. Every switch is an `atag plugin …` call: the agent stays the only
   writer of <stateDir>/plugins/plugins.json.

   "Install from folder…" asks main for the native folder picker and runs
   the same `atag plugin install <folder>` the terminal does (plugins-ipc.ts),
   so the copy, the security scan and the runs-code rule stay the agent's.
   Marketplaces (`atag plugin marketplace add <owner/repo>`) stay in the
   terminal; the footnote says so. There is no built-in catalog to feature. */

const PLG = {
  rows: null,          // PluginOverview[] once read
  err: null,           // the last read's error
  unsupported: false,  // the agent has no `plugin list --json` yet
  loading: null,       // the running list read (a promise), so a later write can queue one more
  again: false,        // a read was asked for while one was running
  busy: null,          // name of the plugin a write is running for
  cursor: 0,           // index into rows (keyboard)
  open: {},            // name → true when its parts are shown
  msg: null,           // {text, restart} after a write
  removeConfirm: null, // {name, error, submitting}
  codeConfirm: null,   // {name, parts, error, submitting}
  install: null,       // {phase: 'picking'|'installing'|'confirm'|'blocked'|'error', folder, error, findings}
};

/* ---- pure helpers (exported for test/plugins-pane.test.mjs) ---- */

const PLG_PART_KIND = {skill: 'Skill', mcp: 'MCP server', hook: 'Hook', command: 'Command', agent: 'Subagent'};

/* "2 skills · 1 MCP server · 3 hooks", or "Empty". */
function plgCountsText(c) {
  if (!c) return '';
  const parts = [[c.skills, 'skill'], [c.mcpServers, 'MCP server'], [c.hooks, 'hook'], [c.commands, 'command'], [c.agents, 'subagent']]
    .filter(([n]) => n > 0).map(([n, w]) => n + ' ' + w + (n === 1 ? '' : 's'));
  return parts.length ? parts.join(' · ') : 'Empty';
}

/* Proposed wording for the trust column (product owner decides; see the PR). */
function plgTrustText(p) {
  if (!p || p.trust === 'no-code') return 'No code';
  return p.trust === 'code-allowed' ? 'Code allowed' : 'Code off';
}

/* The row's chips, in order: runs code + trust, needs a key, files missing. */
function plgBadges(p) {
  const out = [];
  if (!p.filesOk) { out.push({text: 'Files missing', tone: 'red', title: p.error || 'Reinstall the plugin'}); return out; }
  if (p.runsCode) {
    out.push({text: 'Runs code', tone: 'line', title: (p.codeParts || []).join('; ')});
    out.push({text: plgTrustText(p), tone: p.trust === 'code-allowed' ? 'green' : 'amber',
      title: p.trust === 'code-allowed' ? 'It may run its local MCP servers, hooks and scripts and receive your keys' : 'Its local MCP servers, hooks, scripts and servers that read your keys stay off until you allow them'});
  } else {
    out.push({text: plgTrustText(p), tone: 'line', title: 'Nothing in this plugin runs a program'});
  }
  if (p.needsKey) out.push({text: 'Needs a key', tone: 'amber', title: 'Set ' + (p.missingKeys || []).join(', ') + ' in the agent\'s .env'});
  return out;
}

/* A part's own notes: runs code, off until code is allowed, missing keys. */
function plgPartNotes(p, part) {
  const out = [];
  if (part.runsCode) out.push({text: 'Runs code', tone: 'line'});
  if (p.enabled && part.enabled && !part.active) out.push({text: 'Off until code is allowed', tone: 'amber'});
  if (part.missingKeys && part.missingKeys.length) out.push({text: 'Needs ' + part.missingKeys.join(', '), tone: 'amber'});
  return out;
}

/* `toggle:demo` → {verb:'toggle', name:'demo'}; `part:demo:mcp:gh` → {verb:'part', name:'demo', part:'mcp:gh'}. */
function plgParseAct(what) {
  const s = String(what || '');
  const i = s.indexOf(':');
  if (i === -1) return {verb: s, name: null, part: null};
  const verb = s.slice(0, i), rest = s.slice(i + 1);
  if (verb !== 'part') return {verb, name: rest || null, part: null};
  const j = rest.indexOf(':');
  return j === -1 ? {verb, name: rest || null, part: null} : {verb, name: rest.slice(0, j), part: rest.slice(j + 1)};
}

/* The folder's last segment, for "Installing my-plugin…". */
function plgFolderName(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

/* "2 installed · 1 on", or nothing before the first read and while nothing is installed. */
function plgSummaryText(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  return rows.length + ' installed · ' + rows.filter((p) => p.enabled).length + ' on';
}

/* ---- data ---- */

function pluginsTabEntered() { pluginsRefresh(); }

function pluginsRefresh() {
  if (typeof BR === 'undefined' || !BR || !BR.pluginList) { PLG.err = 'Plugins need the desktop bridge.'; return; }
  // A read already running may predate a write that just landed: queue one more read after it.
  if (PLG.loading) { PLG.again = true; return PLG.loading; }
  PLG.again = false;
  PLG.loading = BR.pluginList().then((res) => {
    PLG.loading = null;
    if (PLG.again) return pluginsRefresh();
    if (res && res.ok) {
      PLG.rows = Array.isArray(res.plugins) ? res.plugins : [];
      PLG.err = null; PLG.unsupported = false;
      PLG.cursor = Math.max(0, Math.min(PLG.cursor, PLG.rows.length - 1));
    } else {
      PLG.unsupported = !!(res && res.unsupported);
      PLG.err = (res && res.error) || 'The agent did not answer.';
      if (PLG.unsupported) PLG.rows = [];
    }
    render();
  }, (err) => {
    PLG.loading = null;
    if (PLG.again) return pluginsRefresh();
    PLG.err = String(err && err.message || err); render();
  });
  render();
  return PLG.loading;
}

function plgFind(name) { return (PLG.rows || []).find((p) => p.name === name) || null; }

/* One `atag plugin …` write, then a re-read. Starting MCP servers needs the agent restarted, so that message carries the button; stopping them is live (the agent watches plugins.json). `text` replaces the agent's own line. */
function plgWrite(name, call, restart, text) {
  if (PLG.busy) return Promise.resolve();
  PLG.busy = name; PLG.msg = null; PLG.err = null;
  render();
  return call().then((res) => {
    PLG.busy = null;
    if (res && res.ok) PLG.msg = {text: text || res.message || 'Done.', restart: !!restart};
    else PLG.err = (res && res.error) || 'The agent did not answer.';
    return pluginsRefresh();
  }, (err) => { PLG.busy = null; PLG.err = String(err && err.message || err); render(); });
}

function pluginsAct(what) {
  const {verb, name, part} = plgParseAct(what);
  const p = name ? plgFind(name) : null;
  if (verb === 'refresh') { pluginsRefresh(); return; }
  if (verb === 'expand' && p) { PLG.open[p.name] = !PLG.open[p.name]; PLG.cursor = PLG.rows.indexOf(p); render(); return; }
  if (verb === 'toggle' && p) {
    plgWrite(p.name, () => BR.pluginSet(p.name, p.enabled ? 'disable' : 'enable'), !p.enabled && p.counts && p.counts.mcpServers > 0);
    return;
  }
  if (verb === 'part' && p && part) {
    const pt = (p.parts || []).find((x) => x.id === part);
    if (pt) plgWrite(p.name, () => BR.pluginSet(p.name, pt.enabled ? 'disable' : 'enable', pt.id), !pt.enabled && pt.kind === 'mcp');
    return;
  }
  if (verb === 'code' && p && p.runsCode) {
    // Stopping code needs no question; allowing it is asked first, listing what would run.
    // The running agent stops the plugin's MCP servers itself (ATO-1407): no restart.
    if (p.trust === 'code-allowed') plgWrite(p.name, () => BR.pluginSet(p.name, 'deny-code'), false);
    else { PLG.codeConfirm = {name: p.name, parts: p.codeParts || [], error: null, submitting: false}; render(); }
    return;
  }
  if (verb === 'codeCancel') { PLG.codeConfirm = null; render(); return; }
  if (verb === 'codeConfirm' && PLG.codeConfirm && !PLG.codeConfirm.submitting) {
    const c = PLG.codeConfirm;
    c.submitting = true; render();
    BR.pluginSet(c.name, 'allow-code').then((res) => {
      if (res && res.ok) { PLG.codeConfirm = null; PLG.msg = {text: res.message || 'Code allowed.', restart: true}; pluginsRefresh(); }
      else { c.submitting = false; c.error = (res && res.error) || 'The agent did not answer.'; render(); }
    });
    return;
  }
  if (verb === 'install') { plgInstallPick(); return; }
  if (verb === 'installAnyway' && PLG.install && PLG.install.phase === 'confirm') { plgInstallRun(PLG.install.folder, true); return; }
  if (verb === 'installDismiss') { PLG.install = null; render(); return; }
  if (verb === 'remove' && p) { PLG.removeConfirm = {name: p.name, error: null, submitting: false}; render(); return; }
  if (verb === 'removeCancel') { PLG.removeConfirm = null; render(); return; }
  if (verb === 'removeConfirm' && PLG.removeConfirm && !PLG.removeConfirm.submitting) {
    const c = PLG.removeConfirm;
    c.submitting = true; render();
    BR.pluginRemove(c.name).then((res) => {
      if (res && res.ok) { PLG.removeConfirm = null; delete PLG.open[c.name]; PLG.msg = {text: res.message || ('Removed ' + c.name + '.'), restart: true}; pluginsRefresh(); }
      else { c.submitting = false; c.error = (res && res.error) || 'The agent did not answer.'; render(); }
    });
  }
}

/* Install from folder…: main's picker, then `atag plugin install <folder>`; the new plugin opens in the list. */
function plgInstallPick() {
  if (typeof BR === 'undefined' || !BR || !BR.pluginPickFolder || !BR.pluginInstall) { PLG.err = 'Installing needs a newer desktop app.'; render(); return; }
  const cur = PLG.install && PLG.install.phase;
  if (cur === 'picking' || cur === 'installing' || PLG.busy) return;
  PLG.install = {phase: 'picking', folder: null, error: null, findings: []};
  PLG.msg = null;
  render();
  return BR.pluginPickFolder().then((res) => {
    const folder = res && res.ok ? res.folder : null;
    if (!folder) { PLG.install = null; render(); return; }
    return plgInstallRun(folder, false);
  }, (err) => { PLG.install = {phase: 'error', folder: null, error: String(err && err.message || err), findings: []}; render(); });
}

function plgInstallRun(folder, confirmCaution) {
  PLG.install = {phase: 'installing', folder, error: null, findings: []};
  render();
  return BR.pluginInstall(folder, !!confirmCaution).then((res) => {
    if (res && res.ok) {
      PLG.install = null;
      if (res.name) PLG.open[res.name] = true;
      const extra = res.runsCode ? ' Parts that run programs stay off until you choose Allow code.' : '';
      PLG.msg = {text: (res.message || 'Installed.') + extra, restart: !!res.startsServers};
      return pluginsRefresh();
    }
    const phase = res && res.needsConfirmation ? 'confirm' : res && res.blocked ? 'blocked' : 'error';
    PLG.install = {phase, folder, error: (res && res.error) || 'The agent did not answer.', findings: (res && res.findings) || []};
    render();
  }, (err) => { PLG.install = {phase: 'error', folder, error: String(err && err.message || err), findings: []}; render(); });
}

/* Keys, as in the TUI panel: j/k move, Enter open, e switch, c code, d remove, r refresh; y/n in a question. */
function pluginsKey(e, k, inText) {
  if (inText) return false;
  // Cmd/Ctrl/Alt combos (copy, paste, reload) are not panel keys, even inside a question.
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const confirm = PLG.removeConfirm ? 'remove' : PLG.codeConfirm ? 'code' : null;
  if (confirm) {
    if (k === 'y' || k === 'Enter') { e.preventDefault(); pluginsAct(confirm + 'Confirm'); return true; }
    if (k === 'n' || k === 'Escape') { e.preventDefault(); pluginsAct(confirm + 'Cancel'); return true; }
    return true;
  }
  const rows = PLG.rows || [];
  const p = rows[Math.max(0, Math.min(PLG.cursor, rows.length - 1))];
  if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); PLG.cursor = Math.min(PLG.cursor + 1, Math.max(0, rows.length - 1)); render(); return true; }
  if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); PLG.cursor = Math.max(PLG.cursor - 1, 0); render(); return true; }
  if (k === 'r') { e.preventDefault(); pluginsRefresh(); return true; }
  if (!p) return false;
  if (k === 'Enter') { e.preventDefault(); pluginsAct('expand:' + p.name); return true; }
  if (k === 'e') { e.preventDefault(); pluginsAct('toggle:' + p.name); return true; }
  if (k === 'c') { e.preventDefault(); pluginsAct('code:' + p.name); return true; }
  if (k === 'd') { e.preventDefault(); pluginsAct('remove:' + p.name); return true; }
  return false;
}

/* ---- view ---- */

/* Lucide "puzzle" (ISC), thin stroke: the screen's own mark, sized by the caller. */
function plgPuzzleSVG(size) {
  const n = size || 16;
  return '<svg width="' + n + '" height="' + n + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/></svg>';
}

/* What plugins are and where they come from: always shown, true facts only (src/plugins/README.md). */
const PLG_INTRO = 'Plugins add ready-made abilities to Atomic Agent: skills, tools (MCP servers) and commands, packed together.';
const PLG_SOURCES = 'A plugin is a folder. Get one from GitHub or from someone who shared it with you, then install it from that folder. Plugins made for Claude Code, Codex or Cursor work too.';

/* The install's own line: picking, copying and scanning, the scan's question, or why it stopped. */
function plgInstallHTML() {
  const st = PLG.install;
  if (!st || st.phase === 'picking') return '';
  const where = st.folder ? '<span class="mono">' + esc(plgFolderName(st.folder)) + '</span>' : '';
  if (st.phase === 'installing') {
    return '<div class="tuimsg tk-notice set-plginstall" role="status"><span class="tk-spin" aria-hidden="true"></span>'
      + '<span class="grow">Installing ' + where + '… copying it and checking every file.</span></div>';
  }
  const findings = (st.findings || []).length
    ? '<pre class="set-plgfindings">' + esc(st.findings.join('\n')) + '</pre>' : '';
  if (st.phase === 'confirm') {
    return '<div class="tk-notice tk-notice--amber set-plginstall set-plginstall--col" role="alert">'
      + '<div class="set-plginstall-row">' + ic('shield') + '<span class="grow">' + esc(st.error) + '</span></div>' + findings
      + '<div class="acts"><button class="btn btn-s sm" data-act="plugins:installDismiss">Cancel</button>'
      + '<button class="btn btn-p sm" data-act="plugins:installAnyway">Install anyway</button></div></div>';
  }
  return '<div class="tuierr tk-notice tk-notice--red set-plginstall set-plginstall--col" role="alert">'
    + '<div class="set-plginstall-row">' + ic('alert') + '<span class="grow">' + esc(st.error) + (where ? ' (' + where + ')' : '') + '</span>'
    + '<button class="iconbtn sm" data-act="plugins:installDismiss" title="Dismiss" aria-label="Dismiss">' + ic('x') + '</button></div>' + findings + '</div>';
}

function plgChipHTML(b) {
  return '<span class="tk-chip tk-chip--sm' + (b.tone ? ' tk-chip--' + b.tone : '') + '"' + (b.title ? ' title="' + esc(b.title) + '"' : '') + '>' + esc(b.text) + '</span>';
}

function plgSwitchHTML(on, act, label, disabled) {
  return '<span class="tk-switch' + (on ? ' on' : '') + '" role="switch" aria-checked="' + !!on + '" aria-label="' + esc(label) + '" title="' + esc(label) + '"'
    + ' data-act="' + esc(act) + '"' + (disabled ? ' aria-disabled="true"' : '') + '></span>';
}

function plgRowHTML(p, i) {
  const sel = i === PLG.cursor, open = !!PLG.open[p.name], busy = PLG.busy === p.name;
  const head = '<div class="tk-li set-plgrow' + (sel ? ' on' : '') + (p.enabled ? '' : ' dim') + '"' + (sel ? ' aria-selected="true"' : '') + '>'
    + (busy ? '<span class="tk-spin" aria-hidden="true"></span>'
      : plgSwitchHTML(p.enabled, 'plugins:toggle:' + p.name, (p.enabled ? 'Turn off ' : 'Turn on ') + p.name + ' (e)', PLG.busy !== null))
    + '<button class="body set-plgbody" data-act="plugins:expand:' + esc(p.name) + '" aria-expanded="' + open + '">'
      + '<span class="t"><span class="mono">' + esc(p.name) + '</span> <span class="m">' + esc(p.version || '') + '</span></span>'
      + (p.description ? '<span class="d">' + esc(p.description) + '</span>' : '')
      + '<span class="set-plgmeta">' + '<span class="sec">' + esc(plgCountsText(p.counts)) + '</span>'
        + '<span class="sec" title="' + esc(p.sourceLabel || '') + '">' + esc(p.sourceLabel || '') + '</span>'
        + plgBadges(p).map(plgChipHTML).join('') + '</span>'
    + '</button>'
    + '<span class="iconbtn sm" role="button" data-act="plugins:remove:' + esc(p.name) + '" title="Remove (d)" aria-label="Remove ' + esc(p.name) + '">' + ic('trash') + '</span>'
    + '</div>';
  return head + (open ? plgPartsHTML(p) : '');
}

function plgPartsHTML(p) {
  const code = p.runsCode
    ? '<div class="tk-notice set-softnote set-plgcode"><span class="grow">' + esc(p.trust === 'code-allowed'
        ? 'This plugin may run programs on this computer or receive your keys: ' + (p.codeParts || []).join('; ') + '.'
        : 'This plugin can run programs on this computer or receive your keys (' + (p.codeParts || []).join('; ') + '). Those parts stay off until you allow them.') + '</span>'
      + '<button class="btn ' + (p.trust === 'code-allowed' ? 'btn-s' : 'btn-p') + ' sm" data-act="plugins:code:' + esc(p.name) + '"' + (PLG.busy ? ' disabled' : '') + ' title="' + (p.trust === 'code-allowed' ? 'Stop its code (C)' : 'Allow code (C)') + '">'
      + (p.trust === 'code-allowed' ? 'Stop its code' : 'Allow code…') + '</button></div>'
    : '';
  const notes = (p.notes || []).length ? '<details class="set-softnote"><summary>Notes (' + p.notes.length + ')</summary><pre>' + esc(p.notes.join('\n')) + '</pre></details>' : '';
  if (!p.filesOk) return '<div class="set-plgparts"><div class="tuierr tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(p.error || 'Plugin files are missing.') + '</span></div></div>';
  const parts = (p.parts || []).map((pt) => '<div class="tk-li set-plgpart' + (pt.active ? '' : ' dim') + '">'
      + plgSwitchHTML(pt.enabled, 'plugins:part:' + p.name + ':' + pt.id, (pt.enabled ? 'Turn off ' : 'Turn on ') + pt.name, PLG.busy !== null)
      + '<span class="tk-chip tk-chip--sm tk-chip--line">' + esc(PLG_PART_KIND[pt.kind] || pt.kind) + '</span>'
      + '<span class="t mono" title="' + esc(pt.id) + '">' + esc(pt.name) + '</span>'
      + '<span class="grow"></span>' + plgPartNotes(p, pt).map(plgChipHTML).join('')
      + '</div>').join('');
  return '<div class="set-plgparts">' + code + (parts || '<p class="set-cap">This plugin ships nothing the agent uses yet.</p>') + notes + '</div>';
}

function plgRemoveConfirmHTML() {
  const c = PLG.removeConfirm;
  return '<div class="set-overlay"><div class="tk-modal tk-modal--danger set-modal" role="alertdialog" aria-label="Remove plugin">'
    + '<div class="set-mhead"><span class="tk-ico tk-ico--red">' + ic('trash') + '</span><h4>Remove plugin</h4></div>'
    + '<p>Remove <b class="mono">' + esc(c.name) + '</b> and delete its files? Its skills, commands and MCP servers go with it.</p>'
    + (c.error ? '<div class="tuierr tk-help tk-help--err">' + esc(c.error) + '</div>' : '')
    + (c.submitting ? '<div class="acts"><span class="tk-spin"></span><span class="set-cap">removing…</span></div>'
        : '<div class="acts"><button class="btn btn-s sm" data-act="plugins:removeCancel" title="Keep (N)">Keep</button>'
          + '<button class="btn btn-df sm" data-act="plugins:removeConfirm" title="Remove (Y)">Remove</button></div>')
    + '</div></div>';
}

function plgCodeConfirmHTML() {
  const c = PLG.codeConfirm;
  return '<div class="set-overlay"><div class="tk-modal set-modal" role="alertdialog" aria-label="Allow code">'
    + '<div class="set-mhead"><span class="tk-ico tk-ico--amber">' + ic('shield') + '</span><h4>Allow this plugin to run code and use your keys?</h4></div>'
    + '<p><b class="mono">' + esc(c.name) + '</b> can start programs on this computer or receive your keys:</p>'
    + '<ul class="set-plglist">' + c.parts.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>'
    + '<p class="set-cap">Allow it only if you trust where it came from. You can stop it again here or with <span class="mono">atag plugin deny-code ' + esc(c.name) + '</span>.</p>'
    + (c.error ? '<div class="tuierr tk-help tk-help--err">' + esc(c.error) + '</div>' : '')
    + (c.submitting ? '<div class="acts"><span class="tk-spin"></span><span class="set-cap">saving…</span></div>'
        : '<div class="acts"><button class="btn btn-s sm" data-act="plugins:codeCancel" title="Not now (N)">Not now</button>'
          + '<button class="btn btn-p sm" data-act="plugins:codeConfirm" title="Allow code (Y)">Allow code</button></div>')
    + '</div></div>';
}

function pluginsTab() {
  const rows = PLG.rows || [];
  const summary = plgSummaryText(PLG.rows);
  const installing = !!PLG.install && (PLG.install.phase === 'picking' || PLG.install.phase === 'installing');
  const canInstall = !PLG.unsupported;
  // What plugins are first, always; then the list's own row: label and counts left, actions right.
  const about = '<div class="set-plgabout"><p class="set-plgintro">' + esc(PLG_INTRO) + '</p>'
    + '<p class="set-plgintro set-plgintro--2">' + esc(PLG_SOURCES) + '</p></div>';
  const head = '<div class="set-plghead">'
    + '<h4 class="set-plgtitle">Installed</h4>'
    + (summary ? '<span class="set-counts">' + esc(summary) + '</span>' : '')
    + '<span class="grow"></span>'
    + '<button class="iconbtn sm" data-act="plugins:refresh" title="Refresh (r)" aria-label="Refresh"' + (PLG.loading ? ' disabled aria-busy="true"><span class="tk-spin"></span>' : '>' + ic('refresh')) + '</button>'
    + (canInstall ? '<button class="btn btn-p sm" data-act="plugins:install"' + (installing || PLG.busy ? ' disabled aria-busy="true"' : '') + '>Install from folder…</button>' : '')
    + '</div>';
  let body;
  if (PLG.unsupported) {
    body = '<div class="tk-empty set-empty set-plgempty"><span class="set-plgmark set-plgmark--lg" aria-hidden="true">' + plgPuzzleSVG(28) + '</span><h4>Plugins need a newer agent</h4><p>' + esc(PLG.err || '') + '</p></div>';
  } else if (!PLG.rows) {
    body = PLG.err ? '' : '<div class="tk-empty set-empty set-plgempty"><span class="tk-spin"></span><p>reading plugins…</p></div>';
  } else if (!rows.length) {
    body = '<div class="tk-empty set-empty set-plgempty"><span class="set-plgmark set-plgmark--lg" aria-hidden="true">' + plgPuzzleSVG(28) + '</span>'
      + '<h4>No plugins yet</h4>'
      + '<p>Choose <b>Install from folder…</b> and pick the plugin\'s folder. It shows up here with a switch to turn it on or off.</p></div>';
  } else {
    body = '<div class="tk-list set-plglist-rows">' + rows.map(plgRowHTML).join('') + '</div>';
  }
  const foot = PLG.unsupported ? '' : '<p class="set-plgfoot">From a terminal: <span class="mono">atag plugin install &lt;folder&gt;</span>, or add a plugin marketplace from GitHub with <span class="mono">atag plugin marketplace add &lt;owner/repo&gt;</span>.</p>';
  const msg = PLG.msg ? (PLG.msg.restart ? restartLine(PLG.msg.text) : '<div class="tuimsg tk-notice tk-notice--blue">' + ic('info') + '<span class="grow">' + esc(PLG.msg.text) + '</span></div>') : '';
  const err = PLG.err && !PLG.unsupported ? '<div class="tuierr tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(PLG.err) + '</span></div>' : '';
  const overlay = PLG.removeConfirm ? plgRemoveConfirmHTML() : PLG.codeConfirm ? plgCodeConfirmHTML() : '';
  return '<div class="set-pane set-plugins">' + about + head + plgInstallHTML() + err + msg + body + foot + overlay + '</div>';
}

if (typeof module !== 'undefined') module.exports = {plgCountsText, plgTrustText, plgBadges, plgPartNotes, plgParseAct, plgFolderName, plgSummaryText, PLG_INTRO, PLG_SOURCES};
