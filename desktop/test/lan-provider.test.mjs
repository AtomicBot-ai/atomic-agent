import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ATO-1066: the "Another computer on your network" row of the add-provider list.
const source = readFileSync(new URL('../renderer/lan-provider.js', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
function load() { const c = {URL}; runInNewContext(source, c); return c; }

test('an address typed as read off the other computer becomes a base URL', () => {
  const c = load();
  const cases = [
    ['192.168.1.20:8080', 'http://192.168.1.20:8080'],
    [' 10.0.0.5:11434 ', 'http://10.0.0.5:11434'],
    ['gpu-box.local:1234', 'http://gpu-box.local:1234'],
    ['http://192.168.1.20:8080/v1', 'http://192.168.1.20:8080'],
    ['http://192.168.1.20:8080/v1/', 'http://192.168.1.20:8080'],
    ['https://studio.lan:1234', 'https://studio.lan:1234'],
    ['[fd12::1]:8080', 'http://[fd12::1]:8080'],
    ['192.168.1.20:8080/v1?x=1', 'http://192.168.1.20:8080'],
  ];
  for (const [raw, baseUrl] of cases) {
    const r = c.lanAddressToBaseUrl(raw);
    assert.equal(r.ok, true, raw); assert.equal(r.baseUrl, baseUrl, raw);
    // What the wizard's own URL check accepts.
    assert.match(r.baseUrl, /^https?:\/\/\S+$/);
  }
});

test('what is not an address is refused with a reason', () => {
  const c = load();
  for (const raw of ['', '  ', 'ftp://192.168.1.20', 'http://', 'http://u:p@192.168.1.20:8080', null]) {
    const r = c.lanAddressToBaseUrl(raw);
    assert.equal(r.ok, false, String(raw)); assert.ok(r.reason.length > 0);
  }
});

test('the error lines say what to check on the other computer', () => {
  const c = load();
  const down = c.lanWizardError('http://192.168.1.20:8080', true, false, false);
  assert.match(down, /Nothing answered at http:\/\/192\.168\.1\.20:8080/);
  assert.match(down, /not only on 127\.0\.0\.1/); assert.match(down, /firewall/);
  assert.match(c.lanWizardError('http://192.168.1.20:8080', false, true, false), /asks for a key/);
  // A typed key that was refused is that key's fault: the generic line stays.
  assert.equal(c.lanWizardError('http://192.168.1.20:8080', false, true, true), null);
  assert.equal(c.lanWizardError('http://192.168.1.20:8080', false, false, false), null);
});

test('the row is a custom-address row with an optional key', () => {
  const row = load().lanProviderRow();
  assert.equal(row.kind, 'openai-compatible'); assert.equal(row.custom, true); assert.equal(row.lan, true);
  assert.equal(row.local, undefined, 'not "an app on this computer"');
});

test('the renderer loads the module first and wires the row in', () => {
  assert.ok(html.indexOf('lan-provider.js') > -1 && html.indexOf('lan-provider.js') < html.indexOf('renderer.js'));
  assert.match(renderer, /KIND_ROWS\.push\(lanProviderRow\(\)\)/);
  assert.match(renderer, /lanAddressToBaseUrl\(WIZ\.baseUrl\)/);
  assert.match(renderer, /lanWizardError\(/);
  // The plain custom row stays the first custom row: existing entries map to it.
  assert.ok(renderer.indexOf("id:'openai-compatible', kind:'openai-compatible'") < renderer.indexOf('KIND_ROWS.push(lanProviderRow())'));
});

const LAN = ['http://192.168.1.20:8080', 'http://10.0.0.5:11434', 'http://172.20.1.2', 'http://169.254.3.4:8080',
  'http://gpu-box.local:1234', 'http://gpu-box:8080', 'http://studio.lan', 'http://[fd12::1]:8080', 'http://[fe80::1]:8080'];
const NOT_LAN = ['http://localhost:8080', 'http://127.0.0.1:1234', 'http://127.0.0.2:8080', 'http://[::1]:8080', 'http://0.0.0.0:8080',
  'http://box.localhost', 'https://api.openai.com', 'http://8.8.8.8:8080', 'http://172.32.0.1', 'not a url', '', undefined];

test('the renderer and main agree on what another computer on the network is', () => {
  const c = load();
  const { isOtherComputerOnNetworkUrl } = require('../out/main/agent-cli.js');
  for (const url of LAN) { assert.equal(c.lanIsOtherComputerUrl(url), true, url); assert.equal(isOtherComputerOnNetworkUrl(url), true, url); }
  for (const url of NOT_LAN) { assert.equal(c.lanIsOtherComputerUrl(url), false, String(url)); assert.equal(isOtherComputerOnNetworkUrl(url || ''), false, String(url)); }
});

test('a keyless server on another computer is usable, one that names its key variable is not', () => {
  const { isKeylessLocalProviderEntry } = require('../out/main/agent-cli.js');
  assert.equal(isKeylessLocalProviderEntry({id:'custom-192-168-1-20-8080', kind:'openai-compatible', baseUrl:'http://192.168.1.20:8080'}), true);
  assert.equal(isKeylessLocalProviderEntry({id:'custom-x', kind:'openai-compatible', baseUrl:'http://192.168.1.20:8080', apiKeyEnvVar:'MY_KEY'}), false);
  assert.equal(isKeylessLocalProviderEntry({id:'custom-pub', kind:'openai-compatible', baseUrl:'https://api.example.com'}), false);
  assert.match(renderer, /lanIsOtherComputerUrl\(p\.baseUrl\)/);
});

test('a server on another computer never gets the shared OpenAI key from the environment', () => {
  const { resolveKeyValue, providerHasKey } = require('../out/main/agent-cli.js');
  const saved = {OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_COMPAT_API_KEY: process.env.OPENAI_COMPAT_API_KEY};
  process.env.OPENAI_API_KEY = 'sk-test';
  delete process.env.OPENAI_COMPAT_API_KEY;
  try {
    // Saved with a blank key: the user's real key must not go as a Bearer over plain http:// to that box.
    assert.equal(resolveKeyValue({id:'custom-192-168-1-20-8080', kind:'openai-compatible', baseUrl:'http://192.168.1.20:8080'}), null);
    assert.equal(providerHasKey({id:'custom-192-168-1-20-8080', kind:'openai-compatible', baseUrl:'http://192.168.1.20:8080'},
      {present:new Set(['OPENAI_API_KEY']), nonEmpty:new Set(['OPENAI_API_KEY']), badChars:new Set()}), false);
    // Its own key still goes.
    assert.equal(resolveKeyValue({id:'lan', kind:'openai-compatible', baseUrl:'http://192.168.1.20:8080', apiKey:'lan-key'}), 'lan-key');
    // A cloud endpoint keeps the shared fallback, as before.
    assert.equal(resolveKeyValue({id:'openai-compatible', kind:'openai-compatible', baseUrl:'https://api.openai.com'}), 'sk-test');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('the smoke driver decides "no key needed" by the app\'s rule, not a copy of the loopback-only one (ATO-1546)', () => {
  const main = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
  const at = main.indexOf('const keylessLocal = (p: Provider) =>');
  assert.ok(at >= 0, 'the Settings smoke still has its keylessLocal');
  const line = main.slice(at, main.indexOf('\n', at));
  assert.match(line, /isKeylessLocalProviderEntry\(p\)/);
  assert.doesNotMatch(line, /localhost/);
});
