/* Shared by the renderer and Node checks; no filesystem or permission policy. */
function workspaceSkillCommands(rows, builtins) {
  const reserved = new Set(builtins.flatMap(row => [row[0], ...(row[3] || [])]));
  const seen = new Set();
  return (rows || []).filter(row => row.enabled && /^[\w.-]{1,64}$/.test(row.name)
    && !reserved.has(row.name) && !seen.has(row.name) && seen.add(row.name))
    .map(row => [row.name, row.description, 'skill']);
}
function workspaceSkillMessage(name, input) {
  return 'Use the ' + JSON.stringify(name) + ' skill. Load its instructions with skill.view('
    + JSON.stringify({name}) + ') before proceeding.' + (input ? '\n\n' + input : '');
}
function createSkillCatalogLoader(read) {
  let serial = 0, pending = null;
  return {
    load(key, sessionId) {
      if (pending && pending.key === key) return pending.promise;
      const version = ++serial;
      const promise = Promise.resolve().then(() => read(sessionId))
        .catch(error => ({ok:false, error:String(error)}))
        .then(result => ({current: version === serial, result}))
        .finally(() => { if (pending && pending.version === version) pending = null; });
      pending = {key, version, promise};
      return promise;
    },
  };
}
/* ATO-1102: "Test skill" on the skill card. main/skill-eval-ipc.ts runs `atag skill eval`; these draw its answer. */
function skillEvalDuration(seconds) {
  if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60), rest = s % 60;
  if (m < 60) return m + ' min' + (rest ? ' ' + rest + ' s' : '');
  return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
}
function skillEvalTokens(tokens) {
  if (typeof tokens !== 'number' || !isFinite(tokens) || tokens < 0) return null;
  if (tokens < 1000) return Math.round(tokens) + ' tokens';
  const k = tokens / 1000;
  return (k < 100 ? k.toFixed(1).replace(/\.0$/, '') : String(Math.round(k))) + 'k tokens';
}
function skillEvalCost(usd) {
  if (typeof usd !== 'number' || !isFinite(usd) || usd <= 0) return null; // 0 is a local model: nothing to say
  return '$' + (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2));
}
function skillEvalLine(label, side, unit) {
  const pct = side.runs ? Math.round(side.accuracy * 100) : 0;
  const parts = [side.passed + ' of ' + side.runs + ' ' + unit + ' passed' + (side.runs ? ' (' + pct + '%)' : '')];
  const time = skillEvalDuration(side.secondsMean), tokens = skillEvalTokens(side.tokens), cost = skillEvalCost(side.costUsd);
  if (time && side.runs && side.secondsMean > 0) parts.push(time + ' per task');
  if (tokens) parts.push(tokens);
  if (cost) parts.push(cost);
  return {label, text: parts.join(', ')};
}
/* The result in plain words (main/skill-eval-cli.ts reads #1307's `summary`):
   one line per variant, then what the skill changed, then anything to know. */
