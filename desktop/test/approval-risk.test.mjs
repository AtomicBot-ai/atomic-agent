// ATO-1268: smart approval's verdict on the approval card
// (renderer/approval-risk.js, wired in renderer.js onApprovalEvent and the card).
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { apprRiskFields, apprRiskLine } = require('../renderer/approval-risk.js');

test('a medium or high verdict reads as one line with its reason', () => {
  assert.equal(apprRiskLine({ riskNote: 'risk check: medium (installs a package)', riskLevel: 'medium', riskReason: 'installs a package' }),
    'Risk check: medium. Installs a package');
  assert.equal(apprRiskLine({ riskNote: 'risk check: high', riskLevel: 'high' }), 'Risk check: high.');
});

test('an older agent without riskReason: the reason comes out of riskNote', () => {
  assert.equal(apprRiskLine({ riskNote: 'risk check: high (deletes (many) files)', riskLevel: 'high' }),
    'Risk check: high. Deletes (many) files');
});

test('a review that gave no answer says so', () => {
  assert.equal(apprRiskLine({ riskNote: 'risk check: no answer, asking you' }), 'Risk check: no answer, asking you.');
});

test('no review, no line (an agent without smart approval)', () => {
  assert.equal(apprRiskLine({}), '');
  assert.equal(apprRiskLine(null), '');
  assert.deepEqual(apprRiskFields({ approvalId: 'a1', reason: 'x' }), {});
});

test('the frame fields are kept only when they are what the agent sends', () => {
  assert.deepEqual(apprRiskFields({ riskNote: 'risk check: medium (x)', riskLevel: 'medium', riskReason: 'x' }),
    { riskNote: 'risk check: medium (x)', riskLevel: 'medium', riskReason: 'x' });
  assert.deepEqual(apprRiskFields({ riskLevel: 'catastrophic', riskReason: 42 }), {});
});

test('the reason stays on one line; the card escapes it as text', () => {
  assert.equal(apprRiskLine({ riskLevel: 'medium', riskReason: 'a\nb\u0007c' }), 'Risk check: medium. A b c');
  // Plain text out: markup in the model's words is the card's esc() to neutralise.
  assert.equal(apprRiskLine({ riskLevel: 'high', riskReason: '<img src=x onerror=alert(1)>' }),
    'Risk check: high. <img src=x onerror=alert(1)>');
  const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(renderer, /'<div class="apprrisk' \+ \(m\.riskLevel === 'high' \? ' high' : ''\) \+ '">' \+ esc\(risk\) \+ '<\/div>'/,
    'the card draws the line through esc()');
  assert.match(renderer, /\.\.\.apprRiskFields\(payload\)/, 'onApprovalEvent keeps the frame\'s risk fields');
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('approval-risk.js') >= 0 && html.indexOf('approval-risk.js') < html.indexOf('renderer.js'),
    'approval-risk.js loads before renderer.js');
});
