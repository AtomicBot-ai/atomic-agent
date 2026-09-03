"use strict";

/* The Electron preload exposes window.atomic. Without it (opened as a
   plain page) the app runs the scripted demo instead of a real agent. */
const BR = typeof window !== "undefined" ? window.atomic : null;
let WORKSPACE = '';
let LIVE_CAPS = null, LIVE_CONFIG = null;

/* The composer's model selector: one popup, panes walked left to right.
   Local route is backend → model; cloud route is backend → provider →
   model, which is what the TUI's composer meta row does. */
const SEL = {
  open:false, kind:'backend', cursor:0, filter:'',
  rows:[], models:[], modelsFor:null, modelsBusy:false, modelsErr:null,
  local:[], localBusy:false, addOpen:false, presetCur:0,
  pulling:null, pullLine:'', busy:false, err:null,
};
/* Real token usage, read from the agent's trace after each turn. */
const PLAN = { on:false, supported:null };
/* The composer's stance. Read from and written to /api/coding-mode, which
   moves the runtime's live ladder and plan flag exactly as the TUI's
   onCodingModeChanged does — config.json is never touched. */
const MODE = { current:'default', supported:null, baseLevel:null, approvalLevel:null };
/* The add-provider wizard: pick_kind → configure → verifying. */
const WIZ = { phase:null, row:null, apiKey:'', baseUrl:'', error:null, busy:false };
/* Kind rows in the TUI's KIND_ROW_ORDER, minus the two subscription-CLI
   kinds, whose config shape the desktop does not write. */
const KIND_ROWS = [
  {id:'openrouter', kind:'openrouter', label:'OpenRouter (cloud chat + optional cloud embed)', env:'OPENROUTER_API_KEY', defaultModel:'openrouter/auto'},
  {id:'aimlapi', kind:'aimlapi', label:'AI/ML API (1000+ models, OpenAI-compatible)', env:'AIMLAPI_API_KEY'},
  {id:'gemini', kind:'gemini', label:'Gemini (Google AI)', env:'GEMINI_API_KEY'},
  {id:'openai-compatible', kind:'openai-compatible', label:'OpenAI-compatible API (custom base URL)', custom:true, defaultModel:'gpt-5.4-mini'},
];
const OPEN_GROUPS = new Set();
const CTX = { tokens:0, source:null, stablePrefix:0, tail:0, cacheHitTokens:null, modelId:null, window:null, windowLabel:'' };
/* default / auto / bypass. `plan` is deliberately absent: plan mode is a
   closure variable in the runtime with no route, no config key and no
   request field, so a desktop chip could only paint a state the agent
   does not have. */
const CODING_MODES = [
  {id:'default', label:'default', detail:'asks before risky steps', tone:'ok',
   summary:'default — approvals follow the configured approval level'},
  {id:'plan', label:'plan', detail:'reads only, then proposes', tone:'accent',
   summary:'plan mode — the agent reads and proposes, and every tool that would change something is refused'},
  {id:'auto', label:'auto', detail:'edits this folder freely', tone:'warn',
   summary:'auto — file writes inside this workspace stop asking; everything else still does'},
  {id:'bypass', label:'bypass permissions', detail:'never asks at all', tone:'bad',
   summary:'bypass permissions — nothing asks, for the rest of this session. Hardline shell-guard rules still block.'},
];

/* Models pane. Mirrors src/tui/providers/provider-presets.ts: every
   preset resolves to the existing `openai-compatible` kind with baseUrl
   filled in, so adding one is a config write, not a new provider kind. */
const PRESETS = [
  {id:'openrouter', label:'OpenRouter', kind:'openrouter', baseUrl:'https://openrouter.ai/api', env:'OPENROUTER_API_KEY'},
  {id:'aimlapi', label:'AI/ML API', kind:'aimlapi', baseUrl:'https://api.aimlapi.com', env:'AIMLAPI_API_KEY'},
  {id:'anthropic', label:'Anthropic (Claude)', kind:'openai-compatible', baseUrl:'https://api.anthropic.com', env:'ANTHROPIC_API_KEY', apiKeyHeader:'x-api-key', headers:{'anthropic-version':'2023-06-01'}},
  {id:'groq', label:'Groq', kind:'openai-compatible', baseUrl:'https://api.groq.com/openai', env:'GROQ_API_KEY'},
  {id:'deepseek', label:'DeepSeek', kind:'openai-compatible', baseUrl:'https://api.deepseek.com', env:'DEEPSEEK_API_KEY'},
  {id:'mistral', label:'Mistral', kind:'openai-compatible', baseUrl:'https://api.mistral.ai', env:'MISTRAL_API_KEY'},
  {id:'cerebras', label:'Cerebras', kind:'openai-compatible', baseUrl:'https://api.cerebras.ai', env:'CEREBRAS_API_KEY'},
  {id:'together', label:'Together AI', kind:'openai-compatible', baseUrl:'https://api.together.xyz', env:'TOGETHER_API_KEY'},
  {id:'fireworks', label:'Fireworks AI', kind:'openai-compatible', baseUrl:'https://api.fireworks.ai/inference', env:'FIREWORKS_API_KEY'},
  {id:'xai', label:'xAI (Grok)', kind:'openai-compatible', baseUrl:'https://api.x.ai', env:'XAI_API_KEY'},
  {id:'moonshot', label:'Moonshot AI (Kimi)', kind:'openai-compatible', baseUrl:'https://api.moonshot.ai', env:'MOONSHOT_API_KEY'},
  {id:'perplexity', label:'Perplexity', kind:'openai-compatible', baseUrl:'https://api.perplexity.ai', env:'PERPLEXITY_API_KEY'},
  {id:'nous', label:'Nous Research', kind:'openai-compatible', baseUrl:'https://inference-api.nousresearch.com', env:'NOUS_API_KEY'},
  {id:'novita', label:'Novita AI', kind:'openai-compatible', baseUrl:'https://api.novita.ai/openai', env:'NOVITA_API_KEY'},
  {id:'ollama', label:'Ollama (local)', kind:'openai-compatible', baseUrl:'http://localhost:11434', env:'OLLAMA_API_KEY', local:true},
  {id:'lmstudio', label:'LM Studio (local)', kind:'openai-compatible', baseUrl:'http://localhost:1234', env:'LMSTUDIO_API_KEY', local:true},
];
PRESETS.filter((p) => !['openrouter','aimlapi'].includes(p.id)).forEach((p) =>
  KIND_ROWS.splice(KIND_ROWS.length - 1, 0, {id:p.id, kind:'openai-compatible', label:p.label, env:p.env, baseUrl:p.baseUrl, apiKeyHeader:p.apiKeyHeader, headers:p.headers}));
const MP = {
  local: [], localBusy: false, localErr: null, pulling: null, pullLog: [],
  addOpen: false, presetCur: 0, apiKey: '',
  pickFor: null, pickQuery: '', picks: [], pickBusy: false, pickErr: null,
  busy: false, err: null,
};
const OB = {
  open: false, step: 'choose', choice: 0,
  models: [], modelCur: 0, ram: 0, busy: false, log: [], error: null,
  providers: [], keyEnv: {},
};
const OB_CHOICES = [
  {id:'local',  t:'Local models',    d:'llama.cpp on this machine. Private, free per token, one download of 2.7–22 GB.'},
  {id:'cloud',  t:'Cloud models',    d:'OpenRouter, Anthropic, Gemini, Groq and 20 more. Fastest to a working agent — needs an API key.'},
  {id:'custom', t:'Custom endpoint', d:'An OpenAI-compatible or llama-server URL you already run. Nothing is downloaded, nothing else is asked.'},
];

/* ---- Item 7: settings surface — the TUI menu tree + the Manage tabs ----
   MENU_GROUPS mirrors src/tui/menu/menu-registry.ts (MENU_GROUP_ORDER,
   MENU_GROUP_LABELS, every node label and its ctrl+g chord, in registry
   order). A node with `tab` switches the right-hand panel; `na` marks a
   node the desktop has no implementation for — it is drawn with the TUI
   label and a muted note, never dropped. The user asked for the TUI menu
   copied as it is, so the whole tree is here, not just Manage. */
const MENU_GROUPS = [
  ['Go', [
    {id:'go.run', label:'Run', chord:'r'},
    {id:'go.observe', label:'Observe', sub:[
      {id:'go.observe.feed', label:'Feed', chord:'f'},
      {id:'go.observe.world', label:'World', chord:'w'},
      {id:'go.observe.reasoning', label:'Reasoning', chord:'e'},
      {id:'go.observe.logs', label:'Logs', chord:'o'},
      {id:'go.observe.llm-logs', label:'LLM logs', chord:'L'},
    ]},
    {id:'go.manage', label:'Manage', sub:[
      {id:'go.manage.tasks', label:'Tasks', chord:'t', tab:'tasks'},
      {id:'go.manage.skills', label:'Skills', chord:'s', tab:'skills'},
      {id:'go.manage.memory', label:'Memory', chord:'m', tab:'memory'},
      {id:'go.manage.mcp', label:'MCP', chord:'c', tab:'mcp'},
      {id:'go.manage.llm', label:'LLM', chord:'l', tab:'llm'},
      {id:'go.manage.telegram', label:'Telegram', chord:'g', tab:'telegram'},
      {id:'go.manage.import', label:'Import', chord:'i', tab:'import'},
      {id:'go.manage.privacy', label:'Privacy', chord:'p', tab:'privacy'},
    ]},
    {id:'go.debug', label:'Toggle debug pane'},
  ]],
  ['Session', [
    {id:'session.new', label:'New session', chord:'n'},
    {id:'session.switch', label:'Switch session…', chord:'u'},
    {id:'session.clear', label:'Clear transcript'},
    {id:'session.context', label:'Context window'},
    {id:'session.id', label:'Show session id'},
    {id:'session.window', label:'New terminal window', na:true},
  ]],
  ['Model', [
    {id:'model.chat', label:'Switch chat model…', chord:'k'},
  ]],
  ['Run', [
    {id:'run.mode', label:'Coding mode…', chord:'M'},
    {id:'run.abort', label:'Abort turn', chord:'a'},
    {id:'run.queue', label:'Queued messages', na:true},
    {id:'run.steer', label:'Steer the running turn', na:true},
    {id:'run.expand', label:'Expand all tool cards'},
    {id:'run.collapse', label:'Collapse all tool cards'},
  ]],
  ['Setup', [
    {id:'setup.theme', label:'Theme…', chord:'h'},
    {id:'setup.mouse', label:'Mouse…', na:true},
    {id:'setup.sidebar', label:'Hide or show the sidebar'},
    {id:'setup.analytics', label:'Analytics'},
    {id:'setup.skill', label:'Enable or disable a skill…'},
    {id:'setup.task', label:'Create, cancel or run a task…'},
  ]],
  ['Help', [
    {id:'help.commands', label:'Commands'},
    {id:'help.tools', label:'List built-in tools'},
    {id:'help.dump', label:'Write debug bundle', chord:'d', na:true},
    {id:'help.quit', label:'Quit', chord:'q'},
  ]],
  ['Danger zone', [
    {id:'danger.uninstall', label:'Uninstall atomic-agent…', na:true},
  ]],
];
/* The desktop act each menu verb already has. Nodes with a `tab` and
   nodes marked `na` are not in here. */
const MENU_ACTS = {
  'go.run':'room:chat', 'go.observe.feed':'insp:steps', 'go.observe.world':'insp:world',
  'go.observe.reasoning':'insp:reasoning', 'go.observe.logs':'console:agent', 'go.observe.llm-logs':'console:llm',
  'go.debug':'toggle:console',
  'session.new':'session:new', 'session.switch':'session:switch', 'session.clear':'clear',
  'session.context':'context', 'session.id':'session:id',
  'model.chat':'selector:model',
  'run.mode':'modes', 'run.abort':'stop', 'run.expand':'cards:expand', 'run.collapse':'cards:collapse',
  'setup.theme':'palette:theme', 'setup.sidebar':'toggle:sidebar', 'setup.analytics':'settings:privacy',
  'setup.skill':'settings:skills', 'setup.task':'settings:tasks',
  'help.commands':'palette', 'help.tools':'tools', 'help.quit':'quit',
};
/* ids === MANAGE_TABS (src/tui/section.ts), labels from buildManageTabs. */
const SETTINGS_TABS = [['tasks','Tasks','tasks'],['skills','Skills','skills'],['memory','Memory','doc'],['mcp','MCP','link'],
                       ['llm','LLM','cpu'],['telegram','Telegram','chat'],['import','Import','folder'],['privacy','Privacy','key']];
/* Settings shell state: the diagnostics line's tool counters, read from
   the open session's tool_result rows (GET /api/sessions/{id}). */
const SET = { tools:null, toolsFor:null, toolsBusy:false, health:null, healthBusy:false };
/* Installed skills incl. disabled ones, from `atag skill list` — the N in
   the Skills tab's ` (N)` suffix (debug-pane.tsx:162 counts every loaded
   row; GET /api/skills never carries disabled skills). */
const SK = { rows:null, busy:false, err:null, calls:0 };
/* Tasks tab state — the TUI's TasksPanelState, minus the firings ring
   the HTTP API does not expose. */
const TK = {
  rows:[], filter:'all', search:'', searchOpen:false, auto:true, lastRefreshedAt:null, loading:false,
  primed:false, mode:'list', cursor:0, detailId:null, cancel:null, msg:null, err:null, timer:null,
  form:null,
  note:null, // muted line under `msg` — the one-shot `at` degradation on 0.5.4, repeated after submit
};
const TK_FILTER_ORDER = ['all','pending','running','completed','failed','blocked','cancelled','recurring'];
const TK_MAX_ROWS = 14; // tasks-panel.tsx:24 — the Tasks list is a 14-row window around the cursor, as in the TUI
/* Privacy tab state — the TUI's PrivacyPanelState (message / lastError / busy).
   `effective` is what the TUI shows (getConfig().analytics.enabled, the
   schema default when the user file has no key): the user file from GET
   /api/config when it carries the key, else `atag config get
   analytics.enabled`; null until either has answered. */
const PRIV = { busy:false, message:null, lastError:null, effective:null, effectiveBusy:false, chain:Promise.resolve(), pending:0 }; // chain/pending: the analytics write queue
/* The TUI's ctrl+g chord layer (menu-popup.tsx `ctrl+g <key>`): ctrl+g
   arms a 1.5 s prefix, the next key runs the menu node with that chord. */
const CHORD = { pending:false, timer:null };
/* Renderer faults, counted for --smoke (`window.__errCount`). */
let ERR_COUNT = 0;

/* ============================================================
   Atomic Agent Desktop — clickable prototype, no backend.
   Command/menu wording, the slash registry and its rank order,
   the approval categories and their auto-approve levels, and the
   approval footer text are taken from the shipped TUI:
     src/tui/menu/menu-registry.ts
     src/tui/approval-modal.tsx
     src/approval/approval-level.ts
     src/tui/run-mode/
   The window's own radius and shadow are drawn here because this
   is a page mockup; in Tauri the OS draws them.
   ============================================================ */

/* ---------------- icons: 16px optical, 1.5px stroke ---------------- */
const P = {
  chat:'<rect x="2.25" y="3.25" width="11.5" height="8.5" rx="2.5"/><path d="M5.5 11.75v2.1l2.8-2.1"/>',
  tasks:'<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.5h11M5.5 2.25v2.5M10.5 2.25v2.5M5.5 9.5h5"/>',
  skills:'<path d="M8 2.2 9.55 5.6l3.7.42-2.75 2.5.75 3.63L8 10.35 4.75 12.15l.75-3.63L2.75 6.02l3.7-.42z"/>',
  memory:'<path d="M8 2.6C6.2 2.6 4.8 3.7 4.8 5.1c0 .5.2 1 .5 1.4-.6.5-1 1.2-1 2 0 1.6 1.6 2.9 3.7 2.9s3.7-1.3 3.7-2.9c0-.8-.4-1.5-1-2 .3-.4.5-.9.5-1.4 0-1.4-1.4-2.5-3.2-2.5Z"/><path d="M8 2.6v9"/>',
  search:'<circle cx="7.2" cy="7.2" r="4"/><path d="M10.2 10.2 13.5 13.5"/>',
  sidebar:'<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6.2 3v10"/>',
  inspector:'<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M10 3v10"/>',
  console:'<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 9.6h12"/>',
  plus:'<path d="M8 3.5v9M3.5 8h9"/>',
  chevD:'<path d="M4 6.2 8 10l4-3.8"/>',
  chevR:'<path d="M6.2 4 10 8l-3.8 4"/>',
  check:'<path d="M3.5 8.4 6.4 11.3 12.5 5.2"/>',
  x:'<path d="M4 4l8 8M12 4l-8 8"/>',
  warn:'<path d="M8 2.8 14 12.6H2z"/><path d="M8 6.6v3M8 11.1h.01"/>',
  stop:'<rect x="4.5" y="4.5" width="7" height="7" rx="1.5"/>',
  up:'<path d="M8 12.5v-9M4.2 7.3 8 3.5l3.8 3.8"/>',
  copy:'<rect x="5.5" y="5.5" width="8" height="8" rx="2"/><path d="M10.5 5.5v-1a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1"/>',
  gear:'<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6"/>',
  cloud:'<path d="M4.6 12.2h6.6a2.9 2.9 0 0 0 .3-5.78A4 4 0 0 0 4.3 6.9a2.65 2.65 0 0 0 .3 5.3Z"/>',
  cpu:'<rect x="5" y="5" width="6" height="6" rx="1.5"/><path d="M6.5 2.5v2.5M9.5 2.5v2.5M6.5 11v2.5M9.5 11v2.5M2.5 6.5h2.5M2.5 9.5h2.5M11 6.5h2.5M11 9.5h2.5"/>',
  key:'<circle cx="5.5" cy="8" r="2.6"/><path d="M8.1 8h5.4M11.6 8v2.2M13.5 8v1.6"/>',
  link:'<path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 1 0-3.7-3.7l-.9.9"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 1 0 3.7 3.7l.9-.9"/>',
  folder:'<path d="M2.5 4.6a1.6 1.6 0 0 1 1.6-1.6h2.1l1.4 1.7h4.3a1.6 1.6 0 0 1 1.6 1.6v5.1a1.6 1.6 0 0 1-1.6 1.6H4.1a1.6 1.6 0 0 1-1.6-1.6z"/>',
  refresh:'<path d="M13 8a5 5 0 1 1-1.5-3.55"/><path d="M13.2 2.6v3h-3"/>',
  filter:'<path d="M2.6 3.7h10.8L9.4 8.4v4l-2.8-1.4V8.4z"/>',
  atom:'<path d="M8 2.6v10.8M2.6 8h10.8"/><circle cx="8" cy="8" r="5.4"/>',
  bolt:'<path d="M8.8 2.4 4.2 9.1h3.2l-.6 4.5 4.8-6.9H8.3z"/>',
  doc:'<path d="M4 2.6h5l3 3v7.8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1Z"/><path d="M9 2.6v3h3"/>',
  play:'<path d="M5.5 3.6 12 8l-6.5 4.4z"/>',
  trash:'<path d="M3 4.6h10M6.4 4.6V3.4a.9.9 0 0 1 .9-.9h1.4a.9.9 0 0 1 .9.9v1.2M4.4 4.6l.6 8a1 1 0 0 0 1 .9h4a1 1 0 0 0 1-.9l.6-8M6.8 7v4M9.2 7v4"/>',
};
function ic(n, cls) {
  return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" '
    + 'stroke-linecap="round" stroke-linejoin="round"' + (cls ? ' class="' + cls + '"' : '') + '>' + (P[n] || '') + '</svg>';
}
const MARK_COLOR = '<svg width="16" height="16" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#006AFF"/><path fill="#fff" d="M35.24 49.92a1.25 1.25 0 0 0 1.3-1.24 12.2 12.2 0 0 1 12.14-12.14 1.25 1.25 0 0 0 1.24-1.3v-6.47c0-.69-.56-1.24-1.24-1.24H37.72c-.69 0-1.24-.56-1.24-1.25V15.32c0-.69-.56-1.24-1.24-1.24h-6.47c-.69 0-1.24.56-1.3 1.24A12.2 12.2 0 0 1 15.32 27.46c-.68.06-1.24.61-1.24 1.3v6.47c0 .69.56 1.24 1.24 1.24h10.96c.69 0 1.24.56 1.24 1.25v10.95c0 .69.56 1.24 1.24 1.24z"/></svg>';
const MARK_MONO = '<svg width="20" height="20" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true"><path d="M35.24 49.92a1.25 1.25 0 0 0 1.3-1.24 12.2 12.2 0 0 1 12.14-12.14 1.25 1.25 0 0 0 1.24-1.3v-6.47c0-.69-.56-1.24-1.24-1.24H37.72c-.69 0-1.24-.56-1.24-1.25V15.32c0-.69-.56-1.24-1.24-1.24h-6.47c-.69 0-1.24.56-1.3 1.24A12.2 12.2 0 0 1 15.32 27.46c-.68.06-1.24.61-1.24 1.3v6.47c0 .69.56 1.24 1.24 1.24h10.96c.69 0 1.24.56 1.24 1.25v10.95c0 .69.56 1.24 1.24 1.24z"/></svg>';

const dur = (ms) => ms == null ? '…' : ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const $ = (s) => document.querySelector(s);
const keycaps = (str) => str ? str.split(' ').map((k) => '<span class="kc">' + esc(k) + '</span>').join('') : '';

/* ---------------- registry data ---------------- */

// slash registry in the registry's own rank order (rank is user-visible)
const SLASH = [
  ['dump','write debug zip to ~/Documents/atomic-agent-debug'],
  ['help','list available slash commands'],
  ['tools','list built-in tools (fs, shell, browser, memory, vision)','<query>'],
  ['theme','switch the UI theme','<name>|list'],
  ['clear','clear chat transcript (keeps session)'],
  ['abort','abort the running turn'],
  ['quit','exit atomic-agent'],
  ['debug','toggle debug pane (feed / logs / world …)'],
  ['chat','return to single-view chat mode'],
  ['run','run mode — fusion orchestrates on cloud, executes locally','local|cloud|fusion [0-100]'],
  ['observe','switch to the Observe section'],
  ['manage','switch to the Manage section'],
  ['feed','jump to the Observe → Feed tab'],
  ['logs','jump to the Observe → Logs tab'],
  ['reasoning','jump to the Observe → Reasoning tab'],
  ['world','jump to the Observe → World tab'],
  ['expand','expand every tool card in the chat log'],
  ['collapse','collapse every tool card in the chat log'],
  ['session','show current session id'],
  ['sessions','open session picker to switch threads'],
  ['new','start a fresh session (keeps warm runtime)'],
  ['skills','jump to the Skills tab','dump'],
  ['skill','enable or disable a skill','enable|disable <name>'],
  ['memory','open Memory tab (profile, notes, lessons, …)','dump'],
  ['llm','open LLM Local/Cloud/External panel','provider <id>'],
  ['mcp','open MCP tab (servers + discovered tools)','add|remove <name>'],
  ['model','open chat model picker','pull|use|status <id>'],
  ['tasks','jump to the Tasks tab (cron + ingress UI)'],
  ['task','create, cancel or run a task','new|cancel|run <id>'],
  ['telegram','telegram channel','enable|disable|start|stop|pair|token'],
  ['import','open the Import tab (one-shot migration)'],
  ['privacy','analytics opt-out + session grants','analytics on|off'],
  ['analytics','toggle anonymous analytics','on|off|status'],
];

// approval categories → the level at which each stops asking (approval-level.ts)
const CATS = [
  ['fs_write_workspace','file write · workspace',2],
  ['fs_write_home','file write · home',3],
  ['fs_trash','move to Trash',3],
  ['http','HTTP request',3],
  ['shell','shell command',4],
  ['script','skill script',4],
  ['proc_kill','process kill',4],
  ['browser_nonweb','browser · non-web URL',5],
  ['trust_config','agent trust config',5],
  ['other','uncategorised',5],
];


/* palette catalogue — every row has a menu-bar home */
const PAL = [
  ['Go', [
    ['chat','Chat','Session','⌘ 1','room:chat'],
    ['inspector','Feed','Observe','/feed','insp:steps'],
    ['atom','World','Observe','/world','insp:world'],
    ['bolt','Reasoning','Observe','/reasoning','insp:reasoning'],
    ['console','Logs','Console','/logs','console:agent'],
    ['tasks','Tasks','Manage','','settings:tasks'],
    ['skills','Skills','Manage','','settings:skills'],
    ['doc','Memory','Manage','⌘ 4','settings:memory'],
    ['link','MCP','Manage','/mcp','settings:mcp'],
    ['cpu','LLM','Manage','/llm','settings:llm'],
    ['chat','Telegram','Manage','/telegram','settings:telegram'],
    ['folder','Import','Manage','/import','settings:import'],
    ['key','Privacy','Manage','⇧ ⌘ ,','settings:privacy'],
  ]],
  ['Session', [
    ['plus','New session','keeps warm runtime','⌘ N','session:new'],
    ['x','Clear transcript','keeps session','⌘ ⌫','clear'],
    ['copy','Show session id','','⌃ ⌘ C','session:id'],
  ]],
  ['Model', [
    ['cloud','Switch chat model…','pull | use | status','⇧ ⌘ M','selector:model'],
  ]],
  ['Run', [
    ['stop','Abort turn','','⌘ .','stop'],
    ['chevD','Expand all tool cards','','⌥ ⌘ E','cards:expand'],
    ['chevR','Collapse all tool cards','','⌥ ⌘ K','cards:collapse'],
  ]],
  ['Setup', [
    ['gear','Theme…','','','scope:theme'],
    ['skills','Enable or disable a skill…','','','settings:skills'],
    ['tasks','Create, cancel or run a task…','','','settings:tasks'],
    ['key','Analytics','','','settings:privacy'],
  ]],
  ['Help', [
    ['doc','List built-in tools','','⌥ ⌘ T','tools'],
  ]],
];

/* ---------------- state ---------------- */
const S = {
  room:'chat', theme:'system',
  inspector:true, inspTab:'steps',
  consoleOpen:false, consoleTab:'agent',
  settings:null, settingsPane:'tasks',
  overlay:null, menuOpen:null, alert:null,
  q:'', cur:0, scope:null,
  slash:false, slashCur:0,
  draft:'',
  mode:'fusion', share:40, dialShare:40,
  localModel:'qwen3-8b-instruct', cloudModel:'claude-opus-5', modelTab:'local', modelQuery:'',
  level:3, grants:[],
  busy:false, pending:null, queued:[], phase:'', elapsed:0,
  sessionId:'s1',
  stick:true,
  memTab:'notes', skillsTab:'installed', taskFilter:'all',
  toasts:[], toastId:0,
  agentSession:null, reasonId:null, baseLevel:null,
  live:{state: BR ? 'starting' : 'demo', binary:null, port:null, workingDir:'~', llama:null, error:null},
  history:[], turnId:null, streamId:null,
  log:[],
};

let SESSIONS = [];

const TASKS = [];

const MODELS = { local: [], cloud: [], external: [] };
const shortModel = (id) => id.replace(/-instruct$/, '');

const SKILLS = [];
const HUB = [];
const NOTES = [];

