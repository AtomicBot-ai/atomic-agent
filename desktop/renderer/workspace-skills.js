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
function skillEvalLine(label, side) {
  const pct = side.total ? Math.round(side.passed / side.total * 100) : 0;
  const parts = [side.passed + ' of ' + side.total + ' tasks passed' + (side.total ? ' (' + pct + '%)' : '')];
  const time = skillEvalDuration(side.seconds), tokens = skillEvalTokens(side.tokens);
  if (time) parts.push(time);
  if (tokens) parts.push(tokens);
  return {label, text: parts.join(', ')};
}
/* The result in plain words: one line per run, then what the skill changed. */
function skillEvalSummary(result) {
  const w = result.withSkill, wo = result.withoutSkill;
  const lines = [skillEvalLine('With the skill', w), skillEvalLine('Without it', wo)];
  const tasks = (n, word) => n + ' ' + word + ' task' + (n === 1 ? '' : 's');
  const diff = w.passed - wo.passed;
  let verdict;
  if (!w.total && !wo.total) verdict = 'The task set has no tasks.';
  else if (w.total !== wo.total) verdict = 'The two runs did not finish the same tasks, so they cannot be compared.';
  else if (diff > 0) verdict = 'The skill helped: ' + tasks(diff, 'more') + ' passed.';
  else if (diff < 0) verdict = 'The skill made it worse: ' + tasks(-diff, 'fewer') + ' passed.';
  else verdict = 'No difference in passed tasks.';
  const extra = [];
  if (typeof w.seconds === 'number' && typeof wo.seconds === 'number') {
    const d = w.seconds - wo.seconds, t = skillEvalDuration(Math.abs(d));
    if (t && Math.round(Math.abs(d)) >= 1) extra.push(t + (d > 0 ? ' slower' : ' faster'));
  }
  if (typeof w.tokens === 'number' && typeof wo.tokens === 'number' && w.tokens !== wo.tokens) {
    extra.push(skillEvalTokens(Math.abs(w.tokens - wo.tokens)).replace(/ tokens$/, '') + (w.tokens > wo.tokens ? ' more tokens' : ' fewer tokens'));
  }
  if (extra.length) verdict += ' With the skill: ' + extra.join(', ') + '.';
  return {lines, verdict};
}
/* The card's block. Nothing at all unless main said this skill can be tested here
   (the agent has `skill eval` and the skill has a tasks.yaml): no button that cannot work. */
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
      + '<span class="set-cap grow">' + (other ? 'Another skill test is running.' : 'Runs the tasks in tasks.yaml with and without this skill.') + '</span>';
  }
  out += '</div>';
  const o = !mine && st.outcome;
  if (o && o.ok && o.result) {
    const sum = skillEvalSummary(o.result);
    out += sum.lines.map(l => '<p class="set-cap"><b>' + esc(l.label) + ':</b> ' + esc(l.text) + '</p>').join('')
      + '<p class="set-desc">' + esc(sum.verdict) + '</p>';
  } else if (o && o.cancelled) out += '<p class="set-cap">Test stopped.</p>';
  else if (o) out += '<div class="tuierr tk-help tk-help--err">' + esc(o.error || 'The test did not finish.') + '</div>';
  return out + '</div>';
}
if (typeof module !== 'undefined') module.exports = {workspaceSkillCommands, workspaceSkillMessage, createSkillCatalogLoader,
  skillEvalDuration, skillEvalTokens, skillEvalSummary, skillEvalHTML};
