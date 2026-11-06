/* ATO-1144: Settings › Privacy › Approval rules. The rules the agent keeps
   (GET /api/approval-rules): its own file's rules, each with a Delete
   (DELETE /api/approval-rules/:id), and the ask/deny rules of the chat's
   folder (.atomic-agent/approval-rules.json), shown read-only: the person
   edits that file, not this window. An agent from before the route says
   "Update the agent to manage rules" and changes nothing.
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/approval-rules.test.mjs). No DOM, no IPC of its own. */

const ARULES_EMPTY = 'No saved rules yet. Choose ‘Always allow’ on an approval to add one.';
const ARULES_OLD_AGENT = 'Update the agent to manage rules.';
const ARULES_PROJECT_FILE = '.atomic-agent/approval-rules.json';

/** The folder the project file sits in: `<dir>/.atomic-agent/approval-rules.json` → `<dir>`. */
function arulesHere(data) {
  const p = data && typeof data.projectPath === 'string' ? data.projectPath : '';
  const m = /^(.*?)[\\/]\.atomic-agent[\\/]approval-rules\.json$/.exec(p);
  return m ? m[1] : '';
}

/** What a rule does, in one plain line: `Always allow "git status"`.
    deps.categoryPlain(cat): the category in words ("run a terminal command");
    deps.pathText(p): a path as a person reads it (~ for home). */
function arulesSentence(rule, deps) {
  const d = deps || {};
  const r = rule || {};
  const verb = r.decision === 'deny' ? 'Never allow' : r.decision === 'ask' ? 'Always ask before' : 'Always allow';
  const prefix = Array.isArray(r.commandPrefix) ? r.commandPrefix.filter((x) => typeof x === 'string' && x) : [];
  let what;
  if (prefix.length) what = verb + ' "' + prefix.join(' ') + '"';
  else if (r.tool) what = verb + ' the ' + r.tool + ' tool';
  else if (r.category) what = verb + ': ' + ((d.categoryPlain && d.categoryPlain(r.category)) || r.category);
  else what = verb + ' every request';
  if (r.path) what += ' in ' + (d.pathText ? d.pathText(r.path) : r.path);
  return what;
}

/** Where it applies. `here`: the chat's folder, so its own rules read "this project". */
function arulesScope(rule, here, deps) {
  const p = rule && typeof rule.project === 'string' ? rule.project : '';
  if (!p) return {text: 'everywhere', title: 'Applies in every folder'};
  const strip = (s) => String(s).replace(/[\\/]+$/, '');
  if (here && strip(p) === strip(here)) return {text: 'this project', title: p};
  const base = strip(p).split(/[\\/]/).pop() || p;
  return {text: 'project ' + base, title: deps && deps.pathText ? deps.pathText(p) : p};
}

/** "added 6 Nov 2026", or '' for a rule with no readable date. */
function arulesAdded(rule) {
  const t = rule && rule.createdAt ? Date.parse(rule.createdAt) : NaN;
  if (!Number.isFinite(t)) return '';
  return 'added ' + new Date(t).toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric'});
}

function arulesList(v) {
  return Array.isArray(v) ? v.filter((r) => r && typeof r === 'object' && typeof r.id === 'string') : [];
}

/* `api.read(sessionId)` → {supported:false} | {supported:true, ok:true, data} | {supported:true, ok:false, error}
   `api.remove(id)`     → {supported:false} | {ok:true} | {ok:false, notFound?, error} */
