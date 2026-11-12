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
if (typeof module !== 'undefined') module.exports = {workspaceSkillCommands, workspaceSkillMessage, createSkillCatalogLoader,
  skillEvalDuration, skillEvalTokens, skillEvalCost, skillEvalSummary, skillEvalHTML};