/* ---------------- transcript ---------------- */
let uid = 0;
const nid = () => 'i' + (++uid);
S.log = [
  {id:nid(), k:'user', text:"what's in this folder?"},
  {id:nid(), k:'tool', name:'os.fs.list_dir', arg:'~/Teletubbies', where:'local', ms:41, ok:true, open:false,
   args:'{ "path": "~/Teletubbies", "depth": 1 }',
   out:'tinky-winky-s01e04.pdf\ndipsy-s01e07.pdf\nlaa-laa-s02e02.pdf\npo/  (12 files)'},
  {id:nid(), k:'assistant', text:'Three episode scripts at the top level, plus a po/ folder with twelve more. Want them organised?'},
];

/* ============================================================
   render
   ============================================================ */
function render() {
  renderToolbar(); renderSidebar(); renderContent();
  renderInspector(); renderConsole(); renderOverlays(); renderSettings(); renderToasts();
}


function toolCount() { const n = S.log.filter((x) => x.k === 'tool').length; return n === 1 ? '1 tool call' : n + ' tool calls'; }
function roomTitle() {
  if (S.room === 'chat') {
    const ses = SESSIONS.find((x) => x.id === S.sessionId);
    return ['Chat', ses ? ses.t + ' · ' + (S.busy ? 'running' : S.pending ? 'waiting for you' : toolCount()) : ''];
  }
  if (S.room === 'tasks')  return ['Tasks', TASKS.length + (TASKS.length === 1 ? ' task' : ' tasks')];
  if (S.room === 'skills') return ['Skills', SKILLS.filter((s) => s.on).length + ' enabled of ' + SKILLS.length];
  return ['Chat', ''];
}

function renderToolbar() {
  const [t, sub] = roomTitle();
  $('#toolbar').innerHTML =
    '<div class="lights"><span class="lg" style="background:#FF5F57"></span><span class="lg" style="background:#FEBC2E"></span><span class="lg" style="background:#28C840"></span></div>'
    + '<button class="iconbtn" data-act="toggle:sidebar" title="Hide sidebar (Ctrl+0)">' + ic('sidebar') + '</button>'
    + '<div class="tb-title"><b>' + esc(t) + '</b><span>' + esc(sub) + '</span></div>'
    + '<div class="tb-right">'
      + '<button class="searchbtn" data-act="palette">' + ic('search') + '<span class="sec">Search</span>' + keycaps('⌘ K') + '</button>'
      + '<button class="iconbtn' + (S.inspector ? ' on' : '') + '" data-act="toggle:inspector" title="Inspector">' + ic('inspector') + '</button>'
      + '<button class="iconbtn' + (S.consoleOpen ? ' on' : '') + '" data-act="toggle:console" title="Console (Ctrl+Shift+Y)">' + ic('console') + '</button>'
    + '</div>';
}

function renderSidebar() {
  const live = BR && S.live.state === 'connected';
  const nav = [['chat','Chat',''],
               ['tasks','Tasks', String(TASKS.length)],
               ['skills','Skills', String(SKILLS.length)],
               ];
  let groups = '', last = '';
  SESSIONS.forEach((s) => {
    if (s.g !== last) { groups += '<div class="sb-group micro">' + esc(s.g) + '</div>'; last = s.g; }
    const waiting = s.id === S.sessionId && S.pending;
    groups += '<button class="sesrow' + (s.id === S.sessionId ? ' on' : '') + '" data-ses="' + s.id + '">'
      + '<span class="col"><span class="t1">' + esc(s.t) + '</span><span class="t2">' + esc(s.sub) + (s.origin ? ' ' + s.origin : '') + '</span></span>'
      + '<span class="sesstat">' + (waiting ? '<span style="color:var(--warn);display:flex">' + ic('warn') + '</span>'
                 : s.st ? '<span class="dot ' + s.st + '"></span>' : '') + '</span>'
      + '<span class="sesacts"><span class="iconbtn" data-del="' + s.id + '" title="Delete session" role="button">' + ic('trash') + '</span></span>'
      + '</button>';
  });
  $('#sidebar').innerHTML =
    '<div class="sb-head">' + MARK_COLOR
      + '<button class="wschip" data-act="workspace"><span>' + esc(BR ? WORKSPACE : '~/Teletubbies') + '</span>' + ic('chevD') + '</button>'
      + '<button class="iconbtn" data-act="session:new" title="New session (Ctrl+N)" style="margin-left:auto">' + ic('plus') + '</button></div>'
    + '<div class="sb-nav">' + nav.map(([id, label, count]) =>
        '<button class="navrow' + (S.room === id ? ' on' : '') + '" data-room="' + id + '">'
        + '<span class="ic">' + ic(id) + '</span><span class="lb">' + label + '</span>'
        + '<span class="ct tnum">' + count + '</span></button>').join('') + '</div>'
    + '<div class="seswrap">' + groups + '</div>'
    // Item 7: the bottom-left settings entry. Lands on Go › Manage › Tasks, the TUI's default Manage tab.
    + '<button class="sb-foot" data-act="settings:tasks" title="Settings (⌘ ,)">' + ic('gear') + '<span>Settings</span>' + keycaps('⌘ ,') + '</button>'
    ;
}

/* ---------------- content ---------------- */
function renderContent() {
  const c = $('#content');
  if (S.room === 'chat')   { c.innerHTML = chatView(); afterChat(); return; }
  if (S.room === 'tasks')  { c.innerHTML = tasksView(); return; }
  c.innerHTML = skillsView();
}

function chatView() {
  const body = S.log.length ? '<div class="col720">' + renderItems() + '</div>' : emptyChat();
  return '<div class="scroller" id="scroller">' + body + '</div>' + composer();
}

function emptyChat() {
  return '<div class="empty"><span style="opacity:.25;color:var(--text-primary)">'
    + '<svg width="48" height="48" viewBox="0 0 64 64" fill="currentColor"><path d="M35.24 49.92a1.25 1.25 0 0 0 1.3-1.24 12.2 12.2 0 0 1 12.14-12.14 1.25 1.25 0 0 0 1.24-1.3v-6.47c0-.69-.56-1.24-1.24-1.24H37.72c-.69 0-1.24-.56-1.24-1.25V15.32c0-.69-.56-1.24-1.24-1.24h-6.47c-.69 0-1.24.56-1.3 1.24A12.2 12.2 0 0 1 15.32 27.46c-.68.06-1.24.61-1.24 1.3v6.47c0 .69.56 1.24 1.24 1.24h10.96c.69 0 1.24.56 1.24 1.25v10.95c0 .69.56 1.24 1.24 1.24z"/></svg></span>'
    + '<div style="font-size:22px;line-height:28px;font-weight:600;letter-spacing:-.02em">Ask it to do something on this machine</div>'
    + '<div class="ghost">'
      + ['what can you do?','summarise the files in this folder','check the disk space on this Mac']
          .map((g) => '<button class="ghostchip" data-fill="' + esc(g) + '">' + esc(g) + '</button>').join('')
    + '</div></div>';
}

function item(m) {
  if (m.k === 'user') return '<div class="turn"><div class="gutter"><span class="avatar">›</span></div>'
    + '<div class="prose usr">' + esc(m.text) + '</div></div>';
  if (m.k === 'assistant') return '<div class="turn"><div class="gutter"><span style="color:var(--accent-text);display:flex">' + MARK_MONO + '</span></div>'
    + '<div class="prose">' + renderProse(m.text) + '</div></div>';
  if (m.k === 'system') return '<div class="sysrow"><span></span><span>' + m.text + '</span></div>';
  if (m.k === 'reason') return '<div class="turn"><div></div><div>'
    + '<button class="disc" data-toggle="' + m.id + '">' + ic(m.open ? 'chevD' : 'chevR') + 'Reasoning · ' + m.steps + ' steps</button>'
    + (m.open ? '<div class="discbody">' + esc(m.text) + '</div>' : '') + '</div></div>';
  if (m.k === 'tool') return '<div class="turn"><div></div><div>' + toolCard(m) + '</div></div>';
  if (m.k === 'approval') return '<div class="turn"><div></div><div>' + apprCard(m) + '</div></div>';
  return '';
}

function previewArgs(args) {
  let obj = args;
  if (typeof args === 'string') { try { obj = JSON.parse(args); } catch { return args.length > 160 ? args.slice(0, 159) + '\u2026' : args; } }
  if (!obj || typeof obj !== 'object') return '';
  const fmt = (v) => {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'string') return JSON.stringify(v.length > 60 ? v.slice(0, 59) + '\u2026' : v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { const j = JSON.stringify(v); return j.length > 60 ? j.slice(0, 59) + '\u2026' : j; } catch { return '[object]'; }
  };
  const out = Object.entries(obj).map(([k, v]) => k + '=' + fmt(v)).join(' ');
  return out.length > 160 ? out.slice(0, 159) + '\u2026' : out;
}
function argsBlock(args) {
  if (!args) return '(no args)';
  if (typeof args === 'string') { try { return JSON.stringify(JSON.parse(args), null, 2); } catch { return args; } }
  try { return JSON.stringify(args, null, 2); } catch { return '[unserialisable args]'; }
}
function toolCard(m) {
  const running = m.ok === null;
  const glyph = running ? '<span class="dot run"></span>'
    : m.ok ? '<span style="color:var(--success);display:flex">' + ic('check') + '</span>'
           : '<span style="color:var(--danger);display:flex">' + ic('warn') + '</span>';
  const summary = (m.out || '').trim().replace(/\s+/g, ' ');
  const clipped = summary.length > 160 ? summary.slice(0, 159) + '\u2026' : summary;
  return '<div class="card' + (running ? ' running' : '') + (m.ok === false ? ' err' : '') + '" id="card-' + m.id + '">'
    + '<button class="cardhead" data-toggle="' + m.id + '" aria-expanded="' + (!!m.open) + '">'
      + glyph + '<span class="nm">' + esc(m.name) + '</span>'
      + '<span class="du tnum" title="' + (m.ms ? 'measured by the agent' : 'wall time observed by this window, from the call frame to the next frame') + '">'
      + (running ? '\u2026' : dur(m.ms || m.observedMs || 0) || '') + '</span>'
      + (m.truncated ? '<span class="cap" style="color:var(--warn)">truncated</span>' : '')
      + '<span class="ar">' + esc(previewArgs(m.args || m.arg)) + '</span>'
      + '<span class="ter" style="display:flex">' + ic(m.open ? 'chevD' : 'chevR') + '</span>'
    + '</button>'
    + (!m.open && clipped ? '<div class="cardsum' + (m.ok === false ? ' bad' : '') + '">' + esc(clipped) + '</div>' : '')
    + (m.open ? '<div class="cardbody">'
        + '<div class="micro sec">args</div><pre>' + esc(argsBlock(m.args || m.arg)) + '</pre>'
        + '<div class="micro sec">result</div><pre>' + esc(running ? '(pending)' : (m.out || '\u2014')) + '</pre></div>' : '')
    + '</div>';
}

function apprCard(m) {
  if (m.state) {
    const ok = m.state === 'approved';
    return '<div class="appr done' + (ok ? ' ok' : '') + '">'
      + '<div class="hstack" style="gap:8px"><span class="sec">' + (ok ? 'Approved' : 'Denied') + ' · ' + m.at + '</span>'
      + '<span class="badge" style="background:transparent;border-color:var(--line);color:var(--text-secondary)">' + esc(m.kind) + '</span></div></div>';
  }
  const isTrust = m.cat === 'trust_config';
  return '<div class="appr' + (isTrust ? ' danger' : '') + '" id="apprcard">'
    + '<div class="apprhead"><span style="color:var(--warn);display:flex">' + ic('warn') + '</span>'
      + '<span class="ttl">Approval required</span>'
      + '<span class="badge" style="margin-left:auto">' + esc(m.kind) + '</span></div>'
    + '<dl class="dl">'
      + '<dt>tool</dt><dd><span class="mono">' + esc(m.tool) + '</span></dd>'
      + '<dt>kind</dt><dd>' + esc(m.kind) + ' <span class="cap">— auto-approves from level ' + m.lvl + '</span></dd>'
      + '<dt>reason</dt><dd>' + esc(m.reason) + '</dd>'
      + '<dt>preview</dt><dd><div class="previewblk">' + esc(m.preview) + '</div></dd>'
      + '<dt>affects</dt><dd><span class="pathchip"><b>' + esc(m.affectsBase) + '</b><span class="cap">' + esc(m.affectsDir) + '</span></span></dd>'
    + '</dl>'
    + '<div class="apprbtns"><div class="apprgrp">'
      + '<button class="btn btn-p" data-appr="y">Approve' + keycaps('Y') + '</button>'
      + (isTrust || m.approvalId ? '' : '<button class="btn btn-t" data-appr="s">Allow &ldquo;' + esc(m.kind) + '&rdquo; this session' + keycaps('S') + '</button>')
      + (isTrust || m.approvalId ? '' : '<button class="btn btn-t" data-appr="a">Allow all &ldquo;' + esc(m.shape) + '&rdquo; commands this session' + keycaps('A') + '</button>')
      + '<button class="btn btn-s" data-appr="n" id="denybtn">Deny' + keycaps('N') + '</button></div>'
      + '<button class="btn btn-g" data-appr="esc">Abort run' + keycaps('⎋') + '</button>'
    + '</div>'
    + '<div class="apprfoot">' + (isTrust
        ? 'trust-config writes are never granted for the session; y approves this call only'
        : (m.approvalId
        ? 'y approves this call once, n refuses it. Session-wide grants are not offered here because the agent\u2019s HTTP API implements allow-once and deny only \u2014 raise the standing level on the <button class="btn-g" style="text-decoration:underline" data-act="settings:privacy">Privacy</button> tab.'
        : 'y approves this call once; s / a grant for this session only (never persisted); raise the standing level on the <button class="btn-g" style="text-decoration:underline" data-act="settings:privacy">Privacy</button> tab'))
    + '</div></div>';
}

function composer() {
  const running = S.busy || !!S.pending;
  const status = S.pending
    ? '<div class="statusstrip gated">' + ic('warn') + 'Waiting for your approval'
      + '<button class="btn-g" style="text-decoration:underline" data-act="jump:appr">Jump to request</button></div>'
    : S.busy
    ? '<div class="statusstrip"><span class="threedot"><i></i><i></i><i></i></span><span>' + S.phase + '</span>'
      + '<span class="mono ter tnum" style="margin-left:auto">' + (S.elapsed / 10).toFixed(1) + 's</span>'
      + '<button class="btn-g" data-act="stop">Stop</button></div>'
    : '';
  const q = S.queued.length ? '<div class="qtray">' + S.queued.map((t, i) =>
      '<div class="qchip"><span class="ter">Queued</span><span style="flex:1;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(t) + '</span>'
      + '<button class="iconbtn" style="width:20px;height:20px" data-unqueue="' + i + '">' + ic('x') + '</button></div>').join('') + '</div>' : '';
  return '<div class="composerwrap">' + status + q
    + '<div class="composer' + (running ? ' running' : '') + '" id="composer">'
      + (S.slash ? slashPopover() : '')
      + '<div class="field"><textarea id="entry" rows="1" placeholder="' + (running ? 'Send to steer this turn…' : 'Ask for an outcome, or / for a command') + '"></textarea>'
      + sendButton() + '</div>'
      + '<div class="cfoot">'
        + '<button class="cchip modechip" data-sel-open="backend">'
          + ic(selBackend() === 'local' ? 'cpu' : 'cloud') + selBackend() + ic('chevD') + '</button>'
        + (selBackend() === 'cloud'
            ? '<button class="cchip" data-sel-open="provider">' + esc(selActiveProviderId() || 'no provider') + ic('chevD') + '</button>'
            : '')
        + '<button class="cchip modelchip" data-sel-open="model">'
          + esc(shortModel(activeModel())) + ic('chevD') + '</button>'
        + '<span style="flex:1"></span>'
        + contextChip()
        + codingModeChip()
      + '</div>'
    + '</div></div>';
}

function sendButton() {
  if (S.busy || S.pending) {
    if (S.draft.trim()) return '<button class="sendbtn" data-act="send" title="Queue">' + ic('plus') + '</button>';
    return '<button class="sendbtn stop" data-act="stop" title="Stop (Ctrl+.)">' + ic('stop') + '</button>';
  }
  return '<button class="sendbtn' + (S.draft.trim() ? '' : ' mute') + '" data-act="send" title="Send">' + ic('up') + '</button>';
}

function afterChat() {
  const e = $('#entry');
  if (!e) return;
  e.value = S.draft;
  autosize(e);
  const sc = $('#scroller');
  if (sc) {
    sc.addEventListener('scroll', () => {
      S.stick = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40;
      $('#toolbar').classList.toggle('scrolled', sc.scrollTop > 2);
    });
    if (S.stick) sc.scrollTop = sc.scrollHeight;
  }
  if (S.pending && !S.apprFocused) { const d = $('#denybtn'); if (d) { d.focus(); S.apprFocused = true; } }
}
function autosize(e) { e.style.height = 'auto'; e.style.height = Math.min(e.scrollHeight, 180) + 'px'; }

/* ---------------- rooms ---------------- */
function segControl(items, cur, actPrefix) {
  return '<div class="seg">' + items.map(([id, label]) =>
    '<button class="' + (cur === id ? 'on' : '') + '" data-act="' + actPrefix + id + '">' + esc(label) + '</button>').join('') + '</div>';
}

function tasksView() {
  // Item 7: the Tasks room is the settings window's Tasks tab — one implementation.
  return '<div class="scroller"><div class="tuiwrap">' + tasksTab() + '</div></div>';
}

function skillsView() {
  const installed = '<div class="rows">' + SKILLS.map((s) =>
    '<div class="row"><span class="ic sec" style="display:flex">' + ic('skills') + '</span>'
    + '<span class="main"><span class="t">' + esc(s.t) + '</span><span class="cap">' + esc(s.s) + '</span></span>'
    + '<span class="meta">v' + s.v + ' · ' + s.src + '</span>'
    + '<span class="cap">' + (s.on ? 'enabled' : 'disabled') + '</span></div>').join('') + '</div>';
  const hub = '<div class="pad" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">'
    + HUB.map((h) => '<div class="panelcard"><div class="hstack"><span class="hd">' + esc(h.t) + '</span>'
      + '<span class="cap" style="margin-left:auto">' + esc(h.d) + '</span></div>'
      + '<div class="cap">' + esc(h.s) + '</div>'
      + '<div class="mono ter">' + esc(h.repo) + '</div>'
      + '<button class="btn btn-t" style="align-self:flex-start">Install…</button></div>').join('') + '</div>';
  return '<div class="chead"><span class="hd">Skills</span>'
    + '<span class="grow"></span></div>'
    + '<div class="scroller">' + (S.skillsTab === 'installed' ? installed : hub) + '</div>';
}

function memoryView() {
  const rows = NOTES.filter((n) => S.memTab === 'notes' ? n.tag === 'note' : S.memTab === 'lessons' ? n.tag === 'lesson' : true);
  const profile = '<div class="pad"><div class="panelcard"><dl class="kvgrid">'
    + '<dt>name</dt><dd>Tinky Winky</dd><dt>timezone</dt><dd>Europe/Berlin</dd>'
    + '<dt>style</dt><dd>blunt, no filler, ship-first</dd><dt>workspace</dt><dd class="mono">~/Teletubbies</dd></dl></div></div>';
  return '<div class="chead"><span class="hd">Memory</span>'
    + segControl([['profile','Profile'],['notes','Notes'],['lessons','Lessons'],['links','Links']], S.memTab, 'memtab:')
    + '<span class="grow"></span></div>'
    + '<div class="scroller">' + (S.memTab === 'profile' ? profile
      : S.memTab === 'links' ? '<div class="pad"><p class="sec">2 links between notes. Selecting a link fills the inspector.</p></div>'
      : '<div class="rows">' + rows.map((n) => '<button class="row"><span class="dot"></span>'
        + '<span class="main"><span class="t" style="font-weight:400">' + esc(n.t) + '</span></span>'
        + '<span class="meta">' + esc(n.s) + '</span></button>').join('') + '</div>') + '</div>';
}

/* ---------------- inspector ---------------- */
function renderInspector() {
  const el = $('#inspector');
  el.classList.toggle('hide', !S.inspector);
  if (!S.inspector) return;
  const tabs = [['steps','Steps'],['reasoning','Reasoning'],['world','World']];
  let body = '';
  if (S.inspTab === 'steps') {
    const tools = S.log.filter((m) => m.k === 'tool');
    body = tools.length ? tools.map((m, i) => '<button class="step" data-goto="' + m.id + '">'
        + '<span class="ix">' + String(i + 1).padStart(2, '0') + '</span>'
        + '<span class="nm">' + esc(m.name) + '</span>'
        + '<span class="hstack">'
        + '<span class="mono ter tnum">' + dur(m.ok === null ? null : m.ms) + '</span></span></button>').join('')
      : '<p class="cap">No steps yet.</p>';
  } else if (S.inspTab === 'reasoning') {
    const r = S.log.filter((m) => m.k === 'reason');
    body = r.length ? r.map((m) => '<div style="margin-bottom:12px"><div class="micro sec">step ' + m.steps + '</div>'
        + '<div class="mono sec" style="white-space:pre-wrap">' + esc(m.text) + '</div></div>').join('')
      : '<p class="cap">Reasoning appears here as the turn runs.</p>';
  } else if (S.inspTab === 'world') {
    const caps = LIVE_CAPS || {};
    const tools = Array.isArray(caps.tools) ? caps.tools.map((t) => t.name).join(' · ') : '';
    body = caps.paths
      ? '<dl class="kvgrid"><dt>cwd</dt><dd class="mono">' + esc(S.live.workingDir || '') + '</dd>'
        + '<dt>state dir</dt><dd class="mono">' + esc(caps.paths.stateDir || '') + '</dd>'
        + '<dt>skills</dt><dd>' + (SKILLS.length ? SKILLS.map((k) => esc(k.t)).join('<br>') : 'none installed') + '</dd>'
        + '<dt>tools</dt><dd>' + esc(tools) + '</dd></dl>'
      : '<p class="cap">Connect an agent to see what it can reach.</p>';
  }
  el.innerHTML = '<div class="insphead">' + segControl(tabs, S.inspTab, 'insp:') + '</div>'
    + '<div class="inspbody">' + body + '</div>'
    + '<div class="inspfoot">' + (S.agentSession ? '<span class="mono">' + esc(String(S.agentSession).slice(0, 18)) + '…</span>' : 'no session yet') + '</div>';
}

/* ---------------- console ---------------- */
const LOGS = [];
const LLMLOGS = [];
function renderConsole() {
  const el = $('#console');
  el.classList.toggle('hide', !S.consoleOpen);
  if (!S.consoleOpen) return;
  const rows = (S.consoleTab === 'agent' ? LOGS : LLMLOGS);
  el.innerHTML = '<div class="conhead">'
    + segControl([['agent','Agent log'],['llm','LLM log']], S.consoleTab, 'console:')
    + '<span style="flex:1"></span>'
    + '<button class="btn btn-s" data-act="dump">Write Debug Bundle' + keycaps('⌥ ⌘ D') + '</button>'
    + '<button class="iconbtn" data-act="toggle:console">' + ic('x') + '</button></div>'
    + '<div class="conbody">' + rows.map(([t, l, m]) =>
        '<div class="logrow"><span class="ter">' + t + '</span><span class="lvl ' + l + '">' + l + '</span>'
        + '<span class="sec">' + esc(m) + '</span></div>').join('') + '</div>';
}

/* ---------------- palette ---------------- */
const SCOPES = {
  theme: {label:'Theme', ph:'Choose a theme…', rows:[['gear','System','follow macOS','','theme:system'],['gear','Light','','','theme:light'],['gear','Dark','','','theme:dark']]},
  // Item 7: the prototype's Task scope is gone — nothing targeted scope:task, and the Tasks tab is the one surface.
};

function palRows() {
  if (S.scope) return SCOPES[S.scope].rows.map((r) => ({ic:r[0], t:r[1], cx:r[2], sc:r[3], act:r[4]}));
  const q = S.q.trim().toLowerCase();
  const all = [];
  PAL.forEach(([g, rows]) => rows.forEach((r) => all.push({ic:r[0], t:r[1], cx:r[2], sc:r[3], act:r[4], g})));
  if (!q) return null; // grouped rendering
  const score = (r) => {
    const t = r.t.toLowerCase();
    if (t === q) return 0;
    if (t.startsWith(q)) return 1;
    if (t.split(/[\s·]+/).some((w) => w.startsWith(q))) return 2;
    if (t.includes(q)) return 3;
    if ((r.cx || '').toLowerCase().includes(q)) return 4;
    return 9;
  };
  const hits = all.map((r) => ({r, s:score(r)})).filter((x) => x.s < 9).sort((a, b) => a.s - b.s).map((x) => x.r);
  // cross-entity
  SESSIONS.filter((s) => s.t.toLowerCase().includes(q)).slice(0, 3)
    .forEach((s) => hits.push({ic:'chat', t:s.t, cx:'Session · ' + s.sub, sc:'', act:'ses:' + s.id, badge:'session'}));
  TASKS.filter((t) => t.t.toLowerCase().includes(q)).slice(0, 3)
    .forEach((t) => hits.push({ic:'tasks', t:t.t, cx:'Task · ' + t.when, sc:'', act:'room:tasks', badge:'task'}));
  SKILLS.filter((s) => s.t.toLowerCase().includes(q)).slice(0, 3)
    .forEach((s) => hits.push({ic:'skills', t:s.t, cx:'Skill · ' + s.s, sc:'', act:'room:skills', badge:'skill'}));
  return hits;
}

function bold(t, q) {
  if (!q) return esc(t);
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(t);
  return esc(t.slice(0, i)) + '<b>' + esc(t.slice(i, i + q.length)) + '</b>' + esc(t.slice(i + q.length));
}

function palRowHTML(r, i, q) {
  const shortcut = r.sc && r.sc.startsWith('/')
    ? '<span class="mono ter">' + esc(r.sc) + '</span>'
    : keycaps(r.sc);
  return '<button class="palrow' + (i === S.cur ? ' on' : '') + '" data-palrow="' + i + '">'
    + '<span class="ic">' + ic(r.ic) + '</span>'
    + '<span class="ti">' + bold(r.t, q) + '</span>'
    + '<span class="cx">' + esc(r.cx || '') + '</span>'
    + '<span class="sc">' + shortcut + '</span></button>';
}

