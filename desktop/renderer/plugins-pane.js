/* ---------------- Settings › Plugins (ATO-954; the TUI's /plugins panel) ----------------
   Loaded BEFORE renderer.js, so it only declares: everything it touches
   (BR, S, esc, ic, render, settingsPaneId) is read when a function runs,
   never at load time.

   Rows are the agent's own `PluginOverview` (src/plugins/plugin-overview.ts),
   read with `atag plugin list --json` through main/plugins-ipc.ts, so this
   screen and the terminal's /plugins panel count and label a plugin the same
   way. Every switch is an `atag plugin …` call: the agent stays the only
   writer of <stateDir>/plugins/plugins.json.

   Installing is not here: `atag plugin install <folder>` (and the
   marketplace flow, a separate item) own it; the empty state says so. */

const PLG = {
  rows: null,          // PluginOverview[] once read
  err: null,           // the last read's error
  unsupported: false,  // the agent has no `plugin list --json` yet
  loading: false,
  busy: null,          // name of the plugin a write is running for
  cursor: 0,           // index into rows (keyboard)
  open: {},            // name → true when its parts are shown
  msg: null,           // {text, restart} after a write
  removeConfirm: null, // {name, error, submitting}
  codeConfirm: null,   // {name, parts, error, submitting}
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
      title: p.trust === 'code-allowed' ? 'Its local MCP servers, hooks and scripts may run' : 'Its local MCP servers, hooks and scripts stay off until you allow them'});
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

/* ---- data ---- */

function pluginsTabEntered() { pluginsRefresh(); }

function pluginsRefresh() {
  if (typeof BR === 'undefined' || !BR || !BR.pluginList) { PLG.err = 'Plugins need the desktop bridge.'; return; }
  if (PLG.loading) return;
  PLG.loading = true;
  render();
  return BR.pluginList().then((res) => {
    PLG.loading = false;
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
  }, (err) => { PLG.loading = false; PLG.err = String(err && err.message || err); render(); });
}

function plgFind(name) { return (PLG.rows || []).find((p) => p.name === name) || null; }

