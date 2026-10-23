/* ATO-510 (U-74): the Add MCP server box takes JSON, a command or a URL.

   One field, three shapes, one result: whatever is pasted becomes the same
   `mcp.servers` entry the JSON path always wrote ({name, transport, env?}).
   - JSON: a bare server object, the `{ mcpServers: { name: {…} } }` envelope
     with exactly one entry, and the `command`/`args` (or `url`/`serverUrl`)
     shortcut promoted into `transport` (persist-mcp-server.ts
     parseAddServerJson). Unchanged from before this file.
   - A command line as a README prints it: `npx -y @scope/server-x ~/Docs`,
     with quotes, `\` line continuations, a leading `$ `, `KEY=value`
     prefixes (they become the server's `env`) and `claude mcp add …`.
   - A URL: http(s) becomes a remote server, `sse` when the path ends in
     /sse, streamable HTTP otherwise.
   A command or URL gets a name made from the package or host, which the
   user can change in the box before adding.

   Loaded before renderer.js and required by the Node checks. Pure: no DOM,
   no IPC, no config access. The schema itself (name regex, transport shape,
   trust enum) is still checked by the agent on the write. */

const MCP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
const MCP_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/* ---------------- JSON (moved from renderer.js as is) ---------------- */

function mcpNormalizeShortcut(obj) {
  if (obj.transport !== undefined) return obj;
  if (typeof obj.command === 'string') {
    const out = Object.assign({}, obj); delete out.command; delete out.args; delete out.cwd;
    const transport = {kind:'stdio', command:obj.command};
    if (obj.args !== undefined) transport.args = obj.args;
    if (obj.cwd !== undefined) transport.cwd = obj.cwd;
    out.transport = transport; return out;
  }
  const rawUrl = typeof obj.url === 'string' ? obj.url : typeof obj.serverUrl === 'string' ? obj.serverUrl : null;
  if (rawUrl !== null) {
    const out = Object.assign({}, obj); delete out.url; delete out.serverUrl; delete out.headers; delete out.type;
    const transport = {kind:obj.type === 'sse' ? 'sse' : 'streamable_http', url:rawUrl};
    if (obj.headers !== undefined) transport.headers = obj.headers;
    out.transport = transport; return out;
  }
  return obj;
}
function mcpParseAddJson(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed.length) return {ok:false, error:'Paste a server config first.'};
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch (err) { return {ok:false, error:'This isn\u2019t valid JSON. Check for a missing comma, quote or bracket (' + (err && err.message ? err.message : String(err)) + ').'}; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {ok:false, error:'Paste one server config: a JSON object in { } braces.'};
  let candidate;
  const envelope = parsed.mcpServers;
  if (envelope !== undefined) {
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return {ok:false, error:'"mcpServers" should hold the server by name, like the example.'};
    const entries = Object.entries(envelope);
    if (!entries.length) return {ok:false, error:'"mcpServers" is empty. Paste exactly one server.'};
    if (entries.length > 1) return {ok:false, error:'Paste exactly one server. This has ' + entries.length + ' in "mcpServers".'};
    const [keyName, value] = entries[0];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {ok:false, error:'`mcpServers[' + JSON.stringify(keyName) + ']` must be an object'};
    if (typeof value.name === 'string' && value.name !== keyName) return {ok:false, error:'name mismatch: envelope key ' + JSON.stringify(keyName) + ' vs inner ' + JSON.stringify(value.name)};
    candidate = mcpNormalizeShortcut(Object.assign({name:keyName}, value));
  } else {
    candidate = mcpNormalizeShortcut(parsed);
  }
  if (Object.hasOwn(candidate, '__proto__') || Object.hasOwn(candidate, 'constructor') || Object.hasOwn(candidate, 'prototype')) return {ok:false, error:'refusing a prototype key'};
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) return {ok:false, error:'mcp.servers: name: expected a non-empty string'};
  return {ok:true, server:candidate};
}

/* ---------------- command lines ---------------- */

/* Splits a command line the way a POSIX shell would for the cases READMEs
   use: spaces, '…', "…" (with \" \\ \$ \` inside), a backslash escaping the
   next character, and backslash-newline joining lines. No expansion, no
   pipes. An unclosed quote is an error. */
