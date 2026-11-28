// ATO-2528 / ATO-2529: Settings › Privacy › Known hosts and Security rules
// (renderer/security-settings.js, main/guard-rules-file.ts).
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const K = require('../renderer/security-settings.js');
const G = require('../out/main/guard-rules-file.js');
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

test('a host is checked the way the agent checks it', () => {
  assert.equal(K.knownHostNormalise('GitHub.com.'), 'github.com');
  assert.equal(K.knownHostNormalise('*.Example.com'), '*.example.com');
  assert.equal(K.knownHostNormalise('https://user@api.example.com:8443/v1'), 'api.example.com');
  for (const bad of ['', '*', 'a b', '*.', 'x.io/path', '-x.io', 'x.io;rm', 42]) assert.equal(K.knownHostNormalise(bad), null, String(bad));
});

test('adding refuses a bad, a repeated and a 501st host, so the config never fails to load', () => {
  // A bad entry would make the agent refuse the whole config file (security-config.ts parseKnownHosts throws).
  assert.equal(K.knownHostsAdd([], 'not a host').ok, false);
  assert.equal(K.knownHostsAdd(['x.io'], 'X.io').ok, false);
  const full = Array.from({ length: K.KHOSTS_MAX }, (_, i) => 'h' + i + '.io');
  assert.equal(K.knownHostsAdd(full, 'new.io').ok, false);
  assert.deepEqual(K.knownHostsAdd(['x.io'], 'y.io'), { ok: true, list: ['x.io', 'y.io'], entry: 'y.io' });
  assert.deepEqual(K.knownHostsRemove(['x.io', 'y.io'], 'x.io'), ['y.io']);
});

test('the list reads the config and escapes what it shows', () => {
  const list = K.knownHostsOf({ agent: { security: { knownHosts: ['github.com', '*.npmjs.org', 7] } } });
  assert.deepEqual(list, ['github.com', '*.npmjs.org']);
  const html = K.knownHostsHTML(list, {}, { esc });
  assert.match(html, /data-act="khosts:del:github.com"/);
  assert.match(html, /and every subdomain/);
  assert.match(K.knownHostsHTML([], {}, { esc }), /No known hosts yet/);
  assert.deepEqual(K.knownHostsOf(null), []);
});

test('Add host writes the whole new list through PATCH, and a bad host is not written', async () => {
  const saved = [];
  let config = { agent: { security: { knownHosts: ['github.com'] } } };
  let typed = 'Bad Host';
  const S = K.createSecuritySettings({
    guardRules: async () => null, guardRulesOpen: async () => null,
    config: () => config,
    saveHosts: async (list) => { saved.push(list); config = { agent: { security: { knownHosts: list } } }; return { ok: true, live: true }; },
    inputValue: () => typed, render() {}, repaint() {}, toast() {},
  });
  await S.act('khosts', 'add');
  assert.equal(saved.length, 0);
  assert.match(S.hosts.error, /Not a host name/);
  typed = 'registry.npmjs.org';
  await S.act('khosts', 'add');
  assert.deepEqual(saved.pop(), ['github.com', 'registry.npmjs.org']);
  await S.act('khosts', 'del:github.com');
  assert.deepEqual(saved.pop(), ['registry.npmjs.org']);
  await S.act('khosts', 'del:not-on-the-list.io');
  assert.equal(saved.length, 0);
});

test('an older app without the bridge says so instead of a dead button', async () => {
  const S = K.createSecuritySettings({ guardRules: () => null, guardRulesOpen: () => null, config: () => null, saveHosts: async () => ({ ok: true }), inputValue: () => '', render() {}, repaint() {}, toast() {} });
  await S.load();
  assert.match(S.html({ esc }), /can’t create the security rules file/);
});

test('the starter guard.md turns nothing on, and an existing file is never written over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    assert.equal(G.guardRuleLines(G.GUARD_STARTER), 0);
    const first = await G.ensureGuardFile(dir);
    assert.equal(first.created, true);
    assert.equal(readFileSync(first.path, 'utf8'), G.GUARD_STARTER);
    writeFileSync(first.path, G.GUARD_STARTER + 'Block reading any .env file.\n');
    const again = await G.ensureGuardFile(dir);
    assert.equal(again.created, false);
    assert.match(readFileSync(first.path, 'utf8'), /Block reading any \.env file/);
    const st = await G.guardRulesState(dir);
    assert.deepEqual({ exists: st.exists, ruleLines: st.ruleLines }, { exists: true, ruleLines: 1 });
    assert.equal((await G.guardRulesState(join(dir, 'missing'))).exists, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the starter frontmatter parses the way the agent parses it: onFailure ask, no tools, no rules', () => {
  // Same regexes as src/approval/guard-rules.ts parseGuardFile.
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(G.GUARD_STARTER);
  assert.ok(front);
  const fields = front[1].split('\n').map((l) => /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(l)).filter(Boolean).map((m) => m[1].toLowerCase());
  assert.deepEqual(fields, ['onfailure']);
  assert.equal(G.GUARD_STARTER.slice(front[0].length).trim(), '');
});

test('the rules block offers Create when there is no file and Open when there is', () => {
  assert.match(K.guardRulesHTML({ loaded: true, exists: false }, { esc }), /Create guard\.md/);
  const on = K.guardRulesHTML({ loaded: true, exists: true, ruleLines: 2, path: '/s/guard.md' }, { esc });
  assert.match(on, /Open guard\.md/);
  assert.match(on, /On: 2 lines of rules in \/s\/guard\.md/);
  assert.match(K.guardRulesHTML({ loaded: true, exists: true, ruleLines: 0 }, { esc }), /holds no rule yet/);
});

test('main wires the routes with the opener that never runs a file, and the preload exposes them', () => {
  const main = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
  assert.match(main, /wireGuardRulesIpc\(openWithoutRunning\)/);
  const preload = readFileSync(new URL('../preload/preload.ts', import.meta.url), 'utf8');
  assert.match(preload, /guardRules: \(\) => ipcRenderer\.invoke\("app:guardRules"\)/);
  assert.match(preload, /guardRulesOpen: \(\) => ipcRenderer\.invoke\("app:guardRulesOpen"\)/);
});
