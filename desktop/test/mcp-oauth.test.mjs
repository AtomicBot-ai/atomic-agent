// MCP browser sign-in in the window: the renderer's pure helpers
// (renderer/mcp-auth.js), the https check main runs before opening the
// sign-in page (main/mcp-auth-url.ts, built to out/main), and the wiring
// between preload, main, index.html and renderer.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../renderer/mcp-auth.js');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const h = {esc};
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const remote = {name:'monid', transport:{kind:'streamable_http', url:'https://mcp.monid.ai/v1'}};
const keyed = {name:'keyed', transport:{kind:'streamable_http', url:'https://x.test/mcp', headers:{Authorization:'Bearer k'}}};
const xkey = {name:'composio', transport:{kind:'streamable_http', url:'https://x.test/mcp', headers:{'x-api-key':'k'}}};
const local = {name:'fs', transport:{kind:'stdio', command:'npx'}};

test('browser sign-in applies to a remote server with no key in its headers', () => {
  assert.equal(A.mcpUsesOAuth(remote), true);
  assert.equal(A.mcpUsesOAuth({name:'s', transport:{kind:'sse', url:'https://x.test/sse', headers:{'X-Trace':'1'}}}), true);
  assert.equal(A.mcpUsesOAuth(keyed), false);
  assert.equal(A.mcpUsesOAuth(xkey), false);
  assert.equal(A.mcpUsesOAuth(local), false);
  assert.equal(A.mcpUsesOAuth(null), false);
});

test('the row view: needs_auth asks to sign in, pending waits, signed in offers sign out', () => {
  assert.equal(A.mcpAuthViewOf(remote, {state:'needs_auth'}, undefined, false), 'needs');
  assert.equal(A.mcpAuthViewOf(remote, undefined, {state:'signed_out'}, true), 'needs', 'a catalog sign-in server before its first sign-in');
  assert.equal(A.mcpAuthViewOf(remote, undefined, {state:'signed_out'}, false), null, 'a remote server that never asked stays quiet');
  assert.equal(A.mcpAuthViewOf(remote, {state:'needs_auth'}, {state:'pending'}, false), 'pending');
  assert.equal(A.mcpAuthViewOf(remote, {state:'up'}, {state:'signed_in'}, false), 'signed_in');
  assert.equal(A.mcpAuthViewOf(remote, {state:'needs_auth'}, {state:'signed_in'}, false), 'needs', 'a refused refresh asks to sign in again');
  assert.equal(A.mcpAuthViewOf({...remote, enabled:false}, {state:'needs_auth'}, undefined, true), null, 'a turned-off server shows nothing');
  assert.equal(A.mcpAuthViewOf(keyed, {state:'needs_auth'}, undefined, false), null, 'a server with a key never signs in');
  assert.equal(A.mcpAuthViewOf(local, {state:'needs_auth'}, undefined, false), null);
});