function paletteHTML() {
  const q = S.q.trim();
  const flat = palRows();
  let list = '', idx = 0;
  if (flat === null) {
    PAL.forEach(([g, rows]) => {
      list += '<div class="palgroup micro">' + esc(g) + '</div>';
      rows.forEach((r) => {
        list += palRowHTML({ic:r[0], t:r[1], cx:r[2], sc:r[3], act:r[4]}, idx++, '');
      });
    });
  } else if (flat.length === 0) {
    list = '<div class="palempty"><div style="font-weight:500">No results for &ldquo;' + esc(q) + '&rdquo;</div>'
      + '<div class="cap">Nothing in the command registry matches.</div>'
      + '<button class="palrow" data-ask="1"><span class="ic">' + ic('chat') + '</span>'
      + '<span class="ti">Ask the agent &ldquo;' + esc(q) + '&rdquo;</span><span></span><span class="sc">' + keycaps('↩') + '</span></button></div>';
  } else {
    list = flat.map((r, i) => palRowHTML(r, i, q)).join('');
  }
  const sc = S.scope ? SCOPES[S.scope] : null;
  const dial = (sc && sc.dial) ? '<div style="padding:12px 16px;box-shadow:inset 0 1px 0 var(--line-soft)">'
      + '<div class="hstack" style="margin-bottom:6px"><span class="cap">cloud share</span>'
      + '<span class="mono tnum" style="margin-left:auto">' + S.dialShare + '</span></div>'
      + '<input class="slider" type="range" min="0" max="100" step="5" value="' + S.dialShare + '" id="dial">'
      + '<div class="cap" style="margin-top:4px">' + esc(shareBlurb(S.dialShare)) + '</div></div>' : '';
  return '<div class="scrim" data-close="1"><div class="pal" role="dialog" aria-label="Command palette">'
    + '<div class="palin">' + ic('search')
      + (sc ? '<span class="palscope">' + esc(sc.label) + ' <span data-popscope="1">×</span></span>' : '')
      + '<input id="palq" placeholder="' + (sc ? esc(sc.ph) : 'Search commands, sessions, tasks and skills…') + '" value="' + esc(S.q) + '">'
      + keycaps('esc') + '</div>'
    + '<div class="pallist" id="pallist">' + list + '</div>' + dial
    + '<div class="palfoot"><span>' + keycaps('↩') + ' ' + (S.scope ? 'Apply' : 'Go') + '</span>'
      + '<span>' + keycaps('↑') + keycaps('↓') + ' Move</span>'
      + (S.scope ? '<span>' + keycaps('⌫') + ' Back</span>' : '')
      + '<span style="margin-left:auto">' + PAL.reduce((n, g) => n + g[1].length, 0) + ' commands</span></div>'
    + '</div></div>';
}
function shareBlurb(v) {
  if (v === 0) return 'everything local';
  if (v === 100) return 'everything cloud';
  return 'cloud handles steps scoring ≥ ' + (100 - v);
}

