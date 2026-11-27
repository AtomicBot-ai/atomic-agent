// ATO-2485: the agent's shell jobs in the terminal panel, "Take over" to
// type into one. Logic of renderer/agent-jobs-logic.js, and the wiring
// from the window to the agent (index.html, preload, main).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const {
  AJ_MAX_RAW, ajScreenText, ajAppendRaw, ajLooksSecret, ajTabLabel, ajStateLine, ajMergeJobs, ajJobsFrom, ajChipText, ajInputText, ajFitSize,
  ajIsTextField, ajPromptToast, ajSecretSentNote,
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
  assert.match(read('../main/main.ts'), /wireAgentJobsIpc\(client, /);
  // ATO-2486: the card of a job's password, before renderer.js like the question card.
  assert.ok(at('src="shell-secret-card.js"') > 0 && at('src="shell-secret-card.js"') < at('src="renderer.js"'));
  assert.ok(preload.includes('"agentJobs:secret"') && read('../main/agent-jobs-ipc.ts').includes('"agentJobs:secret"'));
  assert.match(read('../main/agent-client.ts'), /\/api\/shell\/secret/);
  const renderer = read('../renderer/renderer.js');
  assert.match(renderer, /payload\.category === 'shell_secret' && typeof ssPrompt === 'function'/);
  assert.match(renderer, /m\.secret && typeof ssCardHTML === 'function'/);
  assert.match(renderer, /req\.secret && key !== 'esc' && typeof ssKey === 'function'/);
});