function mcpSplitCommand(line) {
  const s = String(line || '');
  const out = [];
  let cur = '', has = false, quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") { if (c === "'") quote = null; else cur += c; continue; }
    if (quote === '"') {
      if (c === '"') { quote = null; continue; }
      if (c === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) { i++; if (s[i] !== '\n') cur += s[i]; continue; }
      cur += c; continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      i++;
      if (s[i] === '\r' && s[i + 1] === '\n') i++;
      if (s[i] !== '\n' && s[i] !== '\r') { cur += s[i]; has = true; }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (/\s/.test(c)) { if (has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c; has = true;
  }
  if (quote) return {ok:false, error:'A quote (' + quote + ') is not closed.'};
  if (has) out.push(cur);
  return {ok:true, tokens:out};
}

/* A name the agent accepts (lowercase letters, digits and dashes, 2 to 32
   characters), made from any text. Empty when nothing usable is left. */
function mcpSlug(text) {
  let s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > 32) s = s.slice(0, 32).replace(/-+$/g, '');
  return MCP_NAME_RE.test(s) ? s : '';
}

/* `@scope/server-github@1.2` → `github`: the package's own name without its
   version and the usual mcp / server words, else its scope. */
function mcpNameFromPackage(pkg) {
  let p = String(pkg || '').trim();
  if (!p) return '';
  p = p.replace(/^(?:npm|jsr|pypi):/, '');
  let scope = '';
  if (p.startsWith('@')) { const slash = p.indexOf('/'); if (slash > 0) { scope = p.slice(1, slash); p = p.slice(slash + 1); } else p = p.slice(1); }
  p = p.replace(/@[^/]*$/, '').replace(/==.*$/, '').replace(/:[^/\\:]*$/, '');
  p = p.split(/[\\/]/).filter(Boolean).pop() || '';
  p = p.replace(/\.(?:js|mjs|cjs|ts|py|exe|jar)$/i, '');
  const core = mcpSlug(p)
    .replace(/^(?:mcp-server-|server-mcp-|mcp-|server-)+/, '')
    .replace(/(?:-mcp-server|-server-mcp|-mcp|-server)+$/, '');
  if (core && core !== 'mcp' && core !== 'server') return mcpSlug(core);
  return mcpSlug(scope) || mcpSlug(p);
}

/* `https://mcp.linear.app/sse` → `linear`. */
function mcpNameFromUrl(raw) {
  let host = '';
  try { host = new URL(raw).hostname; } catch (e) { return ''; }
  if (host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':')) return 'local';
  const parts = host.split('.').filter((p) => p && !/^(?:www|mcp|api|server|app)$/.test(p));
  if (parts.length > 1) parts.pop(); // the top-level domain
  return mcpSlug(parts.length ? parts[parts.length - 1] : host);
}

/* Runners whose first real argument is the package (`npx -y pkg`), and
   flags that eat the next word, so `-e KEY` or `--from x` is skipped. */
const MCP_RUNNERS = {
  npx:1, bunx:1, uvx:1, pipx:1, deno:1, node:1, python:1, python3:1, bun:1, docker:1, podman:1,
  pnpm:1, yarn:1, npm:1, uv:1, go:1, java:1,
};
const MCP_VALUE_FLAGS = new Set(['-p', '--package', '--from', '--with', '-e', '--env', '--env-file', '-v', '--volume',
  '--name', '--network', '-w', '--workdir', '--mount', '-u', '--user', '--directory', '--python', '--platform', '--entrypoint', '-c']);
const MCP_SUBCOMMANDS = new Set(['run', 'dlx', 'exec', 'x', 'tool']);

function mcpNameFromCommand(command, args) {
  const base = String(command || '').split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
  if (!MCP_RUNNERS[base]) return mcpNameFromPackage(base);
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i]);
    if (a === '-m' && i + 1 < list.length) return mcpNameFromPackage(list[i + 1]);
    if (a.startsWith('-')) { if (!a.includes('=') && MCP_VALUE_FLAGS.has(a)) i++; continue; }
    if (MCP_SUBCOMMANDS.has(a) && i < 2) continue;
    if (/^(?:jsr|npm):/.test(a) || !/^[a-z]+:/.test(a)) return mcpNameFromPackage(a);
  }
  return mcpNameFromPackage(base);
}

