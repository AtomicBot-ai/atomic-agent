// ATO-2486: a job's password the agent asked for (`shell_secret`), as the
// chat draws it (renderer/shell-secret-card.js). The value is typed in the
// terminal panel (agent-jobs.js) and sent to POST /api/shell/secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const { ssPrompt, ssAskLine, ssCardHTML } = createRequire(import.meta.url)('../renderer/shell-secret-card.js');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const h = {esc, ic: (n) => '<i data-ic="' + n + '"></i>', keyLabel: (k) => k};
const frame = {jobId: 2, label: 'sudo password', commandLine: 'sudo apt install jq', promptLine: '[sudo] password for n:'};

test('the request is read from the frame, checked', () => {
  assert.deepEqual(ssPrompt(frame), frame);
  assert.equal(ssPrompt({...frame, jobId: 0}), null);
  assert.equal(ssPrompt({...frame, jobId: '2'}), null);
  assert.equal(ssPrompt(null), null);
  assert.equal(ssPrompt({jobId: 1}).label, 'a password');
  assert.ok(ssPrompt({...frame, label: 'x'.repeat(500)}).label.length <= 120);
});

test('the open card has Type it and Skip, never Allow, and escapes what the agent sent', () => {
  const m = {approvalId: 'a-1', secret: ssPrompt({...frame, commandLine: '<b>x</b>'})};
  const html = ssCardHTML(m, h, true);
  assert.match(html, /data-ss="type"/);
  assert.match(html, /data-ss="skip"/);
  assert.match(html, /data-appr="esc"/);
  assert.doesNotMatch(html, /data-appr="y"|Allow/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /sudo password/);
  assert.match(html, /id="apprcard"/);
  // No field on the card: the value is typed in the panel only.
  assert.doesNotMatch(html, /<input|<textarea/);
});

test('a closed card says what happened, without the value', () => {
  const base = {approvalId: 'a-1', secret: ssPrompt(frame), at: '10:00:00'};
  assert.match(ssCardHTML({...base, state: 'answered'}, h, false), /Typed into the command/);
  assert.match(ssCardHTML({...base, state: 'skipped'}, h, false), /Skipped/);
  assert.match(ssCardHTML({...base, state: 'expired'}, h, false), /stopped waiting/);
});

test('the panel line names what is asked, and why the agent refused', () => {
  const req = {secret: ssPrompt(frame)};
  assert.match(ssAskLine(req), /asks for sudo password/);
  assert.match(ssAskLine({...req, ssError: 'The agent did not take it: the secret is empty.'}), /did not take it/);
  assert.equal(ssAskLine(null), '');
});

test('the value is never kept on the row, logged or put into the chat', () => {
  const src = readFileSync(new URL('../renderer/shell-secret-card.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /req\.\w+\s*=\s*body\b|req\.\w+\s*=\s*body\.value/);
  assert.doesNotMatch(src, /console\.|LOGS\.push|S\.log\.push|S\.draft/);
  assert.match(src, /BR\.answerShellSecret\(/);
  assert.doesNotMatch(src, /resolveApproval|approval\/resolve/);
});