test('what the person types is never put into the chat', () => {
  const panel = read('../renderer/agent-jobs.js');
  // The panel never touches the transcript or the composer.
  assert.doesNotMatch(panel, /S\.log|S\.history|pushHistory|S\.draft|sendMessage/);
  assert.doesNotMatch(read('../main/agent-jobs-ipc.ts'), /console\.|log\(/);
});

test('a field the person types into is told from a button or a checkbox', () => {
  assert.ok(ajIsTextField({tagName: 'TEXTAREA'}));
  assert.ok(ajIsTextField({tagName: 'INPUT', type: 'text'}));
  assert.ok(ajIsTextField({tagName: 'DIV', isContentEditable: true}));
  assert.ok(!ajIsTextField({tagName: 'INPUT', type: 'checkbox'}));
  assert.ok(!ajIsTextField({tagName: 'BUTTON'}));
  assert.ok(!ajIsTextField(null));
});

test('the prompt toast promises only what the agent does', () => {
  for (const opened of [true, false]) {
    const [, body] = ajPromptToast(opened);
    // The review's false promise: "It goes to the command only".
    assert.doesNotMatch(body, /command only|never sees/i);
    assert.match(body, /not to the chat/);
    assert.match(body, /short or a single plain word/);
  }
  assert.match(ajPromptToast(false)[1], /Agent job needs you/);
  // The chip is not drawn while the panel is open: the toast points at the panel's field.
  assert.doesNotMatch(ajPromptToast(false, true)[1], /Agent job needs you/);
  assert.match(ajPromptToast(false, true)[1], /field in the terminal panel/);
});

test('after a hidden send the person is told when the agent could not mask it', () => {
  assert.equal(ajSecretSentNote({written: true, masked: true}), null);
  assert.match(ajSecretSentNote({written: true, masked: false})[1], /short or a plain word/);
  // An agent from before `secret` answers without `masked`.
  assert.match(ajSecretSentNote({written: true})[1], /version of the agent/);
});

/** agent-jobs.js in a page of its own: fake bridge, host, field and composer. */
function loadPanel(extra = {}) {
  const calls = [];
  const toasts = [];
  const field = {value: '', type: 'text', focused: 0, focus() { this.focused += 1; }};
  const host = {hidden: true, innerHTML: '', contains: (el) => el === field, querySelector: (q) => (q === '.aj-input' ? field : null)};
  const document = {activeElement: null, getElementById: () => host, createElement: () => ({})};
  const BR = {
    agentJobsList: () => Promise.resolve({ok: true, data: {jobs: []}}),
    agentJobInput: (...args) => { calls.push(args); return Promise.resolve({ok: true, data: {written: true, masked: true}}); },
  };
  const ctx = vm.createContext({document, BR, toast: (...t) => toasts.push(t), setTimeout: () => 0, clearTimeout: () => undefined, ...extra});
  vm.runInContext(read('../renderer/agent-jobs-logic.js'), ctx);
  vm.runInContext(read('../renderer/agent-jobs.js'), ctx);
  vm.runInContext(`AJ.sid = 's-1'; AJ.selected = 1;
    AJ.jobs = [{id: 1, commandLine: 'sudo ls', cwd: '/w', state: 'running', interactive: true, resizable: false}];`, ctx);
  return {ctx, calls, toasts, field, document};
}

test('Send with Hide typing on marks the text secret, so the agent masks it for the model', async () => {
  const {ctx, calls, field} = loadPanel();
  field.value = 'Tr0ub4dor&3';
  vm.runInContext('AJ.hide = true', ctx);
  await vm.runInContext('ajSend(false)', ctx);
  assert.deepEqual(calls, [['s-1', 1, 'Tr0ub4dor&3\n', false, true]]);
  assert.equal(field.value, '');
  vm.runInContext('AJ.hide = false', ctx);
  field.value = 'y';
  await vm.runInContext('ajSend(false)', ctx);
  assert.deepEqual(calls[1], ['s-1', 1, 'y\n', false, false]);
});

test('a password prompt never takes the caret from the composer; the chip asks instead', () => {
  const {ctx, document, toasts} = loadPanel();
  document.activeElement = {tagName: 'TEXTAREA'};
  vm.runInContext(`AJ.raw[1] = '[sudo] password for n: '; AJ.next[1] = 24; ajNoticePrompt(1);`, ctx);
  assert.equal(vm.runInContext('ajWantFocus', ctx), false);
  assert.equal(vm.runInContext('AJ.open', ctx), false);
  assert.equal(vm.runInContext('AJ.hide', ctx), true);
  assert.match(toasts[0][1], /Agent job needs you/);
  // Nobody typing elsewhere: the tab opens and its field takes the caret.
  document.activeElement = null;
  vm.runInContext(`AJ.next[1] = 30; ajNoticePrompt(1);`, ctx);
  assert.equal(vm.runInContext('ajWantFocus', ctx), true);
  assert.equal(vm.runInContext('AJ.open', ctx), true);
});

test('with the panel open and the caret in the chat box, a password prompt still hides typing', () => {
  const {ctx, document, toasts, field} = loadPanel();
  vm.runInContext('AJ.open = true; AJ.hide = false; AJ.taking = false; AJ.selected = null;', ctx);
  document.activeElement = {tagName: 'TEXTAREA'};
  vm.runInContext(`AJ.raw[1] = '[sudo] password for n: '; AJ.next[1] = 24; ajNoticePrompt(1);`, ctx);
  assert.equal(vm.runInContext('AJ.hide', ctx), true);
  assert.equal(vm.runInContext('AJ.taking', ctx), true);
  assert.equal(vm.runInContext('AJ.selected', ctx), 1);
  // The caret stays in the chat box.
  assert.equal(vm.runInContext('ajWantFocus', ctx), false);
  assert.equal(field.focused, 0);
  assert.doesNotMatch(toasts[0][1], /Agent job needs you/);
  assert.match(toasts[0][1], /field in the terminal panel/);
});

test('a password the agent asked for (shell_secret) answers that request, not the job\'s stdin', async () => {
  const sent = [];
  const ask = {approvalId: 'a-1', secret: {jobId: 1}};
  const {ctx, calls, field} = loadPanel({ssOpenFor: (sid, id) => (sid === 's-1' && id === 1 ? ask : null), ssSend: (req, body) => sent.push([req, body])});
  field.value = 'Tr0ub4dor&3';
  await vm.runInContext('ajSend(false)', ctx);
  assert.deepEqual(sent, [[ask, {value: 'Tr0ub4dor&3'}]]);
  assert.deepEqual(calls, []);
  assert.equal(field.value, '');
});

test('the backspace pass is linear: a long spinner line comes out right', () => {
  assert.equal(ajScreenText('ab\u0008\u0008c'), 'c');
  assert.equal(ajScreenText('\u0008\u0008a'), 'a');
  const spinner = '|\u0008/\u0008-\u0008\\\u0008'.repeat(5_000) + 'done';
  assert.equal(ajScreenText(spinner), 'done');
});