/* One `atag plugin …` write, then a re-read. MCP changes need the agent restarted, so that message carries the button. */
function plgWrite(name, call, restart) {
  if (PLG.busy) return Promise.resolve();
  PLG.busy = name; PLG.msg = null; PLG.err = null;
  render();
  return call().then((res) => {
    PLG.busy = null;
    if (res && res.ok) PLG.msg = {text: res.message || 'Done.', restart: !!restart};
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
    plgWrite(p.name, () => BR.pluginSet(p.name, p.enabled ? 'disable' : 'enable'), p.counts && p.counts.mcpServers > 0);
    return;
  }
  if (verb === 'part' && p && part) {
    const pt = (p.parts || []).find((x) => x.id === part);
    if (pt) plgWrite(p.name, () => BR.pluginSet(p.name, pt.enabled ? 'disable' : 'enable', pt.id), pt.kind === 'mcp');
    return;
  }
  if (verb === 'code' && p && p.runsCode) {
    // Stopping code is safe at once; allowing it is asked first, listing what would run.
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

/* Keys, as in the TUI panel: j/k move, Enter open, e switch, c code, d remove, r refresh; y/n in a question. */
function pluginsKey(e, k, inText) {
  if (inText) return false;
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
        ? 'This plugin may run programs on this computer: ' + (p.codeParts || []).join('; ') + '.'
        : 'This plugin can run programs on this computer (' + (p.codeParts || []).join('; ') + '). Those parts stay off until you allow them.') + '</span>'
      + '<button class="btn ' + (p.trust === 'code-allowed' ? 'btn-s' : 'btn-p') + ' sm" data-act="plugins:code:' + esc(p.name) + '"' + (PLG.busy ? ' disabled' : '') + ' title="c">'
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
        : '<div class="acts"><button class="btn btn-s sm" data-act="plugins:removeCancel" title="[n] cancel">Keep</button>'
          + '<button class="btn btn-df sm" data-act="plugins:removeConfirm" title="[y] remove">Remove</button></div>')
    + '</div></div>';
}

function plgCodeConfirmHTML() {
  const c = PLG.codeConfirm;
  return '<div class="set-overlay"><div class="tk-modal set-modal" role="alertdialog" aria-label="Allow code">'
    + '<div class="set-mhead"><span class="tk-ico tk-ico--amber">' + ic('shield') + '</span><h4>Allow this plugin to run code?</h4></div>'
    + '<p><b class="mono">' + esc(c.name) + '</b> can start programs on this computer:</p>'
    + '<ul class="set-plglist">' + c.parts.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>'
    + '<p class="set-cap">Allow it only if you trust where it came from. You can stop it again here or with <span class="mono">atag plugin deny-code ' + esc(c.name) + '</span>.</p>'
    + (c.error ? '<div class="tuierr tk-help tk-help--err">' + esc(c.error) + '</div>' : '')
    + (c.submitting ? '<div class="acts"><span class="tk-spin"></span><span class="set-cap">saving…</span></div>'
        : '<div class="acts"><button class="btn btn-s sm" data-act="plugins:codeCancel" title="[n] cancel">Not now</button>'
          + '<button class="btn btn-p sm" data-act="plugins:codeConfirm" title="[y] allow">Allow code</button></div>')
    + '</div></div>';
}

function pluginsTab() {
  const rows = PLG.rows || [];
  const on = rows.filter((p) => p.enabled).length;
  const bar = '<div class="tuibar tk-bar set-toolbar"><div class="set-tbrow">'
    + '<span class="set-counts">' + (PLG.rows ? rows.length + ' installed · ' + on + ' on' : '') + '</span><span class="grow"></span>'
    + '<button class="iconbtn sm" data-act="plugins:refresh" title="Refresh (r)" aria-label="Refresh"' + (PLG.loading ? ' disabled aria-busy="true"><span class="tk-spin"></span>' : '>' + ic('refresh')) + '</button>'
    + '</div></div>';
  let body;
  if (PLG.unsupported) {
    body = '<div class="tk-empty set-empty"><span class="tk-ico tk-ico--lg" aria-hidden="true">' + ic('puzzle') + '</span><h4>Plugins need a newer agent</h4><p>' + esc(PLG.err || '') + '</p></div>';
  } else if (!PLG.rows) {
    body = PLG.err ? '' : '<div class="tk-empty set-empty"><span class="tk-spin"></span><p>reading plugins…</p></div>';
  } else if (!rows.length) {
    body = '<div class="tk-empty set-empty"><span class="tk-ico tk-ico--lg" aria-hidden="true">' + ic('puzzle') + '</span><h4>No plugins installed</h4>'
      + '<p>Plugins bundle skills, MCP servers, hooks and commands. Install one from a terminal:</p>'
      + '<p class="mono">atag plugin install &lt;folder&gt;</p></div>';
  } else {
    body = '<div class="tk-list set-plglist-rows">' + rows.map(plgRowHTML).join('') + '</div>';
  }
  const msg = PLG.msg ? (PLG.msg.restart ? restartLine(PLG.msg.text) : '<div class="tuimsg tk-notice tk-notice--blue">' + ic('info') + '<span class="grow">' + esc(PLG.msg.text) + '</span></div>') : '';
  const err = PLG.err && !PLG.unsupported ? '<div class="tuierr tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(PLG.err) + '</span></div>' : '';
  const overlay = PLG.removeConfirm ? plgRemoveConfirmHTML() : PLG.codeConfirm ? plgCodeConfirmHTML() : '';
  return '<div class="set-pane set-plugins">' + bar + err + msg + body + overlay + '</div>';
}

if (typeof module !== 'undefined') module.exports = {plgCountsText, plgTrustText, plgBadges, plgPartNotes, plgParseAct};