/* ---------------- slash completion ---------------- */
function slashMatches() {
  const q = S.draft.replace(/^\//, '').toLowerCase();
  if (!q) return SLASH;
  return SLASH.filter(([n, d]) => n.startsWith(q)) .concat(SLASH.filter(([n, d]) => !n.startsWith(q) && n.includes(q)));
}
function slashPopover() {
  const m = slashMatches();
  const q = S.draft.replace(/^\//, '');
  if (!m.length) return '<div class="slash"><div class="slashrow"><span class="cmd" style="color:var(--warn)">no matching command</span><span></span><span></span></div></div>';
  return '<div class="slash"><div class="slashlist">' + m.map(([n, d, a], i) =>
    '<button class="slashrow' + (i === S.slashCur ? ' on' : '') + '" data-slash="' + esc(n) + '">'
    + '<span class="cmd">/' + bold(n, q) + '</span><span class="ds">' + esc(d) + '</span>'
    + '<span class="hint">' + esc(a || '') + '</span></button>').join('') + '</div></div>';
}

/* ---------------- overlays ---------------- */
function renderOverlays() {
  const o = $('#overlays');
  let html = '';
  if (S.overlay === 'palette') html += paletteHTML();
  if (S.overlay === 'context') html += contextHTML();
  if (S.overlay === 'modes') html += modesHTML();
  if (SEL.open) html += selectorHTML();
  if (S.overlay === 'sessions') html += sessionSheet();
  if (S.overlay === 'shortcuts') html += shortcutsSheet();
  if (S.alert) html += alertHTML();
  if (OB.open) html = obHTML();
  o.innerHTML = html;
  o.style.pointerEvents = html ? 'auto' : 'none';
  o.style.position = 'absolute'; o.style.inset = '0'; o.style.zIndex = '20';
  const pq = $('#palq');
  if (pq) { pq.focus(); pq.setSelectionRange(pq.value.length, pq.value.length); }
  const cur = o.querySelector('.palrow.on');
  if (cur) cur.scrollIntoView({block:'nearest'});
}



/** Pin a popover to the control that opened it, clamped inside the window. */
function anchorStyle(sel, width) {
  const el = document.querySelector(sel);
  const win = $('#window').getBoundingClientRect();
  if (!el) return 'right:24px;bottom:96px';
  const r = el.getBoundingClientRect();
  const left = Math.max(win.left + 8, Math.min(r.left, win.right - width - 8));
  return 'position:fixed;left:' + Math.round(left) + 'px;bottom:'
    + Math.round(window.innerHeight - r.top + 8) + 'px;top:auto;right:auto';
}

function contextHTML() {
  const agent = (LIVE_CONFIG && LIVE_CONFIG.agent) || {};
  const pairs = agent.conversationMaxPairs || 20;
  const win = CTX.window;
  const title = CTX.tokens
    ? 'context \u00b7 ' + tok(CTX.tokens) + (win ? ' of ' + tok(win) + ' \u00b7 ' + Math.min(100, Math.round(CTX.tokens / win * 100)) + '%' : ' \u00b7 window unknown')
    : 'context \u00b7 not measured yet';
  const rows = CTX.tokens
    ? '<dl class="kvgrid" style="grid-template-columns:1fr max-content;gap:4px 12px">'
      + '<dt>prompt scaffold</dt><dd class="mono tnum">' + tok(CTX.stablePrefix) + '</dd>'
      + '<dt>conversation</dt><dd class="mono tnum">' + tok(CTX.tail) + '</dd>'
      + (win ? '<dt class="ter">free</dt><dd class="mono tnum ter">' + tok(Math.max(0, win - CTX.tokens)) + '</dd>' : '')
      + '</dl>'
    : '<p class="cap" style="margin:0">send a message \u2014 the breakdown comes from the prompt the agent actually builds</p>';
  return '<div class="scrim" data-close="1" style="background:transparent">'
    + '<div class="popover" style="width:360px;' + anchorStyle('.ctxbtn', 360) + '">'
    + '<div style="padding:12px 16px 8px"><div class="hd" style="margin-bottom:8px">' + esc(title) + '</div>' + rows
    + (CTX.tokens ? '<p class="cap" style="margin:8px 0 0">' + (CTX.source === 'provider'
        ? 'counted by ' + esc(CTX.modelId || 'the model') : 'estimated from the built prompt') + '</p>' : '')
    + '</div>'
    + '<div class="ctxdials"><div class="ctxdial"><span class="col"><span>tasks per turn</span>'
      + '<span class="cap">sent each turn (1-100)</span></span>'
      + '<span class="hstack">'
      + '<button class="btn btn-s" data-ctx-step="agent.conversationMaxPairs:-1"' + (pairs <= 1 ? ' disabled' : '') + '>\u2212</button>'
      + '<span class="mono tnum" style="min-width:40px;text-align:center">' + pairs + '</span>'
      + '<button class="btn btn-s" data-ctx-step="agent.conversationMaxPairs:1"' + (pairs >= 100 ? ' disabled' : '') + '>+</button>'
      + '</span></div></div>'
    + '<div class="popfoot"><button class="btn btn-g" data-act="clear">Clear transcript</button>'
    + '<button class="btn btn-s" data-act="close">Done</button></div></div></div>';
}

function sessionSheet() {
  let last = '', rows = '';
  SESSIONS.forEach((s) => {
    if (s.g !== last) { rows += '<div class="micro sec" style="padding:8px 0 4px">' + s.g + '</div>'; last = s.g; }
    rows += '<button class="row" style="padding:0;height:40px" data-ses="' + s.id + '">'
      + (s.st ? '<span class="dot ' + s.st + '"></span>' : '<span class="dot" style="background:transparent"></span>')
      + '<span class="main"><span class="t" style="font-weight:400">' + esc(s.t) + '</span></span>'
      + '<span class="meta">' + esc(s.sub) + '</span></button>';
  });
  return sheet('Switch session', '<input class="btn btn-s" style="width:100%;height:32px" placeholder="Filter sessions…">' + rows,
    '<button class="btn btn-s" data-act="close">Cancel</button><button class="btn btn-p" data-act="close">Open</button>');
}

function shortcutsSheet() {
  const rows = [
    ['Command palette','⌘ K','Ctrl K'],['Chat / Tasks / Skills / Memory','⌘ 1-4','Ctrl 1-4'],
    ['New session','⌘ N','Ctrl N'],['Switch session','⌘ O','Ctrl O'],
    ['Toggle sidebar','⌘ 0','Ctrl 0'],['Toggle console','⇧ ⌘ Y','Ctrl ⇧ Y'],
    ['Send','↩',''],['Newline','⇧ ↩',''],['Stop','⌘ .','Ctrl .'],
    ['Expand all cards','⌥ ⌘ E',''],['Collapse all cards','⌥ ⌘ K',''],
    ['Cycle run mode','⌃ R',''],['Approve / grant / deny / abort','Y S N ⎋',''],
    ['Settings','⌘ ,','Ctrl ,'],['Shortcuts','⌘ /',''],
  ];
  return sheet('Keyboard shortcuts',
    '<div class="rows">' + rows.map(([t, k, p]) => '<div class="row" style="padding:0;height:32px">'
      + '<span class="main"><span class="t" style="font-weight:400">' + esc(t) + '</span></span>'
      + '<span class="hstack">' + keycaps(k) + (p ? '<span class="cap">proto ' + esc(p) + '</span>' : '') + '</span></div>').join('') + '</div>',
    '<button class="btn btn-p" data-act="close">Done</button>');
}

function alertHTML() {
  const a = S.alert;
  return '<div class="sheetwrap" style="align-items:center;padding:0" data-close="1"><div class="alertbox">'
    + '<div style="display:flex;justify-content:center">' + MARK_COLOR.replace('width="16" height="16"', 'width="40" height="40"') + '</div>'
    + '<div class="ttl" style="text-align:center">' + esc(a.title) + '</div>'
    + '<p class="cap" style="text-align:center;margin:0">' + esc(a.msg) + '</p>'
    + '<div class="hstack" style="justify-content:center;margin-top:4px">'
      + '<button class="btn btn-s" data-act="close" autofocus>Cancel</button>'
      + '<button class="btn btn-danger" data-act="' + a.act + '">' + esc(a.ok) + '</button></div></div></div>';
}

function sheet(title, body, foot) {
  return '<div class="sheetwrap" data-close="1"><div class="sheet"><div class="sheethead"><div class="ttl">' + esc(title) + '</div></div>'
    + '<div class="sheetbody">' + body + '</div><div class="sheetfoot">' + foot + '</div></div></div>';
}

/* ---------------- settings ---------------- */
/* Item 7: the settings window is the TUI menu. Left column = the menu
   tree (src/tui/menu/menu-registry.ts); right = the Manage sub-tab strip
   (buildManageTabs, src/tui/components/debug-pane.tsx), the diagnostics
   line (debug-diagnostics-line.tsx) and the active panel. The popup
   title is the TUI's "Menu › Manage" (menu-selectors.ts). */
function renderSettings() {
  const old = $('#settings'); if (old) old.remove();
  if (!S.settings) return;
  const cur = settingsPaneId(S.settingsPane);
  const el = document.createElement('div');
  el.id = 'settings';
  const strip = SETTINGS_TABS.map(([id, label], i) =>
      (i ? '<span class="tabsep">  |  </span>' : '')
      + '<button class="settab' + (cur === id ? ' on' : '') + '" data-act="settings:' + id + '">' + esc(label + tabSuffix(id)) + '</button>').join('');
  el.innerHTML = '<div class="setwin"><div class="settb">'
    + '<div class="lights"><button class="lg" style="background:#FF5F57" data-act="settings:close"></button>'
      + '<span class="lg" style="background:var(--bg-active)"></span><span class="lg" style="background:var(--bg-active)"></span></div>'
    + '<span class="setttl">Menu › Manage</span>'
    + '<span style="flex:1"></span><button class="iconbtn" data-act="settings:close" title="Close (Esc)">' + ic('x') + '</button>'
    + '</div><div class="setcols">'
    + '<div class="setmenu">' + menuTreeHTML() + '</div>'
    + '<div class="setmain"><div class="settabs">' + strip + '</div>'
    + '<div class="setdiag">' + esc(diagLine()) + '</div>'
    + '<div class="setbody">' + settingsPane() + '</div></div>'
    + '</div></div>';
  el.querySelector('.lights').style.marginRight = '0';
  $('#window').appendChild(el);
}

/* The prototype's pane ids and the --models harness (`__pane('models')`)
   still name panes that are now Manage tabs. */
function settingsPaneId(v) {
  if (SETTINGS_TABS.some((t) => t[0] === v)) return v;
  return {models:'llm', channels:'telegram', general:'tasks', appearance:'tasks'}[v] || 'tasks';
}

/* Count suffix ` (N)` exactly as debug-pane.tsx suffix(): tasks = every
   fetched row, skills = every installed skill, memory = rows of the
   selected channel, mcp = configured servers. Zero → no suffix. */
function tabSuffix(id) {
  let n = 0;
  if (id === 'tasks') n = TK.lastRefreshedAt === null ? TASKS.length : TK.rows.length; // until the tab's own fetch lands, GET /api/tasks from loadResources
  else if (id === 'skills') n = SK.rows ? SK.rows.length : 0; // no suffix until `atag skill list` has answered
  else if (id === 'memory') n = 0; // the Memory tab lands in the next step of this branch; no channel is loaded yet
  else if (id === 'mcp') n = ((LIVE_CONFIG && LIVE_CONFIG.mcp && LIVE_CONFIG.mcp.servers) || []).length;
  return n === 0 ? '' : ' (' + n + ')';
}

function menuTreeHTML() {
  const cur = settingsPaneId(S.settingsPane);
  const row = (n, sub) => {
    const on = n.tab && n.tab === cur;
    // The chord is live in the desktop too: ctrl+g then the key (the keydown handler's CHORD layer).
    const chord = n.chord ? '<span class="ch" title="press ctrl+g, then ' + esc(n.chord) + '">ctrl+g ' + esc(n.chord) + '</span>' : '';
    if (n.na) return '<div class="menurow na' + (sub ? ' sub' : '') + '" title="not available in the desktop"><span class="lb">' + esc(n.label) + '</span><span class="note">not available in the desktop</span></div>';
    return '<button class="menurow' + (sub ? ' sub' : '') + (on ? ' on' : '') + '" data-act="menu:' + esc(n.id) + '"><span class="lb">' + esc(n.label) + '</span>' + chord + '</button>';
  };
  return MENU_GROUPS.map(([label, nodes]) =>
    '<div class="menuhd">' + esc(label) + '</div>'
    + nodes.map((n) => n.sub
        ? '<div class="menurow parent"><span class="lb">' + esc(n.label) + ' →</span></div>' + n.sub.map((c) => row(c, true)).join('')
        : row(n, false)).join('')).join('');
}

/* debug-diagnostics-line.tsx: `cwd | llama | llm — · step — | kv — |
   tools <ok>ok/<err>err | approval L<n> | skills <n>`. The llm/step/kv
   numbers are TUI process metrics the desktop does not have, so they
   stay in the TUI's own null form; the tools counters come from the open
   session's tool_result rows, or the segment is left out. */
function diagLine() {
  const home = homeDir();
  const wd = (SET.health && SET.health.workingDir) || WORKSPACE || S.live.workingDir || '';
  const cwd = home && wd.startsWith(home) ? '~' + wd.slice(home.length) : (wd || '—');
  const llama = (SET.health && SET.health.llamaUrl) || (S.live.llama && S.live.llama.url) || (LIVE_CAPS && LIVE_CAPS.llama && LIVE_CAPS.llama.url) || '—';
  const parts = ['cwd ' + cwd, 'llama ' + llama, 'llm — · step —', 'kv —'];
  if (SET.tools && SET.toolsFor === S.agentSession) parts.push('tools ' + SET.tools.ok + 'ok/' + SET.tools.err + 'err');
  parts.push('approval L' + (LIVE_CAPS && typeof S.level === 'number' ? S.level : '—'));
  parts.push('skills ' + SKILLS.length);
  return parts.join(' | ');
}

/* Refresh what the diagnostics line and the tab suffixes read. Each
   fetch repaints only when its answer changed, so switching tabs does not
   rebuild the window (and drop focus) for data that is still the same.
   `atag skill list` is a subprocess: it runs once per window opening
   (`skills:true`) and on the Skills tab's own refresh, never per click. */
async function refreshDiag(opts) {
  if (!BR) return;
  refreshHealth();
  if (!SK.rows || (opts && opts.skills)) refreshSkillList();
  // Pin the session id before the await: the counts belong to the session
  // they were read from, never to whichever one is open when they arrive.
  const id = S.agentSession;
  if (!id || SET.toolsBusy) return;
  if (SET.toolsFor === id && SET.tools) return;
  SET.toolsBusy = true;
  const res = await BR.session(id);
  SET.toolsBusy = false;
  if (id !== S.agentSession) return;
  const turns = res && res.ok && res.data && Array.isArray(res.data.turns) ? res.data.turns : null;
  if (!turns) return;
  let ok = 0, err = 0;
  turns.forEach((t) => { if (t.kind === 'tool_result') { if (t.status === 'ok') ok++; else err++; } });
  const changed = !SET.tools || SET.tools.ok !== ok || SET.tools.err !== err || SET.toolsFor !== id;
  SET.tools = {ok, err}; SET.toolsFor = id;
  if (S.settings && changed) tkRenderKeepCaret(); // a late /api/sessions/{id} answer must not drop the caret in the Tasks form
}
/* GET /health: workingDir + llama.url for the diagnostics line's cwd/llama segments. */
async function refreshHealth() {
  if (!BR || !BR.health || SET.healthBusy) return;
  SET.healthBusy = true;
  const res = await BR.health();
  SET.healthBusy = false;
  if (!(res && res.ok && res.data)) return;
  const next = {workingDir: typeof res.data.workingDir === 'string' ? res.data.workingDir : null,
                llamaUrl: res.data.llama && typeof res.data.llama.url === 'string' ? res.data.llama.url : null};
  const changed = JSON.stringify(next) !== JSON.stringify(SET.health);
  SET.health = next;
  if (S.settings && changed && !tkTyping()) render(); // a late /health answer must not drop the caret in the Tasks form
}
/* `atag skill list` (cwd = workspace, so project skills count too). */
async function refreshSkillList() {
  if (!BR || !BR.skillList || SK.busy) return;
  SK.busy = true; SK.calls++;
  const res = await BR.skillList();
  SK.busy = false;
  const before = JSON.stringify([SK.rows, SK.err]);
  if (res && res.ok && Array.isArray(res.rows)) { SK.rows = res.rows; SK.err = null; }
  else SK.err = (res && res.error) || 'skill list failed';
  if (S.settings && before !== JSON.stringify([SK.rows, SK.err]) && !tkTyping()) render(); // same guard as refreshHealth
}
/* Everything a Manage tab needs when it comes into view: the diagnostics
   line, the Tasks list primed once (the TUI starts its tasks orchestrator
   at mount, so `Tasks (N)` is right whichever tab opens first) and the
   Privacy tab's effective analytics value. `opened` = the window was
   closed a moment ago. */
function settingsPaneEntered(opened) {
  refreshDiag({skills: !!opened});
  if (TK.lastRefreshedAt === null && !TK.loading) tasksRefresh(true);
  // Privacy: fetch the effective value once; `r` re-reads on demand (no repaint for a value already known).
  if (settingsPaneId(S.settingsPane) === 'privacy' && privacyEffective() === null && !PRIV.effectiveBusy) privacyRefresh();
}

function settingsPane() {
  const p = settingsPaneId(S.settingsPane);
  if (p === 'tasks') return tasksTab();
  if (p === 'privacy') return privacyPane();
  if (p === 'skills') return skillsListPane();
  if (p === 'llm') return comingNote('LLM') + modelsPane();
  return comingNote(SETTINGS_TABS.find((t) => t[0] === p)[1]);
}
function comingNote(label) {
  return '<div class="tui"><b>' + esc(label) + '</b><div class="ter">coming in the next step of this branch</div></div>';
}
/* Skills tab, this step of the branch: the installed list as
   skills-list.tsx draws it — header row, rows from `atag skill list` (the
   only surface that lists disabled skills) sorted enabled-first then alpha,
   the TUI column widths (state 9 · [source] 9 · vN 8 · name 24/26 ·
   description 60). The palette's Skills rows and `/skills` land here, so
   they open a real list; toggle / detail / remove / hub follow in the next
   step of this branch. */
function skillsListPane() {
  if (!SK.rows) {
    return '<div class="tui"><b>Skills</b>' + (SK.err ? '<div class="tuierr">! ' + esc(SK.err) + '</div>' : '<div class="ter">loading skill list…</div>') + '</div>';
  }
  const rows = SK.rows.slice().sort((a, b) => (a.enabled === b.enabled ? a.name.localeCompare(b.name) : a.enabled ? -1 : 1));
  const cell = (s, max, w) => { const t = s.length > max ? s.slice(0, max - 1) + '…' : s; return t.padEnd(w); };
  const body = rows.length ? rows.map((r) => '<div class="tuirow">  '
      + '<span class="' + (r.enabled ? 'sk-on' : 'sk-off') + '">' + (r.enabled ? 'enabled' : 'disabled').padEnd(9) + '</span>'
      + esc(('[' + r.source + ']').padEnd(9) + ('v' + r.version).padEnd(8) + cell(r.name, 24, 26) + cell(r.description, 60, 60)) + '</div>').join('')
    : '<div class="ter">no skills match the current filter — install one with `atomic-agent skill install`, or press `f` to cycle filter / `r` to refresh.</div>';
  return '<div class="tui"><b>Skills</b>'
    + '<div class="tuihead">  state     source   version  name                       description</div>' + body
    + '<div class="ter">' + rows.length + ' shown · ' + rows.filter((r) => r.enabled).length + ' enabled · ' + rows.filter((r) => !r.enabled).length + ' disabled'
    + ' — e toggle · Enter detail · d remove · Skills Hub: coming in the next step of this branch</div></div>';
}

function modelsPane() {
  const tab = S.modelTab === 'cloud' ? 'cloud' : 'local';
  return '<div class="stack">'
    + '<div class="hstack">' + segControl([['local','Local'],['cloud','Cloud']], tab, 'modeltab:')
      + '<span style="flex:1"></span>'
      + (tab === 'local'
          ? '<button class="btn btn-s" data-act="models:refresh">Refresh catalogue</button>'
          : '<button class="btn btn-p" data-act="provider:add">' + ic('plus') + 'Add provider</button>')
    + '</div>'
    + (MP.err ? '<div class="cap" style="color:var(--danger)">' + esc(MP.err) + '</div>' : '')
    + (tab === 'local' ? localModelsSection() : cloudProvidersSection())
    + '</div>';
}

function localModelsSection() {
  if (MP.pulling) {
    return '<div class="card"><div class="card-h">downloading ' + esc(MP.pulling) + '</div>'
      + '<div class="card-b"><div class="ob-prog" id="mp-prog">' + esc(MP.pullLog.slice(-8).join('\n')) + '</div>'
      + '<button class="btn btn-s" style="align-self:flex-start" data-act="models:cancelPull">Cancel</button></div></div>';
  }
  if (MP.localBusy) return '<div class="card"><div class="card-b cap">reading the catalogue…</div></div>';
  if (MP.localErr) return '<div class="card"><div class="card-b cap" style="color:var(--danger)">' + esc(MP.localErr) + '</div></div>';
  if (!MP.local.length) {
    return '<div class="card"><div class="card-b cap">No catalogue yet — Refresh catalogue reads it from the agent.</div></div>';
  }
  return '<div class="card"><div class="card-h">local models · ' + MP.local.length + '</div><div class="modellist">'
    + MP.local.map((m) => {
      const fit = fitFor(m.size, OB.ram || 16);
      return '<div class="modelrow' + (m.active ? ' on' : '') + '">'
        + '<span class="radio"' + (m.active ? ' style="border-color:var(--accent);border-width:4px"' : '') + '></span>'
        + '<span class="col"><span class="mono nm">' + esc(m.id) + '</span>'
        + '<span class="cap">' + esc(m.size) + ' · ' + esc(m.context) + ' context · ' + esc(fit.label)
        + (m.downloaded ? ' · on disk' : '') + '</span></span>'
        + (m.active
            ? '<span class="cap">active</span>'
            : m.downloaded
              ? '<button class="btn btn-s" data-use-local="' + esc(m.id) + '">Use</button>'
              : '<button class="btn btn-t" data-pull-local="' + esc(m.id) + '">Download</button>')
        + '</div>';
    }).join('') + '</div></div>';
}

function cloudProvidersSection() {
  const providers = ((LIVE_CONFIG && LIVE_CONFIG.llm && LIVE_CONFIG.llm.providers) || [])
    .filter((p) => p.kind !== 'llama-server');
  const activeId = LIVE_CONFIG && LIVE_CONFIG.llm && LIVE_CONFIG.llm.activeTextProvider;
  const rows = providers.length ? providers.map((p) =>
    '<div class="modelrow' + (p.id === activeId ? ' on' : '') + '">'
    + '<span class="radio"' + (p.id === activeId ? ' style="border-color:var(--accent);border-width:4px"' : '') + '></span>'
    + '<span class="col"><span class="nm">' + esc(p.id) + '</span>'
    + '<span class="cap">' + esc(p.kind) + (p.defaultChatModel ? ' · ' + esc(p.defaultChatModel) : ' · no model chosen')
    + (p.apiKeyEnvVar ? ' · key from ' + esc(p.apiKeyEnvVar) : '') + '</span></span>'
    + '<span class="hstack">'
    + '<button class="btn btn-s" data-pick-models="' + esc(p.id) + '">Models…</button>'
    + (p.id === activeId ? '<span class="cap">active</span>' : '<button class="btn btn-t" data-use-provider="' + esc(p.id) + '">Use</button>')
    + '</span></div>').join('')
    : '<div class="pad cap">No cloud provider configured yet.</div>';

  const picker = MP.pickFor ? '<div class="card"><div class="card-h">models · ' + esc(MP.pickFor)
    + '<span style="margin-left:auto"><button class="btn-g cap" data-act="provider:closePick">close</button></span></div>'
    + '<div class="card-b">'
    + '<input class="field-inp" id="mp-query" style="width:100%" placeholder="filter, e.g. claude, 70b, free" value="' + esc(MP.pickQuery) + '">'
    + (MP.pickBusy ? '<div class="cap">searching…</div>' : '')
    + (MP.pickErr ? '<div class="cap" style="color:var(--danger)">' + esc(MP.pickErr) + '</div>' : '')
    + '<div class="modellist" style="max-height:38vh;overflow-y:auto">'
    + (MP.picks.length ? MP.picks.map((m) =>
        '<div class="modelrow"><span class="radio"></span>'
        + '<span class="col"><span class="mono nm">' + esc(m.id) + '</span>'
        + '<span class="cap">' + (m.contextWindow ? tok(m.contextWindow) + ' context' : '')
        + (m.supportsTools && m.supportsTools !== 'none' ? ' · tools' : '')
        + (m.supportsVision ? ' · vision' : '') + '</span></span>'
        + '<button class="btn btn-t" data-set-model="' + esc(m.id) + '">Select</button></div>').join('')
       : (MP.pickBusy ? '' : '<div class="pad cap">Type to search this provider\u2019s catalogue — try <span class="mono">claude</span>, <span class="mono">70b</span> or <span class="mono">free tools</span>.</div>'))
    + '</div></div></div>' : '';

  const add = MP.addOpen ? '<div class="card"><div class="card-h">add a provider'
    + '<span style="margin-left:auto"><button class="btn-g cap" data-act="provider:closeAdd">close</button></span></div>'
    + '<div class="card-b">'
    + '<div class="modellist" style="max-height:34vh;overflow-y:auto">'
    + PRESETS.map((p, i) => '<div class="modelrow' + (i === MP.presetCur ? ' on' : '') + '" data-preset="' + i + '">'
        + '<span class="radio"></span><span class="col"><span class="nm">' + esc(p.label) + '</span>'
        + '<span class="cap mono">' + esc(p.baseUrl) + '</span></span>'
        + '<span class="cap">' + esc(p.env) + '</span></div>').join('')
    + '</div>'
    + '<input class="field-inp" id="mp-key" style="width:100%" type="password" placeholder="API key — optional, leave blank to use ' + esc(PRESETS[MP.presetCur].env) + '">'
    + '<div class="hstack"><span class="cap">Saved to llm.providers. A blank key means the agent reads the environment variable instead.</span>'
    + '<span style="flex:1"></span><button class="btn btn-p" data-act="provider:save"' + (MP.busy ? ' disabled' : '') + '>Add provider</button></div>'
    + '</div></div>' : '';

  return add + '<div class="card"><div class="card-h">cloud providers · ' + providers.length + '</div>'
    + '<div class="modellist">' + rows + '</div></div>' + picker;
}

/* src/tui/privacy/components/privacy-panel.tsx after PR #303: analytics
   + session grants, no ladder. The desktop's approval path only offers
   allow-once/deny, so the runtime never accumulates grants and the TUI's
   "none active" line is the truth here. The toggle is `atag config set
   analytics.enabled`; the running agent keeps its boot-time client, so
   the note and the Restart button say so. */
function privacyPane() {
  const eff = privacyEffective();
  const known = typeof eff === 'boolean';
  const on = known && eff;
  return '<div class="tui">'
    + '<b>Analytics</b>'
    + '<div>   <span class="ter">anonymous usage </span>' + (known ? '<span class="' + (on ? 'tuimsg' : 'ter') + '">' + (on ? 'on' : 'off') + '</span>'
        : PRIV.effectiveBusy || (BR && PRIV.effective === null && !PRIV.lastError) ? '<span class="ter">…</span>'
        : '<span class="ter">— (analytics.enabled is not set in config.json and `atag config get analytics.enabled` did not answer)</span>')
      + (PRIV.busy ? '<span class="ter">  …</span>' : '') + '</div>'
    + '<div class="ter">   Product analytics + crash reports, fully anonymous. No message content, paths, args, or IP ever leave this machine — only an install id and coarse counters.</div>'
    + '<b style="margin-top:8px">Session grants</b>'
    + '<div class="ter">   none active — grants you make with [s] / [a] at a prompt appear here for this session</div>'
    + (PRIV.message ? '<div class="tuimsg" style="margin-top:8px">   ' + esc(PRIV.message)
        + ' <span class="ter">(the running agent picks it up after Restart Agent Runtime)</span> '
        + '<button class="btn btn-s" data-act="agent:restart" style="height:22px">Restart Agent Runtime</button></div>' : '')
    + (PRIV.lastError ? '<div class="tuierr" style="margin-top:8px">   ' + esc(PRIV.lastError) + '</div>' : '')
    + '<div class="tuihint"><button data-act="privacy:analytics"' + (!known || PRIV.busy ? ' disabled' : '') + '>a: analytics ' + (on ? 'off' : 'on') + '</button>'
      + '<span>·</span><button data-act="privacy:refresh">r: refresh</button></div>'
    + '</div>';
}
/* The value the TUI shows: the user file's key when set, else the
   effective value `atag config get analytics.enabled` printed (the schema
   default). null = not known yet / the CLI read failed. */
function privacyEffective() {
  const a = LIVE_CONFIG && LIVE_CONFIG.analytics;
  if (a && typeof a.enabled === 'boolean') return a.enabled;
  return typeof PRIV.effective === 'boolean' ? PRIV.effective : null;
}
/* Privacy `r` / tab entry: re-read the user file, then the effective value
   when the user file has no analytics.enabled. */
async function privacyRefresh() {
  if (!BR) return;
  await refreshLiveConfig();
  const a = LIVE_CONFIG && LIVE_CONFIG.analytics;
  if (a && typeof a.enabled === 'boolean') { PRIV.effective = a.enabled; return; }
  if (!BR.configGetKey || PRIV.effectiveBusy) return;
  PRIV.effectiveBusy = true;
  const res = await BR.configGetKey('analytics.enabled');
  PRIV.effectiveBusy = false;
  const v = res && res.ok ? res.value : undefined;
  const before = PRIV.effective;
  PRIV.effective = typeof v === 'boolean' ? v : null;
  if (PRIV.effective === null) PRIV.lastError = 'config get analytics.enabled failed: ' + ((res && res.error) || 'no boolean answer');
  if (S.settings && settingsPaneId(S.settingsPane) === 'privacy' && (before !== PRIV.effective || PRIV.effective === null)) render();
}

async function privacyToggle() {
  if (!BR || !LIVE_CONFIG || PRIV.busy) return;
  const eff = privacyEffective();
  if (typeof eff !== 'boolean') { privacyRefresh(); return; } // nothing to flip until the effective value is known
  await privacySet(!eff);
}
/* privacy-orchestrator.ts setAnalyticsEnabled(enabled): persist the value
   through `atag config set analytics.enabled <enabled>` (an absolute write —
   the `a` key and the slash verbs both land here), then re-read. The
   running agent keeps its boot-time client; the pane's restart note says so. */
async function privacySet(enabled) {
  if (!BR) return;
  // Writes queue behind each other (`/analytics on` then `/analytics off`
  // lands both, in order, as the TUI does) instead of dropping the second.
  const run = async () => {
    PRIV.busy = true; PRIV.message = null; PRIV.lastError = null; render();
    const res = await BR.configSet('analytics.enabled', String(!!enabled));
    if (!res || res.ok === false) {
      PRIV.lastError = 'analytics toggle failed: ' + ((res && res.error) || 'unknown error');
    } else {
      PRIV.message = enabled ? 'analytics enabled' : 'analytics disabled';
    }
    await privacyRefresh();
    PRIV.busy = false; render();
  };
  PRIV.pending++;
  PRIV.chain = PRIV.chain.then(run, run);
  try { await PRIV.chain; } finally { PRIV.pending--; }
}

/* ---------------- toasts ---------------- */
function renderToasts() {
  $('#toasts').innerHTML = S.toasts.map((t) =>
    '<div class="toast"><span style="color:var(--success);display:flex">' + ic('check') + '</span>'
    + '<span><span style="font-weight:500">' + esc(t.t) + '</span>'
    + (t.s ? '<span class="cap" style="display:block">' + esc(t.s) + '</span>' : '') + '</span></div>').join('');
}
function toast(t, s) {
  const id = ++S.toastId;
  S.toasts.push({id, t, s});
  renderToasts();
  setTimeout(() => { S.toasts = S.toasts.filter((x) => x.id !== id); renderToasts(); }, 6000);
}

/* ============================================================
   behaviour
   ============================================================ */
function act(a) {
  if (!a) return;
  const [k, v] = a.split(':');
  const close = () => { S.overlay = null; S.menuOpen = null; S.scope = null; S.q = ''; S.cur = 0; S.alert = null; SEL.open = false; SEL.addOpen = false; WIZ.phase = null; };

  if (a === 'close') { close(); render(); return; }
  if (a === 'palette') { close(); S.overlay = 'palette'; render(); return; }
  if (a === 'palette:slash') { close(); S.overlay = 'palette'; S.q = ''; render(); toast('Slash commands', 'Type / in the composer for the in-context list'); return; }
  if (a === 'shortcuts') { close(); S.overlay = 'shortcuts'; render(); return; }
  if (a === 'context') { close(); S.overlay = 'context'; render(); return; }
  if (a === 'modes') { close(); S.overlay = 'modes'; render(); return; }
  if (a === 'sel:add') { WIZ.phase = 'pick_kind'; WIZ.row = null; WIZ.apiKey = ''; WIZ.baseUrl = ''; WIZ.error = null; render(); return; }
  if (a === 'wiz:back') { WIZ.phase = WIZ.phase === 'configure' ? 'pick_kind' : null; WIZ.error = null; render(); return; }
  if (a === 'wiz:next') { wizNext(); return; }
  if (a === 'wiz:cancel') { WIZ.phase = null; render(); return; }
  if (a === 'sel:browseLocal') { SEL.kind = 'model'; SEL.filter = ''; render(); selLoadLocal(); return; }
  if (a === 'sel:closeAdd') { SEL.addOpen = false; render(); return; }
  if (a === 'sel:savePreset') { selSavePreset(); return; }
  if (a === 'sel:cancelPull') { BR.cancelPull(); SEL.pulling = null; render(); return; }
  if (a === 'runmode') { close(); S.dialShare = S.share; S.overlay = 'runmode'; render(); return; }
  if (a === 'applydial') { S.share = S.dialShare; if (S.mode !== 'fusion' && S.dialShare > 0) S.mode = 'fusion'; close(); render(); toast('Run type applied', S.mode + (S.mode === 'fusion' ? ' · cloud share ' + S.share : '')); return; }
  if (a === 'session:new') { close(); S.log = []; S.history = []; S.agentSession = null; S.busy = false; S.pending = null; S.room = 'chat'; render(); toast('New session', 'The next turn starts fresh'); return; }
  if (a === 'session:switch') { close(); S.overlay = 'sessions'; render(); return; }
  if (a === 'clear') { close(); S.log = []; S.history = []; render(); toast('Transcript cleared', 'The next turn starts fresh'); return; }
  if (a === 'stop') { close(); abort(); return; }
  if (a === 'send') { close(); submit(); return; }
  if (a === 'retry') { close(); render(); toast('Retrying last turn'); return; }
  if (a === 'dump') { close(); render(); toast('Write debug bundle', 'not available in the desktop'); return; } // Item 7: no bundle writer in the desktop
  if (a === 'tools') { close(); S.inspector = true; S.inspTab = 'world'; render(); return; }
  if (a === 'restart') { close(); render(); toast('Agent runtime restarted'); return; }
  if (a === 'quit') { close(); if (BR && BR.quit) { BR.quit(); return; } render(); toast('This is a prototype', 'Nothing to quit'); return; }
  if (a === 'about') { close(); render(); toast('Atomic Agent 0.3.7', 'Local-first agent · GAIA L1 69.8%'); return; }
  if (a === 'update') { close(); render(); toast('You are up to date', 'Version 0.3.7, stable channel'); return; }
  if (a === 'copy:session' || a === 'session:id') {
    // The TUI's /session prints the real id; the desktop shows the one it is talking to.
    close(); render();
    const id = S.agentSession || '';
    if (!id) { toast('No session yet', 'send a message to start one'); return; }
    toast('Session id', id);
    if (navigator.clipboard) navigator.clipboard.writeText(id).catch(() => {});
    return;
  }
  // Item 7: menu verbs that need the settings window out of the way first.
  if (a === 'selector:model') { close(); S.settings = null; openSelector('model'); return; }
  if (a === 'palette:theme') { close(); S.settings = null; S.overlay = 'palette'; S.scope = 'theme'; render(); return; }
  if (a === 'settings:close') { close(); S.settings = null; render(); return; }
  if (k === 'menu') { menuActivate(a.slice(5)); return; }
  // close() first like every other verb: `/task` and a palette row reach these with the palette still open.
  if (k === 'tasks') { close(); tasksAct(a.slice(6)); return; }
  if (a === 'privacy:analytics') { close(); privacyToggle(); return; }
  if (a === 'privacy:refresh') { close(); privacyRefresh(); return; }
  if (a === 'copy:reply') { close(); render(); toast('Copied last reply'); return; }
  if (a === 'workspace') { close(); render(); toast('Workspace', '~/Teletubbies · rw'); return; }
  if (a === 'analytics') { close(); const opened = !S.settings; S.settings = 1; S.settingsPane = 'privacy'; render(); settingsPaneEntered(opened); return; }
  if (a === 'jump:appr') { const c = $('#apprcard'); if (c) c.scrollIntoView({block:'center', behavior:'smooth'}); return; }
  if (a === 'skills:hub') { close(); S.room = 'skills'; S.skillsTab = 'hub'; render(); return; }
  if (a === 'na') return;

  if (k === 'room')      { close(); S.room = v; render(); return; }
  if (k === 'insp')      { close(); S.inspector = true; S.inspTab = v; render(); return; }
  if (k === 'console')   { close(); S.consoleOpen = true; S.consoleTab = v; render(); return; }
  if (k === 'toggle')    { close(); if (v === 'sidebar') $('#sidebar').classList.toggle('rail');
                           else if (v === 'inspector') S.inspector = !S.inspector;
                           else S.consoleOpen = !S.consoleOpen; render(); return; }
  if (k === 'settings')  { close(); const opened = !S.settings; S.settings = 1; S.settingsPane = settingsPaneId(v); render(); settingsPaneEntered(opened); return; }
  if (k === 'theme')     { close(); S.theme = v;
                           if (v === 'system') document.documentElement.removeAttribute('data-theme');
                           else document.documentElement.setAttribute('data-theme', v);
                           render(); return; }
  if (k === 'mode')      { S.mode = v; if (S.overlay === 'palette') close(); render(); return; }
  if (k === 'cards')     { close(); S.log.forEach((m) => { if (m.k === 'tool') m.open = v === 'expand'; }); render(); return; }
  if (k === 'ses')       { close(); openSession(v); return; }
  if (k === 'delask')    { const ss = SESSIONS.find((x) => x.id === v); if (!ss) return;
                           S.alert = {title:'Delete “' + ss.t + '”?', msg:'The transcript, its tool calls and its work log are removed from this machine. This cannot be undone.', ok:'Delete', act:'del:' + v};
                           render(); return; }
  if (k === 'del')       { const i = SESSIONS.findIndex((x) => x.id === v); if (i >= 0) { const gone = SESSIONS[i].t; SESSIONS.splice(i, 1);
                             if (S.sessionId === v) { S.sessionId = SESSIONS[0] ? SESSIONS[0].id : ''; S.log = []; }
                             close(); render(); toast('Session deleted', gone); } return; }
  if (k === 'scope')     { S.scope = v; S.q = ''; S.cur = 0; S.dialShare = S.share; render(); return; }
  if (k === 'taskfilter'){ S.taskFilter = v; render(); return; }
  if (k === 'modeltab')  { S.modelTab = v; MP.err = null; render(); if (v === 'local' && !MP.local.length) mpLoadLocal(); return; }
  if (a === 'models:refresh') { mpLoadLocal(); return; }
  if (a === 'models:cancelPull') { BR.cancelPull(); MP.pulling = null; render(); return; }
  if (a === 'provider:add') { MP.addOpen = true; MP.err = null; render(); return; }
  if (a === 'provider:closeAdd') { MP.addOpen = false; render(); return; }
  if (a === 'provider:closePick') { MP.pickFor = null; MP.picks = []; render(); return; }
  if (a === 'provider:save') { mpSaveProvider(); return; }
  if (k === 'skillstab') { S.skillsTab = v; render(); return; }
  if (k === 'memtab')    { S.memTab = v; render(); return; }
  if (k === 'appr')      { answer(v); return; }
}

/* ---------------- the run ---------------- */



function pushTool(name, arg, where, args) { S.log.push({id:nid(), k:'tool', name, arg, where, args, ok:null, open:false}); }
function endTool(out, ms) {
  for (let i = S.log.length - 1; i >= 0; i--) {
    if (S.log[i].k === 'tool' && S.log[i].ok === null) { S.log[i].ok = true; S.log[i].out = out; S.log[i].ms = ms; break; }
  }
}

let timer = null, step = 0, ticker = null;
function submit() {
  const e = $('#entry');
  const text = (e ? e.value : S.draft).trim();
  if (!text) return;
  if (text.startsWith('/')) { runSlash(text.slice(1).split(/\s+/)); S.draft = ''; if (e) { e.value = ''; autosize(e); } S.slash = false; render(); return; }
  S.draft = ''; if (e) { e.value = ''; autosize(e); }
  S.slash = false;
  if (S.busy || S.pending) {
    S.queued.push(text);
    S.log.push({id:nid(), k:'system', text:'queued — will reach the agent at the next step boundary'});
    render(); return;
  }
  S.log.push({id:nid(), k:'user', text});
  if (S.live.state !== 'connected') {
    // Nothing may be fabricated. If the agent is not answering, say so.
    S.log.push({id:nid(), k:'system', text: S.live.state === 'starting'
      ? 'the agent is still starting — send this again in a moment'
      : esc(S.live.error || 'no agent is attached, so nothing was run')});
    render();
    return;
  }
  startLiveTurn(text);
}
function answer(key) {
  const req = S.pending;
  if (!req) return;
  answerLive(req, key);
}

function abort() {
  clearTimeout(timer); clearInterval(ticker);
  if (!S.busy && !S.pending) return;
  S.busy = false; S.pending = null;
  S.log.push({id:nid(), k:'system', text:'turn aborted — everything produced so far is kept'});
  render();
}

/* `/analytics on|enable|off|disable|status` (also reached as `/privacy
   analytics …`): every verb opens the Privacy tab so the effect is
   visible; on/off write the value the user typed — the TUI's
   onAnalyticsSetEnabledRequested(true|false) is an absolute
   persistAnalyticsEnabled, never a toggle — and `status` re-reads. A bare
   `/analytics` prints the TUI's usage line. Comparing against the user
   file here would flip the wrong way when analytics.enabled is unset (the
   effective value is then the schema default, true). */
function analyticsSlash(args) {
  const verb = (args[0] || '').toLowerCase();
  if (verb === 'on' || verb === 'enable' || verb === 'off' || verb === 'disable') { act('settings:privacy'); privacySet(verb === 'on' || verb === 'enable'); return; }
  if (verb === 'status') { act('settings:privacy'); privacyRefresh(); return; }
  S.log.push({id:nid(), k:'system', text:'usage: /analytics on | off | status'}); render();
}

function runSlash(parts) {
  const name = parts[0];
  const nav = {chat:'room:chat', tasks:'settings:tasks', task:'tasks:new', skills:'settings:skills', skill:'settings:skills',
    memory:'settings:memory', feed:'insp:steps', world:'insp:world', reasoning:'insp:reasoning', observe:'insp:steps',
    logs:'console:agent', manage:'settings:tasks', mcp:'settings:mcp', llm:'settings:llm', model:'selector:model',
    telegram:'settings:telegram', import:'settings:import', privacy:'settings:privacy', analytics:'settings:privacy',
    theme:'palette:theme', sessions:'session:switch', new:'session:new', clear:'clear', abort:'stop',
    session:'session:id', dump:'dump', tools:'tools', quit:'quit', help:'palette', debug:'toggle:console',
    expand:'cards:expand', collapse:'cards:collapse', mode:'modes', context:'context', sidebar:'toggle:sidebar'};
  if (name === 'run') {
    if (parts[1]) { S.mode = parts[1]; if (parts[2]) { S.share = Math.max(0, Math.min(100, +parts[2])); S.dialShare = S.share; } render(); toast('Run type ' + S.mode); }
    else act('runmode');
    return;
  }
  // Item 7: `/privacy [analytics <verb>]` and `/analytics <verb>` as
  // slash-command-handler.ts dispatchPrivacySub / dispatchAnalyticsSub.
  const rest = parts.slice(1).filter(Boolean);
  if (name === 'privacy' && rest.length) {
    if (rest[0].toLowerCase() === 'analytics') { analyticsSlash(rest.slice(1)); return; }
    S.log.push({id:nid(), k:'system', text:'usage: /privacy | /privacy analytics on|off|status'}); render(); return;
  }
  if (name === 'analytics') { analyticsSlash(rest); return; }
  if (nav[name]) { act(nav[name]); return; }
  S.log.push({id:nid(), k:'system', text:'unknown command /' + esc(name) + ' — ⌘K lists everything'});
  render();
}

/* ---------------- events ---------------- */
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-closemenu]')) { S.menuOpen = null; render(); return; }
  const mb = t.closest('[data-menu]');
  if (mb) { S.menuOpen = S.menuOpen === +mb.dataset.menu ? null : +mb.dataset.menu; render(); return; }
  if (t.closest('[data-popscope]')) { S.scope = null; S.cur = 0; render(); return; }

  // a real control always wins over the dismiss-on-scrim handler behind it
  const a = t.closest('[data-act]'); if (a) { e.preventDefault(); act(a.dataset.act); return; }
  if (t.closest('[data-close]') && !t.closest('.pal, .sheet, .popover, .alertbox')) { act('close'); return; }
  const ap = t.closest('[data-appr]'); if (ap) { answer(ap.dataset.appr); return; }
  const rm = t.closest('[data-room]'); if (rm) { act('room:' + rm.dataset.room); return; }
  const dl = t.closest('[data-del]'); if (dl) { e.preventDefault(); e.stopPropagation(); act('delask:' + dl.dataset.del); return; }
  const ss = t.closest('[data-ses]'); if (ss) { act('ses:' + ss.dataset.ses); return; }
  const grp = t.closest('[data-group]');
  if (grp) { OPEN_GROUPS.add(grp.dataset.group); S.stick = false; render(); return; }
  const fchip = t.closest('[data-file]');
  if (fchip && BR) { BR.openPath(fchip.dataset.file.replace(/^~/, homeDir() || '~')).then((r) => { if (r && r.ok === false) toast('Could not open', r.error || ''); }); return; }
  const mlink = t.closest('[data-url]');
  if (mlink && BR) { e.preventDefault(); BR.openExternal(mlink.dataset.url); return; }
  const tg = t.closest('[data-toggle]');
  if (tg) { const m = S.log.find((x) => x.id === tg.dataset.toggle); if (m) { m.open = !m.open; S.stick = false; render(); } return; }
  const go = t.closest('[data-goto]');
  if (go) { const el = document.getElementById('card-' + go.dataset.goto);
            if (el) { S.stick = false; el.scrollIntoView({block:'center', behavior:'smooth'}); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 400); } return; }
  const fill = t.closest('[data-fill]');
  if (fill) { S.draft = fill.dataset.fill; render(); const en = $('#entry'); if (en) { en.focus(); autosize(en); } return; }
  const pr = t.closest('[data-palrow]'); if (pr) { activatePal(+pr.dataset.palrow); return; }
  const sl = t.closest('[data-slash]'); if (sl) { acceptSlash(sl.dataset.slash); return; }
  const uq = t.closest('[data-unqueue]'); if (uq) { S.queued.splice(+uq.dataset.unqueue, 1); render(); return; }
  const rv = t.closest('[data-revoke]'); if (rv) { S.grants.splice(+rv.dataset.revoke, 1); render(); toast('Grant revoked'); return; }
  const ask = t.closest('[data-ask]'); if (ask) { const q = S.q; act('close'); S.draft = q; render(); submit(); return; }
  const obc = t.closest('[data-ob-choice]');
  if (obc) { OB.choice = +obc.dataset.obChoice; render(); return; }
  const obm = t.closest('[data-ob-model]');
  if (obm) { OB.modelCur = +obm.dataset.obModel; render(); return; }
  const obp = t.closest('[data-ob-provider]');
  if (obp) { OB.modelCur = +obp.dataset.obProvider; render(); return; }
  const ob = t.closest('[data-ob]');
  if (ob) { obAction(ob.dataset.ob); return; }
  const selOpen = t.closest('[data-sel-open]');
  if (selOpen) { openSelector(selOpen.dataset.selOpen); return; }
  const selTab = t.closest('[data-sel-tab]');
  if (selTab) { SEL.kind = selTab.dataset.selTab; SEL.cursor = 0; SEL.filter = ''; SEL.addOpen = false; render(); selEnterModelPane(); return; }
  const selRow = t.closest('[data-sel-row]');
  if (selRow) { selActivate(SEL.rows[+selRow.dataset.selRow]); return; }
  const wizKind = t.closest('[data-wiz-kind]');
  if (wizKind) { WIZ.row = KIND_ROWS[+wizKind.dataset.wizKind]; WIZ.phase = 'configure'; WIZ.error = null; render(); return; }
  const selPreset = t.closest('[data-sel-preset]');
  if (selPreset) { SEL.presetCur = +selPreset.dataset.selPreset; render(); return; }
  const ctxStep = t.closest('[data-ctx-step]');
  if (ctxStep) { ctxAdjust(ctxStep.dataset.ctxStep); return; }
  const modeRow = t.closest('[data-mode]');
  if (modeRow) { setCodingMode(modeRow.dataset.mode); return; }
  const mpPreset = t.closest('[data-preset]');
  if (mpPreset) { MP.presetCur = +mpPreset.dataset.preset; render(); return; }
  const mpUseLocal = t.closest('[data-use-local]');
  if (mpUseLocal) { mpUseLocalModel(mpUseLocal.dataset.useLocal); return; }
  const mpPull = t.closest('[data-pull-local]');
  if (mpPull) { mpPullModel(mpPull.dataset.pullLocal); return; }
  const mpUseProv = t.closest('[data-use-provider]');
  if (mpUseProv) { mpUseProvider(mpUseProv.dataset.useProvider); return; }
  const mpPick = t.closest('[data-pick-models]');
  if (mpPick) { MP.pickFor = mpPick.dataset.pickModels; MP.picks = []; MP.pickQuery = ''; MP.pickErr = null; render(); mpSearch(); return; }
  const mpSet = t.closest('[data-set-model]');
  if (mpSet) { mpSetModel(mpSet.dataset.setModel); return; }
  const md = t.closest('[data-model]');
  if (md) {
    const id = md.dataset.model;
    if (S.modelTab === 'local') S.localModel = id; else if (S.modelTab === 'cloud') S.cloudModel = id;
    render(); toast('Model selected', shortModel(id) + ' · takes effect on the next turn'); return;
  }
  const sk = t.closest('[data-skill]');
  if (sk) { const s = SKILLS.find((x) => x.t === sk.dataset.skill); if (s) { s.on = !s.on; render(); toast(s.t + (s.on ? ' enabled' : ' disabled')); } return; }
  if (t.closest('#composer') && !t.closest('button')) { const en = $('#entry'); if (en) en.focus(); }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'entry') {
    S.draft = e.target.value; autosize(e.target);
    const wasSlash = S.slash;
    S.slash = S.draft.startsWith('/');
    if (S.slash) { S.slashCur = 0; refreshSlash(); }
    else if (wasSlash) render();
    else refreshSend();
    return;
  }
  if (e.target.id === 'palq') { S.q = e.target.value; S.cur = 0; refreshPalette(); return; }
  // Item 7: Tasks tab inputs edit state in place; only the preview block repaints.
  if (e.target.dataset && e.target.dataset.tkField) { tkFieldInput(e.target.dataset.tkField, e.target.value); return; }
  if (e.target.id === 'tk-search') { TK.search = e.target.value; TK.cursor = 0; const at = e.target.selectionStart; tkRepaint();
    const n = $('#tk-search'); if (n) { n.focus(); n.setSelectionRange(at, at); } return; }
  if (e.target.id === 'sel-filter') { SEL.filter = e.target.value; const at = e.target.selectionStart; render();
    const n = document.getElementById('sel-filter'); if (n) { n.focus(); n.setSelectionRange(at, at); } return; }
  if (e.target.id === 'mp-query') {
    MP.pickQuery = e.target.value;
    clearTimeout(MP.searchTimer);
    MP.searchTimer = setTimeout(mpSearch, 350);
    return;
  }
  if (e.target.id === 'modelq') { S.modelQuery = e.target.value; const at = e.target.selectionStart; render();
    const n = $('#modelq'); if (n) { n.focus(); n.setSelectionRange(at, at); } return; }
  if (e.target.id === 'dial') { S.dialShare = +e.target.value; refreshDial(); return; }
});

