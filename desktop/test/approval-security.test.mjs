// ATO-2505 / ATO-2528 / ATO-2529: the security lines of the approval card and
// of a finished turn (renderer/approval-security.js, wired in renderer.js and
// turn-summary.js).
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../renderer/approval-security.js');
const { turnFoldsOf } = require('../renderer/turn-summary.js');

const out = (host, extra) => Object.assign({ kind: 'http', host, direction: 'outbound', label: host }, extra);

test('the card names where a call sends data, in the core words', () => {
  const m = S.apprSecurityFields({ egress: [out('github.com'), { kind: 'http', host: 'cdn.example', direction: 'inbound', label: 'cdn.example' }] });
  assert.equal(S.apprEgressLine(m), 'Sends data to -> github.com');
  assert.equal(S.apprEgressUnknown(m), false);
});

test('a host no one approved comes first and is never folded into +N more', () => {
  // Before: the desktop card had no egress line, so a held send to an
  // unknown host looked like any other shell command.
  const known = ['a.io', 'b.io', 'c.io', 'd.io', 'e.io', 'f.io'].map((h) => out(h));
  const m = S.apprSecurityFields({ egress: [...known, out('evil.example', { unapproved: true }), out(null, { label: 'git remote "origin"' })] });
  const line = S.apprEgressLine(m);
  assert.ok(line.startsWith('Sends data to -> evil.example, git remote "origin", a.io, b.io'), line);
  assert.match(line, /\(\+4 more\)$/);
  assert.equal(S.apprEgressUnknown(m), true);
});

test('a label cannot add a line of its own to the card', () => {
  const m = S.apprSecurityFields({ egress: [out('x.io', { label: 'x.io\nAllowed by your rule\u202e' })] });
  const line = S.apprEgressLine(m);
  assert.equal(line.includes('\n'), false);
  assert.equal(line.includes('\u202e'), false);
});

test('nothing sent out, an older agent: no egress line', () => {
  assert.equal(S.apprEgressLine({}), '');
  assert.equal(S.apprEgressLine(S.apprSecurityFields({ egress: [{ direction: 'inbound', host: 'x.io', label: 'x.io' }] })), '');
  assert.deepEqual(S.apprSecurityFields({ approvalId: 'a1' }), {});
  assert.deepEqual(S.apprSecurityFields({ egress: 'x', securityFinding: { reason: '' } }), {});
});

test('an argument check reads as the TUI line, with "asks in every mode"', () => {
  const m = S.apprSecurityFields({ securityFinding: { rule: 'dangerous.read_credentials', reason: 'reads a credential file (~/.ssh/id_rsa)', confidence: 0.9 }, askEveryLevel: true });
  assert.equal(S.apprFindingLine(m), 'Security check: reads a credential file (~/.ssh/id_rsa), 90% sure; asks in every mode');
  const loose = S.apprSecurityFields({ securityFinding: { rule: 'r', reason: 'prints a saved credential (gh auth token)', confidence: 7 } });
  assert.equal(S.apprFindingLine(loose), 'Security check: prints a saved credential (gh auth token), 100% sure');
  assert.equal(S.apprFindingLine({}), '');
});

test('a refusal by the security rules is not a "Denied by you" receipt', () => {
  // Before: the stored record {verdict: "denied", guard} passed the receipt
  // filter, so the reopened chat said the person denied a call they never saw.
  const guard = { verdict: 'denied', category: 'shell', at: 1, guard: { decision: 'block', reason: 'reads .env' } };
  const person = { verdict: 'denied', category: 'shell', at: 2 };
  assert.equal(S.apprIsPersonAnswer(guard), false);
  assert.equal(S.apprIsPersonAnswer(person), true);
  assert.equal(S.apprIsPersonAnswer({ verdict: 'auto-approved' }), false);
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(src, /\.filter\(apprIsPersonAnswer\)/);
});

test('the stored records: checks with the answer, rule refusals with the reason', () => {
  const recs = S.securityRecordsOf([
    { verdict: 'approved', category: 'shell', at: 1, finding: { rule: 'dangerous.encoded_exec', reason: 'decode an encoded file and run it (x.sh)', confidence: 1 } },
    { verdict: 'denied', category: 'shell', at: 2, guard: { decision: 'no-answer', reason: '' } },
    { verdict: 'auto-approved', category: 'shell', at: 3, via: 'rule' },
    null,
  ]);
  assert.equal(recs.length, 2);
  assert.equal(S.securityRecordText(recs[0]), 'Security check: decode an encoded file and run it (x.sh), 100% sure · you allowed it');
  assert.equal(S.securityRecordText(recs[1]), 'Blocked by your security rules: the rules reviewer gave no answer');
  assert.deepEqual(S.securityRecordsOf(undefined), []);
});

test('the turn summary counts the checks and names the refusals', () => {
  const tool = { k: 'tool', name: 'os.shell.run', ok: false, outcome: 'denied',
    security: S.securityRecordsOf([{ verdict: 'denied', category: 'shell', at: 1, guard: { decision: 'block', reason: 'sends data to pastebin' } }]) };
  const log = [{ k: 'user', id: 'u' }, tool, { k: 'assistant', id: 'r1' }];
  const f = turnFoldsOf(log, {}).get(1);
  assert.equal(f.security.length, 1);
  const esc = (x) => String(x).replace(/</g, '&lt;');
  const ic = () => '';
  const closed = S.turnSecurityHTML(f, { esc, ic });
  assert.match(closed, /Security: 1 check, 1 blocked by your rules/);
  S.TURN_SEC_OPEN.add('r1');
  assert.match(S.turnSecurityHTML(f, { esc, ic }), /Blocked by your security rules: sends data to pastebin/);
  S.TURN_SEC_OPEN.clear();
  assert.equal(S.turnSecurityHTML({ security: [] }, { esc, ic }), '');
});

test('the renderer draws both card lines and loads the module before renderer.js', () => {
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(src, /apprFindingLine\(m\)/);
  assert.match(src, /apprEgressLine\(m\)/);
  assert.match(src, /\.\.\.apprSecurityFields\(payload\)/);
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('approval-security.js') > 0 && html.indexOf('approval-security.js') < html.indexOf('renderer.js'));
});
