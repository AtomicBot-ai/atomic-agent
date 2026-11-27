// ATO-2485: the agent's shell jobs in the terminal panel, "Take over" to
// type into one. Logic of renderer/agent-jobs-logic.js, and the wiring
// from the window to the agent (index.html, preload, main).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const {
  AJ_MAX_RAW, ajScreenText, ajAppendRaw, ajLooksSecret, ajTabLabel, ajStateLine, ajMergeJobs, ajJobsFrom, ajChipText, ajInputText, ajFitSize,
} = createRequire(import.meta.url)('../renderer/agent-jobs-logic.js');

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const job = (over = {}) => ({id: 1, commandLine: 'npm init', cwd: '/w', state: 'running', interactive: true, resizable: false,
  startedAt: 0, exitCode: null, signal: null, ...over});

test('the screen drops colour codes and keeps what a terminal would show', () => {
  assert.equal(ajScreenText('\u001b[32mok\u001b[0m\r\nnext'), 'ok\nnext');
  // A progress bar redraws its line with a carriage return.
  assert.equal(ajScreenText('10%\r55%\r100%\ndone'), '100%\ndone');
  assert.equal(ajScreenText('abcdef\rXY'), 'XYcdef');
  // A backspace removes the character before it.
  assert.equal(ajScreenText('pas\u0008\u0008ython'), 'python');
  // A title change (OSC) is not text.
  assert.equal(ajScreenText('\u001b]0;title\u0007$ '), '$ ');
});

test('raw output is bounded per job', () => {
  const big = 'x'.repeat(AJ_MAX_RAW);
  const out = ajAppendRaw(big, 'tail');
  assert.equal(out.length, AJ_MAX_RAW);
  assert.ok(out.endsWith('tail'));
});

test('a password prompt is spotted so typing is hidden; ordinary output is not', () => {
  assert.ok(ajLooksSecret('Installing...\nPassword:'));
  assert.ok(ajLooksSecret('[sudo] password for nadia: '));
  assert.ok(ajLooksSecret("Enter passphrase for key '/Users/n/.ssh/id_ed25519': "));
  assert.ok(!ajLooksSecret('package name: (app)'));
  assert.ok(!ajLooksSecret('Downloaded tokenizer.json'));
  assert.ok(!ajLooksSecret(''));
});

test('a tab is named after the command, shortened', () => {
  assert.equal(ajTabLabel(job()), 'Agent job: npm init');
  const long = ajTabLabel(job({commandLine: 'x'.repeat(100)}));
  assert.ok(long.startsWith('Agent job: '));
  assert.ok(long.length <= 'Agent job: '.length + 40);
});

test('the state line says whether the person can type, and how a job ended', () => {
  assert.match(ajStateLine(job()), /take over/i);
  assert.match(ajStateLine(job({interactive: false})), /does not take typing/);
  assert.equal(ajStateLine(job({state: 'exited', exitCode: 0})), 'Finished.');
  assert.equal(ajStateLine(job({state: 'exited', exitCode: 2})), 'Ended with exit code 2.');
  assert.equal(ajStateLine(job({state: 'killed'})), 'Stopped.');
});

test('an ended job the agent no longer lists keeps its tab until the person closes it', () => {
  const kept = ajMergeJobs([job({id: 1}), job({id: 2})], [job({id: 2})], {});
  assert.deepEqual(kept.map((j) => [j.id, j.state]), [[1, 'exited'], [2, 'running']]);
  const closed = ajMergeJobs(kept, [job({id: 2})], {1: true});
  assert.deepEqual(closed.map((j) => j.id), [2]);
});

test('only well-formed jobs from the agent are drawn', () => {
  assert.deepEqual(ajJobsFrom({jobs: [job(), {id: 'x'}, null]}).map((j) => j.id), [1]);
  assert.deepEqual(ajJobsFrom(null), []);
});

test('the folded chip says when a job needs the person', () => {
  assert.equal(ajChipText([job()], false), 'Agent job running');
  assert.equal(ajChipText([job(), job({id: 2})], false), '2 agent jobs running');
  assert.equal(ajChipText([job()], true), 'Agent job needs you');
  assert.equal(ajChipText([job({state: 'exited'})], false), 'Agent job ended');
});

test('Send types the text and presses Enter', () => {
  assert.equal(ajInputText('y'), 'y\n');
  assert.equal(ajInputText('', false), '');
});

test('a native terminal is sized to the panel, within bounds', () => {
  assert.deepEqual(ajFitSize(800, 300, 8, 20), {cols: 100, rows: 15});
  assert.deepEqual(ajFitSize(40, 40, 8, 20), {cols: 20, rows: 5});
  assert.equal(ajFitSize(0, 300, 8, 20), null);
});

test('the panel is wired: its own element, scripts after renderer.js, CSS, preload and main', () => {
  const html = read('../renderer/index.html');
  assert.match(html, /<div id="agentjobs" hidden><\/div>/);
  const at = (s) => html.indexOf(s);
  assert.ok(at('src="renderer.js"') < at('src="agent-jobs-logic.js"'));
  assert.ok(at('src="agent-jobs-logic.js"') < at('src="agent-jobs.js"'));
  assert.match(html, /href="css\/agent-jobs\.css"/);
  const preload = read('../preload/preload.ts');
  for (const ch of ['agentJobs:list', 'agentJobs:output', 'agentJobs:input', 'agentJobs:resize', 'agentJobs:stop']) {
    assert.ok(preload.includes(`"${ch}"`), ch + ' in preload');
    assert.ok(read('../main/agent-jobs-ipc.ts').includes(`"${ch}"`), ch + ' in main');
  }
  assert.match(read('../main/main.ts'), /wireAgentJobsIpc\(client\)/);
});

test('what the person types is never put into the chat', () => {
  const panel = read('../renderer/agent-jobs.js');
  // The panel never touches the transcript or the composer.
  assert.doesNotMatch(panel, /S\.log|S\.history|pushHistory|S\.draft|sendMessage/);
  assert.doesNotMatch(read('../main/agent-jobs-ipc.ts'), /console\.|log\(/);
});