function refreshSend() {
  const b = document.querySelector('.sendbtn');
  if (b) b.outerHTML = sendButton();
}
function refreshSlash() {
  const c = $('#composer'); if (!c) return;
  const old = c.querySelector('.slash'); if (old) old.remove();
  c.insertAdjacentHTML('afterbegin', slashPopover());
  refreshSend();
}
function refreshPalette() {
  const host = $('#overlays').querySelector('.pal');
  if (!host) return;
  const sel = host.querySelector('#palq').selectionStart;
  const scroll = host.querySelector('.pallist').scrollTop;
  $('#overlays').innerHTML = paletteHTML();
  const q = $('#palq'); if (q) { q.focus(); q.setSelectionRange(sel, sel); }
  const l = $('#pallist'); if (l && !S.q) l.scrollTop = scroll;
  const cur = $('#overlays').querySelector('.palrow.on'); if (cur) cur.scrollIntoView({block:'nearest'});
}
function refreshDial() {
  const wrap = $('#dial') ? $('#dial').parentElement : null;
  if (!wrap) return;
  const n = wrap.querySelector('.mono.tnum'); if (n) n.textContent = S.dialShare;
  const c = wrap.querySelector('.cap'); if (c && S.mode === 'fusion') c.textContent = shareBlurb(S.dialShare);
}

function flatPalRows() {
  const rows = palRows();
  if (rows) return rows;
  const out = [];
  PAL.forEach(([g, r]) => r.forEach((x) => out.push({ic:x[0], t:x[1], cx:x[2], sc:x[3], act:x[4]})));
  return out;
}
function activatePal(i) {
  const rows = flatPalRows();
  const r = rows[i]; if (!r) return;
  if (r.act && r.act.startsWith('scope:')) { act(r.act); return; }
  act(r.act);
}
function acceptSlash(name) {
  S.draft = '/' + name + ' ';
  S.slash = false;
  render();
  const e = $('#entry'); if (e) { e.focus(); e.setSelectionRange(e.value.length, e.value.length); }
}

/* ---------------- keyboard ---------------- */
document.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  const k = e.key;
  const inText = e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT';
  // Item 7: the TUI's ctrl+g menu chords, live everywhere as in the TUI.
  if (chordKey(e, k)) return;

  // approval scope — only while a card is pending and focus is not in a text field
  if (S.pending && !inText && !S.settings && !(S.room === 'tasks' && TK.cancel)) { // Item 7: the settings window (and the Tasks room's cancel modal) own their keys
    const kk = k.toLowerCase();
    if (['y','s','a','n'].includes(kk)) { e.preventDefault(); answer(kk); return; }
    if (k === 'Escape') { e.preventDefault(); answer('esc'); return; }
  }

  const mod = e.metaKey || e.ctrlKey;
  // Item 7: Ctrl+Enter inside the Tasks create form submits the task, not the composer.
  if (mod && k === 'Enter' && e.target.dataset && e.target.dataset.tkField) { e.preventDefault(); tkSubmit(); return; }
  if (mod && !e.shiftKey && !e.altKey) {
    const map = {k:'palette', '1':'room:chat', '2':'room:tasks', '3':'room:skills', '4':'settings:memory',
                 '0':'toggle:sidebar', n:'session:new', o:'session:switch', ',':'settings:tasks',
                 '.':'stop', '/':'shortcuts'};
    if (map[k.toLowerCase()]) { e.preventDefault(); act(map[k.toLowerCase()]); return; }
    if (k === 'Enter') { e.preventDefault(); submit(); return; }
  }
  if (mod && e.shiftKey && k.toLowerCase() === 'y') { e.preventDefault(); act('toggle:console'); return; }
  if (e.ctrlKey && !e.metaKey && k.toLowerCase() === 'r' && !e.shiftKey) {
    e.preventDefault();
    const order = ['local','cloud','fusion'];
    S.mode = order[(order.indexOf(S.mode) + 1) % 3];
    render(); toast('Run type ' + S.mode); return;
  }

  // palette
  if (S.overlay === 'palette') {
    const rows = flatPalRows();
    if (k === 'ArrowDown') { e.preventDefault(); S.cur = Math.min(S.cur + 1, rows.length - 1); refreshPalette(); return; }
    if (k === 'ArrowUp')   { e.preventDefault(); S.cur = Math.max(S.cur - 1, 0); refreshPalette(); return; }
    if (k === 'Enter')     { e.preventDefault(); activatePal(S.cur); return; }
    if (k === 'ArrowRight' && !S.scope) { const r = rows[S.cur]; if (r && r.act.startsWith('scope:')) { e.preventDefault(); act(r.act); } return; }
    if (k === 'Backspace' && S.scope && !S.q) { e.preventDefault(); S.scope = null; S.cur = 0; render(); return; }
    if (k === 'Escape')    { e.preventDefault(); if (S.scope) { S.scope = null; S.cur = 0; render(); } else act('close'); return; }
    return;
  }
  // Item 7: keys inside the settings window (tab cycling, the Tasks tab's hotkeys, Esc).
  if (S.settings && !S.overlay && S.menuOpen === null) {
    if (settingsKey(e, k, inText)) return;
  }
  // Item 7: the Tasks room is the same Tasks tab, so its j/k/n/c/R/r/a/f// keys work there too (no tab-cycling arrows).
  if (!S.settings && !S.overlay && S.menuOpen === null && S.room === 'tasks') {
    if (tasksKey(e, k, inText)) return;
  }
  if (S.overlay || S.settings || S.menuOpen !== null) {
    if (k === 'Escape') { e.preventDefault(); if (S.settings) { S.settings = null; render(); } else act('close'); return; }
    return;
  }

  // slash completion owns the arrows while open
  if (S.slash && e.target.id === 'entry') {
    const m = slashMatches();
    if (k === 'ArrowDown') { e.preventDefault(); S.slashCur = Math.min(S.slashCur + 1, m.length - 1); refreshSlash(); return; }
    if (k === 'ArrowUp')   { e.preventDefault(); S.slashCur = Math.max(S.slashCur - 1, 0); refreshSlash(); return; }
    if (k === 'Tab' || (k === 'Enter' && !e.shiftKey)) { e.preventDefault(); if (m[S.slashCur]) acceptSlash(m[S.slashCur][0]); return; }
    if (k === 'Escape') { e.preventDefault(); S.slash = false; render(); return; }
  }

  if (k === 'Enter' && !e.shiftKey && !e.altKey && e.target.id === 'entry') { e.preventDefault(); submit(); return; }

  if (k === 'Escape') {
    e.preventDefault();
    const sc = $('#scroller');
    if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight > 40) { sc.scrollTop = sc.scrollHeight; S.stick = true; return; }
    if (S.busy) { abort(); return; }
    if (S.toasts.length) { S.toasts.pop(); renderToasts(); return; }
    return;
  }
  if (!inText && k.length === 1 && !mod && S.room === 'chat') { const en = $('#entry'); if (en) en.focus(); }
});

render();
setTimeout(() => { const e = $('#entry'); if (e) e.focus(); }, 60);


/* ============================================================
   Live wiring — everything below talks to the real agent through
   the preload bridge. With no bridge the file above runs unchanged.
   ============================================================ */

function liveLabel() {
  const st = S.live.state;
  if (st === 'connected') return 'agent running · ' + (S.live.llama && S.live.llama.reachable ? 'llama ok' : 'llama down');
  if (st === 'starting') return 'starting the agent…';
  if (st === 'missing-binary') return 'agent not installed';
  if (st === 'error') return 'agent stopped';
  if (st === 'stopped') return BR ? 'agent not started' : 'demo data — no agent attached';
  return 'demo data — no agent attached';
}

function applyStatus(st) {
  if (!st) return;
  const was = S.live.state;
  S.live = Object.assign({}, S.live, st);
  if (S.live.workingDir) WORKSPACE = S.live.workingDir;
  if (S.live.state === 'connected' && was !== 'connected') {
    S.log.push({id:nid(), k:'system', text:'connected to atomic-agent · ' + esc(S.live.workingDir)});
    loadResources();
  }
  if (S.live.state === 'missing-binary' || S.live.state === 'error') {
    S.log.push({id:nid(), k:'system', text: esc(S.live.error || 'the agent stopped')});
  }
  render();
}

async function loadResources() {
  if (!BR) return;
  BR.codingMode().then((res) => {
    if (!res) return;
    MODE.supported = res.supported;
    if (res.ok) { MODE.current = res.mode; MODE.approvalLevel = res.approvalLevel; MODE.baseLevel = res.baseLevel; }
    render();
  });
  const [caps, cfg, skills, tasks, sessions] = await Promise.all([
    BR.capabilities(), BR.config(), BR.skills(), BR.tasks(), BR.sessions(),
  ]);
  if (caps && caps.ok && caps.data) {
    LIVE_CAPS = caps.data;
    if (caps.data.agent && typeof caps.data.agent.approvalLevel === 'number') {
      S.level = Math.max(1, Math.min(5, caps.data.agent.approvalLevel));
      if (S.baseLevel == null) S.baseLevel = S.level;
    }
  }
  if (cfg && cfg.ok && cfg.data && cfg.data.config) {
    LIVE_CONFIG = cfg.data.config;
    const provider = (LIVE_CONFIG.llm && (LIVE_CONFIG.llm.providers || [])
      .find((p) => p.id === LIVE_CONFIG.llm.activeTextProvider)) || null;
    if (provider) {
      S.mode = provider.kind === 'llama-server' ? 'local' : 'cloud';
      if (provider.defaultChatModel) S.cloudModel = provider.defaultChatModel;
    }
    const managed = LIVE_CONFIG.localModels && LIVE_CONFIG.localModels.managed;
    if (managed && managed.modelId) {
      S.localModel = managed.modelId;
      if (!MODELS.local.some((m) => m.id === managed.modelId)) {
        MODELS.local.unshift({id:managed.modelId, q:'managed', size:'—', ctx:String(managed.contextSize || 'auto'),
                              state:'installed', fit:'running on port ' + (managed.port || '?')});
      }
    }
  }
  if (skills && skills.ok && skills.data && Array.isArray(skills.data.skills)) {
    SKILLS.length = 0;
    skills.data.skills.forEach((k) => SKILLS.push({
      t:k.name, s:(k.requiresTools || []).join(' · ') || 'no tools declared',
      v:k.version || '—', on:k.enabled !== false, src:k.source || 'local',
    }));
  }
  if (tasks && tasks.ok && tasks.data && Array.isArray(tasks.data.tasks)) {
    TASKS.length = 0;
    tasks.data.tasks.forEach((t) => TASKS.push({
      id:t.id, t:t.message || t.id, when:t.schedule ? JSON.stringify(t.schedule) : 'once',
      last:t.status || 'pending', st:t.status === 'running' ? 'run' : t.status === 'failed' ? 'bad' : 'ok',
    }));
  }
  if (sessions && sessions.ok && sessions.data && Array.isArray(sessions.data.sessions)) {
    SESSIONS.length = 0;
    sessions.data.sessions.forEach((x, i) => SESSIONS.push({
      id:x.id || ('s' + i), t:x.id, g:'RECENT',
      sub:(x.turnCount ? x.turnCount + (x.turnCount === 1 ? ' turn' : ' turns') : 'session'), st:'',
    }));
    // A session id says nothing. Its first message says what it is about.
    SESSIONS.slice(0, 20).forEach((row) => {
      BR.session(row.id).then((res) => {
        const turns = res && res.ok && res.data && res.data.turns;
        if (!Array.isArray(turns)) return;
        const first = turns.find((t) => t.kind === 'user' && t.text);
        if (!first) return;
        row.t = first.text.trim().replace(/\s+/g, ' ').slice(0, 72);
        render();
      });
    });
    if (SESSIONS[0]) S.sessionId = SESSIONS[0].id;
  }
  render();
}


function startLiveTurn(text) {
  S.history.push({role:'user', content:text});
  S.reasonId = null;
  S.busy = true; S.stick = true; S.elapsed = 0; S.phase = 'Thinking';
  const streaming = {id:nid(), k:'assistant', text:''};
  S.streamId = streaming.id;
  S.log.push(streaming);
  clearInterval(ticker);
  ticker = setInterval(() => {
    S.elapsed++;
    const n = document.querySelector('.statusstrip .tnum');
    if (n) n.textContent = (S.elapsed / 10).toFixed(1) + 's';
  }, 100);
  render();
  // The agent holds the session, so a turn sends the new message and the
  // session id — not a replay of everything said so far.
  BR.chat([{role:'user', content:text}], S.agentSession || undefined).then((res) => {
    if (!res || !res.ok) {
      S.busy = false; clearInterval(ticker);
      S.log.push({id:nid(), k:'system', text:'could not start the turn: ' + esc((res && res.error) || 'unknown error')});
      render();
      return;
    }
    S.turnId = res.turnId;
  });
}

function onChatEvent(ev) {
  if (!ev || ev.turnId !== S.turnId) return;
  const item = S.log.find((m) => m.id === S.streamId);
  // Any frame after a running tool card brackets that tool's wall time as
  // observed here. The trace's own measurement replaces it after the turn.
  for (let i = S.log.length - 1; i >= 0; i--) {
    const c = S.log[i];
    if (c.k === 'tool' && c.ok === null && c.startedAt && !c.observedMs) { c.observedMs = Math.max(1, Date.now() - c.startedAt); break; }
    if (c.k === 'tool') break;
  }

  if (ev.kind === 'session_id') { S.agentSession = pick(ev.payload, 'sessionId', 'session_id', 'id'); return; }
  if (ev.kind === 'reasoning_progress') {
    const text = pick(ev.payload, 'delta', 'text', 'content') || '';
    if (!text) return;
    let block = S.reasonId ? S.log.find((m) => m.id === S.reasonId) : null;
    if (!block) {
      block = {id:nid(), k:'reason', steps:1, open:false, text:''};
      S.reasonId = block.id;
      S.log.splice(S.log.indexOf(item), 0, block);
    }
    block.text += text;
    S.phase = 'Thinking';
    render();
    return;
  }
  if (ev.kind === 'tool_progress') {
    const name = pick(ev.payload, 'tool', 'name') || 'tool';
    if (name === 'reply' || name === 'finish') return;
    // The stream carries the args as `label` (stringified, clipped to 120).
    const arg = pick(ev.payload, 'label') || '';
    const card = {id:nid(), k:'tool', name, arg, ok:null, open:false, args:arg, startedAt:Date.now(), turn:S.turnId};
    S.log.splice(S.log.indexOf(item), 0, card);
    S.phase = name;
    render();
    return;
  }
  if (ev.kind === 'delta') {
    if (item) { item.text += ev.text; S.phase = 'Writing reply'; render(); }
    return;
  }
  if (ev.kind === 'done' || ev.kind === 'finish' || ev.kind === 'aborted' || ev.kind === 'error') {
    if (ev.kind === 'finish') return;
    S.busy = false; S.turnId = null; clearInterval(ticker);
    S.reasonId = null;
    refreshContext();
    reconcileToolCards();
    // Cards stay pending until the session store describes them.
    if (item && item.text) S.history.push({role:'assistant', content:item.text});
    if (item && !item.text) item.text = ev.kind === 'aborted' ? '(stopped)' : '(no reply)';
    if (ev.kind === 'error') S.log.push({id:nid(), k:'system', text:'turn failed: ' + esc(ev.error || '')});
    if (S.queued.length) { const q = S.queued.shift(); S.log.push({id:nid(), k:'user', text:q}); startLiveTurn(q); return; }
    render();
  }
}

function onApprovalEvent(payload) {
  if (!payload || !payload.approvalId) return;
  const affects = Array.isArray(payload.affectedResources) ? payload.affectedResources : [];
  const first = affects[0] || S.live.workingDir || '';
  const cut = String(first).lastIndexOf('/');
  const req = {
    id:nid(), k:'approval',
    approvalId: payload.approvalId,
    tool: payload.tool || 'unknown tool',
    cat: payload.category || 'other',
    kind: CATEGORY_LABEL[payload.category] || payload.category || 'action',
    lvl: (CATS.find((c) => c[0] === payload.category) || [,,5])[2],
    reason: payload.reason || '',
    preview: payload.preview || '(no preview)',
    shape: payload.commandShape || '',
    affectsBase: cut >= 0 ? String(first).slice(cut + 1) : String(first),
    affectsDir: cut >= 0 ? String(first).slice(0, cut + 1) : '',
    sessionGrants: false,
  };
  S.pending = req;
  S.log.push(req);
  S.apprFocused = false;
  S.busy = false;
  render();
}

function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
}
function summariseArgs(args) {
  if (!args) return '';
  if (typeof args === 'string') return args.slice(0, 120);
  const first = Object.values(args)[0];
  return typeof first === 'string' ? first.slice(0, 120) : JSON.stringify(args).slice(0, 120);
}

const CATEGORY_LABEL = {
  fs_write_workspace:'file write · workspace', fs_write_home:'file write · home',
  fs_trash:'move to Trash', http:'HTTP request', shell:'shell command',
  script:'skill script', proc_kill:'process kill', browser_nonweb:'browser · non-web URL',
  trust_config:'agent trust config', other:'uncategorised',
};

function answerLive(req, key) {
  const approve = key === 'y' || key === 's' || key === 'a';
  S.pending = null;
  req.state = approve ? 'approved' : 'denied';
  req.at = new Date().toTimeString().slice(0, 8);
  if (key === 's' || key === 'a') {
    S.log.push({id:nid(), k:'system',
      text:'granted once — session-wide grants are not exposed by the agent\u2019s HTTP API yet, so this behaved as “allow once”.'});
  }
  BR.approve(req.approvalId, approve ? 'allow-once' : 'deny').then((res) => {
    if (res && !res.ok) S.log.push({id:nid(), k:'system', text:'could not resolve the approval: ' + esc(res.error || '')});
    render();
  });
  if (key === 'esc') { S.busy = false; if (S.turnId) BR.cancel(S.turnId); }
  render();
}

if (BR) {
  // Drop the prototype's fake window chrome — macOS draws all of it.
  document.body.classList.add('electron');
  // The mock transcript is demo furniture; a real agent starts clean.
  S.log = [];
  S.history = [];
  BR.onStatus(applyStatus);
  BR.onChat(onChatEvent);
  BR.onApproval(onApprovalEvent);
  BR.onMenu((command) => { if (typeof command === 'string') act(command); });
  BR.onLog((entry) => {
    if (!entry || !entry.line) return;
    LOGS.push([new Date().toTimeString().slice(0, 8), entry.stream === 'stderr' ? 'warn' : 'info', entry.line]);
    if (LOGS.length > 300) LOGS.shift();
    if (S.consoleOpen) renderConsole();
  });
  BR.status().then(applyStatus);

  // Stop routes to the real turn, and the workspace chip opens a picker.
  const originalAct = act;
  act = function (a) {
    if (a === 'stop' && S.turnId) { BR.cancel(S.turnId); S.busy = false; clearInterval(ticker); render(); return; }
    if (a === 'agent:restart') { S.log.push({id:nid(), k:'system', text:'restarting the agent…'}); BR.restart().then(applyStatus); return; }
    if (a === 'workspace' || a === 'workspace:choose') {
      BR.chooseWorkspace().then((dir) => {
        if (!dir) return;
        WORKSPACE = dir;
        S.log.push({id:nid(), k:'system', text:'workspace → ' + esc(dir) + ' · the agent is restarting there'});
        render();
      });
      return;
    }
    return originalAct(a);
  };
  render();
}

/* Hooks used by `electron . --smoke` to drive the app without a human. */
if (typeof window !== 'undefined') {
  window.__live = () => S.live.state;
  window.__skills = () => SKILLS.length;
  window.__ask = (text) => { S.draft = text; const e = $('#entry'); if (e) e.value = text; submit(); };
  window.__lastReply = () => {
    for (let i = S.log.length - 1; i >= 0; i--) if (S.log[i].k === 'assistant') return S.log[i].text || '';
    return '';
  };
}


/* ---- live projections: what the chips read when an agent is attached ---- */
function tok(n) { return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); }
function ctxTotal() {
  const cap = LIVE_CONFIG && LIVE_CONFIG.agent && LIVE_CONFIG.agent.conversationMaxTokens;
  return cap || 128000;
}
function ctxUsed() {
  if (!BR || S.live.state !== 'connected') return 18000;
  // No token accounting over the HTTP API yet: approximate from the
  // transcript so the gauge moves honestly rather than sitting still.
  const chars = S.history.reduce((n, m) => n + m.content.length, 0);
  return Math.round(chars / 4);
}
function activeProvider() {
  if (!LIVE_CONFIG || !LIVE_CONFIG.llm) return null;
  const id = LIVE_CONFIG.llm.activeTextProvider;
  return (LIVE_CONFIG.llm.providers || []).find((p) => p.id === id) || null;
}
function activeModel() {
  if (BR && S.live.state === 'connected') {
    const p = activeProvider();
    if (p && p.kind !== 'llama-server') return p.defaultChatModel || 'no model chosen';
    const managed = (LIVE_CONFIG && LIVE_CONFIG.localModels && LIVE_CONFIG.localModels.managed) || {};
    return managed.modelId || 'not configured';
  }
  return S.mode === 'local' ? S.localModel : S.cloudModel;
}

/* ============================================================
   Setup wizard — the same two steps the TUI runs on a fresh
   install (src/tui/onboarding), with the same copy and the same
   effect on config. It writes through `atag config set`, one
   dotted key at a time, because PATCH /api/config re-defaults
   every block it does not merge.
   ============================================================ */



/** Mirrors decideOnboarding(): completed/skipped wins, then a configured backend. */
function needsOnboarding(cfg) {
  const ob = (cfg && cfg.tui && cfg.tui.onboarding) || {};
  if (ob.completedAt || ob.skippedAt) return false;
  const lm = (cfg && cfg.localModels) || {};
  const managedReady = lm.mode === 'managed' && lm.managed && lm.managed.modelId;
  const localConfigured = (lm.mode === 'external' || lm.mode === 'custom') && lm.url;
  const llm = (cfg && cfg.llm) || {};
  const active = (llm.providers || []).find((p) => p.id === llm.activeTextProvider);
  const cloudReady = !!active && active.kind !== 'llama-server';
  return !(managedReady || localConfigured || cloudReady);
}

function fitFor(sizeLabel, ram) {
  const gb = parseFloat(String(sizeLabel)) || 0;
  const needed = Math.ceil(gb * 1.6);
  if (needed <= ram) return {v:'fits', label:'fits this Mac'};
  if (needed <= ram * 1.4) return {v:'tight', label:'tight on ' + ram + ' GB'};
  return {v:'over', label:'needs about ' + needed + ' GB'};
}

async function openOnboarding() {
  OB.open = true; OB.step = 'choose'; OB.choice = 0; OB.error = null; OB.log = [];
  render();
  if (!BR) return;
  OB.ram = (await BR.hostRam()) || 0;
  OB.keyEnv = (await BR.keyEnv()) || {};
  const cfg = await BR.configGet();
  if (cfg && cfg.ok && cfg.config && cfg.config.llm) {
    OB.providers = (cfg.config.llm.providers || []).map((p) => ({
      id: p.id, kind: p.kind, model: p.defaultChatModel || '', active: p.id === cfg.config.llm.activeTextProvider,
    }));
  }
  render();
}

async function obLoadModels() {
  OB.busy = true; OB.error = null; render();
  const res = await BR.modelsList();
  OB.busy = false;
  if (!res || !res.ok) { OB.error = (res && res.error) || 'could not read the model catalogue'; render(); return; }
  // Embedding models are a separate daemon; the chat wizard does not offer them.
  OB.models = res.models.filter((m) => !/embed|bge|nomic|jina/i.test(m.id));
  OB.modelCur = Math.max(0, OB.models.findIndex((m) => m.active));
  render();
}

async function obFinish(kind, detail) {
  OB.busy = true; render();
  const stamp = new Date().toISOString();
  const writes = [];
  if (kind === 'local') {
    writes.push(['localModels.mode', 'managed']);
    writes.push(['tui.onboarding.localSetupSeenAt', stamp]);
  }
  if (kind === 'cloud') writes.push(['llm.activeTextProvider', detail]);
  if (kind === 'custom') {
    writes.push(['localModels.mode', 'custom']);
    writes.push(['localModels.url', detail]);
  }
  writes.push(['tui.onboarding.introSeenAt', stamp]);
  writes.push([kind === 'skip' ? 'tui.onboarding.skippedAt' : 'tui.onboarding.completedAt', stamp]);
  for (const [key, value] of writes) {
    const res = await BR.configSet(key, value);
    if (res && res.ok === false) {
      OB.busy = false;
      OB.error = 'could not write ' + key + ': ' + (res.error || 'unknown error');
      render();
      return;
    }
  }
  OB.busy = false; OB.open = false;
  toast('Setup complete', kind === 'skip' ? 'You can run it again from the menu' : 'Restarting the agent…');
  render();
  BR.restart().then(applyStatus);
}

function obUseModel(model) {
  if (model.downloaded) {
    OB.busy = true; render();
    BR.modelsUse(model.id).then((res) => {
      OB.busy = false;
      if (res && res.ok === false) { OB.error = res.error || 'could not select the model'; render(); return; }
      obFinish('local', model.id);
    });
    return;
  }
  OB.step = 'pulling'; OB.log = ['downloading ' + model.id + ' · ' + model.size]; OB.pulling = model; render();
  BR.modelsPull(model.id).then((res) => {
    if (res && res.ok === false) { OB.error = res.error || 'could not start the download'; OB.step = 'local'; render(); }
  });
}

