import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { parseRecommendJson, upgradeVerdict, upgradeStillWanted, localPickTakenLive, parseUpgradeDeclined, upgradeDownloadLabel } = require('../out/main/upgrade-model.js');
const { STARTER_MODEL_ID } = require('../out/main/starter-model.js');

/** ATO-1044: after the starter, the best model for this computer, downloaded in the background and switched to on a click. */
const BIG = { id: 'gemma-4-26b-a4b', name: 'Gemma 4 26B A4B GGUF', sizeLabel: '14.3 GB', downloadGb: 15.1 };
const answer = (action, model = BIG, why = null) => JSON.stringify({ version: 1, upgrade: { action, why, model: action === 'none' ? null : model } });
const base = {
  cloudReady: false, localMode: 'managed', activeProvider: 'local-llama',
  downloadBusy: false, laterId: null, activeModelId: STARTER_MODEL_ID, starterId: STARTER_MODEL_ID,
};

test('parses the agent answer, and nothing from an agent without the subcommand', () => {
  assert.deepEqual(parseRecommendJson(answer('download')), { action: 'download', why: null, model: BIG });
  assert.deepEqual(parseRecommendJson(answer('none', null, 'already_best')), { action: 'none', why: 'already_best', model: null });
  assert.equal(parseRecommendJson('unknown subcommand: recommend'), null);
  assert.equal(parseRecommendJson(''), null);
  assert.equal(parseRecommendJson(JSON.stringify({ upgrade: { action: 'download', model: null } })), null);
});

test('ATO-1475: on the starter with nothing running, ask first, never download unasked', () => {
  const v = upgradeVerdict({ ...base, recommend: parseRecommendJson(answer('download')) });
  assert.deepEqual(v, { act: 'ask', model: BIG });
  assert.notEqual(v.act, 'download');
});

test('ATO-1475: a Not now kept on disk is not asked again, a different model is', () => {
  const recommend = parseRecommendJson(answer('download'));
  assert.equal(upgradeVerdict({ ...base, recommend, declinedId: BIG.id }).why, 'declined');
  assert.equal(upgradeVerdict({ ...base, recommend, declinedId: 'other-model' }).act, 'ask');
  assert.equal(parseUpgradeDeclined(JSON.stringify({ id: BIG.id, at: 1 })), BIG.id);
  assert.equal(parseUpgradeDeclined('not json'), null);
  assert.equal(parseUpgradeDeclined('{}'), null);
});

test('ATO-1475: the Download button names what goes over the wire', () => {
  assert.equal(upgradeDownloadLabel(BIG), '15.1 GB');
  assert.equal(upgradeDownloadLabel({ ...BIG, downloadGb: 0 }), '14.3 GB');
});

test('already on disk: ask right away', () => {
  assert.equal(upgradeVerdict({ ...base, recommend: parseRecommendJson(answer('switch')) }).act, 'offer');
});

test('left alone: a model picked by hand, a cloud route, an external server, a busy slot, a Later', () => {
  const recommend = parseRecommendJson(answer('download'));
  assert.equal(upgradeVerdict({ ...base, recommend, activeModelId: 'qwen-3.5-4b' }).why, 'not_on_starter');
  assert.equal(upgradeVerdict({ ...base, recommend, cloudReady: true, activeProvider: 'openrouter' }).why, 'has_cloud');
  assert.equal(upgradeVerdict({ ...base, recommend, localMode: 'external' }).why, 'external');
  assert.equal(upgradeVerdict({ ...base, recommend, downloadBusy: true }).why, 'busy');
  assert.equal(upgradeVerdict({ ...base, recommend, laterId: BIG.id }).why, 'later');
  assert.equal(upgradeVerdict({ ...base, recommend: null }).why, 'no_answer');
});

test('a cloud key alone does not stop it while the route stays local', () => {
  assert.equal(upgradeVerdict({ ...base, recommend: parseRecommendJson(answer('download')), cloudReady: true }).act, 'ask');
});

test('a choice made during the download stands', () => {
  const now = { id: BIG.id, cloudReady: false, activeProvider: 'local-llama', localMode: 'managed', activeModelId: STARTER_MODEL_ID };
  assert.equal(upgradeStillWanted(now), true);
  assert.equal(upgradeStillWanted({ ...now, activeProvider: 'openrouter' }), false);
  assert.equal(upgradeStillWanted({ ...now, localMode: 'external' }), false);
  assert.equal(upgradeStillWanted({ ...now, activeModelId: BIG.id }), false);
});