function skillEvalSummary(result) {
  const w = result.with, wo = result.without, d = result.delta;
  const unit = result.repeat > 1 ? 'runs' : 'tasks';
  const lines = [skillEvalLine('With the skill', w, unit), skillEvalLine('Without it', wo, unit)];
  const n = (k, word) => k + ' ' + word + ' ' + (k === 1 ? unit.slice(0, -1) : unit);
  let verdict;
  if (!w.runs && !wo.runs) verdict = 'The task set has no tasks.';
  else if (!d) verdict = 'The two runs cannot be compared.';
  else {
    const diff = w.passed - wo.passed, pts = Math.round(d.accuracy * 100);
    if (w.runs === wo.runs && diff > 0) verdict = 'The skill helped: ' + n(diff, 'more') + ' passed.';
    else if (w.runs === wo.runs && diff < 0) verdict = 'The skill made it worse: ' + n(-diff, 'fewer') + ' passed.';
    else if (pts > 0) verdict = 'The skill helped: the pass rate is ' + pts + ' points higher.';
    else if (pts < 0) verdict = 'The skill made it worse: the pass rate is ' + (-pts) + ' points lower.';
    else verdict = 'No difference in passed ' + unit + '.';
    const extra = [], t = skillEvalDuration(Math.abs(d.secondsMean));
    if (t && Math.round(Math.abs(d.secondsMean)) >= 1) extra.push(t + (d.secondsMean > 0 ? ' slower' : ' faster') + ' per task');
    if (typeof d.tokens === 'number' && d.tokens !== 0) {
      extra.push(skillEvalTokens(Math.abs(d.tokens)).replace(/ tokens$/, '') + (d.tokens > 0 ? ' more tokens' : ' fewer tokens'));
    }
    if (extra.length) verdict += ' With the skill: ' + extra.join(', ') + '.';
  }
  const notes = [];
  if (!result.complete) notes.push('Stopped early: not every run finished.');
  const errors = w.errors + wo.errors;
  if (errors) notes.push(errors + (errors === 1 ? ' run' : ' runs') + ' ended in an error or ran out of time.');
  if (result.approvalsDenied) notes.push(result.approvalsDenied + (result.approvalsDenied === 1 ? ' action needed' : ' actions needed') + ' your approval and ' + (result.approvalsDenied === 1 ? 'was' : 'were') + ' refused, since nobody can answer during a test.');
  return {lines, verdict, notes};
}
/* The card's block. Nothing at all unless main said this skill can be tested here
   (the agent has `skill eval` and the skill has a task set beside its SKILL.md): no button that cannot work. */
function skillEvalHTML(st, esc) {
  const probe = st.probe;
  if (!probe || !probe.available) return '';
  const name = st.name, mine = st.runningName === name, other = !!st.runningName && !mine;
  let out = '<div class="set-softnote set-skeval"><div class="acts">';
  if (mine) {
    out += '<span class="tk-spin"></span><span class="set-cap grow">' + (st.cancelling ? 'Stopping the test…' : 'Testing: each task runs with and without the skill. This can take a few minutes.') + '</span>'
      + '<button class="btn btn-s sm" data-act="skills:testCancel"' + (st.cancelling ? ' disabled' : '') + '>Cancel</button>';
  } else {
    out += '<button class="btn btn-s sm" data-act="skills:test:' + esc(name) + '"' + (other ? ' disabled title="Another skill test is running"' : '') + '>Test skill</button>'
      + '<span class="set-cap grow">' + (other ? 'Another skill test is running.' : 'Runs the tasks in ' + esc(probe.tasksFile ? probe.tasksFile.split(/[\\/]/).pop() : 'tasks.yaml') + ' with and without this skill.') + '</span>';
  }
  out += '</div>';
  const o = !mine && st.outcome;
  if (o && o.ok && o.result) {
    const sum = skillEvalSummary(o.result);
    out += sum.lines.map(l => '<p class="set-cap"><b>' + esc(l.label) + ':</b> ' + esc(l.text) + '</p>').join('')
      + '<p class="set-desc">' + esc(sum.verdict) + '</p>'
      + sum.notes.map(t => '<p class="set-cap">' + esc(t) + '</p>').join('')
      + (o.savedPath ? '<p class="set-cap">Saved to <span class="mono">' + esc(o.savedPath) + '</span></p>' : '');
  } else if (o && o.cancelled) out += '<p class="set-cap">Test stopped.</p>';
  else if (o) out += '<div class="tuierr tk-help tk-help--err">' + esc(o.error || 'The test did not finish.') + '</div>';
  return out + '</div>';
}
/* ATO-67 (Nadya 18.11): skills the agent learned from a turn that read outside content wait as drafts
   until the person looks at them. main/skill-drafts-ipc.ts reads `atag skill list --json` (status
   "pending") and runs `atag skill learned show|approve|discard <id>`; these draw the "Pending review"
   group above the skill rows, a draft's read-only preview and the Discard confirm. Every string
   from the agent (the model's reason, the skill name, the SKILL.md, the sources) goes through esc. */