function obHTML() {
  const head = (step, title, sub) =>
    '<div class="ob-head">'
    + '<span class="ob-mark">' + MARK_COLOR.replace('width="16" height="16"', 'width="44" height="44"') + '</span>'
    + '<span class="ob-step">' + esc(step === 1 ? 'setup · step 1 of 2' : step) + '</span>'
    + '<span class="ob-title">' + esc(title) + '</span>'
    + (sub ? '<span class="ob-sub">' + esc(sub) + '</span>' : '') + '</div>';
  const err = OB.error ? '<div class="ob-note" style="color:var(--danger)">' + esc(OB.error) + '</div>' : '';

  if (OB.step === 'choose') {
    return '<div id="onboarding"><div class="ob">'
      + head(1, 'Where should the model run?', 'atomic-agent can drive models three ways. Nothing here is permanent — you can add the others at any time from the menu.')
      + '<div class="ob-list">' + OB_CHOICES.map((c, i) =>
          '<button class="ob-opt' + (i === OB.choice ? ' on' : '') + '" data-ob-choice="' + i + '">'
          + '<span class="radio"></span>'
          + '<span><span class="t">' + esc(c.t) + '</span><br><span class="d">' + esc(c.d) + '</span></span>'
          + '<span></span></button>').join('') + '</div>'
      + err
      + '<div class="ob-foot"><button class="btn btn-g" data-ob="skip">Skip for now</button>'
      + '<span class="grow"></span>'
      + '<button class="btn btn-p" data-ob="next">Continue</button></div>'
      + '</div></div>';
  }

  if (OB.step === 'local') {
    const rows = OB.models.length ? OB.models.map((m, i) => {
      const fit = fitFor(m.size, OB.ram);
      return '<button class="ob-opt' + (i === OB.modelCur ? ' on' : '') + '" data-ob-model="' + i + '">'
        + '<span class="radio"></span>'
        + '<span><span class="t mono" style="font-size:13px">' + esc(m.id) + '</span><br>'
        + '<span class="d">' + esc(m.size) + ' · ' + esc(m.context) + ' context · ' + esc(fit.label)
        + (m.downloaded ? ' · already on disk' : '') + '</span></span>'
        + (m.active ? '<span class="tag">Active</span>' : fit.v === 'fits' && !m.downloaded ? '<span class="tag">Recommended</span>' : '<span></span>')
        + '</button>';
    }).join('') : '<div class="ob-note">' + (OB.busy ? 'reading the catalogue…' : 'no models listed') + '</div>';
    return '<div id="onboarding"><div class="ob">'
      + head('local models · step 2 of 2', 'Pick a local model', 'One download, then it runs offline. This machine reports ' + OB.ram + ' GB of RAM.')
      + '<div class="ob-models">' + rows + '</div>' + err
      + '<div class="ob-foot"><button class="btn btn-g" data-ob="back">Back</button>'
      + '<span class="grow"></span>'
      + '<button class="btn btn-p" data-ob="use"' + (OB.busy || !OB.models.length ? ' disabled' : '') + '>'
      + (OB.models[OB.modelCur] && OB.models[OB.modelCur].downloaded ? 'Use this model' : 'Download and use') + '</button></div>'
      + '</div></div>';
  }

  if (OB.step === 'pulling') {
    return '<div id="onboarding"><div class="ob">'
      + head('local models · step 2 of 2', 'Downloading', 'Hugging Face is sending the model. This runs in the background — you can leave it.')
      + '<div class="ob-prog" id="ob-prog">' + esc(OB.log.slice(-8).join('\n')) + '</div>' + err
      + '<div class="ob-foot"><button class="btn btn-s" data-ob="cancel">Cancel</button><span class="grow"></span></div>'
      + '</div></div>';
  }

  if (OB.step === 'cloud') {
    const rows = OB.providers.filter((p) => p.kind !== 'llama-server').map((p, i) =>
      '<button class="ob-opt' + (i === OB.modelCur ? ' on' : '') + '" data-ob-provider="' + i + '">'
      + '<span class="radio"></span>'
      + '<span><span class="t">' + esc(p.id) + '</span><br><span class="d">'
      + esc(p.model || 'configured provider') + ' · key from ' + esc(OB.keyEnv[p.kind] || 'the environment')
      + '</span></span>' + (p.active ? '<span class="tag">Active</span>' : '<span></span>') + '</button>').join('');
    return '<div id="onboarding"><div class="ob">'
      + head('cloud models · step 2 of 2', 'Choose a cloud provider', 'These are the providers already in your config. Keys are read from the environment, not stored here.')
      + '<div class="ob-list">' + (rows || '<div class="ob-note">No cloud provider is configured yet.</div>') + '</div>'
      + '<div class="ob-note">To add one, set its key in your environment — for example '
      + '<span class="mono">export ' + esc(OB.keyEnv.openrouter || 'OPENROUTER_API_KEY') + '=…</span> — then run setup again.</div>'
      + err
      + '<div class="ob-foot"><button class="btn btn-g" data-ob="back">Back</button><span class="grow"></span>'
      + '<button class="btn btn-p" data-ob="useProvider"' + (rows ? '' : ' disabled') + '>Use this provider</button></div>'
      + '</div></div>';
  }

  // custom
  return '<div id="onboarding"><div class="ob">'
    + head('custom endpoint · step 2 of 2', 'Point at your endpoint', 'An OpenAI-compatible or llama-server URL you already run.')
    + '<input class="field-inp" id="ob-url" style="width:100%" placeholder="http://127.0.0.1:8080" value="' + esc(OB.url || '') + '">'
    + err
    + '<div class="ob-foot"><button class="btn btn-g" data-ob="back">Back</button><span class="grow"></span>'
    + '<button class="btn btn-p" data-ob="useUrl">Use this endpoint</button></div>'
    + '</div></div>';
}


function obAction(what) {
  if (what === 'skip') { obFinish('skip', ''); return; }
  if (what === 'back') { OB.step = 'choose'; OB.error = null; render(); return; }
  if (what === 'next') {
    const choice = OB_CHOICES[OB.choice];
    OB.error = null;
    OB.modelCur = 0;
    OB.step = choice.id;
    render();
    if (choice.id === 'local') obLoadModels();
    return;
  }
  if (what === 'use') { const m = OB.models[OB.modelCur]; if (m) obUseModel(m); return; }
  if (what === 'useProvider') {
    const list = OB.providers.filter((p) => p.kind !== 'llama-server');
    const p = list[OB.modelCur];
    if (p) obFinish('cloud', p.id);
    return;
  }
  if (what === 'useUrl') {
    const input = document.getElementById('ob-url');
    const url = (input && input.value.trim()) || '';
    if (!/^https?:\/\/\S+$/.test(url)) { OB.error = 'That does not look like a URL.'; render(); return; }
    OB.url = url;
    obFinish('custom', url);
    return;
  }
  if (what === 'cancel') { BR.cancelPull(); OB.step = 'local'; render(); return; }
}

if (BR) {
  BR.onPull((ev) => {
    if (!ev) return;
    if (ev.line) OB.log.push(ev.line);
    if (ev.done) {
      if (ev.ok && OB.pulling) {
        BR.modelsUse(OB.pulling.id).then(() => obFinish('local', OB.pulling.id));
      } else {
        OB.error = ev.error || 'the download failed';
        OB.step = 'local';
        render();
      }
      return;
    }
    if (OB.open && OB.step === 'pulling') {
      const box = document.getElementById('ob-prog');
      if (box) { box.textContent = OB.log.slice(-8).join('\n'); box.scrollTop = box.scrollHeight; }
    }
  });

  // First run: the wizard opens itself, exactly as the TUI does.
  BR.configGet().then((res) => {
    if (res && res.ok && needsOnboarding(res.config)) openOnboarding();
  });

  const prevAct = act;
  act = function (a) {
    if (a === 'onboarding') { openOnboarding(); return; }
    return prevAct(a);
  };
}


/* ---- Models pane: everything below drives the real agent ---- */

async function mpLoadLocal() {
  if (!BR) return;
  MP.localBusy = true; MP.localErr = null; render();
  const res = await BR.modelsList();
  MP.localBusy = false;
  if (!res || !res.ok) { MP.localErr = (res && res.error) || 'could not read the catalogue'; render(); return; }
  MP.local = res.models.filter((m) => !/embed|bge|nomic|jina/i.test(m.id));
  if (!OB.ram) BR.hostRam().then((r) => { OB.ram = r || 16; render(); });
  render();
}

async function mpUseLocalModel(id) {
  MP.err = null; render();
  const res = await BR.modelsUse(id);
  if (res && res.ok === false) { MP.err = res.error || 'could not switch model'; render(); return; }
  toast('Local model selected', id);
  await mpLoadLocal();
  refreshLiveConfig();
}

function mpPullModel(id) {
  MP.pulling = id; MP.pullLog = ['starting ' + id + '…']; MP.err = null; render();
  BR.modelsPull(id).then((res) => {
    if (res && res.ok === false) { MP.pulling = null; MP.err = res.error || 'could not start the download'; render(); }
  });
}

async function mpUseProvider(id) {
  MP.err = null; MP.busy = true; render();
  const res = await BR.configSet('llm.activeTextProvider', id);
  MP.busy = false;
  if (res && res.ok === false) { MP.err = res.error || 'could not switch provider'; render(); return; }
  toast('Provider selected', id + ' · takes effect on the next turn');
  refreshLiveConfig();
}

async function mpSearch() {
  if (!MP.pickFor) return;
  if (!MP.pickQuery.trim()) { MP.picks = []; MP.pickBusy = false; MP.pickErr = null; render(); return; }
  MP.pickBusy = true; MP.pickErr = null; render();
  const res = await BR.modelsSearch(MP.pickQuery || '', MP.pickFor, 40);
  MP.pickBusy = false;
  if (!res || !res.ok) { MP.pickErr = (res && res.error) || 'search failed'; MP.picks = []; render(); return; }
  MP.picks = res.models || [];
  render();
  const q = document.getElementById('mp-query');
  if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

async function mpSetModel(model) {
  const id = MP.pickFor;
  MP.busy = true; MP.err = null; render();
  const res = await BR.setProviderModel(id, model);
  MP.busy = false;
  if (res && res.ok === false) { MP.err = res.error || 'could not set the model'; render(); return; }
  MP.pickFor = null; MP.picks = [];
  toast('Model selected', id + ' → ' + model);
  refreshLiveConfig();
}

async function mpSaveProvider() {
  const preset = PRESETS[MP.presetCur];
  const keyInput = document.getElementById('mp-key');
  const apiKey = (keyInput && keyInput.value.trim()) || '';
  MP.busy = true; MP.err = null; render();
  const entry = {
    id: preset.id, kind: preset.kind, baseUrl: preset.baseUrl, apiKeyEnvVar: preset.env,
  };
  if (apiKey) entry.apiKey = apiKey;
  if (preset.apiKeyHeader) entry.apiKeyHeader = preset.apiKeyHeader;
  if (preset.headers) entry.headers = preset.headers;
  const res = await BR.upsertProvider(entry);
  MP.busy = false;
  if (res && res.ok === false) { MP.err = res.error || 'could not save the provider'; render(); return; }
  MP.addOpen = false;
  toast('Provider added', preset.label + ' · pick a model with Models…');
  refreshLiveConfig();
}

/** Re-read config so every chip and row reflects what was just written. */
async function refreshLiveConfig() {
  if (!BR) return;
  const cfg = await BR.configGet();
  if (cfg && cfg.ok && cfg.config) LIVE_CONFIG = cfg.config;
  const provider = LIVE_CONFIG && LIVE_CONFIG.llm
    && (LIVE_CONFIG.llm.providers || []).find((p) => p.id === LIVE_CONFIG.llm.activeTextProvider);
  if (provider) {
    S.mode = provider.kind === 'llama-server' ? 'local' : 'cloud';
    if (provider.defaultChatModel) S.cloudModel = provider.defaultChatModel;
  }
  const managed = LIVE_CONFIG && LIVE_CONFIG.localModels && LIVE_CONFIG.localModels.managed;
  if (managed && managed.modelId) S.localModel = managed.modelId;
  render();
}

if (BR) {
  BR.onPull((ev) => {
    if (ev && SEL.pulling) {
      if (ev.line) { SEL.pullLine = ev.line; const box = document.querySelector('.popover .cap'); if (box) box.textContent = ev.line; }
      if (ev.done) {
        const id = SEL.pulling; SEL.pulling = null;
        if (ev.ok) selActivate({type:'localModel', id, downloaded:true});
        else { SEL.err = ev.error || 'the download failed'; render(); }
      }
      return;
    }
    if (!ev || !MP.pulling) return;
    if (ev.line) MP.pullLog.push(ev.line);
    if (ev.done) {
      const id = MP.pulling;
      MP.pulling = null;
      if (ev.ok) { toast('Downloaded', id); mpUseLocalModel(id); }
      else { MP.err = ev.error || 'the download failed'; render(); }
      return;
    }
    const box = document.getElementById('mp-prog');
    if (box) { box.textContent = MP.pullLog.slice(-8).join('\n'); box.scrollTop = box.scrollHeight; }
  });
}

/* Hooks for `electron . --smoke --models`. */
if (typeof window !== 'undefined') {
  window.__pane = (room, tab) => {
    if (room === 'models') { S.settings = 1; S.settingsPane = 'models'; S.modelTab = tab; render(); if (tab === 'local') mpLoadLocal(); }
  };
  window.__mp = () => ({
    local: MP.local.length,
    picks: MP.picks.length,
    firstPick: MP.picks[0] ? MP.picks[0].id : '',
    err: MP.err,
  });
  window.__addProvider = (id) => {
    const i = PRESETS.findIndex((p) => p.id === id);
    if (i < 0) return;
    MP.presetCur = i; MP.addOpen = true; render();
    mpSaveProvider();
  };
  window.__pickModels = (id, query) => { MP.pickFor = id; MP.picks = []; MP.pickQuery = query || ''; render(); mpSearch(); };
  window.__selectFirstModel = () => { if (MP.picks[0]) mpSetModel(MP.picks[0].id); };
}

/* ============================================================
   Model selector — backend → (provider) → model
   ============================================================ */

function selBackend() {
  const p = activeProvider();
  return p && p.kind === 'llama-server' ? 'local' : 'cloud';
}
function selKinds() { return selBackend() === 'local' ? ['backend','model'] : ['backend','provider','model']; }
function selProviders() {
  return ((LIVE_CONFIG && LIVE_CONFIG.llm && LIVE_CONFIG.llm.providers) || [])
    .filter((p) => p.kind !== 'llama-server');
}
function selActiveProviderId() { return LIVE_CONFIG && LIVE_CONFIG.llm && LIVE_CONFIG.llm.activeTextProvider; }

function openSelector(kind) {
  SEL.open = true; SEL.kind = kind || 'backend'; SEL.cursor = 0; SEL.filter = ''; SEL.err = null;
  render();
  if (SEL.kind === 'model') selEnterModelPane();
  if (SEL.kind === 'backend' && selBackend() === 'local' && !SEL.local.length) selLoadLocal();
}
function closeSelector() { SEL.open = false; SEL.addOpen = false; render(); }

async function selLoadLocal() {
  SEL.localBusy = true; render();
  const res = await BR.modelsList();
  SEL.localBusy = false;
  SEL.local = res && res.ok ? res.models.filter((m) => !/embed|bge|nomic|jina/i.test(m.id)) : [];
  if (!OB.ram) OB.ram = (await BR.hostRam()) || 16;
  render();
}

async function selLoadModels(providerId) {
  const entry = selProviders().find((p) => p.id === providerId);
  SEL.modelsFor = providerId; SEL.models = []; SEL.modelsBusy = true; SEL.modelsErr = null; render();
  const res = await BR.providerModels(providerId, (entry && entry.kind) || '');
  SEL.modelsBusy = false;
  if (!res || !res.ok) { SEL.modelsErr = (res && res.error) || 'could not list models'; render(); return; }
  SEL.models = res.models || [];
  render();
}

function selEnterModelPane() {
  if (selBackend() === 'local') { if (!SEL.local.length) selLoadLocal(); return; }
  const id = selActiveProviderId();
  if (id && SEL.modelsFor !== id) selLoadModels(id);
}

/** Rows for the current pane, as objects the delegate can act on by index. */
function selRows() {
  if (SEL.kind === 'backend') {
    const managed = (LIVE_CONFIG && LIVE_CONFIG.localModels && LIVE_CONFIG.localModels.managed) || {};
    const provs = selProviders();
    return [
      {type:'backend', id:'local', label:'local',
       detail: managed.modelId ? 'llama.cpp on this machine · ' + managed.modelId : 'no model downloaded yet',
       active: selBackend() === 'local'},
      {type:'backend', id:'cloud', label:'cloud',
       detail: provs.length ? provs.length + (provs.length === 1 ? ' provider configured' : ' providers configured') : 'add a provider first',
       active: selBackend() === 'cloud'},
    ];
  }
  if (SEL.kind === 'provider') {
    const activeId = selActiveProviderId();
    const rows = selProviders().map((p) => ({
      type:'provider', id:p.id, label:p.id,
      detail: p.kind + ' · ' + (p.defaultChatModel || 'no model chosen')
        + (p.apiKeyEnvVar ? ' · key from ' + p.apiKeyEnvVar : p.apiKey ? '' : ' · no API key'),
      active: p.id === activeId,
    }));
    return rows;
  }
  // model pane
  if (selBackend() === 'local') {
    return SEL.local
      .filter((m) => !SEL.filter || modelMatches(m.id, m.family, SEL.filter))
      .map((m) => {
        const fit = fitFor(m.size, OB.ram || 16);
        return {type:'localModel', id:m.id, label:m.id, downloaded:m.downloaded, active:m.active,
          detail: m.size + ' · ' + m.context + ' context · ' + fit.label + (m.downloaded ? ' · on disk' : '')};
      });
  }
  const entry = selProviders().find((p) => p.id === selActiveProviderId());
  const chosen = entry && entry.defaultChatModel;
  const f = SEL.filter.toLowerCase();
  return SEL.models
    .filter((m) => {
      if (!f) return true;
      const tags = (m.supportsVision ? 'vision ' : '') + (m.supportsTools && m.supportsTools !== 'none' ? 'tools ' : '');
      return modelMatches(m.id, tags, f);
    })
    .map((m) => ({type:'cloudModel', id:m.id, label:m.id, active:m.id === chosen,
      detail: (m.contextWindow ? tok(m.contextWindow) + ' context' : '')
        + (m.supportsTools && m.supportsTools !== 'none' ? ' · tools' : '')
        + (m.supportsVision ? ' · vision' : '')}));
}

async function selActivate(row) {
  if (!row) return;
  if (row.type === 'backend') { selChooseBackend(row.id); return; }
  if (row.type === 'provider') {
    SEL.busy = true; render();
    const res = await BR.configSet('llm.activeTextProvider', row.id);
    SEL.busy = false;
    if (res && res.ok === false) { SEL.err = res.error || 'could not switch provider'; render(); return; }
    await refreshLiveConfig();
    SEL.kind = 'model'; SEL.cursor = 0; SEL.filter = ''; render();
    selLoadModels(row.id);
    return;
  }
  if (row.type === 'cloudModel') {
    // Apply and close first; the config write confirms in the background.
    const pid = selActiveProviderId();
    const entry = selProviders().find((p) => p.id === pid);
    if (entry) entry.defaultChatModel = row.id;
    S.cloudModel = row.id;
    closeSelector();
    BR.setProviderModel(pid, row.id).then((res) => {
      if (res && res.ok === false) toast('Could not select the model', res.error || '');
      refreshLiveConfig();
    });
    return;
  }
  if (row.type === 'localModel') {
    if (!row.downloaded) { selPull(row.id); return; }
    S.localModel = row.id;
    if (LIVE_CONFIG && LIVE_CONFIG.localModels && LIVE_CONFIG.localModels.managed) LIVE_CONFIG.localModels.managed.modelId = row.id;
    closeSelector();
    (async () => {
      const used = await BR.modelsUse(row.id);
      if (used && used.ok === false) { toast('Could not select the model', used.error || ''); refreshLiveConfig(); return; }
      await BR.configSet('llm.activeTextProvider', 'local-llama');
      BR.modelsStart();
      refreshLiveConfig();
    })();
  }
}

function selPull(id) {
  SEL.pulling = id; SEL.pullLine = 'starting…'; SEL.err = null; render();
  BR.modelsPull(id).then((res) => {
    if (res && res.ok === false) { SEL.pulling = null; SEL.err = res.error || 'could not start the download'; render(); }
  });
}

function selectorHTML() {
  const rows = selRows();
  SEL.rows = rows;

  if (SEL.pulling) {
    return selShell('Downloading ' + SEL.pulling,
      '<div class="selbody"><p class="cap">' + esc(SEL.pullLine) + '</p>'
      + '<p class="cap">It is selected automatically when it lands.</p></div>',
      '<button class="btn btn-s" data-act="sel:cancelPull">Cancel</button>');
  }

  // Adding a provider is its own screen: the presets you have NOT
  // configured yet. Mixing it into the provider list is what made
  // "add" feel like another row that led nowhere.
  if (WIZ.phase) return wizardHTML();
  if (SEL.addOpen) {
    const taken = new Set(selProviders().map((p) => p.id));
    const free = PRESETS.filter((p) => !taken.has(p.id));
    return selShell('Add a provider',
      '<div class="selbody">'
      + (free.length
        ? '<div class="sellist">' + free.map((p, i) =>
            '<button class="modelrow' + (i === SEL.presetCur ? ' on' : '') + '" data-sel-preset="' + i + '">'
            + '<span class="radio"' + (i === SEL.presetCur ? ' style="border-color:var(--accent);border-width:4px"' : '') + '></span>'
            + '<span class="col"><span class="nm">' + esc(p.label) + '</span>'
            + '<span class="cap mono">' + esc(p.baseUrl) + '</span></span></button>').join('') + '</div>'
            + '<div style="padding:10px 16px 0"><input class="field-inp" id="sel-key" type="password" style="width:100%" '
            + 'placeholder="API key — blank reads ' + esc((free[SEL.presetCur] || free[0]).env) + '"></div>'
        : '<p class="cap" style="padding:16px">Every preset is already configured.</p>')
      + '</div>',
      '<button class="btn btn-g" data-act="sel:closeAdd">Back</button>'
      + (free.length ? '<button class="btn btn-p" data-act="sel:savePreset">Add provider</button>' : ''));
  }

  const title = SEL.kind === 'backend' ? 'Where it runs'
    : SEL.kind === 'provider' ? 'Provider' : 'Model';

  // An empty list is not a list — it is one action.
  if (!rows.length && !SEL.modelsBusy && !SEL.localBusy && !(SEL.kind === 'model' && SEL.filter)) {
    if (SEL.kind === 'provider') {
      return selShell(title, '<div class="selbody"><p class="cap" style="padding:16px">No cloud provider is configured.</p></div>',
        '<button class="btn btn-p" data-act="sel:add">Add a provider</button>');
    }
    if (SEL.kind === 'model' && selBackend() === 'local') {
      return selShell(title, '<div class="selbody"><p class="cap" style="padding:16px">No local model is downloaded.</p></div>',
        '<button class="btn btn-p" data-act="sel:browseLocal">Download a model</button>');
    }
    return selShell(title, '<div class="selbody"><p class="cap" style="padding:16px">Nothing to show.</p></div>', '');
  }

  const search = SEL.kind === 'model'
    ? '<div class="selsearch"><input class="field-inp" id="sel-filter" style="width:100%" '
      + 'placeholder="search models" value="' + esc(SEL.filter) + '"></div>'
    : '';

  const list = '<div class="sellist">'
    + (SEL.modelsBusy || SEL.localBusy ? '<div class="pad cap">reading the catalogue…</div>' : '')
    + (SEL.modelsErr ? '<div class="pad cap" style="color:var(--danger)">' + esc(SEL.modelsErr) + '</div>' : '')
    + rows.map((r, i) => '<button class="modelrow' + (r.active ? ' on' : '') + '" data-sel-row="' + i + '">'
        + '<span class="radio"' + (r.active ? ' style="border-color:var(--accent);border-width:4px"' : '') + '></span>'
        + '<span class="col"><span class="nm' + (r.type === 'cloudModel' || r.type === 'localModel' ? ' mono' : '') + '">'
        + esc(r.label) + '</span><span class="cap">' + esc(r.detail || '') + '</span></span>'
        + (r.type === 'localModel' && !r.downloaded ? '<span class="cap">download</span>' : '')
        + '</button>').join('')
    + (!rows.length && !SEL.modelsBusy && !SEL.localBusy ? '<div class="pad cap">no models match \u201c' + esc(SEL.filter) + '\u201d</div>' : '')
    + '</div>';

  const foot = SEL.kind === 'provider'
    ? '<button class="btn btn-t" data-act="sel:add">Add a provider</button><button class="btn btn-s" data-act="close">Done</button>'
    : '<button class="btn btn-s" data-act="close">Done</button>';

  return selShell(title, search + list, foot);
}

/** One popup shell: fixed height, its own scroll, anchored to the chip. */
function selShell(title, body, foot) {
  return '<div class="scrim" data-close="1" style="background:transparent">'
    + '<div class="popover selpop" style="' + anchorStyle('.modelchip', 460) + '">'
    + '<div class="selhead">' + esc(title)
    + (SEL.busy ? '<span class="cap" style="margin-left:auto">saving…</span>' : '') + '</div>'
    + body
    + (SEL.err ? '<div class="cap" style="padding:6px 16px;color:var(--danger)">' + esc(SEL.err) + '</div>' : '')
    + (foot ? '<div class="popfoot">' + foot + '</div>' : '')
    + '</div></div>';
}

async function selSavePreset() {
  const preset = PRESETS[SEL.presetCur];
  const input = document.getElementById('sel-key');
  const apiKey = (input && input.value.trim()) || '';
  SEL.busy = true; SEL.err = null; render();
  const entry = {id:preset.id, kind:preset.kind, baseUrl:preset.baseUrl, apiKeyEnvVar:preset.env};
  if (apiKey) entry.apiKey = apiKey;
  if (preset.apiKeyHeader) entry.apiKeyHeader = preset.apiKeyHeader;
  if (preset.headers) entry.headers = preset.headers;
  let res = await BR.upsertProvider(entry);
  if (res && res.ok === false) { SEL.busy = false; SEL.err = res.error || 'could not save the provider'; render(); return; }
  res = await BR.configSet('llm.activeTextProvider', preset.id);
  SEL.busy = false;
  if (res && res.ok === false) { SEL.err = res.error || 'saved, but could not activate it'; render(); return; }
  SEL.addOpen = false;
  await refreshLiveConfig();
  SEL.kind = 'model'; SEL.cursor = 0; render();
  selLoadModels(preset.id);
  toast('Provider added', preset.label);
}

/* ============================================================
   Context gauge — real numbers, measured on the last prompt
   ============================================================ */

async function refreshContext() {
  if (!BR || !S.agentSession) return;
  const stateDir = LIVE_CAPS && LIVE_CAPS.paths && LIVE_CAPS.paths.stateDir;
  if (!stateDir) return;
  const res = await BR.traceUsage(stateDir, S.agentSession);
  if (!res || !res.ok || !res.usage) return;
  Object.assign(CTX, res.usage);
  CTX.window = null; CTX.windowLabel = '';
  const entry = selProviders().find((p) => p.id === selActiveProviderId());
  if (entry && entry.defaultChatModel) {
    const hit = SEL.models.find((m) => m.id === entry.defaultChatModel);
    if (hit && hit.contextWindow) { CTX.window = hit.contextWindow; CTX.windowLabel = 'model window'; }
  }
  if (!CTX.window) {
    const managed = (LIVE_CONFIG && LIVE_CONFIG.localModels && LIVE_CONFIG.localModels.managed) || {};
    if (managed.contextSize) { CTX.window = managed.contextSize; CTX.windowLabel = 'loaded window'; }
    else {
      const row = SEL.local.find((m) => m.id === managed.modelId);
      if (row && row.context) {
        const n = parseFloat(row.context);
        const mult = /m/i.test(row.context) ? 1e6 : /k/i.test(row.context) ? 1000 : 1;
        if (n) { CTX.window = Math.round(n * mult); CTX.windowLabel = 'model max'; }
      }
    }
  }
  render();
}

function contextChip() {
  if (!CTX.tokens) return '';
  const label = CTX.window
    ? tok(CTX.tokens) + '/' + tok(CTX.window)
    : tok(CTX.tokens);
  const pct = CTX.window ? Math.min(100, (CTX.tokens / CTX.window) * 100) : 0;
  return '<button class="cchip ctxbtn" data-act="context" title="context">'
    + (CTX.window ? '<span class="gauge"><i style="width:' + pct + '%"></i></span>' : '')
    + '<span class="tnum gaugelb">' + label + '</span></button>';
}

/* ============================================================
   Coding modes — a projection onto the approval ladder
   ============================================================ */

function currentMode() { return MODE.current; }

function codingModeChip() {
  const id = currentMode();
  const look = CODING_MODES.find((m) => m.id === id) || CODING_MODES[0];
  const colour = look.tone === 'bad' ? 'var(--danger)' : look.tone === 'warn' ? 'var(--warn)'
    : look.tone === 'accent' ? 'var(--accent-text)' : 'var(--success)';
  return '<button class="cchip cmodechip" data-act="modes" title="what the agent may do without asking" '
    + 'style="color:' + colour + '">' + ic('key') + esc(look.label) + ic('chevD') + '</button>';
}

function modesHTML() {
  return '<div class="scrim" data-close="1" style="background:transparent">'
    + '<div class="popover" style="width:360px;' + anchorStyle('.cmodechip', 360) + '">'
    + CODING_MODES.map((m) => {
        const on = m.id === currentMode();
        const off = MODE.supported === false;
        return '<button class="poprow' + (on ? ' on' : '') + (off ? ' dim' : '') + '" data-mode="' + m.id + '">'
          + '<span class="radio"' + (on ? ' style="border-color:var(--accent);border-width:4px"' : '') + '></span>'
          + '<span><span style="font-weight:500">' + esc(m.label) + '</span>'
          + '<span class="cap" style="display:block">' + esc(off ? 'needs an agent with the coding-mode route' : m.detail) + '</span></span>'
          + (on ? '<span class="cap" style="margin-left:auto">current</span>' : '') + '</button>';
      }).join('')
    + '<div style="padding:10px 16px"><p class="cap" style="margin:0">'
    + 'A stance for this session. It moves the live approval ladder and plan flag and writes nothing to config.'
    + '</p></div>'
    + '<div class="popfoot"><button class="btn btn-s" data-act="close">Done</button></div></div></div>';
}

async function setCodingMode(id) {
  if (S.busy) { toast('Not while a turn is running'); return; }
  S.overlay = null; render();
  const res = await BR.codingMode(id);
  if (!res || !res.ok) {
    MODE.supported = res ? res.supported : true;
    S.log.push({id:nid(), k:'system', text: res && res.supported === false
      ? 'coding modes need an agent build that carries /api/coding-mode'
      : 'could not change the mode: ' + esc((res && res.error) || '')});
    render();
    return;
  }
  MODE.supported = true; MODE.current = res.mode; MODE.approvalLevel = res.approvalLevel; MODE.baseLevel = res.baseLevel;
  const look = CODING_MODES.find((m) => m.id === res.mode);
  S.log.push({id:nid(), k:'system', text: esc(look ? look.summary : res.mode)});
  render();
}

if (typeof window !== 'undefined') {
  window.__sel = () => ({open:SEL.open, kind:SEL.kind, rows:SEL.rows.length, backend:selBackend(), err:SEL.err});
  window.__selOpen = (kind) => openSelector(kind);
  window.__selTab = (kind) => { SEL.kind = kind; SEL.cursor = 0; render(); selEnterModelPane(); };
  window.__ctx = () => ({tokens:CTX.tokens, source:CTX.source, window:CTX.window, stablePrefix:CTX.stablePrefix});
  window.__ctxRefresh = () => refreshContext();
  window.__mode = () => currentMode();
}


/**
 * Choosing a backend is a choice, not a step: it picks something usable
 * on that side and applies it. Only when there is nothing to pick does
 * the popup stay open, showing the one action that would fix that.
 */
async function selChooseBackend(id) {
  SEL.err = null;
  const llm = LIVE_CONFIG && LIVE_CONFIG.llm;
  if (id === 'cloud') {
    const provs = selProviders();
    if (!provs.length) { SEL.kind = 'provider'; render(); return; }
    const pick = provs.find((p) => p.id === selActiveProviderId()) || provs[0];
    if (llm) llm.activeTextProvider = pick.id;
    closeSelector();
    BR.configSet('llm.activeTextProvider', pick.id).then((res) => {
      if (res && res.ok === false) toast('Could not switch to cloud', res.error || '');
      refreshLiveConfig();
    });
    return;
  }
  // Local switches at once. A missing model is the model chip's problem,
  // and it reads "not configured" until one is picked.
  if (llm) llm.activeTextProvider = 'local-llama';
  closeSelector();
  const managed = (LIVE_CONFIG && LIVE_CONFIG.localModels && LIVE_CONFIG.localModels.managed) || {};
  BR.configSet('llm.activeTextProvider', 'local-llama').then((res) => {
    if (res && res.ok === false) { toast('Could not switch to local', res.error || ''); refreshLiveConfig(); return; }
    if (managed.modelId) BR.modelsStart();
    refreshLiveConfig();
  });
}

/* ============================================================
   Opening a session — the transcript comes from the agent's store
   ============================================================ */

async function openSession(id) {
  if (!BR || !id) return;
  S.sessionId = id;
  S.room = 'chat';
  S.log = [{id:nid(), k:'system', text:'loading session…'}];
  S.busy = false; S.pending = null; S.stick = true;
  render();

  const res = await BR.session(id);
  if (!res || !res.ok || !res.data) {
    S.log = [{id:nid(), k:'system', text:'could not open that session: ' + esc((res && res.error) || 'unknown error')}];
    render();
    return;
  }
  const data = res.data;
  const turns = Array.isArray(data.turns) ? data.turns : [];
  const log = [];
  turns.forEach((t) => {
    if (t.kind === 'user') { log.push({id:nid(), k:'user', text:t.text || ''}); return; }
    if (t.kind === 'assistant_reply') { log.push({id:nid(), k:'assistant', text:t.text || ''}); return; }
    if (t.kind === 'assistant_tool_call') {
      if (t.reasoning) log.push({id:nid(), k:'reason', steps:1, open:false, text:t.reasoning});
      log.push({id:nid(), k:'tool', name:t.tool || 'tool',
        arg: summariseArgs(t.args), args: JSON.stringify(t.args ?? {}, null, 2),
        where:'local', ok:null, open:false});
      return;
    }
    if (t.kind === 'tool_result') {
      // Pair it with the call that is still open, so a loaded session
      // shows what the tool actually returned — which the live stream
      // does not carry.
      for (let i = log.length - 1; i >= 0; i--) {
        if (log[i].k === 'tool' && log[i].ok === null) {
          log[i].ok = t.status === 'ok';
          log[i].out = t.summary || '';
          log[i].ms = 0;
          return;
        }
      }
      log.push({id:nid(), k:'tool', name:t.tool || 'tool', arg:'', ok:t.status === 'ok', out:t.summary || '', open:false, where:'local'});
    }
  });
  S.log = log.length ? log : [{id:nid(), k:'system', text:'this session has no turns yet'}];
  // Anything sent from here continues that session rather than starting a new one.
  S.agentSession = id;
  S.history = [];
  render();
  refreshContext();
}

async function ctxAdjust(spec) {
  const at = spec.lastIndexOf(':');
  const key = spec.slice(0, at);
  const delta = Number(spec.slice(at + 1));
  const agent = (LIVE_CONFIG && LIVE_CONFIG.agent) || {};
  const current = agent[key.split('.')[1]] || 0;
  const bounds = [1, 100];
  const next = Math.max(bounds[0], Math.min(bounds[1], current + delta));
  if (next === current) return;
  // Write first, then repaint from what the config actually took.
  const res = await BR.configSet(key, String(next));
  if (res && res.ok === false) { toast('Could not change it', res.error || ''); return; }
  await refreshLiveConfig();
}
if (typeof window !== 'undefined') {
  window.__openSession = (id) => openSession(id);
  window.__logLen = () => S.log.length;
  window.__ctxAdjust = (spec) => ctxAdjust(spec);
  window.__ctxRefreshCfg = () => refreshLiveConfig();
  window.__ctxCfg = () => {
    const a = (LIVE_CONFIG && LIVE_CONFIG.agent) || {};
    return {tokens:a.conversationMaxTokens, pairs:a.conversationMaxPairs};
  };
}


/** "claude haiku" matches "claude/haiku", "claude.haiku", "claude-3-haiku": every
    query token must appear once separators are flattened. */
function modelMatches(id, tags, query) {
  const flat = (t) => String(t || '').toLowerCase().replace(/[\/\.\-_:\s]+/g, ' ');
  const hay = flat(id) + ' ' + flat(tags);
  return flat(query).split(' ').filter(Boolean).every((tok) => hay.includes(tok));
}


/* ============================================================
   Add-provider wizard — pick_kind → configure → verifying
   ============================================================ */

function wizardHTML() {
  if (WIZ.phase === 'pick_kind') {
    const taken = new Set(selProviders().map((p) => p.id));
    return selShell('Add a provider',
      '<div class="selbody"><div class="sellist">' + KIND_ROWS.map((k, i) =>
        '<button class="modelrow' + (taken.has(k.id) ? ' dim' : '') + '" data-wiz-kind="' + i + '">'
        + '<span class="col"><span class="nm">' + esc(k.label) + '</span>'
        + '<span class="cap">' + esc(k.custom ? 'you supply the URL' : k.baseUrl || k.kind) + (taken.has(k.id) ? ' \u00b7 already configured' : '') + '</span></span></button>').join('')
      + '</div></div>',
      '<button class="btn btn-g" data-act="wiz:cancel">Cancel</button>');
  }
  const k = WIZ.row;
  const fields = (k.custom
      ? '<label class="cap">Base URL</label><input class="field-inp" id="wiz-url" style="width:100%" placeholder="https://host/v1" value="' + esc(WIZ.baseUrl) + '">'
      : '')
    + '<label class="cap">API key' + (k.env ? ' \u2014 blank reads ' + esc(k.env) : '') + '</label>'
    + '<input class="field-inp" id="wiz-key" type="password" style="width:100%" value="' + esc(WIZ.apiKey) + '">';
  const verifying = WIZ.phase === 'verifying';
  return selShell(k.label,
    '<div class="selbody" style="padding:12px 16px;display:flex;flex-direction:column;gap:8px">' + fields
    + (verifying ? '<p class="cap">checking the key against the provider\u2019s model list\u2026</p>' : '')
    + (WIZ.error ? '<p class="cap" style="color:var(--danger)">' + esc(WIZ.error) + '</p>' : '')
    + '</div>',
    '<button class="btn btn-g" data-act="wiz:back"' + (verifying ? ' disabled' : '') + '>Back</button>'
    + '<button class="btn btn-p" data-act="wiz:next"' + (verifying ? ' disabled' : '') + '>' + (verifying ? 'Verifying\u2026' : 'Next') + '</button>');
}

async function wizNext() {
  const k = WIZ.row; if (!k) return;
  const key = document.getElementById('wiz-key'); WIZ.apiKey = (key && key.value.trim()) || '';
  const url = document.getElementById('wiz-url'); WIZ.baseUrl = (url && url.value.trim()) || '';
  if (k.custom && !/^https?:\/\/\S+$/.test(WIZ.baseUrl)) { WIZ.error = 'That does not look like a URL.'; render(); return; }
  WIZ.phase = 'verifying'; WIZ.error = null; render();

  const id = k.custom ? 'custom-' + WIZ.baseUrl.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '-').slice(0, 32) : k.id;
  const entry = {id, kind:k.kind};
  if (k.baseUrl || k.custom) entry.baseUrl = k.custom ? WIZ.baseUrl : k.baseUrl;
  if (k.env) entry.apiKeyEnvVar = k.env;
  if (WIZ.apiKey) entry.apiKey = WIZ.apiKey;
  if (k.apiKeyHeader) entry.apiKeyHeader = k.apiKeyHeader;
  if (k.headers) entry.headers = k.headers;

  let res = await BR.upsertProvider(entry);
  if (res && res.ok === false) { WIZ.phase = 'configure'; WIZ.error = res.error || 'could not save the provider'; render(); return; }

  // Verification: the provider answers with its model list under this key.
  const listed = await BR.providerModels(id, k.kind);
  if (!listed || !listed.ok || !(listed.models || []).length) {
    WIZ.phase = 'configure';
    WIZ.error = (listed && listed.error) || 'the provider returned no models for this key';
    render();
    return;
  }
  const model = k.defaultModel && listed.models.some((m) => m.id === k.defaultModel) ? k.defaultModel : listed.models[0].id;
  await BR.setProviderModel(id, model);
  await BR.configSet('llm.activeTextProvider', id);
  WIZ.phase = null;
  await refreshLiveConfig();
  closeSelector();
  toast('Provider added', k.label.split(' (')[0] + ' \u00b7 ' + model);
}


