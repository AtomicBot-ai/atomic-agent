// Settings › Connections › Composio, renderer side: the key rule, whether
// the running agent has Composio mounted, the status the pane shows, its
// markup (never the key), where the pane sits in Settings and the palette,
// and the analytics it may send. The helpers come from renderer/composio.js;
// renderer.js is read as text for its registries. No key is written anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const C = require('../renderer/composio.js');
const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const h = {esc, ic: (n) => '<i:' + n + '>'};
const KEY = 'ak_dummy0123456789abcdef';
const base = {hasKey:true, enabled:true, toolsUp:true, restartOwed:false, checkError:null, mode:'list', busy:null,
  keyError:null, message:null, warning:null, lastError:null, shadowed:false, running:false};

test('the key rule matches main: letters, digits and _ - . : + / =, 8 to 512 characters', () => {
  assert.equal(C.composioKeyClean('  ' + KEY + '\n'), KEY, 'surrounding whitespace is trimmed');
  assert.equal(C.composioKeyClean(''), '');
  assert.equal(C.composioKeyClean('   '), '');
  assert.equal(C.composioKeyClean(null), '');
  for (const bad of ['short', 'two words here', KEY + '\nX=1', 'k'.repeat(513), 'ключ-ключ-ключ', KEY + '"', KEY + "'", KEY + '#x', KEY + '\\x']) assert.equal(C.composioKeyClean(bad), null, bad);
  assert.equal(C.composioKeyClean('k'.repeat(512)), 'k'.repeat(512));
  assert.equal(C.composioKeyClean('ak_AZaz09-._:+/='), 'ak_AZaz09-._:+/=');
});

test('Composio counts as mounted only when its search tool is offered', () => {
  assert.equal(C.composioToolsUp({tools:[{name:'os.fs.read'}, {name:'mcp.composio.COMPOSIO_SEARCH_TOOLS'}]}), true);
  assert.equal(C.composioToolsUp({tools:[{name:'mcp.composio_other.X'}, {name:'mcp.github.search'}]}), false);
  assert.equal(C.composioToolsUp({tools:[]}), false);
  assert.equal(C.composioToolsUp({}), null);
  assert.equal(C.composioToolsUp(null), null);
});

test('status: loading, none, restart, off, connected, error, unknown', () => {
  const lv = (over) => C.composioStatus(Object.assign({}, base, over)).level;
  assert.equal(lv({hasKey:null}), 'loading');
  assert.equal(lv({hasKey:false, toolsUp:false}), 'none');
  assert.equal(lv({restartOwed:true}), 'restart', 'a change waiting for a restart wins over what the old agent shows');
  assert.equal(lv({hasKey:false, restartOwed:true}), 'restart');
  assert.equal(lv({enabled:false}), 'off');
  assert.equal(lv({}), 'connected');
  assert.equal(lv({toolsUp:false}), 'error');
  assert.equal(lv({toolsUp:null}), 'unknown');
  assert.match(C.composioStatus(Object.assign({}, base, {hasKey:false, restartOwed:true})).line, /removed/);
  assert.match(C.composioStatus(Object.assign({}, base, {enabled:false, restartOwed:true})).line, /Turned off/);
  assert.equal(C.composioStatus(Object.assign({}, base, {toolsUp:false, checkError:'Composio rejected the API key (HTTP 401).'})).line,
    'Composio rejected the API key (HTTP 401).', 'a real error message is shown as it came');
  // A failed Check again outranks the running agent's tools: no green chip beside a refused key.
  assert.equal(lv({toolsUp:true, checkError:'Composio rejected the API key (HTTP 401).'}), 'error');
  assert.equal(lv({restartOwed:true, checkError:'x'}), 'restart');
});

