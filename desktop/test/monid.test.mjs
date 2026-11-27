// Settings › Connections › Monid (ATO-1630), renderer side: which configured
// server the pane drives (so Sign in never adds a second one next to the MCP
// catalog card's), the status it shows, its markup (no key field), and where
// the pane sits in Settings and the palette. The helpers come from
// renderer/monid.js; renderer.js is read as text for its registries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../renderer/monid.js');
const C = require('../renderer/mcp-catalog.js');
const A = require('../renderer/mcp-smart-add.js');
const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const h = {esc, ic: (n) => '<i:' + n + '>'};

const cardServer = () => {
  const r = A.mcpParseAddInput(C.mcpCatalogJson('monid'), {home:'/home/x'});
  assert.ok(r.ok, r.error);
  return r.server;
};

test('the pane uses the catalog card: same URL, browser sign-in', () => {
  const card = C.mcpCatalogEntry('monid');
  assert.ok(card, 'the catalog has a Monid card');
  assert.equal(card.auth, 'oauth');
  assert.equal(card.server.url, M.MONID_SERVER_URL);
  const s = cardServer();
  assert.equal(s.name, M.MONID_CATALOG_ID);
});

test('no duplicate with the catalog card: the card\'s server, a renamed one and one named monid are all found', () => {
  assert.equal(M.monidServerOf([]), null);
  assert.equal(M.monidServerOf(undefined), null);
  assert.equal(M.monidServerOf([{name:'github', enabled:true, transport:{kind:'streamable_http', url:'https://api.githubcopilot.com/mcp/'}}]), null);
  assert.deepEqual(M.monidServerOf([cardServer()]), {name:'monid', url:M.MONID_SERVER_URL, enabled:true});
  const renamed = {name:'my-monid', enabled:true, transport:{kind:'streamable_http', url:'https://MCP.monid.ai/v1/'}};
  assert.equal(M.monidServerOf([renamed]).name, 'my-monid');
  const local = {name:'monid', enabled:true, transport:{kind:'stdio', command:'monid-local'}};
  assert.equal(M.monidServerOf([local, renamed]).name, 'my-monid', 'the server at Monid\'s URL wins');
  assert.equal(M.monidServerOf([local]).name, 'monid', 'alone, the name still claims it');
  assert.equal(M.monidServerOf([{name:'monid', enabled:false, transport:{kind:'streamable_http', url:M.MONID_SERVER_URL}}]).enabled, false);
  assert.equal(M.monidServerOf([null, 3, {name:7}]), null);
});

test('status: not connected, not signed in, waiting, signed in, sign-in expired, off', () => {
  const server = {name:'monid', url:M.MONID_SERVER_URL, enabled:true};
  const lv = (srv, live, auth) => M.monidStatus(srv, live, auth).level;
  assert.equal(lv(null, null, null), 'none');
  assert.equal(lv(server, null, null), 'signed_out');
  assert.equal(lv(server, null, {state:'signed_out'}), 'signed_out');
  assert.equal(lv(server, null, {state:'unknown'}), 'signed_out');
  assert.equal(lv(server, null, {state:'checking'}), 'checking');
  assert.equal(lv(server, null, {state:'pending'}), 'pending');
  assert.equal(lv(server, null, {state:'signed_in'}), 'signed_in');
  assert.equal(lv(server, {state:'up'}, {state:'signed_in'}), 'signed_in');
  assert.equal(lv(server, {state:'needs_auth'}, {state:'signed_in'}), 'expired');
  assert.equal(lv(server, {state:'needs_auth'}, {state:'signed_out'}), 'signed_out');
  assert.equal(lv({...server, enabled:false}, null, {state:'signed_in'}), 'off');
  // A failed sign-in says why.
  assert.equal(M.monidStatus(server, null, {state:'signed_out', error:'Sign-in timed out. Start it again.'}).line, 'Sign-in timed out. Start it again.');
});

test('markup: no key field; Sign in and Disconnect where they apply; the Monid mark', () => {
  const server = {name:'monid', url:M.MONID_SERVER_URL, enabled:true};
  const html = (over) => M.monidPaneHTML(Object.assign({server:null, live:null, auth:null, busy:false, lastError:null, msg:null}, over), h);
  const none = html({});
  assert.doesNotMatch(none, /<input/, 'no key field');
  assert.doesNotMatch(none, /type="password"|Paste your/);
  assert.match(none, /data-act="monid:signin"/);
  assert.match(none, /Sign in with Monid/);
  assert.match(none, /logos\/monid\.svg/);
  assert.match(none, /data-monid-status="none"/);
  const signedIn = html({server, auth:{state:'signed_in'}});
  assert.doesNotMatch(signedIn, /data-act="monid:signin"/);
  assert.match(signedIn, /data-act="settings:mcp"/);
  const expired = html({server, auth:{state:'signed_in'}, live:{state:'needs_auth'}});
  assert.match(expired, /data-act="monid:signin"/);
  assert.match(expired, /Sign in again/);
  const pending = html({server, auth:{state:'pending'}});
  assert.match(pending, /data-act="monid:signin" disabled/);
  // Disconnect, like Composio's Remove key: only once there is a sign-in to forget.
  assert.match(signedIn, /data-act="monid:disconnect"[^>]*>Disconnect</);
  assert.match(expired, /data-act="monid:disconnect"/);
  assert.doesNotMatch(none, /monid:disconnect/);
  assert.doesNotMatch(pending, /monid:disconnect/);
  assert.match(html({server, auth:{state:'signed_in'}, busy:'signout'}), /Disconnecting…/);
  assert.match(html({server, auth:{state:'signed_in'}, busy:'signout'}), /data-act="monid:disconnect"[^>]*disabled/);
  assert.match(html({lastError:'<boom>'}), /&lt;boom&gt;/);
  // With the shared logo table (ATO-1634), its mark is used instead.
  assert.match(M.monidPaneHTML({server:null}, {...h, logo: () => '<span class="logo">T</span>'}), /<span class="logo">T<\/span>/);
  assert.doesNotMatch(none + signedIn + expired, /—/, 'no em dash in the copy');
});

test('Monid sits next to Composio in Connections, in the tab list and the palette', () => {
  assert.match(source, /\['connections','Connections','plug',\['mcp','telegram','discord','push','phone','composio','monid'\]\]/);
  assert.match(source, /\['composio','Composio'\],\['monid','Monid'\]/);
  assert.match(source, /\['link','Monid','Settings · Connections','','settings:monid'\]/);
  for (const hook of ["pane === 'monid') monidTabEntered()", "p === 'monid') return monidTab()",
    "k === 'monid') { close(); monidAct(a.slice(6))"]) {
    assert.ok(source.includes(hook), hook);
  }
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const helper = index.indexOf('<script src="monid.js">');
  assert.ok(helper > index.indexOf('<script src="mcp-auth.js">'), 'after mcp-auth.js');
  assert.ok(helper > 0 && helper < index.indexOf('<script src="renderer.js">'), 'before renderer.js');
  // The mark is the same file ATO-1634 ships.
  assert.match(readFileSync(new URL('../renderer/logos/monid.svg', import.meta.url), 'utf8'), /^<svg /);
});