test('chip and controls: Sign in required + Sign in, Waiting for the browser, Sign out', () => {
  assert.match(A.mcpAuthChipHTML('needs', undefined, h), /Sign in required/);
  assert.match(A.mcpAuthChipHTML('needs', {error:'Sign-in timed out. Start it again.'}, h), /title="Sign-in timed out/);
  assert.match(A.mcpAuthChipHTML('pending', undefined, h), /Waiting for the browser/);
  assert.equal(A.mcpAuthChipHTML('signed_in', undefined, h), null, 'a signed-in server keeps its usual state chip');
  assert.equal(A.mcpAuthChipHTML(null, undefined, h), null);

  assert.match(A.mcpAuthRowControlHTML('monid', 'needs', h), /data-act="mcp:signin:monid"[^>]*>|>Sign in</);
  assert.match(A.mcpAuthRowControlHTML('monid', 'needs', h), />Sign in</);
  assert.match(A.mcpAuthRowControlHTML('monid', 'signed_in', h), /data-act="mcp:signout:monid"/);
  assert.match(A.mcpAuthRowControlHTML('monid', 'signed_in', h), />Sign out</);
  assert.equal(A.mcpAuthRowControlHTML('monid', 'pending', h), '', 'no second Sign in while one waits');
  assert.equal(A.mcpAuthRowControlHTML('monid', null, h), '');
  // The row is itself a <button>: its controls are spans.
  assert.doesNotMatch(A.mcpAuthRowControlHTML('monid', 'needs', h), /<button/);
  assert.match(A.mcpAuthDetailControlHTML('monid', 'needs', h), /<button[^>]*data-act="mcp:signin:monid"/);
  assert.match(A.mcpAuthDetailControlHTML('monid', 'signed_in', h), /<button[^>]*data-act="mcp:signout:monid"/);
});

test('the poll: every 2 s, stops on signed in, an error or after 5 minutes', () => {
  assert.equal(A.MCP_AUTH.pollMs, 2000);
  assert.equal(A.MCP_AUTH.maxMs, 5 * 60 * 1000);
  const t0 = 1_000_000;
  assert.equal(A.mcpAuthPollStep({state:'pending'}, t0, t0 + 2000, A.MCP_AUTH.maxMs), 'wait');
  assert.equal(A.mcpAuthPollStep(null, t0, t0 + 2000, A.MCP_AUTH.maxMs), 'wait', 'a failed poll waits for the next one');
  assert.equal(A.mcpAuthPollStep({state:'signed_out'}, t0, t0 + 2000, A.MCP_AUTH.maxMs), 'wait', 'the code exchange window is not a failure');
  assert.equal(A.mcpAuthPollStep({state:'signed_out', error:'Sign-in was not completed: denied'}, t0, t0 + 2000, A.MCP_AUTH.maxMs), 'failed');
  assert.equal(A.mcpAuthPollStep({state:'signed_in'}, t0, t0 + 4000, A.MCP_AUTH.maxMs), 'done');
  assert.equal(A.mcpAuthPollStep({state:'signed_out', error:'Access denied.'}, t0, t0 + 4000, A.MCP_AUTH.maxMs), 'failed');
  assert.equal(A.mcpAuthPollStep({state:'pending'}, t0, t0 + A.MCP_AUTH.maxMs, A.MCP_AUTH.maxMs), 'timeout');
});

test('main opens only a plain https sign-in page', { skip: !existsSync(new URL('../out/main/mcp-auth-url.js', import.meta.url)) && 'run npm run build first' }, () => {
  const { isSafeSignInUrl } = require('../out/main/mcp-auth-url.js');
  assert.equal(isSafeSignInUrl('https://auth.monid.ai/authorize?client_id=a&state=b'), true);
  for (const bad of ['http://auth.monid.ai/authorize', 'file:///etc/passwd', 'javascript:alert(1)', 'atomic://x',
    'https://user:pw@auth.monid.ai/', '', 'not a url', null, undefined, 42, 'https://' + 'a'.repeat(9000)]) {
    assert.equal(isSafeSignInUrl(bad), false, String(bad).slice(0, 40));
  }
});

test('wiring: preload, main, index.html and renderer.js', () => {
  const preload = src('../preload/preload.ts');
  for (const ch of ['mcp:authStart', 'mcp:authStatus', 'mcp:authSignOut']) assert.ok(preload.includes('"' + ch + '"'), 'preload ' + ch);
  const live = src('../main/agent-live.ts');
  for (const ch of ['mcp:authStart', 'mcp:authStatus', 'mcp:authSignOut']) assert.ok(live.includes('"' + ch + '"'), 'main ' + ch);
  assert.ok(live.includes('isSafeSignInUrl(data.authUrl)'), 'the URL is checked before it is opened');
  assert.ok(live.indexOf('isSafeSignInUrl(data.authUrl)') < live.indexOf('shell.openExternal(data.authUrl)'));
  const client = src('../main/agent-client.ts');
  for (const p of ['/auth/start', '/auth`', '/auth/signout']) assert.ok(client.includes(p), 'agent-client ' + p);

  const html = src('../renderer/index.html');
  const at = (f) => html.indexOf('<script src="' + f + '"></script>');
  assert.ok(at('mcp-live.js') > 0 && at('mcp-auth.js') > at('mcp-live.js'), 'mcp-auth.js loads after mcp-live.js');
  assert.ok(at('renderer.js') > at('mcp-auth.js'), 'and before renderer.js');

  const r = src('../renderer/renderer.js');
  assert.ok(r.includes("if (verb === 'signin') { mcpAuthSignIn(sel()); return; }"));
  assert.ok(r.includes("if (verb === 'signout') { mcpAuthSignOut(sel()); return; }"));
  assert.ok(r.includes('mcpAuthSync()'), 'a refresh reads which servers are signed in');
  const liveJs = src('../renderer/mcp-live.js');
  assert.ok(liveJs.includes("needs_auth:'sign in required'"));
  assert.ok(src('../renderer/analytics-acts.js').includes('signin:L, signout:L'), 'analytics reports the verb, never the server name');
});

test('new user-facing text has no em dashes', () => {
  assert.doesNotMatch(src('../renderer/mcp-auth.js'), /—/);
  assert.doesNotMatch(src('../main/mcp-auth-url.ts'), /—/);
});