const SKILL_DRAFT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/; // main/skill-drafts-cli.ts
function skillDraftKindLabel(kind) { return kind === 'patch' ? 'Update' : 'New skill'; }
/* A plain skill list never shows a draft as an installed (disabled) skill. */
function skillRowsWithoutDrafts(rows) {
  return (rows || []).filter(row => !row || row.status !== 'pending');
}
/* The group: the drafts main returned, valid ids only, once each, oldest first as main lists them. null when there are none. */
function skillDraftsGroup(rows) {
  const seen = new Set();
  const list = (rows || []).filter(r => r && typeof r.id === 'string' && SKILL_DRAFT_ID_RE.test(r.id) && !seen.has(r.id) && seen.add(r.id))
    .map(r => ({id: r.id, name: String(r.name || r.id), kind: r.kind === 'patch' ? 'patch' : 'create', reason: String(r.reason || '')}));
  return list.length ? {label: 'Pending review', count: list.length, rows: list} : null;
}
/* ATO-2745: a failed call's raw answer, folded under its plain line. */
function skillDraftDetailsHTML(detail, esc) {
  return detail ? '<details class="set-errmore"><summary>Details</summary><span>' + esc(detail) + '</span></details>' : '';
}
function skillDraftsListHTML(st, esc) {
  const group = skillDraftsGroup(st.rows);
  if (!group) return '';
  const busy = id => st.busyId === id;
  return '<div class="tk-list set-sklist set-skdrafts" data-skill-drafts="' + group.count + '">'
    + '<div class="set-tlfam"><span class="set-tlgn">' + esc(group.label) + '</span> <span class="tk-chip tk-chip--sm tk-chip--amber" aria-label="' + group.count + ' pending">' + group.count + '</span>'
    + '<span class="set-tlwhat">Learned from outside content. Nothing is saved until you approve it.</span></div>'
    + (st.error ? '<div class="tuierr tk-help tk-help--err">' + esc(st.error) + skillDraftDetailsHTML(st.errorDetail, esc) + '</div>' : '')
    + group.rows.map(r => '<div class="tk-li set-skdraft" data-skill-draft="' + esc(r.id) + '">'
      + '<span class="t mono" title="' + esc(r.name) + '">' + esc(r.name) + '</span> '
      + '<span class="tk-chip tk-chip--sm' + (r.kind === 'patch' ? ' tk-chip--blue' : ' tk-chip--line') + '">' + skillDraftKindLabel(r.kind) + '</span>'
      + (r.reason ? '<p class="set-cap d">' + esc(r.reason) + '</p>' : '')
      + '<div class="acts">'
        + '<button class="btn btn-s sm" data-act="skills:draft:show:' + esc(r.id) + '"' + (busy(r.id) ? ' disabled' : '') + '>Show</button>'
        + '<button class="btn btn-blue sm" data-act="skills:draft:approve:' + esc(r.id) + '"' + (st.busyId ? ' disabled' : '') + '>Approve</button>'
        + '<button class="btn btn-danger sm" data-act="skills:draft:discard:' + esc(r.id) + '"' + (st.busyId ? ' disabled' : '') + '>Discard</button>'
        + (busy(r.id) ? '<span class="tk-spin"></span>' : '')
      + '</div></div>').join('')
    + '</div>';
}
/* The draft's preview, read-only, where a skill's detail sits: the diff for an update, the draft SKILL.md for a new skill, then its sources. */
function skillDraftDetailHTML(st, esc) {
  const open = st.open;
  if (!open) return '';
  const back = '<button class="btn btn-g sm set-flush" data-act="skills:draft:close" title="Back to all skills (Esc)">All skills</button>';
  if (!open.draft) {
    return '<div class="tk-bar">' + back + '</div>'
      + (open.error ? '<div class="tuierr tk-help tk-help--err">' + esc(open.error) + skillDraftDetailsHTML(open.errorDetail, esc) + '</div>'
        : '<div class="tk-out set-skmd set-loading" role="status"><span class="tk-spin"></span>Loading the draft…</div>');
  }
  const d = open.draft, patch = d.kind === 'patch';
  const text = patch && d.diff ? d.diff : d.skillMd;
  const sources = Array.isArray(d.sources) ? d.sources : [];
  return '<div class="tk-bar">' + back + '<span class="grow"></span>'
      + '<button class="btn btn-blue sm" data-act="skills:draft:approve:' + esc(d.id) + '"' + (st.busyId ? ' disabled' : '') + '>Approve</button>'
      + '<button class="btn btn-danger sm" data-act="skills:draft:discard:' + esc(d.id) + '"' + (st.busyId ? ' disabled' : '') + '>Discard</button>'
    + '</div>'
    + '<div class="set-titlerow"><h3 class="set-dtitle mono">' + esc(d.skill || open.name || d.id) + '</h3>'
      + '<span class="tk-chip tk-chip--sm tk-chip--amber">Pending review</span>'
      + '<span class="tk-chip tk-chip--sm">' + skillDraftKindLabel(d.kind) + '</span></div>'
    + (d.reason ? '<p class="set-desc">' + esc(d.reason) + '</p>' : '')
    + '<p class="set-cap">' + (sources.length ? 'Learned from:' : 'No sources were recorded.') + '</p>'
    + (sources.length ? '<ul class="set-cap set-skdsrc">' + sources.map(s => '<li class="mono">' + esc(s) + '</li>').join('') + '</ul>' : '')
    + '<p class="set-cap">' + (patch ? (d.diff ? 'Changes to ' : 'The new text of ') + '<span class="mono">' + esc(d.path || 'SKILL.md') + '</span>' : 'The draft SKILL.md') + ' (read-only)</p>'
    + '<pre class="tk-out set-skmd" data-skill-draft-preview="' + (patch && d.diff ? 'diff' : 'skill') + '">' + esc(text || '') + '</pre>';
}
/* Discard is final: the same red confirm as Remove skill. */
function skillDraftConfirmHTML(st, esc) {
  const c = st.confirm;
  if (!c) return '';
  return '<div class="set-overlay"><div class="tk-modal tk-modal--danger set-modal" role="alertdialog" aria-label="Discard learned skill">'
    + '<div class="set-mhead"><h4>Discard learned skill</h4></div>'
    + '<p>Discard the draft <b class="mono">' + esc(c.name) + '</b>? It is deleted and cannot be restored.</p>'
    + (c.error ? '<div class="tuierr tk-help tk-help--err">' + esc(c.error) + skillDraftDetailsHTML(c.errorDetail, esc) + '</div>' : '')
    + (c.submitting ? '<div class="acts" role="status"><span class="tk-spin"></span><span class="set-cap">Discarding the draft…</span></div>'
      : '<div class="acts"><button class="btn btn-s sm" data-act="skills:draft:cancel" title="Cancel (N)">Cancel</button>'
        + '<button class="btn btn-df sm" data-act="skills:draft:discardConfirm" title="Discard (Y)">Discard</button></div>')
    + '</div></div>';
}
/* The state and the four actions. `api()` is window.atomic (or a stand-in), `paint()` repaints the tab,
   `changed()` re-reads the skill list after an approve (the skill is now installed). */