test('only a local-to-local pick on a single-mode route is taken live', () => {
  const res = { ok: true, providerId: 'local-llama', transport: 'grammar+llama-server' };
  assert.equal(localPickTakenLive({ provider: 'local-llama', mode: 'single' }, res), true);
  assert.equal(localPickTakenLive({ provider: 'local-llama', mode: 'fusion' }, res), false);
  assert.equal(localPickTakenLive({ provider: 'openrouter', mode: 'single' }, res), false);
  assert.equal(localPickTakenLive(null, res), false);
  assert.equal(localPickTakenLive({ provider: 'local-llama', mode: 'single' }, { ...res, ok: false }), false);
});

test('the strip: progress, then the ask, never a silent switch', () => {
  let renders = 0;
  globalThis.render = () => { renders++; };
  globalThis.esc = (s) => String(s);
  globalThis.ic = (n) => '<i data-ic="' + n + '"></i>';
  const switched = [];
  globalThis.BR = { upgradeSwitch: async () => { switched.push(1); return { ok: true }; }, upgradeLater: async () => true };
  const U = require('../renderer/upgrade-chat.js');
  U.upgradeOnEvent({ id: BIG.id, name: BIG.name, phase: 'downloading' });
  U.upgradeOnPull({ id: BIG.id, percent: 42.4 });
  assert.equal(U.UPGRADE.percent, 42);
  assert.equal(U.upgradeShown(), true);
  U.upgradeOnPull({ id: 'other', percent: 90 });
  assert.equal(U.UPGRADE.percent, 42);
  U.upgradeOnEvent({ id: BIG.id, name: BIG.name, phase: 'ready' });
  assert.equal(switched.length, 0);
  assert.equal(U.upgradeAct('upg:later'), true);
  assert.equal(U.upgradeShown(), false);
  U.upgradeOnEvent({ id: BIG.id, name: BIG.name, phase: 'ready' });
  assert.equal(U.upgradeAct('upg:switch'), true);
  assert.equal(switched.length, 1);
  assert.equal(U.upgradeAct('cpu:dismiss'), false);
  assert.equal(U.upgradeNameForTest(), 'Gemma 4 26B A4B');
  assert.ok(renders > 0);
});

test('ATO-1331: an upgrade that lost its projector still offers the switch, and says it reads text only', () => {
  globalThis.render = () => {};
  globalThis.ic = () => '';
  globalThis.esc = (s) => s;
  const U = require('../renderer/upgrade-chat.js');
  U.upgradeOnEvent({ id: BIG.id, name: BIG.name, phase: 'ready', textOnly: true });
  assert.equal(U.UPGRADE.textOnly, true);
  assert.equal(U.upgradeShown(), true);
  U.upgradeOnEvent({ id: BIG.id, name: BIG.name, phase: 'ready' });
  assert.equal(U.UPGRADE.textOnly, false);
  const html = readFileSync(new URL('../renderer/upgrade-chat.js', import.meta.url), 'utf8');
  assert.ok(html.includes('so it will read text only'));
});

test('ATO-1475: the ask strip shows the size; Download starts it, Not now is said once', () => {
  globalThis.render = () => {};
  globalThis.ic = () => '';
  globalThis.esc = (s) => String(s);
  const calls = [];
  globalThis.BR = {
    upgradeDownload: async () => { calls.push('download'); return { ok: true }; },
    upgradeNotNow: async () => { calls.push('notnow'); return true; },
  };
  const U = require('../renderer/upgrade-chat.js');
  U.upgradeOnEvent({ id: BIG.id, name: BIG.name, sizeLabel: '15.1 GB', phase: 'ask' });
  assert.equal(U.upgradeShown(), true);
  assert.equal(calls.length, 0);
  const src = readFileSync(new URL('../renderer/upgrade-chat.js', import.meta.url), 'utf8');
  assert.ok(src.includes('data-act="upg:download"') && src.includes('Not now'));
  assert.equal(U.upgradeAct('upg:notnow'), true);
  assert.equal(U.upgradeShown(), false);
  assert.deepEqual(calls, ['notnow']);
  U.upgradeOnEvent({ id: BIG.id, name: BIG.name, sizeLabel: '15.1 GB', phase: 'ask' });
  assert.equal(U.upgradeAct('upg:download'), true);
  assert.deepEqual(calls, ['notnow', 'download']);
});