/* A leading `~` means the home folder in a shell, but the agent starts the
   server without one, so it is spelled out when the home folder is known. */
function mcpExpandHome(arg, home) {
  if (!home) return arg;
  if (arg === '~') return home;
  if (arg.startsWith('~/')) return home.replace(/[\\/]+$/, '') + arg.slice(1);
  return arg;
}

/* `KEY=value` words in front of the command → env; `env` itself is skipped. */
function mcpTakeEnv(tokens) {
  const env = {};
  let i = 0;
  if (tokens[0] === 'env') i = 1;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    const eq = t.indexOf('=');
    if (eq <= 0 || !MCP_ENV_RE.test(t.slice(0, eq))) break;
    env[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return {env, rest:tokens.slice(i)};
}

function mcpStdioServer(name, tokens, env, home) {
  if (!tokens.length) return {ok:false, error:'There is no command to run after the settings.'};
  const command = tokens[0];
  const args = tokens.slice(1).map((a) => mcpExpandHome(a, home));
  const server = {name: name || mcpNameFromCommand(command, args), transport:{kind:'stdio', command}};
  if (args.length) server.transport.args = args;
  if (Object.keys(env).length) server.env = env;
  return {ok:true, server};
}

function mcpUrlServer(name, raw, headers) {
  let u;
  try { u = new URL(raw); } catch (e) { return {ok:false, error:'This doesn\u2019t look like a full address. Start it with https://'}; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return {ok:false, error:'Only http:// and https:// addresses can be added.'};
  const kind = /\/sse\/?$/i.test(u.pathname) ? 'sse' : 'streamable_http';
  const server = {name: name || mcpNameFromUrl(raw), transport:{kind, url:raw}};
  if (headers && Object.keys(headers).length) server.transport.headers = headers;
  return {ok:true, server};
}

/* `claude mcp add [opts] <name> -- <command…>` and
   `claude mcp add --transport http|sse [opts] <name> <url>`, as READMEs print
   them for another client. The name given there is kept. */
function mcpParseClaudeAdd(tokens, home) {
  let transport = null, name = null;
  const env = {}, headers = {};
  let i = 3;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') { i++; break; }
    const [flag, inline] = t.startsWith('--') && t.includes('=') ? [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)] : [t, null];
    const value = () => (inline !== null ? inline : tokens[++i]);
    if (flag === '-t' || flag === '--transport') { transport = value(); continue; }
    if (flag === '-s' || flag === '--scope') { value(); continue; }
    if (flag === '-e' || flag === '--env') {
      const kv = String(value() || ''); const eq = kv.indexOf('=');
      if (eq > 0 && MCP_ENV_RE.test(kv.slice(0, eq))) env[kv.slice(0, eq)] = kv.slice(eq + 1);
      continue;
    }
    if (flag === '-H' || flag === '--header') {
      const hv = String(value() || ''); const c = hv.indexOf(':');
      if (c > 0) headers[hv.slice(0, c).trim()] = hv.slice(c + 1).trim();
      continue;
    }
    if (t.startsWith('-')) continue;
    if (name === null) { name = t; continue; }
    break; // the url, or a command without `--`
  }
  const rest = tokens.slice(i);
  if (name === null) return {ok:false, error:'This `claude mcp add` line has no server name.'};
  const nm = mcpSlug(name) || name;
  if (transport === 'http' || transport === 'sse' || (rest.length === 1 && /^https?:\/\//i.test(rest[0]))) {
    const r = mcpUrlServer(nm, rest[0] || '', headers);
    if (r.ok && transport === 'sse') r.server.transport.kind = 'sse';
    if (r.ok && transport === 'http') r.server.transport.kind = 'streamable_http';
    if (r.ok && Object.keys(env).length) r.server.env = env;
    return r;
  }
  return mcpStdioServer(nm, rest, env, home);
}

/* ---------------- the one entry point ---------------- */

/* What the pasted text is: 'json' (starts with { ), 'url' (one http(s)
   address), 'command' (anything else) or '' when empty. */
function mcpDetectAddInput(raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  if (t.startsWith('{')) return 'json';
  if (/^https?:\/\/\S+$/i.test(t)) return 'url';
  return 'command';
}

/* The pasted text → {ok, kind, server} or {ok:false, kind, error}.
   opts.name replaces the made-up name of a command or URL (the box's name
   field); opts.home spells out a leading ~ in command arguments. */
function mcpParseAddInput(raw, opts) {
  const o = opts || {};
  const kind = mcpDetectAddInput(raw);
  if (!kind) return {ok:false, kind, error:'Paste a server config, command or address first.'};
  let r;
  if (kind === 'json') r = mcpParseAddJson(raw);
  else if (kind === 'url') r = mcpUrlServer('', String(raw).trim(), null);
  else {
    const text = String(raw).trim().split(/\r?\n/).map((l) => l.replace(/^\s*[$>]\s+/, '')).join('\n');
    const split = mcpSplitCommand(text);
    if (!split.ok) return {ok:false, kind, error:split.error};
    const tokens = split.tokens;
    if (tokens[0] === 'claude' && tokens[1] === 'mcp' && tokens[2] === 'add') r = mcpParseClaudeAdd(tokens, o.home);
    else { const {env, rest} = mcpTakeEnv(tokens); r = mcpStdioServer('', rest, env, o.home); }
  }
  if (!r.ok) return Object.assign({kind}, r);
  const auto = r.server.name;
  if (kind !== 'json') {
    const typed = typeof o.name === 'string' ? o.name.trim() : '';
    if (typed) r.server.name = typed;
    if (!r.server.name) return {ok:false, kind, auto:'', error:'Type a name for this server: lowercase letters, digits and dashes.'};
    if (!MCP_NAME_RE.test(r.server.name)) return {ok:false, kind, auto, error:'The name can use lowercase letters, digits and dashes (2 to 32 characters).'};
  }
  return {ok:true, kind, auto, server:r.server};
}

/* ---------------- the review block under the box ---------------- */

const MCP_KIND_WORDS = {json:'JSON config', command:'Command (runs on this computer)', url:'Remote server (address)'};
const MCP_TRANSPORT_WORDS = {stdio:'local command', streamable_http:'streamable HTTP', sse:'SSE'};

/* What was understood, laid out for a check before Add. A command or URL
   gets an editable name; env values and header values are never shown.
   `name` is the box's current name field text (kept while typing). */
function mcpAddPreviewHTML(res, name, h) {
  const kind = res && res.kind;
  if (!kind) return '';
  const row = (k, v) => '<dt>' + h.esc(k) + '</dt><dd>' + h.esc(v) + '</dd>';
  let rows = '<dt>detected</dt><dd>' + h.esc(MCP_KIND_WORDS[kind]) + '</dd>';
  const s = res.ok ? res.server : null;
  if (kind !== 'json' && (s || res.auto !== undefined)) {
    rows += '<dt>name</dt><dd><input id="mcp-name" class="tk-inp sd-name" spellcheck="false" autocomplete="off" value="'
      + h.esc(name != null && name !== '' ? name : (res.auto || '')) + '" placeholder="server-name" aria-label="Server name"></dd>';
  } else if (s) rows += row('name', s.name);
  if (s && s.transport && typeof s.transport === 'object') {
    const tr = s.transport;
    rows += row('type', MCP_TRANSPORT_WORDS[tr.kind] || String(tr.kind));
    if (typeof tr.command === 'string') rows += row('command', tr.command);
    if (Array.isArray(tr.args) && tr.args.length) rows += row('arguments', tr.args.join(' '));
    if (typeof tr.url === 'string') rows += row('address', tr.url);
    if (tr.headers && typeof tr.headers === 'object' && Object.keys(tr.headers).length) rows += row('headers', Object.keys(tr.headers).join(', ') + ' (values hidden)');
  }
  if (s && s.env && typeof s.env === 'object' && Object.keys(s.env).length) rows += row('env', Object.keys(s.env).join(', ') + ' (values hidden)');
  return '<dl class="tk-plate sd-detect">' + rows + '</dl>';
}

if (typeof module !== 'undefined') {
  module.exports = {mcpNormalizeShortcut, mcpParseAddJson, mcpSplitCommand, mcpSlug, mcpNameFromPackage, mcpNameFromUrl,
    mcpNameFromCommand, mcpDetectAddInput, mcpParseAddInput, mcpAddPreviewHTML};
}