test('no key: the setup card with the TUI walkthrough, the key link and an empty password field', () => {
  const html = C.composioPaneHTML(Object.assign({}, base, {hasKey:false, toolsUp:false}), h);
  assert.match(html, /Connect apps with Composio/);
  assert.match(html, /go through Composio's servers/);
  assert.match(html, /Sign up at composio\.dev and copy an API key from the dashboard\./);
  assert.match(html, /returns a sign-in link in the chat/);
  assert.match(html, /data-url="https:\/\/composio\.dev"/);
  assert.match(html, /<input id="cmp-key" type="password"[^>]*>/);
  assert.doesNotMatch(html, /<input id="cmp-key"[^>]*value=/, 'the field is emitted empty');
  assert.match(html, /data-act="composio:keySave"/);
  assert.doesNotMatch(html, /Use Composio|Remove key/);
});

test('with a key: status chip, the on switch, Replace and Remove, the connect-an-app guidance', () => {
  const html = C.composioPaneHTML(base, h);
  assert.match(html, /data-cmp-status="connected"[^>]*>Connected</);
  assert.match(html, /role="switch" aria-checked="true" aria-label="Use Composio"/);
  assert.match(html, /data-act="composio:enable"/);
  assert.match(html, /data-act="composio:key"/);
  assert.match(html, /data-act="composio:removeKey"/);
  assert.match(html, /data-act="composio:check"/);
  assert.match(html, /connect my Gmail/);
  assert.doesNotMatch(html, /id="cmp-key"/, 'no field until Replace key');
  const replacing = C.composioPaneHTML(Object.assign({}, base, {mode:'key'}), h);
  assert.match(replacing, /Replace the API key/);
  assert.match(replacing, /data-act="composio:keyCancel"/);
  const off = C.composioPaneHTML(Object.assign({}, base, {enabled:false}), h);
  assert.match(off, /aria-checked="false" aria-label="Use Composio"/);
  const env = C.composioPaneHTML(Object.assign({}, base, {shadowed:true}), h);
  assert.match(env, /COMPOSIO_API_KEY set in its environment/);
});

test('saving, errors and the owed restart', () => {
  const saving = C.composioPaneHTML(Object.assign({}, base, {hasKey:false, toolsUp:false, busy:'save'}), h);
  assert.match(saving, /Checking the key with Composio/);
  assert.match(saving, /<input id="cmp-key"[^>]* disabled>/);
  assert.match(saving, /data-act="composio:keySave"[^>]* disabled/);
  const bad = C.composioPaneHTML(Object.assign({}, base, {hasKey:false, toolsUp:false, keyError:'Composio rejected the API key (HTTP 401).'}), h);
  assert.match(bad, /is-error/);
  assert.match(bad, /tk-help--err">Composio rejected the API key \(HTTP 401\)\.</);
  const owed = C.composioPaneHTML(Object.assign({}, base, {restartOwed:true, message:'Key saved. Composio accepted it.'}), h);
  assert.match(owed, /Key saved\. Composio accepted it\./);
  assert.match(owed, /data-act="agent:restart"/);
  const busyTurn = C.composioPaneHTML(Object.assign({}, base, {restartOwed:true, running:true}), h);
  assert.doesNotMatch(busyTurn, /data-act="agent:restart"/, 'a restart would stop the running reply');
  assert.match(busyTurn, /Restart when the running reply is done/);
  const removed = C.composioPaneHTML(Object.assign({}, base, {hasKey:false, restartOwed:true}), h);
  assert.match(removed, /No key is saved/);
  assert.match(removed, /id="cmp-key"/);
  const err = C.composioPaneHTML(Object.assign({}, base, {lastError:'<b>x</b>', warning:'w & w'}), h);
  assert.match(err, /&lt;b&gt;x&lt;\/b&gt;/, 'messages are escaped');
  assert.match(err, /w &amp; w/);
});

test('the copy has no em dash and does not claim nothing leaves the machine', () => {
  const all = [
    C.composioPaneHTML(Object.assign({}, base, {hasKey:false, toolsUp:false}), h),
    C.composioPaneHTML(base, h), C.composioPaneHTML(Object.assign({}, base, {mode:'key', restartOwed:true}), h),
    ...['loading', 'none', 'restart', 'off', 'connected', 'error', 'unknown'].map((l) => JSON.stringify(C.composioStatus(Object.assign({}, base,
      {hasKey: l === 'loading' ? null : l !== 'none', enabled: l !== 'off', restartOwed: l === 'restart', toolsUp: l === 'connected' ? true : l === 'error' ? false : null})))),
  ].join('\n');
  assert.doesNotMatch(all, /—/);
  assert.doesNotMatch(all, /never leaves|nothing leaves|stays on your machine/i);
});

test('Composio is the third pane of Connections, in the tab list and the palette', () => {
  assert.match(source, /\['connections','Connections','plug',\['mcp','telegram','composio'\]\]/);
  assert.match(source, /\['telegram','Telegram'\],\['composio','Composio'\],\['memory','Memory'\]/);
  assert.match(source, /\['link','Composio','Settings · Connections','','settings:composio'\]/);
  for (const hook of ["pane === 'composio') composioTabEntered()", "p === 'composio') return composioTab()",
    "k === 'composio') { close(); composioAct(a.slice(9))", "pane === 'composio' && composioKey(e, k, inText)"]) {
    assert.ok(source.includes(hook), hook);
  }
  // index.html loads the helpers before renderer.js.
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  assert.ok(index.indexOf('composio.js') > 0 && index.indexOf('composio.js') < index.indexOf('renderer.js'));
});

test('analytics: the pane verbs are kept, nothing after them is', () => {
  const ctx = vm.createContext({window:{}});
  vm.runInContext(readFileSync(new URL('../renderer/analytics-acts.js', import.meta.url), 'utf8'), ctx);
  const {sanitizeAct} = vm.runInContext('ANX_ACTS', ctx);
  for (const v of ['check', 'enable', 'key', 'keyCancel', 'keySave', 'refresh', 'removeKey', 'restart']) {
    assert.equal(sanitizeAct('composio:' + v), 'composio:' + v);
  }
  assert.equal(sanitizeAct('composio:keySave:' + KEY), 'composio:keySave');
  assert.equal(sanitizeAct('composio:' + KEY), 'composio');
});