/** The transcript, with runs of the same tool folded into one line. */
function renderItems() {
  const items = S.log; let html = '';
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    if (m.k === 'tool') {
      let j = i; while (j + 1 < items.length && items[j + 1].k === 'tool' && items[j + 1].name === m.name) j++;
      const run = items.slice(i, j + 1);
      if (run.length >= 3 && !OPEN_GROUPS.has(m.id)) { html += groupCard(run); i = j; continue; }
    }
    html += item(m);
  }
  return html;
}
function groupCard(run) {
  const m = run[0];
  const ms = run.reduce((n, c) => n + (c.ms || c.observedMs || 0), 0);
  const bad = run.filter((c) => c.ok === false).length;
  const pending = run.some((c) => c.ok === null);
  const glyph = pending ? '<span class="dot run"></span>'
    : bad ? '<span style="color:var(--danger);display:flex">' + ic('warn') + '</span>'
          : '<span style="color:var(--success);display:flex">' + ic('check') + '</span>';
  const previews = run.map((c) => previewArgs(c.args || c.arg)).filter(Boolean);
  return '<div class="turn"><div></div><div><div class="card">'
    + '<button class="cardhead" data-group="' + m.id + '">' + glyph
    + '<span class="nm">' + run.length + ' \u00d7 ' + esc(m.name) + '</span>'
    + '<span class="du tnum">' + (pending ? '\u2026' : dur(ms)) + '</span>'
    + (bad ? '<span class="cap" style="color:var(--danger)">' + bad + ' failed</span>' : '')
    + '<span class="ar">' + esc(previews.slice(0, 3).join(' \u00b7 ') + (previews.length > 3 ? ' \u2026' : '')) + '</span>'
    + '<span class="ter" style="display:flex">' + ic('chevR') + '</span></button>'
    + '</div></div></div>';
}

/** After a turn, the session store has what the stream never carried:
    the args, the result, and both timestamps. */
async function reconcileToolCards(attempt = 0) {
  if (!BR || !S.agentSession) return;
  const cards = S.log.filter((m) => m.k === 'tool');
  if (!cards.length) return;
  const res = await BR.session(S.agentSession);
  const turns = res && res.ok && res.data && Array.isArray(res.data.turns) ? res.data.turns : null;
  const calls = [];
  if (turns) {
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (t.kind !== 'assistant_tool_call') continue;
      // The cards skip the loop's own reply/finish tools; the store must too,
      // or the newest call is always `reply` and nothing ever matches.
      if (t.tool === 'reply' || t.tool === 'finish') continue;
      let result = null;
      for (let j = i + 1; j < turns.length; j++) {
        if (turns[j].kind === 'tool_result') { result = turns[j]; break; }
        if (turns[j].kind === 'assistant_tool_call') break;
      }
      calls.push({call:t, result});
    }
  }
  const newest = calls[calls.length - 1];
  const pendingCards = cards.filter((c) => c.ok === null);
  const landed = newest && newest.result && newest.call.tool === cards[cards.length - 1].name
    && newest.call.at >= (cards[cards.length - 1].startedAt || 0) - 5000;
  if (!landed && attempt < 8) {
    // 300ms, 600ms, 1.2s … ≈ 6s in total
    setTimeout(() => reconcileToolCards(attempt + 1), 300 * Math.pow(2, Math.min(attempt, 4)));
    return;
  }
  for (let c = cards.length - 1, k = calls.length - 1; c >= 0 && k >= 0; c--, k--) {
    const card = cards[c], {call, result} = calls[k];
    if (call.tool !== card.name) break;
    card.args = call.args || card.args;
    if (result) {
      card.ok = result.status === 'ok';
      card.out = result.summary || '';
      card.truncated = !!result.truncated;
      if (call.at && result.at) card.ms = Math.max(0, result.at - call.at);
    }
  }
  // Whatever the store still does not describe is finished, just unmeasured.
  pendingCards.forEach((c) => { if (c.ok === null) { c.ok = true; c.out = c.out || ''; } });
  render();
}

/** Escaped prose with files as chips and URLs as links. */
function renderProse(text) {
  const URL_RE = /(?<![\w.])(?:https?:\/\/|www\.)[^\s<>"']+/g;
  const FILE_RE = /(?<![\w\/])((?:~|\/)(?:[\w.@+-]+\/)*[\w.@+-]+\.[A-Za-z0-9]{1,6})(?![\w\/])/g;
  let html = esc(text);
  html = html.replace(URL_RE, (u) => {
    const trail = (u.match(/[.,;:!?)\]}>"'\u00bb]+$/) || [''])[0];
    const core = u.slice(0, u.length - trail.length);
    const href = core.startsWith('www.') ? 'https://' + core : core;
    return '<a class="msglink" href="#" data-url="' + href + '">' + core + '</a>' + trail;
  });
  html = html.replace(FILE_RE, (p) => {
    const name = p.split('/').pop();
    return '<button class="filechip" data-file="' + p + '" title="' + p + '">' + ic('doc') + '<span>' + name + '</span></button>';
  });
  return html;
}
function homeDir() {
  const wd = S.live.workingDir || '';
  return wd.startsWith('/Users/') ? wd.split('/').slice(0, 3).join('/') : '';
}
document.addEventListener('contextmenu', (e) => {
  const f = e.target.closest && e.target.closest('[data-file]');
  if (!f || !BR) return;
  e.preventDefault();
  BR.fileMenu(f.dataset.file.replace(/^~/, homeDir() || '~'));
});

/* Hooks for --smoke. */
if (typeof window !== 'undefined') {
  window.__modeState = () => ({supported:MODE.supported, current:MODE.current});
  window.__search = (q) => { SEL.filter = q; return selRows().length; };
  window.__wizOpen = () => { WIZ.phase = 'pick_kind'; WIZ.row = null; render(); return {rows:KIND_ROWS.length, selected:document.querySelectorAll('[data-wiz-kind].on').length}; };
  window.__storeDiag = async () => {
    if (!BR || !S.agentSession) return 'no session';
    const r = await BR.session(S.agentSession);
    const turns = (r && r.ok && r.data && r.data.turns) || [];
    return JSON.stringify({session:S.agentSession, turns:turns.length, tail:turns.slice(-6).map((t) => ({kind:t.kind, tool:t.tool, at:t.at, status:t.status}))});
  };
  window.__cards = () => S.log.filter((m) => m.k === 'tool').map((m) => ({
    name:m.name,
    args: typeof (m.args || m.arg) === 'string' ? (m.args || m.arg) : JSON.stringify(m.args || m.arg || ''),
    ms: m.ms || m.observedMs || 0, ok: m.ok,
    live: !!m.startedAt,   // born on the stream this run, as opposed to loaded from the store
  }));
  window.__pushAssistant = (t) => { S.log.push({id:nid(), k:'assistant', text:t}); render(); return document.querySelectorAll('.filechip').length; };
}

/* ============================================================
   Item 7 — settings surface: menu dispatch, the Tasks tab, keys
   ============================================================ */

/* A menu node: a Manage tab switches the panel; every other verb is the
   desktop act it already has, run with the settings window closed. */
function menuActivate(id) {
  let node = null;
  MENU_GROUPS.forEach(([, nodes]) => nodes.forEach((n) => {
    if (n.id === id) node = n;
    (n.sub || []).forEach((c) => { if (c.id === id) node = c; });
  }));
  if (!node || node.na) return;
  // A Manage node from the ctrl+g chord layer opens the window; from the menu column it is already open.
  if (node.tab) { const opened = !S.settings; S.settings = 1; S.settingsPane = node.tab; render(); settingsPaneEntered(opened); return; }
  const target = MENU_ACTS[id];
  if (!target) return;
  if (!target.startsWith('settings:')) S.settings = null;
  act(target);
}

/* ---- Tasks tab: src/tui/components/tasks-*.tsx, tasks-summary.ts, tasks-filter.ts ---- */

function formatScheduleLabel(schedule) {
  if (!schedule) return '-';
  if (schedule.kind === 'at') return 'at ' + formatUnixMs(schedule.at);
  if (schedule.kind === 'cron') return 'cron: ' + schedule.expression + (schedule.tz ? ' (' + schedule.tz + ')' : '');
  return 'every ' + formatIntervalMs(schedule.everyMs);
}
function formatUnixMs(ms) {
  if (!Number.isFinite(ms)) return '-';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function formatIntervalMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ms + 'ms';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + 'm';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + 'h';
  return Math.round(hours / 24) + 'd';
}
function formatRelativeMs(target, now) {
  if (target === null || target === undefined) return '-';
  const deltaMs = target - now;
  const abs = Math.abs(deltaMs);
  if (abs < 1000) return 'now';
  return (deltaMs >= 0 ? 'in ' : '') + formatIntervalMs(abs) + (deltaMs >= 0 ? '' : ' ago');
}
function tkTrunc(text, max) { text = String(text); return text.length <= max ? text : text.slice(0, max - 1) + '…'; }
function tkShortId(id) { return id.length <= 10 ? id : id.slice(0, 10) + '…'; }

/* toTaskSummaryRow — the record as GET /api/tasks returns it (recordToJson). */
function tkRow(t) {
  const collapsed = String(t.userMessage || '').replace(/\s+/g, ' ').trim();
  return {
    id:t.id, status:t.status || 'pending', origin:t.origin || '—', triggerSource:t.triggerSource || null,
    sessionId:t.sessionId || null,
    userMessage: collapsed.length <= 96 ? collapsed : collapsed.slice(0, 95) + '…',
    scheduleKind: t.schedule ? t.schedule.kind : null, scheduleLabel: formatScheduleLabel(t.schedule || null),
    recurring: !!t.recurring, scheduledFor: typeof t.scheduledFor === 'number' ? t.scheduledFor : null,
    createdAt:t.createdAt, updatedAt:t.updatedAt, startedAt:t.startedAt ?? null, completedAt:t.completedAt ?? null,
    attempts:t.attempts ?? 0, maxAttempts:t.maxAttempts ?? 0, lastError:t.lastError || null,
  };
}
function tkVisibleRows() {
  const needle = TK.search.trim().toLowerCase();
  return TK.rows.filter((row) => {
    if (TK.filter === 'recurring' ? !row.recurring : (TK.filter !== 'all' && row.status !== TK.filter)) return false;
    if (!needle) return true;
    return row.userMessage.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle)
      || (row.sessionId !== null && row.sessionId.toLowerCase().includes(needle));
  }).sort((a, b) => {
    const aDue = a.scheduledFor ?? Number.POSITIVE_INFINITY, bDue = b.scheduledFor ?? Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;
    return b.createdAt - a.createdAt;
  });
}
function tkSelected() {
  const rows = tkVisibleRows();
  if (!rows.length) return null;
  return rows[Math.max(0, Math.min(TK.cursor, rows.length - 1))];
}
function tasksVisible() {
  return (S.settings && settingsPaneId(S.settingsPane) === 'tasks') || (!S.settings && S.room === 'tasks');
}
/* tasks-orchestrator.ts: refresh every 5 000 ms while the tab is open, limit 200. */
function ensureTasksPoll() {
  if (!BR) return;
  if (!TK.primed) { TK.primed = true; setTimeout(() => tasksRefresh(), 0); }
  if (TK.timer) return;
  TK.timer = setInterval(() => {
    // Tab hidden: stop polling; the next opening gets one immediate load again.
    if (!tasksVisible()) { clearInterval(TK.timer); TK.timer = null; TK.primed = false; return; }
    if (TK.auto) tasksRefresh(true);
  }, 5000);
}
function tkTyping() {
  const el = document.activeElement;
  return !!el && (el.id === 'tk-search' || (el.dataset && el.dataset.tkField));
}
async function tasksRefresh(quiet) {
  if (!BR || TK.loading) return;
  TK.loading = true; TK.err = null;
  if (!quiet) tkRenderKeepCaret();
  const before = JSON.stringify([TK.rows, TK.err]);
  const res = await BR.tasks();
  TK.loading = false;
  if (res && res.ok && res.data && Array.isArray(res.data.tasks)) {
    TK.rows = res.data.tasks.slice(0, 200).map(tkRow);
    TK.lastRefreshedAt = Date.now();
    // The sidebar count reads TASKS; keep it in step with what the tab shows.
    TASKS.length = 0;
    res.data.tasks.forEach((t) => TASKS.push({
      id:t.id, t:t.userMessage || t.id, when:t.schedule ? formatScheduleLabel(t.schedule) : 'once',
      last:t.status || 'pending', st:t.status === 'running' ? 'run' : t.status === 'failed' ? 'bad' : 'ok',
    }));
  } else {
    TK.err = 'tasks refresh failed: ' + ((res && res.error) || 'unknown error');
  }
  // A poll must not steal the caret from the search box or the create form,
  // nor the focus from a hint/kind button: unchanged rows repaint only the
  // filter bar's "refresh: auto (Ns ago)" text; changed rows repaint the
  // tab in place and put the focus back on the same button.
  if (quiet) {
    if (tkTyping()) return;
    if (before === JSON.stringify([TK.rows, TK.err])) { tkRefreshBar(); return; }
    tkRepaintKeepFocus();
    return;
  }
  tkRenderKeepCaret();
}
/* The Tasks list's filter bar only (the `refresh: auto (Ns ago)` clock);
   skipped while the `/` search input lives inside it. */
function tkRefreshBar() {
  if (TK.mode !== 'list' || TK.searchOpen) return;
  const box = S.settings ? document.querySelector('#settings .setbody') : document.querySelector('#content .tuiwrap');
  const bar = box && box.querySelector('.tuibar');
  if (!bar) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = tkFilterBar(tkVisibleRows().length);
  bar.replaceWith(tmp.firstElementChild);
}
/* Repaint the Tasks tab in place and keep the focus on the button (by its
   data-act) the user was on. With nothing focused inside the window a full
   render() also refreshes the tab suffix and the sidebar count. */