function createSkillDraftsController(deps) {
  const st = {rows: [], at: 0, loading: false, error: null, errorDetail: null, open: null, confirm: null, busyId: null, seq: 0};
  const api = () => deps.api() || {};
  const now = deps.now || (() => Date.now());
  async function refresh(force) {
    const br = api();
    if (!br.skillDrafts || st.loading || (!force && now() - st.at < 15000)) return;
    st.loading = true;
    let res = null;
    try { res = await br.skillDrafts(); } catch (e) { res = null; }
    st.loading = false; st.at = now();
    const before = JSON.stringify(st.rows);
    st.rows = res && res.ok && Array.isArray(res.rows) ? res.rows : [];
    if (st.open && !st.rows.some(r => r.id === st.open.id)) st.open = null;
    if (before !== JSON.stringify(st.rows)) deps.paint();
  }
  const nameOf = id => { const r = st.rows.find(x => x.id === id); return r ? r.name : id; };
  async function show(id) {
    const br = api();
    if (!br.skillDraftShow || !SKILL_DRAFT_ID_RE.test(id)) return;
    const seq = ++st.seq;
    st.open = {id, name: nameOf(id), draft: null, error: null, errorDetail: null}; deps.paint();
    let res = null;
    try { res = await br.skillDraftShow(id); } catch (e) { res = {ok: false, error: String((e && e.message) || e)}; }
    if (seq !== st.seq || !st.open || st.open.id !== id) return;
    if (res && res.ok && res.draft) st.open.draft = res.draft;
    else { st.open.error = 'Could not open this draft. Close it and try again.'; st.open.errorDetail = (res && res.error) || null; }
    deps.paint();
  }
  async function approve(id) {
    const br = api();
    if (!br.skillDraftApprove || st.busyId || !SKILL_DRAFT_ID_RE.test(id)) return;
    st.busyId = id; st.error = null; st.errorDetail = null; deps.paint();
    let res = null;
    try { res = await br.skillDraftApprove(id); } catch (e) { res = {ok: false, error: String((e && e.message) || e)}; }
    st.busyId = null;
    if (res && res.ok) { if (st.open && st.open.id === id) st.open = null; if (deps.changed) deps.changed(); }
    else { st.error = 'Could not approve "' + nameOf(id) + '". It is still waiting for review.'; st.errorDetail = (res && res.error) || 'The agent did not answer.'; }
    await refresh(true);
    deps.paint();
  }
  function askDiscard(id) {
    if (!SKILL_DRAFT_ID_RE.test(id) || st.busyId) return;
    st.confirm = {id, name: nameOf(id), submitting: false, error: null, errorDetail: null}; deps.paint();
  }
  async function discard() {
    const c = st.confirm, br = api();
    if (!c || c.submitting || !br.skillDraftDiscard) return;
    c.submitting = true; st.busyId = c.id; deps.paint();
    let res = null;
    try { res = await br.skillDraftDiscard(c.id); } catch (e) { res = {ok: false, error: String((e && e.message) || e)}; }
    st.busyId = null;
    if (res && res.ok) { st.confirm = null; if (st.open && st.open.id === c.id) st.open = null; }
    else { c.submitting = false; c.error = 'Could not discard the draft. It is still waiting for review.'; c.errorDetail = (res && res.error) || null; }
    await refresh(true);
    deps.paint();
  }
  function act(what) {
    const i = what.indexOf(':'), verb = i < 0 ? what : what.slice(0, i), id = i < 0 ? '' : what.slice(i + 1);
    if (verb === 'show') return show(id);
    if (verb === 'approve') return approve(id);
    if (verb === 'discard') return askDiscard(id);
    if (verb === 'discardConfirm') return discard();
    if (verb === 'cancel') { if (st.confirm && !st.confirm.submitting) st.confirm = null; deps.paint(); return; }
    if (verb === 'close') { st.open = null; st.seq++; deps.paint(); return; }
  }
  /* Keys while a confirm or a preview is up: they belong to it, not to the skill rows hidden under it. */
  function key(e, k) {
    if (st.confirm) {
      if (k === 'y' || k === 'Enter') { e.preventDefault(); discard(); }
      else if (k === 'n' || k === 'Escape') { e.preventDefault(); act('cancel'); }
      return true;
    }
    if (st.open) {
      if (k === 'Escape') { e.preventDefault(); act('close'); }
      return true;
    }
    return false;
  }
  return {state: st, refresh, act, key,
    listHTML: esc => skillDraftsListHTML(st, esc), detailHTML: esc => skillDraftDetailHTML(st, esc), confirmHTML: esc => skillDraftConfirmHTML(st, esc)};
}
if (typeof module !== 'undefined') module.exports = {workspaceSkillCommands, workspaceSkillMessage, createSkillCatalogLoader,
  skillEvalDuration, skillEvalTokens, skillEvalCost, skillEvalSummary, skillEvalHTML,
  skillDraftKindLabel, skillRowsWithoutDrafts, skillDraftsGroup, skillDraftsListHTML, skillDraftDetailHTML, skillDraftConfirmHTML,
  createSkillDraftsController};