function createApprovalRules(api) {
  const st = {supported: null, loading: false, error: null, data: null, busy: new Set(), serial: 0};
  return {
    state: st,
    /* Read again. A late answer for an older read is dropped. */
    async load(sessionId) {
      const mine = ++st.serial;
      st.loading = true;
      const res = await Promise.resolve().then(() => api.read(sessionId)).catch((error) => ({supported: true, ok: false, error: String(error)}));
      if (mine !== st.serial) return st;
      st.loading = false;
      if (!res || res.supported === false) { st.supported = false; st.data = null; st.error = null; return st; }
      st.supported = true;
      if (!res.ok) { st.error = res.error || 'could not read the rules'; return st; }
      const d = res.data || {};
      st.error = null;
      st.data = {rules: arulesList(d.rules), projectRules: arulesList(d.projectRules).filter((r) => r.decision !== 'allow'),
        globalPath: typeof d.globalPath === 'string' ? d.globalPath : '', projectPath: typeof d.projectPath === 'string' ? d.projectPath : ''};
      return st;
    },
    /* Another agent is on the wire: it may have the route the last one lacked. */
    reset() {
      st.supported = null; st.serial++; st.loading = false; st.error = null; st.data = null; st.busy.clear();
    },
    /* Delete one of the agent's own rules. One already gone (404) is gone here too. */
    async remove(id) {
      if (!id || st.busy.has(id) || !st.data || !st.data.rules.some((r) => r.id === id)) return {ok: false};
      st.busy.add(id);
      const res = await Promise.resolve().then(() => api.remove(id)).catch((error) => ({ok: false, error: String(error)}));
      st.busy.delete(id);
      if (!res || res.supported === false) { st.supported = false; st.data = null; return {ok: false, unsupported: true}; }
      if (res.ok || res.notFound) {
        if (st.data) st.data.rules = st.data.rules.filter((r) => r.id !== id);
        st.error = null;
        return {ok: true};
      }
      st.error = 'Couldn’t delete the rule: ' + (res.error || 'unknown error');
      return res;
    },
  };
}

/** The block under Privacy's settings. deps: {esc, categoryPlain, pathText}. */
function approvalRulesHTML(st, deps) {
  const {esc} = deps;
  const head = '<div class="tk-sh set-arules-sh"><span>Approval rules</span></div>';
  const note = (text, cls) => '<p class="set-cap set-privnote' + (cls ? ' ' + cls : '') + '">' + text + '</p>';
  if (st.supported === false) return head + note(esc(ARULES_OLD_AGENT), 'set-arules-old');
  const err = st.error ? '<div class="tk-help tk-help--warn set-privnote set-arules-err">' + esc(st.error)
    + ' <button class="set-link" data-act="arules:reload">Try again</button></div>' : '';
  if (!st.data) {
    if (st.error) return head + err;
    return head + note('<span class="tk-spin"></span> Loading rules…', 'set-arules-loading');
  }
  const here = arulesHere(st.data);
  const row = (rule, own) => {
    const scope = arulesScope(rule, here, deps);
    const added = arulesAdded(rule);
    const bits = ['<span title="' + esc(scope.title) + '">' + esc(scope.text) + '</span>'];
    if (own && added) bits.push(esc(added));
    if (!own) bits.push(esc('from ' + ARULES_PROJECT_FILE + ' in this project'));
    if (rule.note) bits.push(esc(rule.note));
    return '<div class="tk-setrow set-arule" data-arule="' + esc(rule.id) + '">'
      + '<div class="body"><div class="t">' + esc(arulesSentence(rule, deps)) + '</div>'
        + '<div class="d">' + bits.join(' · ') + '</div></div>'
      + (own ? '<button class="btn btn-s sm" data-act="arules:del:' + esc(rule.id) + '"' + (st.busy.has(rule.id) ? ' disabled' : '')
        + ' title="Delete this rule. Atomic Agent asks about it again.">Delete</button>' : '')
      + '</div>';
  };
  const rows = st.data.rules.map((r) => row(r, true)).concat(st.data.projectRules.map((r) => row(r, false)));
  if (!rows.length) return head + note(esc(ARULES_EMPTY), 'set-arules-empty') + err;
  return head + '<div class="tk-list set-setlist set-arules">' + rows.join('') + '</div>' + err;
}

if (typeof module !== 'undefined') module.exports = {ARULES_EMPTY, ARULES_OLD_AGENT, ARULES_PROJECT_FILE, arulesHere, arulesSentence, arulesScope, arulesAdded, createApprovalRules, approvalRulesHTML};