function tkRepaintKeepFocus() {
  const el = document.activeElement;
  const box = S.settings ? document.querySelector('#settings .setbody') : document.querySelector('#content .tuiwrap');
  const focused = el && box && box.contains(el) && el.dataset ? el.dataset.act : null;
  if (!focused) { render(); return; }
  tkRepaint();
  const again = box.querySelector('[data-act="' + focused.replace(/"/g, '\\"') + '"]');
  if (again) again.focus();
}

function tasksTab() {
  ensureTasksPoll();
  if (TK.mode === 'create') return tkFormHTML();
  if (TK.mode === 'detail') return tkDetailHTML();
  return tkListHTML();
}

function tkStatusClass(status) {
  return {running:'st-running', completed:'st-completed', failed:'st-failed', blocked:'st-blocked', cancelled:'st-cancelled'}[status] || 'st-pending';
}
function tkFilterBar(visibleCount) {
  const now = Date.now();
  const mode = TK.auto ? 'auto' : 'manual';
  let refresh;
  if (TK.lastRefreshedAt === null) refresh = mode + ' (never)';
  else {
    const seconds = Math.floor(Math.max(0, now - TK.lastRefreshedAt) / 1000);
    refresh = seconds < 1 ? mode + ' (just now)' : seconds < 60 ? mode + ' (' + seconds + 's ago)' : mode + ' (' + Math.floor(seconds / 60) + 'm ago)';
  }
  const search = TK.searchOpen
    ? '  ·  /<input id="tk-search" value="' + esc(TK.search) + '" placeholder="" autocomplete="off" spellcheck="false">'
    : TK.search.length ? '  ·  /' + esc(TK.search) : '';
  return '<div class="tuibar"><b>Tasks</b><span class="ter">  filter: ' + esc(TK.filter) + '  ·  ' + visibleCount + '/' + TK.rows.length
    + search + '  ·  refresh: ' + esc(refresh) + (TK.loading ? '  ·  loading…' : '') + '</span></div>';
}
function tkMessages() {
  return (TK.msg ? '<div class="tuimsg">' + esc(TK.msg) + '</div>' : '')
    + (TK.msg && TK.note ? '<div class="ter">' + esc(TK.note) + '</div>' : '')
    + (TK.err ? '<div class="tuierr">! ' + esc(TK.err) + '</div>' : '');
}
function tkCancelModal() {
  if (!TK.cancel) return '';
  return '<div class="tuimodal warn"><b style="color:var(--warn)">cancel ' + (TK.cancel.isRecurring ? 'recurring ' : '') + 'task?</b>'
    + '<div><span class="ter">id:</span> ' + esc(TK.cancel.taskId) + '</div>'
    + '<div class="tuihint" style="margin-top:2px"><span>this stops all future firings.</span>'
    + '<button data-act="tasks:cancelConfirm">y = confirm</button><span>·</span><button data-act="tasks:cancelKeep">n / Esc = keep</button></div></div>';
}
function tkHint(key, label, act) {
  return '<button data-act="' + act + '">' + esc(key + ' ' + label) + '</button><span>·</span>';
}
function tkListHTML() {
  const rows = tkVisibleRows();
  const now = Date.now();
  const cur = Math.max(0, Math.min(TK.cursor, rows.length - 1));
  let body;
  if (!rows.length) {
    body = '<div class="ter" style="padding:10px 0">no tasks match the current filter — press `n` to create one, `f` to cycle filter, `r` to refresh.</div>';
  } else {
    // tasks-list.tsx:37-41: window the rows around the cursor (row-window.ts
    // computeWindowStart) and say how many are hidden above / below. The
    // hidden-count lines are buttons here (a page up / page down for the
    // mouse) — the TUI reaches them with j/k only.
    const start = computeWindowStart(cur, rows.length, TK_MAX_ROWS);
    const page = rows.slice(start, start + TK_MAX_ROWS);
    const hiddenBefore = start;
    const hiddenAfter = Math.max(0, rows.length - start - page.length);
    body = '<div class="tuihead">  status   schedule               next-run       session   message</div>'
      + (hiddenBefore > 0 ? '<button class="tuimore" data-act="tasks:page:up">↑ ' + hiddenBefore + ' above</button>' : '')
      + page.map((row, idx) => {
        const i = idx + start;
        const sel = i === cur;
        return '<button class="tuirow' + (sel ? ' on' : '') + '" data-task-row="' + esc(row.id) + '" data-act="tasks:detail:' + esc(row.id) + '">'
          // TaskRow: `{chevron} {status(9)}{schedule(22)} {next(14)} {session(10)}{message}` — no
          // separator after the status or session cells, so the columns sit under the header.
          + (sel ? '▸' : ' ') + ' <span class="' + tkStatusClass(row.status) + '">' + esc(row.status.padEnd(9)) + '</span>'
          + '<span class="ter">' + esc(tkTrunc(row.scheduleLabel, 22).padEnd(22) + ' ' + formatRelativeMs(row.scheduledFor, now).padEnd(14) + ' '
            + (row.sessionId ? tkShortId(row.sessionId) : '—').padEnd(10)) + '</span>'
          + esc(tkTrunc(row.userMessage, 64)) + '</button>';
      }).join('')
      + (hiddenAfter > 0 ? '<button class="tuimore" data-act="tasks:page:down">↓ ' + hiddenAfter + ' below</button>' : '');
  }
  const hints = '<div class="tuihint"><span>j/k move</span><span>·</span><span>Enter detail</span><span>·</span>'
    + tkHint('n', 'new', 'tasks:new') + tkHint('c', 'cancel', 'tasks:cancel') + tkHint('R', 'run-now', 'tasks:run')
    + tkHint('r', 'refresh', 'tasks:refresh') + tkHint('a', 'auto', 'tasks:auto') + tkHint('f', 'filter', 'tasks:filter')
    + tkHint('/', 'search', 'tasks:search') + '<button data-act="tasks:clearSearch">Esc clear search</button></div>';
  return '<div class="tui">' + tkFilterBar(rows.length) + tkMessages() + tkCancelModal() + body + hints + '</div>';
}
function tkDetailHTML() {
  const row = TK.rows.find((r) => r.id === TK.detailId);
  if (!row) {
    return '<div class="tui"><div style="color:var(--warn);padding:10px 0">task ' + esc(TK.detailId || '?') + ' not found in the current snapshot. Press Esc to return to the list.</div>'
      + '<div class="tuihint"><button data-act="tasks:back">Esc back</button></div></div>';
  }
  const now = Date.now();
  const id = row.id;
  return '<div class="tui">' + tkMessages() + tkCancelModal()
    + '<div><b>' + esc(id) + '</b><span class="ter">  ·  ' + esc(row.origin) + '</span></div>'
    + '<div><span class="ter">status:</span> ' + esc(row.status) + '  <span class="ter">schedule:</span> ' + esc(row.scheduleLabel) + (row.recurring ? ' (recurring)' : '') + '</div>'
    + '<div><span class="ter">next-run:</span> ' + esc(formatRelativeMs(row.scheduledFor, now)) + ' <span class="ter">(' + esc(row.scheduledFor !== null ? formatUnixMs(row.scheduledFor) : '-') + ')</span></div>'
    + '<div><span class="ter">attempts:</span> ' + row.attempts + '/' + row.maxAttempts + '  <span class="ter">session:</span> ' + esc(row.sessionId ?? '—') + '</div>'
    + '<div class="ter">created: ' + esc(formatUnixMs(row.createdAt)) + ' · updated: ' + esc(formatUnixMs(row.updatedAt))
      + (row.completedAt !== null ? ' · completed: ' + esc(formatUnixMs(row.completedAt)) : '') + '</div>'
    + '<div class="ter" style="margin-top:8px">message:</div><div>' + esc(row.userMessage) + '</div>'
    + (row.lastError ? '<div class="tuierr" style="margin-top:8px">last error: ' + esc(row.lastError) + '</div>' : '')
    + '<div class="ter" style="margin-top:8px">recent firings:</div>'
    // The TUI builds this feed in-process by diffing records between ticks; the HTTP API has no such surface.
    + '<div class="ter">(firings are not exposed by the agent\'s HTTP API)</div>'
    + '<div class="tuihint">' + tkHint('o', 'open session', 'tasks:open:' + esc(id)) + tkHint('R', 'run-now', 'tasks:run:' + esc(id))
      + tkHint('c', 'cancel', 'tasks:cancel:' + esc(id)) + '<button data-act="tasks:back">Esc back</button></div>'
    + '</div>';
}
function tkNewForm() {
  return {kind:'cron', cronExpression:'', intervalSeconds:'', atIsoOrMs:'', tz:'', message:'',
          preview:{ok:false, error:null, nextFirings:[]}, submitting:false, error:null, timer:null};
}
function tkFormHTML() {
  const f = TK.form || (TK.form = tkNewForm());
  const label = (l) => '<span class="mk"></span><span class="lb"> ' + esc(l.padEnd(10)) + ': </span>';
  const field = (l, name, value, placeholder) =>
    '<div class="tkrow">' + label(l) + '<input data-tk-field="' + name + '" value="' + esc(value) + '" placeholder="' + esc(placeholder) + '" autocomplete="off" spellcheck="false"></div>';
  const expr = f.kind === 'cron' ? field('cron', 'cronExpression', f.cronExpression, '0 * * * * (standard 5-field cron)')
    : f.kind === 'interval' ? field('every (s)', 'intervalSeconds', f.intervalSeconds, '300')
    : field('at', 'atIsoOrMs', f.atIsoOrMs, '2026-05-01T09:00:00Z or Unix-ms');
  const canSubmit = f.preview.ok && !f.submitting;
  return '<div class="tui"><div class="tuimodal"><b>new task</b>'
    + '<div class="tkrow">' + label('kind') + ['cron','interval','at'].map((k, i) =>
        (i ? '<span class="ter"> / </span>' : '') + '<button class="tkkind' + (f.kind === k ? ' on' : '') + '" data-act="tasks:kind:' + k + '">' + k + '</button>').join('') + '</div>'
    + expr
    + (f.kind === 'cron' ? field('tz', 'tz', f.tz, '(optional, e.g. Europe/Berlin)') : '')
    + field('message', 'message', f.message, 'what should the agent do when this fires?')
    + '<div id="tk-preview">' + tkPreviewHTML(f) + '</div>'
    + '<div class="tuihint"><button data-act="tasks:submit"' + (canSubmit ? ' style="color:var(--success)"' : ' disabled') + '>Ctrl+Enter submit</button>'
      + '<span>  · Tab next · Shift+Tab back · </span><button data-act="tasks:back">Esc cancel</button>' + (f.submitting ? '<span> · submitting…</span>' : '') + '</div>'
    + '</div></div>';
}
function tkPreviewHTML(f) {
  if (f.error) return '<div class="tuierr" style="margin-top:8px">error: ' + esc(f.error) + '</div>';
  if (f.preview.error) return '<div class="tuierr" style="margin-top:8px">error: ' + esc(f.preview.error) + '</div>';
  if (!f.preview.nextFirings.length) return '<div class="ter" style="margin-top:8px">(preview unavailable)</div>';
  return '<div class="ter" style="margin-top:8px">next firings:</div>'
    + f.preview.nextFirings.map((ms) => '<div class="ter">· ' + esc(formatUnixMs(ms)) + '</div>').join('')
    // Item 7: honest degradation on 0.5.4 — the desktop cannot reach TaskRunner.create, only the CLI.
    // The desktop submits through `atag task create --at`; on agent 0.5.4 that CLI path writes the
    // one-shot through the bare TaskStore with no next-run (scheduled_for NULL), which the scheduler
    // treats as due now — the row will show next-run "-" and be picked up at the next tick. The TUI
    // creates in-process through TaskRunner.create and keeps the `at`; the desktop says so instead
    // of pretending.
    + (f.kind === 'at' ? '<div class="ter" style="margin-top:8px">' + esc(tkAtNote('the time above')) + '</div>' : '');
}
/* The same caveat, worded for the preview ("the time above") and for the
   success line/toast after submit ("the `at` time"). */
function tkAtNote(when) {
  return 'note: on agent 0.5.4 `atag task create --at` stores no next-run for a one-shot, so the scheduler picks it up at its next tick (the row shows next-run "-"), not at ' + when + '.';
}
function tkFieldInput(name, value) {
  const f = TK.form || (TK.form = tkNewForm());
  f[name] = value; f.error = null;
  clearTimeout(f.timer);
  f.timer = setTimeout(() => tkPreview(), 250);
}
/* The preview is the agent's own validator + cron-parser, run in the main process. */
async function tkPreview() {
  const f = TK.form; if (!f || !BR) return null;
  const res = await BR.taskPreview({kind:f.kind, cronExpression:f.cronExpression, intervalSeconds:f.intervalSeconds, atIsoOrMs:f.atIsoOrMs, tz:f.tz, message:f.message});
  if (TK.form !== f) return null;
  if (!res || res.ok === false) { f.preview = {ok:false, error:(res && res.error) || 'preview failed', nextFirings:[]}; }
  else f.preview = res.preview;
  const box = document.getElementById('tk-preview');
  if (box && !tkTyping()) render();
  else if (box) { box.innerHTML = tkPreviewHTML(f); const b = document.querySelector('[data-act="tasks:submit"]'); if (b) { b.disabled = !(f.preview.ok && !f.submitting); b.style.color = f.preview.ok ? 'var(--success)' : ''; } }
  return res;
}
/* Submit: validate like the TUI, then `atag task create` (POST /api/tasks
   on 0.5.4 takes no schedule). Success line is the TUI's runtime_info. */
async function tkSubmit() {
  const f = TK.form; if (!f || !BR || f.submitting) return {ok:false, error:'no form'};
  f.error = null;
  const v = await tkPreview();
  if (!v || v.ok === false || !v.schedule) return {ok:false, error:(f.preview && f.preview.error) || 'invalid'};
  f.submitting = true; render();
  const sc = v.schedule;
  const expression = sc.kind === 'cron' ? sc.expression : sc.kind === 'interval' ? String(sc.everyMs / 1000) : String(sc.at);
  const res = await BR.taskCreate({message:v.message, kind:sc.kind, expression, tz:sc.kind === 'cron' ? (sc.tz || '') : ''});
  f.submitting = false;
  if (!res || !res.ok) { f.error = (res && res.error) || 'task create failed'; render(); return {ok:false, error:f.error}; }
  TK.msg = 'task ' + res.id + ' scheduled (' + sc.kind + ')';
  // The TUI's success line stays verbatim; a one-shot carries the 0.5.4 caveat under it and in the toast.
  TK.note = sc.kind === 'at' ? tkAtNote('the `at` time') : null;
  toast('Task scheduled', TK.msg + (TK.note ? ' — ' + TK.note : ''));
  TK.mode = 'list'; TK.form = null;
  await tasksRefresh();
  return {ok:true, id:res.id};
}
/* Cancel: DELETE /api/tasks/{id}; the lines are the TUI orchestrator's. */
async function tkCancel(id) {
  if (!BR) return;
  const res = await BR.cancelTask(id);
  TK.note = null;
  if (res && res.ok) {
    const after = res.data || {};
    TK.msg = after.status === 'cancelled' ? 'task ' + id + ' cancelled' : 'task ' + id + ' already ' + after.status + ' (cannot cancel)';
  } else {
    const msg = (res && res.error) || 'unknown error';
    TK.msg = /not found/i.test(msg) ? 'task ' + id + ' not found' : 'cancel ' + id + ' failed: ' + msg;
  }
  TK.cancel = null;
  await tasksRefresh();
}
/* Run-now: POST /api/tasks/{id}/run, one attempt, synchronous on the agent. */
async function tkRunNow(id) {
  if (!BR) return;
  TK.msg = 'task ' + id + ' running…'; TK.note = null; tkRenderKeepCaret();
  const res = await BR.runTask(id);
  if (res && res.ok) {
    const t = res.data && res.data.task;
    TK.msg = t ? 'task ' + id + ' run complete (status=' + t.status + ')' : 'task ' + id + ' skipped (already claimed or vanished)';
  } else {
    TK.msg = 'run-now ' + id + ' failed: ' + ((res && res.error) || 'unknown error');
  }
  await tasksRefresh();
}
function tasksAct(what) {
  const [verb, ...rest] = what.split(':');
  const arg = rest.join(':');
  const sel = () => arg || (TK.mode === 'detail' ? TK.detailId : (tkSelected() || {}).id);
  if (verb === 'new') { if (!S.settings && S.room !== 'tasks') { S.settings = 1; S.settingsPane = 'tasks'; } TK.mode = 'create'; TK.form = tkNewForm(); TK.msg = null; render(); return; }
  if (verb === 'kind') { const f = TK.form || (TK.form = tkNewForm()); f.kind = arg; f.error = null; render(); tkPreview(); return; }
  if (verb === 'submit') { tkSubmit(); return; }
  if (verb === 'back') { TK.mode = 'list'; TK.form = null; TK.cancel = null; render(); return; }
  if (verb === 'detail') { TK.detailId = arg; const rows = tkVisibleRows(); const i = rows.findIndex((r) => r.id === arg); if (i >= 0) TK.cursor = i; TK.mode = 'detail'; render(); return; }
  if (verb === 'open') {
    const row = TK.rows.find((r) => r.id === sel());
    if (!row) { TK.msg = 'task ' + sel() + ' not found'; render(); return; }
    if (!row.sessionId) { TK.msg = 'task ' + row.id + ' has no session yet (one-shot not picked up)'; render(); return; }
    S.settings = null; TK.mode = 'list'; openSession(row.sessionId); return;
  }
  if (verb === 'cancel') {
    const id = sel(); if (!id) return;
    const row = TK.rows.find((r) => r.id === id);
    if (row && row.recurring) { TK.cancel = {taskId:id, isRecurring:true}; render(); return; }
    tkCancel(id); return;
  }
  if (verb === 'cancelConfirm') { if (TK.cancel) tkCancel(TK.cancel.taskId); return; }
  if (verb === 'cancelKeep') { TK.cancel = null; render(); return; }
  if (verb === 'run') { const id = sel(); if (id) tkRunNow(id); return; }
  if (verb === 'refresh') { tasksRefresh(); return; }
  if (verb === 'page') { const n = tkVisibleRows().length; TK.cursor = Math.max(0, Math.min(TK.cursor + (arg === 'up' ? -TK_MAX_ROWS : TK_MAX_ROWS), n - 1)); render(); return; }
  if (verb === 'auto') { TK.auto = !TK.auto; render(); return; }
  if (verb === 'filter') { TK.filter = TK_FILTER_ORDER[(TK_FILTER_ORDER.indexOf(TK.filter) + 1) % TK_FILTER_ORDER.length]; TK.cursor = 0; render(); return; }
  if (verb === 'search') { TK.searchOpen = true; render(); const n = $('#tk-search'); if (n) n.focus(); return; }
  if (verb === 'clearSearch') { TK.searchOpen = false; TK.search = ''; TK.cursor = 0; render(); return; }
}

/* The Tasks tab's keys (tasks-key-bindings.ts), shared by the settings
   window and the Tasks room. Returns true when the key was consumed;
   Escape falls through once there is no modal, form or search to clear. */
function tasksKey(e, k, inText) {
  const tkField = inText && e.target.dataset && e.target.dataset.tkField;
  if (k === 'Escape') {
    if (TK.cancel) { e.preventDefault(); TK.cancel = null; render(); return true; }
    if (TK.mode !== 'list') { e.preventDefault(); TK.mode = 'list'; TK.form = null; render(); return true; }
    if (TK.searchOpen || TK.search) { e.preventDefault(); TK.searchOpen = false; TK.search = ''; render(); return true; }
    return false;
  }
  if (tkField && (e.metaKey || e.ctrlKey) && k === 'Enter') { e.preventDefault(); tkSubmit(); return true; }
  if (e.target.id === 'tk-search' && k === 'Enter') { e.preventDefault(); TK.searchOpen = false; render(); return true; }
  if (inText) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (TK.cancel) {
    if (k === 'y') { e.preventDefault(); tkCancel(TK.cancel.taskId); return true; }
    if (k === 'n') { e.preventDefault(); TK.cancel = null; render(); return true; }
    return true;
  }
  if (TK.mode === 'detail') {
    if (k === 'o') { e.preventDefault(); tasksAct('open'); return true; }
    if (k === 'R') { e.preventDefault(); tasksAct('run'); return true; }
    if (k === 'c') { e.preventDefault(); tasksAct('cancel'); return true; }
    if (k === 'r') { e.preventDefault(); tasksAct('refresh'); return true; }
    return false;
  }
  if (TK.mode !== 'list') return false;
  const rows = tkVisibleRows();
  if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); TK.cursor = Math.min(TK.cursor + 1, Math.max(0, rows.length - 1)); render(); return true; }
  if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); TK.cursor = Math.max(TK.cursor - 1, 0); render(); return true; }
  if (k === 'Enter') { e.preventDefault(); const r = tkSelected(); if (r) tasksAct('detail:' + r.id); return true; }
  const map = {n:'new', c:'cancel', R:'run', r:'refresh', a:'auto', f:'filter', '/':'search'};
  if (map[k]) { e.preventDefault(); tasksAct(map[k]); return true; }
  return false;
}

/* Keys inside the settings window. ←/→ and [ ] cycle the Manage tabs as
   cycleSubTab does; the Tasks tab's letters are tasksKey above. */
function settingsKey(e, k, inText) {
  const pane = settingsPaneId(S.settingsPane);
  if (pane === 'tasks' && tasksKey(e, k, inText)) return true;
  if (k === 'Escape') { e.preventDefault(); S.settings = null; render(); return true; }
  if (inText) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  // The open create form owns its keys even when focus sits on one of its
  // buttons: no tab cycling behind a half-filled form (the TUI's Esc closes
  // the form first, and so does this window's).
  if (pane === 'tasks' && TK.mode === 'create') return false;
  // privacy-panel.tsx keys: `a` toggles analytics, `r` re-reads the config.
  if (pane === 'privacy') {
    if (k === 'a') { e.preventDefault(); privacyToggle(); return true; }
    if (k === 'r') { e.preventDefault(); privacyRefresh(); return true; }
  }
  if (k === 'ArrowLeft' || k === 'ArrowRight' || k === '[' || k === ']') {
    e.preventDefault();
    const ids = SETTINGS_TABS.map((t) => t[0]);
    const dir = (k === 'ArrowRight' || k === ']') ? 1 : -1;
    S.settingsPane = ids[(ids.indexOf(pane) + dir + ids.length) % ids.length];
    render(); settingsPaneEntered(false); return true;
  }
  return false;
}
/* The ctrl+g chord layer, run before every other key: ctrl+g arms the
   prefix, the next key (exact case — `L` is LLM logs, `l` is LLM) runs the
   menu node carrying that chord, as menu-popup.tsx does. Returns true when
   the event was consumed. */
function chordKey(e, k) {
  if (CHORD.pending) {
    if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return true; // modifiers on the way to `M`
    e.preventDefault();
    clearTimeout(CHORD.timer); CHORD.pending = false; CHORD.timer = null;
    let hit = null;
    MENU_GROUPS.forEach(([, nodes]) => nodes.forEach((n) => {
      if (n.chord === k) hit = n;
      (n.sub || []).forEach((c) => { if (c.chord === k) hit = c; });
    }));
    if (hit) { if (hit.na) toast(hit.label, 'not available in the desktop'); else menuActivate(hit.id); }
    return true;
  }
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && k.toLowerCase() === 'g') {
    e.preventDefault();
    CHORD.pending = true;
    clearTimeout(CHORD.timer);
    CHORD.timer = setTimeout(() => { CHORD.pending = false; CHORD.timer = null; }, 1500);
    return true;
  }
  return false;
}

/* Repaint only the Tasks tab (the settings body or the Tasks room) —
   the search box keeps its caret and the window is not rebuilt. */
function tkRepaint() {
  const box = S.settings ? document.querySelector('#settings .setbody') : document.querySelector('#content .tuiwrap');
  if (!box) { render(); return; }
  box.innerHTML = tasksTab();
}
/* row-window.ts computeWindowStart, verbatim. */
function computeWindowStart(cursor, total, size) {
  if (size <= 0) return 0;
  if (total <= size) return 0;
  if (cursor < size) return 0;
  return Math.min(cursor - size + 1, total - size);
}
/* Render after an await that may land while the user is typing in the Tasks
   search box or create form: repaint the tab in place and put the caret back
   where it was instead of rebuilding the window around the input. */
function tkRenderKeepCaret() {
  const el = document.activeElement;
  if (!tkTyping()) { render(); return; }
  const id = el.id, field = el.dataset ? el.dataset.tkField : null;
  const at = el.selectionStart, end = el.selectionEnd;
  tkRepaint();
  const n = id ? document.getElementById(id) : (field ? document.querySelector('[data-tk-field="' + field + '"]') : null);
  if (!n) return;
  n.focus();
  if (typeof at === 'number') { try { n.setSelectionRange(at, end); } catch (e) { /* select/checkbox: no caret */ } }
}

/* Hooks for --smoke (Item 7: settings surface). */
if (typeof window !== 'undefined') {
  window.addEventListener('error', () => { ERR_COUNT++; });
  window.addEventListener('unhandledrejection', () => { ERR_COUNT++; });
  window.__menuGroups = () => MENU_GROUPS.map((g) => g[0]);
  window.__settingsTabs = () => SETTINGS_TABS.map((t) => t[0]);
  window.__settingsLabels = () => [...document.querySelectorAll('#settings .settab')].map((b) => b.textContent.replace(/\s*\((\d+|up|down)\)$/, '').trim());
  window.__settingsOpen = (id) => { act('settings:' + id); return settingsPaneId(S.settingsPane); };
  window.__settingsPane = () => (S.settings ? settingsPaneId(S.settingsPane) : null);
  window.__settingsClose = () => { act('settings:close'); };
  window.__settingsBody = () => (document.querySelector('#settings .setbody') || {}).innerText || '';
  window.__errCount = () => ERR_COUNT;
  window.__tasksRows = () => TK.rows.length; // rows loaded from GET /api/tasks?limit=200 (the tab label's N)
  window.__tasksWindow = () => ({painted: document.querySelectorAll('#settings [data-task-row]').length, visible: tkVisibleRows().length, max: TK_MAX_ROWS,
    above: (document.querySelector('#settings [data-act="tasks:page:up"]') || {}).textContent || '', below: (document.querySelector('#settings [data-act="tasks:page:down"]') || {}).textContent || ''});
  window.__tasksSearch = (q) => { TK.search = q; TK.searchOpen = false; TK.cursor = 0; render(); return tkVisibleRows().map((r) => r.id); };
  window.__tasksMsg = () => TK.msg || '';
  window.__tasksRefresh = () => tasksRefresh();
  window.__tasksAct = (what) => { tasksAct(what); return {cancel: TK.cancel ? Object.assign({}, TK.cancel) : null, mode: TK.mode, msg: TK.msg || ''}; };
  window.__taskCreate = (fields) => { TK.mode = 'create'; TK.form = Object.assign(tkNewForm(), fields); render(); return tkSubmit(); };
  window.__privacy = () => ({analyticsEnabled: privacyEffective(), fromConfig: !!(LIVE_CONFIG && LIVE_CONFIG.analytics && typeof LIVE_CONFIG.analytics.enabled === 'boolean')}); // effective value, as the TUI shows it
  window.__chordPending = () => CHORD.pending;
  window.__tasksNote = () => TK.note || '';
  window.__skillListCalls = () => SK.calls;
  window.__privacyToggle = () => privacyToggle();
  window.__privacySet = (on) => privacySet(on).then(() => privacyEffective()); // the slash verbs' write path
  window.__privacyIdle = () => !PRIV.busy && PRIV.pending === 0; // no analytics write queued or in flight
  window.__runSlash = (line) => { runSlash(String(line).replace(/^\//, '').split(/\s+/)); }; // exactly what Enter on a `/…` composer line does
  window.__settingsStripRows = () => new Set([...document.querySelectorAll('#settings .settab')].map((b) => b.offsetTop)).size; // 1 = the TUI's single-line strip
  window.__menuNodes = () => {
    const out = [];
    MENU_GROUPS.forEach(([group, nodes]) => nodes.forEach((n) => {
      out.push({group, id:n.id, label:n.label, chord:n.chord || null, na:!!n.na, tab:n.tab || null, parent:!!n.sub});
      (n.sub || []).forEach((c) => out.push({group, id:c.id, label:c.label, chord:c.chord || null, na:!!c.na, tab:c.tab || null, parent:false}));
    }));
    return out;
  };
  window.__menuActivate = (id) => { menuActivate(id); return {settings: !!S.settings, pane: S.settings ? settingsPaneId(S.settingsPane) : null, inspector: S.inspector, inspTab: S.inspTab}; };
  window.__diag = () => ({line: diagLine(), session: S.agentSession, toolsFor: SET.toolsFor, health: SET.health});
  window.__skillCount = () => (SK.rows ? SK.rows.length : null);
  window.__taskPreviewForm = async (fields) => { TK.mode = 'create'; TK.form = Object.assign(tkNewForm(), fields); render(); await tkPreview(); return TK.form ? TK.form.preview : null; };
}

/* Hook for --smoke (harness: the tool-card turn runs in a fresh session).
   `session:new` alone is not enough: with no session_id the agent derives
   `api-<sha256(system + first user message)>` (src/http/openai-session-id.ts),
   so the same smoke prompt re-enters the same ever-growing session. A
   client-supplied id creates an empty one (openai-chat-completions.ts
   resolveSession). */
if (typeof window !== 'undefined') {
  window.__sessionNew = () => { act('session:new'); S.agentSession = 'smoke-' + Date.now().toString(16) + '-' + Math.floor(Math.random() * 1e6).toString(16); return S.agentSession; };
}
