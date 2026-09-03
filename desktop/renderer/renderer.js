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
/* Lane B — context before the first message (item 3). `source` is
   'provider' | 'estimate' (the trace, after a turn), 'built' (the branch
   route's own prompt), or 'projected' — the turn-0 scaffold of the last
   prompt this agent built in this workspace plus the draft's estimate,
   always drawn with a '~' and the word "projected" until something real
   replaces it. `previewSupported` caches the route's 404 per connection
   the way MODE.supported does; `seq` drops a refresh that lost the race. */
const CTX = { tokens:0, source:null, stablePrefix:0, tail:0, draftTokens:0, cacheHitTokens:null, modelId:null,
  window:null, windowLabel:'', baseline:null, sections:null, pairsCap:0, reserved:0,
  previewSupported:null, seq:0, chipTimer:null };
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
  // Lane B — backend switch: the TUI's third choice, a custom endpoint, is
  // not offered here. The TUI probes the URL (checkLlamaServer, verifyAuth)
  // and then writes mode external + url + the local-llama provider url in
  // ONE whole-file write (persistUserRemoteLlmUrls); the desktop has no
  // probe, and a leaf write of localModels.url would leave the provider
  // entry pointing at the managed port. Rather than write an unverified
  // URL, the option stays out until the probe exists — set it up from the
  // TUI (`atag`).
];
/* Lane B — backend switch. What the chips and rows read while a switch
   runs in main: `line` is the popup's status text, `readyIds` the cloud
   providers with a usable key (the TUI's hasApiKey), `localLoaded`
   whether the local catalogue snapshot has landed — the model chip only
   says "download model" once it has, as the TUI's does — and `readyLoaded`
   whether the key facts have landed at all: until they have, the rows say
   "checking keys…" rather than a "no API key" that is not known yet. */
const BSW = { line:'', readyIds:[], readyLoaded:false, localLoaded:false, gating:false };

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

const dur = (ms) => ms == null ? '…' : ms + 'ms';   // item 4: as the TUI prints it (tool-card.tsx), never X.Xs
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
  ['privacy','analytics opt-out + approval level','level 1..5 | analytics on|off'],
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
const LEVEL_NAMES = ['','Paranoid','Workspace','Home','Operator','Full trust'];


/* palette catalogue — every row has a menu-bar home */
const PAL = [
  ['Go', [
    ['chat','Chat','Session','⌘ 1','room:chat'],
    ['inspector','Feed','Observe','/feed','insp:steps'],
    ['atom','World','Observe','/world','insp:world'],
    ['bolt','Reasoning','Observe','/reasoning','insp:reasoning'],
    ['console','Logs','Console','/logs','console:agent'],
    ['tasks','Tasks','Library','⌘ 2','room:tasks'],
    ['skills','Skills','Library','⌘ 3','room:skills'],
    ['gear','Settings','Settings','⌘ ,','settings:general'],
    ['key','Privacy & Approvals','Settings','⇧ ⌘ ,','settings:privacy'],
    ['cloud','Models & Providers','Settings','/llm','settings:models'],
  ]],
  ['Session', [
    ['plus','New session','keeps warm runtime','⌘ N','session:new'],
    ['x','Clear transcript','keeps session','⌘ ⌫','clear'],
    ['copy','Show session id','','⌃ ⌘ C','copy:session'],
  ]],
  ['Model', [
    ['cloud','Switch chat model…','pull | use | status','⇧ ⌘ M','settings:models'],
  ]],
  ['Run', [
    ['stop','Abort turn','','⌘ .','stop'],
    ['chevD','Expand all tool cards','','⌥ ⌘ E','cards:expand'],
    ['chevR','Collapse all tool cards','','⌥ ⌘ K','cards:collapse'],
  ]],
  ['Setup', [
    ['gear','Theme…','','','scope:theme'],
    ['skills','Enable or disable a skill…','','','room:skills'],
    ['key','Approval level…','1..5','','scope:level'],
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
  settings:null, settingsPane:'general',
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
    ;
}

/* ---------------- content ---------------- */
function renderContent() {
  const c = $('#content');
  if (S.room === 'chat') {
    // Scroll-stable cards: a whole-DOM render replaces #scroller, so remember
    // where the old one was and hand it to afterChat (same capture-then-restore
    // as refreshPalette does for .pallist). Nothing to keep while stuck to the
    // bottom — afterChat snaps there anyway.
    const prev = $('#scroller');
    const keep = prev && !S.stick ? prev.scrollTop : null;
    c.innerHTML = chatView(); afterChat(keep); return;
  }
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
  if (m.k === 'reason') return '<div class="turn" id="turn-' + m.id + '"><div></div><div>'
    + '<button class="disc" data-toggle="' + m.id + '">' + ic(m.open ? 'chevD' : 'chevR') + 'Reasoning · ' + m.steps + ' steps</button>'
    + (m.open ? '<div class="discbody">' + esc(m.text) + '</div>' : '') + '</div></div>';
  if (m.k === 'tool') return '<div class="turn" id="turn-' + m.id + '"><div></div><div>' + toolCard(m) + '</div></div>';
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
      // item 4: the number is the agent's own (trace) once the turn is stored; while it runs, or
      // until the store lands, the wall time this window observed. The TUI prints a fabricated
      // 0ms for a store-rebuilt card (turns-to-messages.ts); the user rejected that zero, so a card
      // with no trace row prints nothing and says so in the tooltip.
      + '<span class="du tnum" title="' + (running ? 'running'
          : m.msSource === 'trace' ? 'measured by the agent (trace): tool result minus the model completion of that step, including parse and any approval wait \u2014 the same interval the TUI shows'
          : m.observedMs ? 'wall time observed by this window, from the call frame to the next frame'
          : 'no trace for this call') + '">'
      + (running ? '\u2026' : m.msSource === 'trace' ? dur(m.ms) : m.observedMs ? dur(m.observedMs) : '') + '</span>'
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
        // Lane B — backend switch: the TUI's ComposerMetaControls renders
        // no model control when there is no model (cloud provider without
        // a chatModel, or local before the snapshot lands); the pane stays
        // reachable through the provider chip and the backend rows.
        + modelChipHtml()
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

function afterChat(keep) {
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
    // Scroll-stable cards: a scrolled-up user is put back at the same pixel
    // after a whole-DOM render (streaming deltas, reconcileToolCards, expand
    // all). Deliberate divergence from the TUI: its chatScrollOffset is
    // bottom-anchored (src/tui/tui-state.ts:614-621, chat-log.tsx:66-75) so its
    // view slides as the tail grows; the desktop holds the pixel position
    // because the user asked for the scroll not to move. The desktop still
    // resets to the bottom exactly where the TUI does: turn start
    // (reducer-helpers.ts:176 <-> startLiveTurn), session switch
    // (reduce-ui-actions.ts:414 <-> openSession) and Esc (app-key-bindings.ts:505
    // / tui-app.tsx:1327 <-> the Escape branch of the keydown handler).
    else if (keep != null) sc.scrollTop = keep;
  }
  if (S.pending && !S.apprFocused) { const d = $('#denybtn'); if (d) { d.focus(); S.apprFocused = true; } }
}
function autosize(e) { e.style.height = 'auto'; e.style.height = Math.min(e.scrollHeight, 180) + 'px'; }

/* ---- Scroll-stable cards ----
   Fold or unfold one transcript entry in place. The scroller is not rebuilt
   and scrollTop is not written, so everything above the entry — its own head
   included — stays where it was on screen. Same rule as the TUI's
   tool_expand_toggled reducer (src/tui/reduce-ui-actions.ts:58-67), which
   touches toolsExpandedById only and never chatScrollOffset.
   Deliberate divergence from the TUI's bottom-anchored offset: the TUI surface
   is pinned to the bottom (tui-state.ts:614-621, chat-log.tsx:66-75), so there a
   toggle keeps the BOTTOM edge fixed and lets the head move up; the desktop
   keeps the HEAD still, which is what the user asked for. S.stick is therefore
   recomputed from geometry instead of copied from the TUI (which leaves
   chatScrollOffset untouched on tool_expand_toggled): a body that now extends
   below the fold means the user is no longer at the bottom, so expanding the
   tail card mid-turn stops auto-follow until Esc (the Escape branch of the
   keydown handler, the desktop twin of the TUI's 'Esc to jump to latest')
   restores it. That is also what keeps reconcileToolCards' delayed render()
   from snapping to the bottom under an expanded card.
   Chromium's own scroll anchoring is off for .scroller (overflow-anchor:none in
   styles.css) so it cannot stack on top of the residual-drift correction. */
function repaintEntry(m, anchorSel) {
  const sc = $('#scroller');
  const old = document.getElementById('turn-' + m.id);
  if (!sc || !old) { render(); return; }
  const before = (old.querySelector(anchorSel) || old).getBoundingClientRect().top;
  old.outerHTML = item(m);
  const fresh = document.getElementById('turn-' + m.id);
  const anchor = fresh && (fresh.querySelector(anchorSel) || fresh);
  const drift = anchor ? anchor.getBoundingClientRect().top - before : 0;
  // Nothing above the entry changed, so drift is 0 unless the browser clamped
  // scrollTop (a collapse near the end of the transcript). Correct what it can.
  if (Math.abs(drift) > 0.5) sc.scrollTop += drift;
  S.stick = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40;
}

/* Unfold a run of same-tool cards into its members, keeping the head where it is.
   The run computation must stay byte-identical to renderItems or the members
   and the fold would disagree. */
function expandGroupInPlace(id) {
  const sc = $('#scroller');
  const old = document.getElementById('group-' + id);
  const i = S.log.findIndex((x) => x.id === id);
  if (!sc || !old || i < 0) { render(); return; }
  let j = i; while (j + 1 < S.log.length && S.log[j + 1].k === 'tool' && S.log[j + 1].name === S.log[i].name) j++;
  const before = (old.querySelector('.cardhead') || old).getBoundingClientRect().top;
  old.outerHTML = S.log.slice(i, j + 1).map(item).join('');
  const head = document.querySelector('#turn-' + id + ' .cardhead');
  const drift = head ? head.getBoundingClientRect().top - before : 0;
  if (Math.abs(drift) > 0.5) sc.scrollTop += drift;
  S.stick = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40;
}

/* ---------------- rooms ---------------- */
function segControl(items, cur, actPrefix) {
  return '<div class="seg">' + items.map(([id, label]) =>
    '<button class="' + (cur === id ? 'on' : '') + '" data-act="' + actPrefix + id + '">' + esc(label) + '</button>').join('') + '</div>';
}

function tasksView() {
  const filtered = TASKS.filter((t) => S.taskFilter === 'all'
    || (S.taskFilter === 'running' && t.st === 'run')
    || (S.taskFilter === 'failed' && t.st === 'bad')
    || (S.taskFilter === 'scheduled' && t.st !== 'run'));
  return '<div class="chead"><span class="hd">Tasks</span>'
    + segControl([['all','All'],['scheduled','Scheduled'],['running','Running'],['failed','Failed']], S.taskFilter, 'taskfilter:')
    + '<span class="grow"></span><button class="btn btn-p" data-act="task:new">' + ic('plus') + 'New Task</button></div>'
    + '<div class="scroller"><div class="rows">'
    + filtered.map((t) => '<button class="row"><span class="dot ' + t.st + '"></span>'
        + '<span class="main"><span class="t">' + esc(t.t) + '</span></span>'
        + '<span class="meta">' + esc(t.when) + ' · ' + esc(t.last) + '</span>'
        + '</button>').join('')
    + '</div>'
    + '</div>';
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
        // item 4: the same cell as the tool card — running is '…'; a finished step prints the trace's
        // number, or the wall time this window observed, or nothing (never '…' or 0ms for a call with no trace row).
        + '<span class="mono ter tnum" title="' + (m.ok === null ? 'running'
            : m.msSource === 'trace' ? 'measured by the agent (trace): tool result minus the model completion of that step, including parse and any approval wait \u2014 the same interval the TUI shows'
            : m.observedMs ? 'wall time observed by this window, from the call frame to the next frame'
            : 'no trace for this call') + '">'
        + (m.ok === null ? '\u2026' : m.msSource === 'trace' ? dur(m.ms) : m.observedMs ? dur(m.observedMs) : '') + '</span></span></button>').join('')
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
  task:  {label:'Task', ph:'Choose an action…', rows:[['plus','New task…','cron | interval | at','','task:new'],['play','Run a task now','','','task:run'],['x','Cancel a task','','','na']]},
  level: {label:'Approval level', ph:'Choose a level…', rows:CATS.length ? [1,2,3,4,5].map((n) => ['key', n + ' ' + LEVEL_NAMES[n], levelBlurb(n), '', 'level:' + n]) : []},
};
function levelBlurb(n) {
  return {1:'every gated action asks first', 2:'file writes inside the workspace stop asking',
          3:'writes under ~, Trash and HTTP stop asking', 4:'shell, skill scripts and process kills stop asking',
          5:'nothing asks — including browser and trust config'}[n];
}

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
  if (S.overlay === 'newtask') html += taskSheet();
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
  // Lane B \u2014 context before the first message (item 3). Copy follows
  // src/tui/components/context-panel.tsx: title(), buildRows() (the
  // "reserved for reply" row is config.localModels.completionMaxTokens,
  // tui-command.ts:232, and "free" is window \u2212 tokens \u2212 reserved, floored
  // at 0), and the pre-measurement screen verbatim. The projected state
  // is the desktop's own: the TUI has no figure before prompt_built.
  const proj = CTX.source === 'projected';
  const reserved = CTX.source === 'built' && CTX.reserved
    ? CTX.reserved
    : ((LIVE_CONFIG && LIVE_CONFIG.localModels && LIVE_CONFIG.localModels.completionMaxTokens) || 0);
  const pct = win ? Math.min(100, Math.round(CTX.tokens / win * 100)) : 0;
  const title = CTX.tokens
    ? 'context \u00b7 ' + (proj ? '~' : '') + fmtTokens(CTX.tokens)
      + (win ? ' of ' + fmtTokens(win) + ' window \u00b7 ' + pct + '%' : ' \u00b7 window unknown')
      + (proj ? ' \u00b7 projected' : '')
    : 'context \u00b7 not measured yet';
  const row = (label, value, dim) => '<dt' + (dim ? ' class="ter"' : '') + '>' + esc(label) + '</dt>'
    + '<dd class="mono tnum' + (dim ? ' ter' : '') + '">' + value + '</dd>';
  let body = '';
  if (CTX.tokens) {
    if (CTX.source === 'built' && CTX.sections) body = CTX.sections.map((s) => row(s.label, fmtTokens(s.tokens))).join('');
    else if (proj) {
      body = row('prompt scaffold', fmtTokens(CTX.stablePrefix));
      if (S.draft.trim()) body += row('your draft', '~' + fmtTokens(CTX.draftTokens));
      body += row('conversation', '0');
    } else body = row('prompt scaffold', fmtTokens(CTX.stablePrefix)) + row('conversation', fmtTokens(CTX.tail));
    if (win) {
      if (reserved > 0) body += row('reserved for reply', fmtTokens(reserved), true);
      body += row('free', fmtTokens(Math.max(0, win - CTX.tokens - reserved)), true);
    }
  }
  const rows = CTX.tokens
    ? '<dl class="kvgrid" style="grid-template-columns:1fr max-content;gap:4px 12px">' + body + '</dl>'
    : '<p class="cap" style="margin:0">send a message \u2014 the breakdown comes from the prompt the agent actually builds</p>';
  return '<div class="scrim" data-close="1" style="background:transparent">'
    + '<div class="popover" style="width:360px;' + anchorStyle('.ctxbtn', 360) + '">'
    + '<div style="padding:12px 16px 8px"><div class="hd" style="margin-bottom:8px">' + esc(title) + '</div>' + rows
    + (CTX.tokens ? '<p class="cap ctxbasis" style="margin:8px 0 0">' + esc(ctxBasisLine()) + '</p>' : '')
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

function taskSheet() {
  return sheet('New scheduled task',
    '<dl class="kvgrid" style="gap:12px 16px">'
    + '<dt>kind</dt><dd>' + segControl([['cron','cron'],['interval','interval'],['at','at']], 'cron', 'na:') + '</dd>'
    + '<dt>expression</dt><dd><input class="btn btn-s" style="width:100%;height:28px;font-family:var(--font-mono)" value="0 8 * * 1-5"></dd>'
    + '<dt>timezone</dt><dd><input class="btn btn-s" style="width:100%;height:28px" value="Europe/Berlin"></dd>'
    + '<dt>message</dt><dd><textarea class="btn btn-s" style="width:100%;height:64px;padding:6px 10px" placeholder="what should the agent do when this fires?"></textarea></dd>'
    + '<dt>next 5</dt><dd class="mono cap">Mon 09:00 · Tue 09:00 · Wed 09:00 · Thu 09:00 · Fri 09:00</dd></dl>',
    '<button class="btn btn-s" data-act="close">Cancel</button><button class="btn btn-p" data-act="close">Create task</button>');
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
function renderSettings() {
  const old = $('#settings'); if (old) old.remove();
  if (!S.settings) return;
  const panes = [['general','General','gear'],['models','Models','cpu'],['mcp','MCP','link'],['channels','Channels','chat'],
                 ['privacy','Privacy','key'],['import','Import','folder'],['appearance','Appearance','atom']];
  const el = document.createElement('div');
  el.id = 'settings';
  el.innerHTML = '<div class="setwin"><div class="settb">'
    + '<div class="lights"><button class="lg" style="background:#FF5F57" data-act="close"></button>'
      + '<span class="lg" style="background:var(--bg-active)"></span><span class="lg" style="background:var(--bg-active)"></span></div>'
    + '<div class="settabs">' + panes.map(([id, label, icon]) =>
        '<button class="settab' + (S.settingsPane === id ? ' on' : '') + '" data-act="settings:' + id + '">' + ic(icon) + esc(label) + '</button>').join('')
    + '</div></div><div class="setbody">' + settingsPane() + '</div></div>';
  el.querySelector('.lights').style.marginRight = '0';
  $('#window').appendChild(el);
}

function settingsPane() {
  const p = S.settingsPane;
  if (p === 'privacy') return privacyPane();
  if (p === 'models') return modelsPane();
  if (p === 'appearance') return '<div class="panelcard"><span class="hd">Appearance</span>'
    + segControl([['system','System'],['light','Light'],['dark','Dark']], S.theme, 'theme:')
    + '<p class="cap" style="margin:0">Named terminal palettes (github, catppuccin, dracula, nord) remain available for the TUI.</p></div>';
  return '<div class="stack"><div class="panelcard"><span class="hd">Workspace</span>'
    + '<dl class="kvgrid"><dt>folder</dt><dd class="mono">' + esc(S.live.workingDir || '—') + '</dd>'
    + '<dt>agent</dt><dd class="mono">' + esc(S.live.binary || 'not found') + '</dd>'
    + '<dt>state</dt><dd>' + esc(liveLabel()) + '</dd></dl>'
    + '<button class="btn btn-s" style="align-self:flex-start" data-act="workspace">Change folder…</button></div>'
    + '<div class="panelcard"><span class="hd">Setup</span>'
    + '<p class="cap" style="margin:0">Re-run the first-run wizard to change how the agent thinks.</p>'
    + '<button class="btn btn-t" style="align-self:flex-start" data-act="onboarding">Run setup again…</button></div></div>';
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

function privacyPane() {
  const stops = [1, 2, 3, 4, 5].map((n) =>
    '<button class="stopwrap' + (n <= S.level ? ' filled' : '') + (n === S.level ? ' on' : '') + '" disabled title="the mode chip on the composer is the approval surface">'
    + '<span class="stopdot">' + (n <= S.level ? '<span style="color:#fff;display:flex">' + ic('check') + '</span>' : '') + '</span>'
    + '<span class="stoplb">' + n + ' ' + LEVEL_NAMES[n] + '</span></button>').join('');
  const rows = CATS.map(([id, label, from]) => '<tr><td>' + esc(label)
      + (id === 'trust_config' ? ' <span class="ter" style="display:inline-flex;vertical-align:-3px" title="a write to the file holding agent.approvalLevel could silently raise the ladder for the next boot">' + ic('key') + '</span>' : '')
      + '</td>'
    + [1,2,3,4,5].map((n) => '<td class="' + (n === S.level ? 'col-on' : '') + '">'
        + '<span class="mdot' + (n >= from ? ' auto' : '') + '"></span>' + (n >= from ? 'auto' : 'asks') + '</td>').join('') + '</tr>').join('');
  return '<div class="stack">'
    + '<div><span class="hd">Approval level</span>'
      + '<p class="cap" style="margin:4px 0 0">How far the agent may act before it asks. Each level makes a whole category stop asking — nothing else changes.</p></div>'
    + '<div class="stepper">' + stops + '</div>'
    + '<table class="matrix"><thead><tr><th>Category</th>' + [1,2,3,4,5].map((n) => '<th>L' + n + '</th>').join('') + '</tr></thead>'
      + '<tbody>' + rows + '</tbody></table>'
    + '<div class="panelcard"><div class="micro sec">Session grants</div>'
      + (S.grants.length
        ? '<div class="hstack" style="flex-wrap:wrap">' + S.grants.map((g, i) => '<span class="badge" style="background:var(--accent-wash);border-color:var(--accent-line);color:var(--accent-text)">'
            + esc(g) + ' <button data-revoke="' + i + '" style="color:inherit">×</button></span>').join('') + '</div>'
        : '<p class="cap" style="margin:0">None. Grants made from an approval card live here and are never persisted to disk.</p>')
    + '</div>'
    + '<div class="panelcard"><div class="hstack"><span class="hd">What leaves this machine</span></div>'
      + '<div class="rows">'
      + '<div class="row" style="padding:0;height:32px"><span class="main"><span class="t" style="font-weight:400">Model calls → Anthropic</span></span><span class="meta">cloud and fusion turns only</span></div>'
      + '<div class="row" style="padding:0;height:32px"><span class="main"><span class="t" style="font-weight:400">Skill hub → clawhub</span></span><span class="meta">only when you install</span></div>'
      + '<div class="row" style="padding:0;height:32px"><span class="main"><span class="t" style="font-weight:400">Anonymous analytics</span></span><span class="meta">off</span></div>'
      + '</div></div></div>';
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
  if (a === 'session:new') { close(); S.log = []; S.history = []; S.agentSession = null; S.busy = false; S.pending = null; S.room = 'chat'; render(); toast('New session', 'The next turn starts fresh');
                             // Lane B — item 3: a new thread has a new window fill (the TUI resets contextUsage on session_created), so the chip goes back to the projection.
                             refreshContext(); return; }
  if (a === 'session:switch') { close(); S.overlay = 'sessions'; render(); return; }
  if (a === 'task:new') { close(); S.overlay = 'newtask'; render(); return; }
  if (a === 'task:run') { close(); render(); toast('Task started', 'Back up the Teletubbies folder'); return; }
  if (a === 'clear') { close(); S.log = []; S.history = []; render(); toast('Transcript cleared', 'The next turn starts fresh'); return; }
  if (a === 'stop') { close(); abort(); return; }
  if (a === 'send') { close(); submit(); return; }
  if (a === 'retry') { close(); render(); toast('Retrying last turn'); return; }
  if (a === 'dump') { close(); render(); toast('Debug bundle written', '~/Documents/atomic-agent-debug'); return; }
  if (a === 'tools') { close(); S.inspector = true; S.inspTab = 'world'; render(); return; }
  if (a === 'restart') { close(); render(); toast('Agent runtime restarted'); return; }
  if (a === 'quit') { close(); render(); toast('This is a prototype', 'Nothing to quit'); return; }
  if (a === 'about') { close(); render(); toast('Atomic Agent 0.3.7', 'Local-first agent · GAIA L1 69.8%'); return; }
  if (a === 'update') { close(); render(); toast('You are up to date', 'Version 0.3.7, stable channel'); return; }
  if (a === 'copy:session') { close(); render(); toast('Copied', 'Session 4f2a91-8b3c-4d1e'); return; }
  if (a === 'copy:reply') { close(); render(); toast('Copied last reply'); return; }
  if (a === 'workspace') { close(); render(); toast('Workspace', '~/Teletubbies · rw'); return; }
  if (a === 'analytics') { close(); S.settings = 1; S.settingsPane = 'privacy'; render(); return; }
  if (a === 'jump:appr') { const c = $('#apprcard'); if (c) c.scrollIntoView({block:'center', behavior:'smooth'}); return; }
  if (a === 'skills:hub') { close(); S.room = 'skills'; S.skillsTab = 'hub'; render(); return; }
  if (a === 'na') return;

  if (k === 'room')      { close(); S.room = v; render(); return; }
  if (k === 'insp')      { close(); S.inspector = true; S.inspTab = v; render(); return; }
  if (k === 'console')   { close(); S.consoleOpen = true; S.consoleTab = v; render(); return; }
  if (k === 'toggle')    { close(); if (v === 'sidebar') $('#sidebar').classList.toggle('rail');
                           else if (v === 'inspector') S.inspector = !S.inspector;
                           else S.consoleOpen = !S.consoleOpen; render(); return; }
  if (k === 'settings')  { close(); S.settings = 1; S.settingsPane = v; render(); return; }
  if (k === 'theme')     { close(); S.theme = v;
                           if (v === 'system') document.documentElement.removeAttribute('data-theme');
                           else document.documentElement.setAttribute('data-theme', v);
                           render(); return; }
  if (k === 'mode')      { S.mode = v; if (S.overlay === 'palette') close(); render(); return; }
  if (k === 'level')     {
    const level = Math.max(1, Math.min(5, +v));
    close(); S.settings = 1; S.settingsPane = 'privacy'; render();
    BR.configSet('agent.approvalLevel', String(level)).then((res) => {
      if (res && res.ok === false) { toast('Could not change the level', res.error || ''); return; }
      S.level = level; S.baseLevel = level; render();
      toast('Approval level ' + level, LEVEL_NAMES[level] + ' · restarting the agent');
      BR.restart().then(applyStatus);
    });
    return;
  }
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
  // Lane B — backend switch: a turn is waiting on the local gate's disk
  // snapshot; the draft stays where it is until that one has been decided.
  if (BSW.gating) return;
  if (text.startsWith('/')) { runSlash(text.slice(1).split(/\s+/)); S.draft = ''; if (e) { e.value = ''; autosize(e); } S.slash = false; ctxDraftChanged(); render(); return; }
  S.draft = ''; if (e) { e.value = ''; autosize(e); }
  ctxDraftChanged(); // Lane B — item 3: the sent draft leaves the projection
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
  // Lane B — backend switch: the TUI's pre-turn gate for the managed local
  // route (src/tui/local-turn-gate.ts). `atag serve` has no equivalent, so
  // without this a turn against a model that is not on disk burns the
  // transport retries and ends in a bare fetch error.
  if (localTurnGate().kind === 'pending') {
    // The TUI stats the disk synchronously; here the disk is one
    // `atag models list` away. In the first seconds on the local route
    // (before the catalogue snapshot has landed) that call is made now,
    // so no turn ever bypasses the gate.
    BSW.gating = true; render();
    bswSnapshot().then(() => { BSW.gating = false; bswGatedTurn(text); });
    return;
  }
  bswGatedTurn(text);
}
/** The gate's verdict, then the turn. */
function bswGatedTurn(text) {
  const gate = localTurnGate();
  if (gate.kind === 'pending') {
    // The snapshot could not be taken (`atag models list` failed), so
    // nothing is known about the disk. The TUI stats it and would decide;
    // here the turn runs, and the transcript says so rather than letting
    // it bypass the gate silently.
    S.log.push({id:nid(), k:'system', text:'local model catalogue unavailable — sending anyway'});
  }
  if (gate.kind === 'block') {
    // chat-orchestrator.ts turn_gate_blocked + input_changed: the
    // optimistic submit already cleared the editor, so the text is handed
    // back and the line says so. The TUI adds the user line to the
    // transcript only when the turn starts, so the one submit() pushed
    // comes off again — the message lives in the editor, not twice.
    const last = S.log[S.log.length - 1];
    if (last && last.k === 'user' && last.text === text) S.log.pop();
    S.log.push({id:nid(), k:'system', text: esc(gate.text + ' (message returned to the editor)')});
    S.draft = text;
    ctxDraftChanged();
    render(); // afterChat() puts S.draft back into #entry
    const e = $('#entry');
    if (e) { autosize(e); e.focus(); e.setSelectionRange(e.value.length, e.value.length); }
    return;
  }
  if (gate.kind === 'notice') S.log.push({id:nid(), k:'system', text: esc(gate.text)});
  startLiveTurn(text);
}
/** droppedPreview (src/tui/detached-turns.ts): one flat line, 60 columns. */
function droppedPreview(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 60 ? flat : flat.slice(0, 59) + '…';
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

function runSlash(parts) {
  const name = parts[0];
  const nav = {chat:'room:chat', tasks:'room:tasks', task:'task:new', skills:'room:skills', skill:'room:skills',
    memory:'room:memory', feed:'insp:steps', world:'insp:world', reasoning:'insp:reasoning', observe:'insp:steps',
    logs:'console:agent', manage:'settings:general', mcp:'settings:mcp', llm:'settings:models', model:'settings:models',
    telegram:'settings:channels', import:'settings:import', privacy:'settings:privacy', analytics:'settings:privacy',
    theme:'settings:appearance', sessions:'session:switch', new:'session:new', clear:'clear', abort:'stop',
    session:'copy:session', dump:'dump', tools:'tools', quit:'quit', help:'palette', debug:'toggle:console',
    expand:'cards:expand', collapse:'cards:collapse'};
  if (name === 'run') {
    if (parts[1]) { S.mode = parts[1]; if (parts[2]) { S.share = Math.max(0, Math.min(100, +parts[2])); S.dialShare = S.share; } render(); toast('Run type ' + S.mode); }
    else act('runmode');
    return;
  }
  if (name === 'privacy' && parts[1] === 'level' && parts[2]) { act('level:' + parts[2]); return; }
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
  if (grp) { OPEN_GROUPS.add(grp.dataset.group); expandGroupInPlace(grp.dataset.group); return; }  // scroll-stable cards: in place, no scrollTop write
  const fchip = t.closest('[data-file]');
  if (fchip && BR) { BR.openPath(fchip.dataset.file.replace(/^~/, homeDir() || '~')).then((r) => { if (r && r.ok === false) toast('Could not open', r.error || ''); }); return; }
  const mlink = t.closest('[data-url]');
  if (mlink && BR) { e.preventDefault(); BR.openExternal(mlink.dataset.url); return; }
  const tg = t.closest('[data-toggle]');
  // Scroll-stable cards: no S.stick = false, no render() — repaintEntry swaps the
  // one entry and recomputes stick from geometry.
  if (tg) { const m = S.log.find((x) => x.id === tg.dataset.toggle); if (m) { m.open = !m.open; repaintEntry(m, m.k === 'tool' ? '.cardhead' : '.disc'); } return; }
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
    // Lane B — item 3: the draft's estimate moves the projected chip only
    // (a 150 ms chip-only repaint — a render() here would reset the
    // textarea from S.draft in afterChat() and move the caret).
    ctxDraftChanged();
    const wasSlash = S.slash;
    S.slash = S.draft.startsWith('/');
    if (S.slash) { S.slashCur = 0; refreshSlash(); }
    else if (wasSlash) render();
    else refreshSend();
    return;
  }
  if (e.target.id === 'palq') { S.q = e.target.value; S.cur = 0; refreshPalette(); return; }
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

  // approval scope — only while a card is pending and focus is not in a text field
  if (S.pending && !inText) {
    const kk = k.toLowerCase();
    if (['y','s','a','n'].includes(kk)) { e.preventDefault(); answer(kk); return; }
    if (k === 'Escape') { e.preventDefault(); answer('esc'); return; }
  }

  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey) {
    const map = {k:'palette', '1':'room:chat', '2':'room:tasks', '3':'room:skills', '4':'room:memory',
                 '0':'toggle:sidebar', n:'session:new', o:'session:switch', ',':'settings:general',
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
  bswRefreshFacts();
  // Lane B — item 3: caps + config are in, so the chip can carry a figure
  // before any message. A fresh connection re-probes the preview route.
  CTX.previewSupported = null;
  refreshContext();
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
    if (S.queued.length) {
      const q = S.queued.shift();
      // Lane B — backend switch: the gate is judged at turn START, so a
      // message parked behind a running turn is re-checked here. A drained
      // message has no editor to go back to (the operator may be
      // mid-draft), so the TUI drops it — announced with a preview, never
      // silently — and stops draining (chat-orchestrator.ts fromQueue).
      const gate = localTurnGate();
      if (gate.kind === 'block') {
        S.log.push({id:nid(), k:'system', text: esc(gate.text + '\n  dropped: ' + droppedPreview(q))});
        render(); return;
      }
      if (gate.kind === 'notice') S.log.push({id:nid(), k:'system', text: esc(gate.text)});
      S.log.push({id:nid(), k:'user', text:q}); startLiveTurn(q); return;
    }
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
    // Lane B — backend switch: the TUI's selectPromptLlmMeta. A cloud
    // provider shows its chatModel (defaultChatModel ?? model) and,
    // when it has none, the TUI renders NO model control at all — the
    // desktop keeps the chip as the pane's anchor and leaves it unlabelled.
    const p = activeProvider();
    if (p && p.kind !== 'llama-server') return p.defaultChatModel || p.model || '';
    // DOWNLOAD_MODEL_LABEL first: selectComposerNeedsModelDownload (local
    // route, snapshot loaded, no pull running, nothing on disk) is judged
    // regardless of managed.modelId, and ComposerMetaControls renders the
    // DownloadModelControl in preference to the model label — an id that
    // names a file which is not there is not a model to show.
    if (BSW.localLoaded && !SEL.pulling && !SEL.local.some((m) => m.downloaded)) return 'download model';
    const managed = (LIVE_CONFIG && LIVE_CONFIG.localModels && LIVE_CONFIG.localModels.managed) || {};
    if (managed.modelId) return managed.modelId;
    return '';
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
  const localConfigured = lm.mode === 'external' && lm.url;
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

/** `restartedAlready`: the local path's selectLocalModel has restarted the agent itself. */
async function obFinish(kind, detail, restartedAlready) {
  // Lane B — backend switch: the cloud branch activates a provider, which
  // restarts `atag serve` and would abort a running turn — same guard as
  // every other switch entry point.
  if (kind === 'cloud' && S.busy) { OB.error = 'Not while a turn is running'; render(); return; }
  OB.busy = true; render();
  const stamp = new Date().toISOString();
  const writes = [];
  if (kind === 'local') writes.push(['tui.onboarding.localSetupSeenAt', stamp]);
  // Lane B — backend switch: there is no 'custom' kind any more (see
  // OB_CHOICES) — the CLI rejects the mode value and the desktop has no
  // URL probe, so that branch is gone rather than half-fixed.
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
  // Lane B — backend switch. Local: the TUI's onboarding writes
  // localModels.mode "managed" through persistUserLocalModelsConfig (url
  // sync included) — the model pick itself already went through
  // selectLocalModel, which is where the route moves and the daemon
  // starts. Cloud: the chosen provider is activated exactly as the
  // provider row does it; that IPC restarts the agent by itself.
  let restarted = false;
  if (kind === 'local') {
    const res = await BR.useManagedMode();
    if (res && res.ok === false) { OB.busy = false; OB.error = 'could not write localModels.mode: ' + (res.error || 'unknown error'); render(); return; }
    // selectLocalModel already bounced `atag serve` for its own writes;
    // only a mode write that actually changed the file needs another one.
    restarted = !!restartedAlready && !(res && res.changed);
  }
  if (kind === 'cloud') {
    const res = await BR.activateProvider(detail);
    if (!res || !res.ok) {
      OB.busy = false;
      OB.error = res && res.needsKey ? 'no API key for ' + detail + ' — set ' + (OB.keyEnv[detail] || 'its key') + ' in the environment first'
        : 'could not activate ' + detail + ': ' + ((res && res.error) || 'unknown error');
      render();
      return;
    }
    bswReport(res);
    restarted = !!res.restart;
  }
  OB.busy = false; OB.open = false;
  toast('Setup complete', kind === 'skip' ? 'You can run it again from the menu' : 'Restarting the agent…');
  render();
  if (restarted) { refreshLiveConfig(); return; }
  BR.restart().then(applyStatus);
}

function obUseModel(model) {
  if (model.downloaded) {
    // Lane B — backend switch: the TUI's pull-completion path writes the
    // model and starts the daemon; selectLocalModel is that sequence. It
    // restarts `atag serve`, so not while a turn is running.
    if (S.busy) { OB.error = 'Not while a turn is running'; render(); return; }
    OB.busy = true; render();
    BR.selectLocalModel(model.id).then((res) => {
      OB.busy = false;
      if (!res || !res.ok) { OB.error = (res && res.error) || 'could not select the model'; render(); return; }
      bswReport(res);
      obFinish('local', model.id, !!res.restart);
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
      + head(1, 'Where should the model run?', 'atomic-agent can drive models three ways; a custom endpoint is set up from the TUI. Nothing here is permanent — you can change it at any time from the menu.')
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

  // Lane B — backend switch: the custom-endpoint step went with its
  // OB_CHOICES entry; an unknown step falls back to the choice list.
  OB.step = 'choose';
  return obHTML();
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
  if (what === 'cancel') { BR.cancelPull(); OB.step = 'local'; render(); return; }
}

if (BR) {
  BR.onPull((ev) => {
    if (!ev) return;
    if (ev.line) OB.log.push(ev.line);
    if (ev.done) {
      if (ev.ok && OB.pulling) {
        BR.selectLocalModel(OB.pulling.id).then((res) => {
          if (!res || !res.ok) { OB.error = (res && res.error) || 'could not select the model'; OB.step = 'local'; render(); return; }
          bswReport(res);
          obFinish('local', OB.pulling.id, !!res.restart);
        });
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
  if (S.busy) { toast('Not while a turn is running'); return; }
  MP.err = null; MP.busy = true; render();
  const res = await BR.activateProvider(id);
  MP.busy = false;
  if (!res || !res.ok) {
    MP.err = res && res.needsKey ? 'no API key for ' + id + ' — add one with the wizard or export its variable' : ((res && res.error) || 'could not switch provider');
    render(); return;
  }
  bswReport(res);
  toast('Provider selected', id + ' · restarting the agent');
  await refreshLiveConfig();
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
  if (S.busy) { toast('Not while a turn is running'); return; }
  const id = MP.pickFor;
  MP.busy = true; MP.err = null; render();
  // The TUI's selectChatModel also activates the provider; here that
  // means a restart of `atag serve` as well.
  const res = await BR.selectCloudModel(id, model);
  MP.busy = false;
  if (!res || !res.ok) {
    MP.err = res && res.needsKey ? 'no API key for ' + id + ' — add one with the wizard or export its variable' : ((res && res.error) || 'could not set the model');
    render(); return;
  }
  MP.pickFor = null; MP.picks = [];
  bswReport(res, 'Selected chat model ' + id + '/' + model + '.');
  toast('Model selected', id + ' → ' + model + ' · restarting the agent');
  await refreshLiveConfig();
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
  // Lane B — item 3: a provider or model change moves the window and the baseline.
  const ctxWas = selActiveProviderId() + '\n' + activeModel();
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
  bswRefreshFacts();
  if (selActiveProviderId() + '\n' + activeModel() !== ctxWas) refreshContext();
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
    // Lane B — backend switch: composer-switch-rows.ts backendRows, in
    // its order (cloud, local) with its details. The TUI's third row,
    // custom (llama.cpp you run), needs the external-URL editor and is
    // not offered here.
    const ready = selProviders().filter((p) => BSW.readyIds.includes(p.id)).length;
    return [
      {type:'backend', id:'cloud', label:'cloud',
       detail: !BSW.readyLoaded ? 'checking keys…' : ready > 0 ? ready + ' provider' + (ready === 1 ? '' : 's') + ' ready' : 'add a provider first',
       active: selBackend() === 'cloud'},
      {type:'backend', id:'local', label:'local',
       detail: 'llama.cpp managed here',
       active: selBackend() === 'local'},
    ];
  }
  if (SEL.kind === 'provider') {
    const activeId = selActiveProviderId();
    // providerRows: hasApiKey ? (chatModel ?? 'default model') : 'no API key'.
    const rows = selProviders().map((p) => ({
      type:'provider', id:p.id, label:p.id,
      detail: !BSW.readyLoaded ? 'checking keys…' : BSW.readyIds.includes(p.id) ? (p.defaultChatModel || p.model || 'default model') : 'no API key',
      active: p.id === activeId,
    }));
    // The TUI's trailing row (intent addProvider): the same screen as the
    // footer's "Add a provider" used to open.
    rows.push({type:'action', id:'add', label:'Add a new provider', detail:'opens the wizard', active:false});
    return rows;
  }
  // model pane
  if (selBackend() === 'local') {
    const rows = SEL.local
      .filter((m) => !SEL.filter || modelMatches(m.id, m.family, SEL.filter))
      .map((m) => {
        const fit = fitFor(m.size, OB.ram || 16);
        return {type:'localModel', id:m.id, label:m.id, downloaded:m.downloaded, active:m.active,
          detail: m.size + ' · ' + m.context + ' context · ' + fit.label + (m.downloaded ? ' · on disk' : '')};
      });
    // The TUI's deep-link row (model:local:download-more), outside the filter.
    rows.push({type:'action', id:'downloadMore', label:'Download more models…', detail:'opens the local models pane', active:false});
    return rows;
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
  // The TUI's trailing rows: "Add a new provider" opens the wizard,
  // "Download more models…" the local models pane (Settings › Models).
  if (row.type === 'action') {
    if (row.id === 'add') { act('sel:add'); return; }
    act('settings:models'); S.modelTab = 'local'; render(); mpLoadLocal();
    return;
  }
  // Lane B — backend switch: every branch below writes through main's
  // port of the TUI's persist helpers and ends in an agent restart, so
  // none of them may run while a turn is in flight.
  if (S.busy) { toast('Not while a turn is running'); return; }
  if (row.type === 'provider') {
    SEL.busy = true; SEL.err = null; BSW.line = 'switching…'; render();
    const res = await BR.activateProvider(row.id);
    SEL.busy = false; BSW.line = '';
    if (!res || !res.ok) {
      if (res && res.needsKey) { bswOpenKey(row.id); return; }
      SEL.err = (res && res.error) || 'could not switch provider'; render(); return;
    }
    bswReport(res);
    await refreshLiveConfig();
    SEL.kind = 'model'; SEL.cursor = 0; SEL.filter = ''; render();
    selLoadModels(row.id);
    return;
  }
  if (row.type === 'cloudModel') {
    // Apply and close first; the write and the restart confirm in the background.
    const pid = selActiveProviderId();
    const entry = selProviders().find((p) => p.id === pid);
    if (entry) entry.defaultChatModel = row.id;
    S.cloudModel = row.id;
    closeSelector();
    BR.selectCloudModel(pid, row.id).then((res) => {
      if (!res || !res.ok) toast('Could not select the model', res && res.needsKey ? 'no API key for ' + pid : ((res && res.error) || ''));
      else bswReport(res, 'Selected chat model ' + pid + '/' + row.id + '.');
      refreshLiveConfig();
    });
    return;
  }
  if (row.type === 'localModel') {
    if (!row.downloaded) { selPull(row.id); return; }
    // The popup stays open until main answers: a daemon that fails to
    // start has to be shown, and `models start` can take a while.
    SEL.busy = true; SEL.err = null; BSW.line = 'starting ' + row.id + '…'; render();
    const res = await BR.selectLocalModel(row.id);
    SEL.busy = false; BSW.line = '';
    if (!res || !res.ok) {
      if (res && res.needsDownload) { selPull(row.id); return; }
      SEL.err = (res && res.error) || 'could not select the model'; render(); return;
    }
    S.localModel = row.id;
    closeSelector();
    bswReport(res);
    if (res.daemon === 'start-failed') toast('Local daemon did not start', res.error || '');
    await refreshLiveConfig();
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

  // An empty list is not a list — it is one action. The provider and
  // local model panes always end in the TUI's action row ("Add a new
  // provider" / "Download more models…"), so, as in the TUI, an empty
  // provider list IS that one row; only the cloud model pane can be bare.
  const real = rows.filter((r) => r.type !== 'action');
  if (!rows.length && !SEL.modelsBusy && !SEL.localBusy && !(SEL.kind === 'model' && SEL.filter)) {
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
    + (!real.length && SEL.kind === 'model' && SEL.filter && !SEL.modelsBusy && !SEL.localBusy ? '<div class="pad cap">no models match \u201c' + esc(SEL.filter) + '\u201d</div>' : '')
    + '</div>';

  // Adding a provider is the pane's own trailing row now, as in the TUI.
  const foot = '<button class="btn btn-s" data-act="close">Done</button>';

  return selShell(title, search + list, foot);
}

/** One popup shell: fixed height, its own scroll, anchored to the chip. */
function selShell(title, body, foot) {
  return '<div class="scrim" data-close="1" style="background:transparent">'
    + '<div class="popover selpop" style="' + anchorStyle(document.querySelector('.modelchip') ? '.modelchip' : '.modechip', 460) + '">'
    + '<div class="selhead">' + esc(title)
    + (SEL.busy ? '<span class="cap" style="margin-left:auto">' + esc(BSW.line || 'saving…') + '</span>' : '') + '</div>'
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
  if (S.busy) { SEL.busy = false; SEL.err = 'saved, but not activated while a turn is running'; render(); refreshLiveConfig(); return; }
  BSW.line = 'switching…';
  res = await BR.activateProvider(preset.id);
  SEL.busy = false; BSW.line = '';
  if (!res || !res.ok) {
    SEL.err = res && res.needsKey ? 'saved, but could not activate it: no API key (' + preset.env + ')' : 'saved, but could not activate it' + (res && res.error ? ': ' + res.error : '');
    render(); refreshLiveConfig(); return;
  }
  bswReport(res);
  SEL.addOpen = false;
  await refreshLiveConfig();
  SEL.kind = 'model'; SEL.cursor = 0; render();
  selLoadModels(preset.id);
  toast('Provider added', preset.label);
}

/* ============================================================
   Context gauge — real numbers, measured on the last prompt
   ============================================================ */

/* ============================================================
   Lane B — context before the first message (item 3)

   The user's words: "I want to see the context before I am sending
   a message, just to calculate the thing". The TUI shows nothing
   before the first prompt_built (selectContextUsage returns null,
   the panel says "not measured yet"), so there is no TUI logic to
   copy for that state — the user's words override it, and the
   figure shown is a labelled PROJECTION built only from data the
   installed agent already produces:
     scaffold  = turn-0 prompt_captured.tokens.stablePrefix of the
                 newest trace built in this workspace (traceBaseline)
     draft     = estimateTokens(S.draft), the runtime's own estimator
     window    = /props n_ctx (local) or the provider catalogue
     reserved  = localModels.completionMaxTokens, as the TUI panel
   Precedence once something real exists: the branch route's built
   prompt ('built') > the session's trace ('provider'|'estimate') >
   the projection. The '~' and the word "projected" never come off
   until one of the first two answers.
   ============================================================ */

/** Port of src/tui/components/format-tokens.ts formatTokens: 6.4k / 32k / 1.0M. */
function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) { const k = n / 1000; return Number.isInteger(k) ? k + 'k' : k.toFixed(1) + 'k'; }
  const m = n / 1e6; return Number.isInteger(m) ? m + 'M' : m.toFixed(1) + 'M';
}
/** Port of src/prompt/token-budget.ts estimateTokens (over-counts by ~10-15% on purpose). */
function estimateTokens(text) {
  if (!text || !text.length) return 0;
  const words = text.trim().split(/\s+/).length;
  return Math.max(Math.ceil(text.length / 3.6), Math.ceil(words * 1.4));
}
function relTime(at) {
  const s = Math.max(0, Date.now() - at) / 1000;
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
  const h = Math.floor(m / 60); if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.floor(h / 24); if (d === 1) return 'yesterday';
  return d + ' days ago';
}

/** The panel's basis line: where the figure comes from, in one sentence. */
function ctxBasisLine() {
  if (CTX.source === 'provider') {
    // On llama the provider count is the KV-cache MISS count (the cached
    // prefix is not re-evaluated), so say how much was reused rather than
    // let a 1.0k figure read as if the projection had been six times off.
    return 'counted by ' + (CTX.modelId || 'the model')
      + (CTX.cacheHitTokens > 0 ? ' (after ' + fmtTokens(CTX.cacheHitTokens) + ' reused from its cache)' : '');
  }
  if (CTX.source === 'estimate') return 'estimated from the built prompt';
  if (CTX.source === 'built') return 'built now from this workspace’s tools, skills and memory — before recall';
  const b = CTX.baseline;
  if (!b) return '';
  const place = b.workspaceMatch ? 'in this workspace' : 'in ' + (b.workingDir || 'another workspace');
  // Never "(glm-5.2, not zhipu/glm-5.2)": the trace holds the provider's
  // echoed id, so a basename match is the same model and a mismatch is
  // stated as what the baseline was built for, not as a correction.
  const built = b.modelMatch
    ? 'for ' + b.modelId + ' ' + place
    : place + (b.modelId ? ' (for ' + b.modelId + ')' : '');
  return 'projected from the last prompt this agent built ' + built + ' — ' + b.sessionId + ', ' + relTime(b.at)
    + '. The real figure comes from the prompt the agent actually builds.';
}

/**
 * The window, in the TUI's order (src/tui/select-context-usage.ts
 * resolveWindow): the prompt's own window → llama /props n_ctx →
 * the provider catalogue → null. Nothing substitutes a default: the
 * TUI's comment calls a gauge against a guessed scale a fabrication.
 * Deliberate divergence from the TUI poller: it reads /props whichever
 * provider is active; here /props is probed only when the active
 * provider is llama-server, so a cloud gauge is never drawn against a
 * local server's n_ctx. For the same reason the managed contextSize
 * and catalogue "model max" fallbacks apply to the local route only.
 */
async function resolveWindow() {
  const entry = activeProvider();
  const local = !entry || entry.kind === 'llama-server';
  if (local) {
    const url = LIVE_CAPS && LIVE_CAPS.llama && LIVE_CAPS.llama.url;
    if (url && BR.llamaProps) {
      const key = (LIVE_CONFIG && LIVE_CONFIG.localModels && LIVE_CONFIG.localModels.apiKey) || undefined;
      const p = await BR.llamaProps(url, key);
      if (p && p.n_ctx > 0) return {window:p.n_ctx, label:'loaded window'};
    }
    const managed = (LIVE_CONFIG && LIVE_CONFIG.localModels && LIVE_CONFIG.localModels.managed) || {};
    if (managed.contextSize) return {window:managed.contextSize, label:'loaded window'};
    const row = SEL.local.find((m) => m.id === managed.modelId);
    if (row && row.context) {
      const n = parseFloat(row.context);
      const mult = /m/i.test(row.context) ? 1e6 : /k/i.test(row.context) ? 1000 : 1;
      if (n) return {window:Math.round(n * mult), label:'model max'};
    }
    return {window:null, label:''};
  }
  const model = entry.defaultChatModel || entry.model;
  if (model && BR.modelWindow) {
    const r = await BR.modelWindow(entry.id, entry.kind, model);
    if (r && r.ok && r.window > 0) return {window:r.window, label:'model window'};
  }
  return {window:null, label:''};
}

function ctxPairsCap() { return (LIVE_CONFIG && LIVE_CONFIG.agent && LIVE_CONFIG.agent.conversationMaxPairs) || 0; }

// `stateDirOverride` exists for the smoke only (window.__ctxEmpty): it
// runs this same path against a real directory that holds no trace, so
// the "not measured yet" state is exercised rather than assumed.
async function refreshContext(stateDirOverride) {
  if (!BR) return;
  const seq = ++CTX.seq;
  const stateDir = (typeof stateDirOverride === 'string' && stateDirOverride)
    || (LIVE_CAPS && LIVE_CAPS.paths && LIVE_CAPS.paths.stateDir);
  const windowP = resolveWindow().catch(() => ({window:null, label:''}));
  let usage = null;
  // (a) the branch route: the agent's own prompt, built now.
  if (BR.contextPreview && CTX.previewSupported !== false) {
    const r = await BR.contextPreview(S.agentSession, S.draft);
    if (r && r.supported === false) CTX.previewSupported = false;
    else if (r && r.ok && r.usage) {
      CTX.previewSupported = true;
      const sec = (label) => { const s = (r.usage.sections || []).find((x) => x.label === label); return s ? s.tokens : 0; };
      usage = {tokens:r.usage.tokens, source:'built', stablePrefix:sec('prompt scaffold'), tail:sec('conversation'),
        cacheHitTokens:null, modelId:null, baseline:null, sections:r.usage.sections || [],
        pairsCap:r.pairsCap || r.usage.conversationPairsCap || 0, reserved:r.reservedForReply || 0,
        builtWindow:r.contextWindow > 0 ? r.contextWindow : null};
    }
  }
  // (b) this session's trace, once a turn has run.
  if (!usage && S.agentSession && stateDir) {
    const r = await BR.traceUsage(stateDir, S.agentSession);
    if (r && r.ok && r.usage) usage = Object.assign({}, r.usage, {baseline:null, sections:null, pairsCap:ctxPairsCap(), reserved:0, builtWindow:null});
  }
  // (c) the projection: the last scaffold this agent built here + the draft.
  if (!usage && stateDir && BR.traceBaseline) {
    const model = activeModel();
    const r = await BR.traceBaseline(stateDir, /^(no model chosen|not configured|download model|)$/.test(model) ? null : model,
      (LIVE_CAPS && LIVE_CAPS.capabilities && LIVE_CAPS.capabilities.workingDir) || null);
    if (r && r.ok && r.baseline) {
      const b = r.baseline;
      usage = {tokens:b.stablePrefix + CTX.draftTokens, source:'projected', stablePrefix:b.stablePrefix, tail:0,
        cacheHitTokens:null, modelId:b.modelId, baseline:b, sections:null, pairsCap:ctxPairsCap(), reserved:0, builtWindow:null};
    }
  }
  if (seq !== CTX.seq) return; // a newer refresh is on its way
  if (!usage) {
    // Nothing measured and no trace to project from: the TUI's own
    // "not measured yet" state — chip hidden, never a zero.
    Object.assign(CTX, {tokens:0, source:null, stablePrefix:0, tail:0, cacheHitTokens:null, modelId:null, baseline:null, sections:null, pairsCap:0, reserved:0});
  } else {
    const builtWindow = usage.builtWindow; delete usage.builtWindow;
    Object.assign(CTX, usage);
    if (builtWindow) { CTX.window = builtWindow; CTX.windowLabel = 'prompt window'; }
  }
  // The window resolves off the critical path: a cached catalogue answer
  // is instant, a first --refresh is not, and the figure should not wait.
  const w = await Promise.race([windowP, new Promise((r) => setTimeout(() => r(undefined), 2000))]);
  if (seq !== CTX.seq) return;
  if (CTX.windowLabel !== 'prompt window') {
    if (w) { CTX.window = w.window; CTX.windowLabel = w.label; }
    else { CTX.window = null; CTX.windowLabel = ''; }
  }
  paintContext();
  if (w === undefined) {
    const late = await windowP;
    if (seq !== CTX.seq) return;
    if (CTX.windowLabel !== 'prompt window') { CTX.window = late.window; CTX.windowLabel = late.label; paintContext(); }
  }
}

/**
 * CTX is read by exactly two things — the composer chip and the context
 * panel — so a refresh repaints the chip in place and rebuilds the page
 * only while the panel is open. A render() here would rebuild #composer
 * and drop the caret of a first message being typed (afterChat restores
 * the text, not the focus), and this refresh now runs precisely while
 * that message is being typed: at boot, on a provider/model change, on
 * session:new and when a slow catalogue answer lands seconds later.
 */
function paintContext() {
  if (S.overlay === 'context') { render(); return; }
  repaintContextChip();
}

/** The draft's estimate: moves the projected figure only, never a measured one. */
function ctxDraftChanged() {
  CTX.draftTokens = estimateTokens(S.draft);
  if (CTX.source === 'projected') { CTX.tokens = CTX.stablePrefix + CTX.draftTokens; scheduleChipRepaint(); }
}
function scheduleChipRepaint() {
  clearTimeout(CTX.chipTimer);
  CTX.chipTimer = setTimeout(repaintContextChip, 150);
}
function repaintContextChip() {
  const el = document.querySelector('.cfoot .ctxbtn');
  const html = contextChip();
  if (el) { if (html) el.outerHTML = html; else el.remove(); return; }
  if (!html) return;
  const next = document.querySelector('.cfoot .cmodechip');
  if (next) next.insertAdjacentHTML('beforebegin', html);
}

function contextChip() {
  if (!CTX.tokens) return '';
  const proj = CTX.source === 'projected';
  const label = (proj ? '~' : '') + (CTX.window
    ? fmtTokens(CTX.tokens) + '/' + fmtTokens(CTX.window)
    : fmtTokens(CTX.tokens));
  const pct = CTX.window ? Math.min(100, (CTX.tokens / CTX.window) * 100) : 0;
  return '<button class="cchip ctxbtn' + (proj ? ' proj' : '') + '" data-act="context" title="'
    + (proj ? 'projected — nothing measured in this session yet' : 'context') + '">'
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
  window.__ctx = () => ({tokens:CTX.tokens, source:CTX.source, window:CTX.window, windowLabel:CTX.windowLabel, stablePrefix:CTX.stablePrefix,
    draftTokens:CTX.draftTokens, previewSupported:CTX.previewSupported,
    baseline: CTX.baseline ? {sessionId:CTX.baseline.sessionId, at:CTX.baseline.at, modelId:CTX.baseline.modelId,
      workingDir:CTX.baseline.workingDir, workspaceMatch:CTX.baseline.workspaceMatch, modelMatch:CTX.baseline.modelMatch} : null});
  window.__ctxRefresh = () => refreshContext();
  window.__mode = () => currentMode();
}


/**
 * Choosing a backend is a choice, not a step: it picks something usable
 * on that side and applies it. Only when there is nothing to pick does
 * the popup stay open, showing the one action that would fix that.
 */
async function selChooseBackend(id) {
  // Lane B — backend switch. The decision (which provider, which model,
  // what to do with the daemon) is the TUI's activateCloud/activateLocal,
  // ported into main's switchBackend; the write is whole-file, and the
  // agent is restarted by main because `atag serve` pins its provider at
  // boot. A running turn would be aborted by that restart, so refuse.
  if (S.busy) { toast('Not while a turn is running'); return {ok:false, error:'a turn is running'}; }
  SEL.err = null; SEL.busy = true; BSW.line = id === 'local' ? 'switching to local…' : 'switching to cloud…'; render();
  const res = await BR.switchBackend(id);
  SEL.busy = false; BSW.line = '';
  if (!res || !res.ok) {
    if (res && res.needsProvider) { SEL.kind = 'provider'; SEL.addOpen = true; SEL.presetCur = 0; render(); return res; }
    if (res && res.needsKey) { bswOpenKey(res.providerId); return res; }
    SEL.err = (res && res.error) || 'could not switch to ' + id;
    toast('Could not switch to ' + id, SEL.err);
    render();
    await refreshLiveConfig();
    return res;
  }
  bswReport(res);
  if (res.daemon === 'start-failed') toast('Local daemon did not start', res.error || '');
  await refreshLiveConfig();
  if (res.needsModel) {
    // activateLocal with nothing on disk: the route moved, the model
    // switch opens (its "download" rows lead to the pull).
    SEL.kind = 'model'; SEL.cursor = 0; SEL.filter = ''; render();
    selLoadLocal();
    return res;
  }
  closeSelector();
  return res;
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
        argsKey: JSON.stringify(t.args ?? {}), at: t.at,   // item 4: what the trace merge matches on
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
          log[i].ms = undefined; log[i].msSource = null;   // item 4: the store carries no duration; the trace does
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
  // item 4: durations come from the agent's trace; repaint only if this transcript is still up.
  const shown = S.log;
  applyTraceDurations().then((changed) => { if (changed && S.log === shown) render(); });
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

  // Lane B — backend switch: opened for an existing entry without a key
  // (bswOpenKey), the write goes to that entry's own id, as the TUI's
  // openProviderConfigFor does; a fresh pick keeps the preset id.
  const existing = WIZ.forId ? selProviders().find((p) => p.id === WIZ.forId) : null;
  WIZ.forId = null;
  const id = existing && existing.kind === k.kind ? existing.id
    : k.custom ? 'custom-' + WIZ.baseUrl.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '-').slice(0, 32) : k.id;
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
  // Lane B — backend switch: one write for the model + the activation, then
  // the restart main does for it. Not while a turn runs.
  if (S.busy) { WIZ.phase = 'configure'; WIZ.error = 'saved and verified, but not activated while a turn is running'; render(); refreshLiveConfig(); return; }
  const sel = await BR.selectCloudModel(id, model);
  if (!sel || !sel.ok) {
    WIZ.phase = 'configure';
    WIZ.error = sel && sel.needsKey ? 'saved, but the agent sees no key for it — enter one above or export ' + (k.env || 'its variable')
      : 'saved, but could not activate it' + (sel && sel.error ? ': ' + sel.error : '');
    render(); refreshLiveConfig(); return;
  }
  bswReport(sel, 'Selected chat model ' + id + '/' + model + '.');
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
  // item 4: the run's total counts only members with a number (trace, or observed while live);
  // the tooltip says when some are unmeasured, and a fold with no measured member prints nothing, never 0ms.
  const measured = run.filter((c) => c.msSource === 'trace' || c.observedMs);
  const ms = measured.reduce((n, c) => n + (c.msSource === 'trace' ? c.ms : c.observedMs), 0);
  const bad = run.filter((c) => c.ok === false).length;
  const pending = run.some((c) => c.ok === null);
  // The title says where the numbers come from: a fold of live cards is window-observed until the store lands.
  const observed = measured.filter((c) => c.msSource !== 'trace').length;
  const duTitle = pending ? 'running'
    : measured.length === run.length ? (observed ? 'sum of the calls; ' + observed + ' observed by this window until the store lands' : 'sum of the calls, measured by the agent (trace)')
    : measured.length ? measured.length + ' of ' + run.length + ' calls measured' + (observed ? ' (' + observed + ' observed by this window until the store lands)' : '') + '; the rest have no trace row'
    : 'no trace for these calls';
  const glyph = pending ? '<span class="dot run"></span>'
    : bad ? '<span style="color:var(--danger);display:flex">' + ic('warn') + '</span>'
          : '<span style="color:var(--success);display:flex">' + ic('check') + '</span>';
  const previews = run.map((c) => previewArgs(c.args || c.arg)).filter(Boolean);
  return '<div class="turn" id="group-' + m.id + '"><div></div><div><div class="card">'
    + '<button class="cardhead" data-group="' + m.id + '">' + glyph
    + '<span class="nm">' + run.length + ' \u00d7 ' + esc(m.name) + '</span>'
    + '<span class="du tnum" title="' + duTitle + '">' + (pending ? '\u2026' : measured.length ? dur(ms) : '') + '</span>'
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
    card.at = call.at; card.argsKey = JSON.stringify(call.args ?? {});   // item 4: for the trace merge
    if (result) {
      card.ok = result.status === 'ok';
      card.out = result.summary || '';
      card.truncated = !!result.truncated;
    }
  }
  // Whatever the store still does not describe is finished, just unmeasured.
  pendingCards.forEach((c) => { if (c.ok === null) { c.ok = true; c.out = c.out || ''; } });
  await applyTraceDurations();   // item 4: live cards flip from observed wall time to the agent's number
  render();
}

/* item 4 — trace-measured tool durations.
   The store stamps one `at` on a call and its result, so it carries no duration
   (the TUI shows 0ms for a reopened session for the same reason). The trace does:
   tool_invocation.ts − the llm_completion.ts of the same step is exactly the
   interval the TUI's live card measures (tool_call_parsed → tool_call_executed). */
async function applyTraceDurations() {
  if (!BR || !S.agentSession || !BR.traceTools) return false;
  const stateDir = LIVE_CAPS && LIVE_CAPS.paths && LIVE_CAPS.paths.stateDir;
  if (!stateDir) return false;
  const sid = S.agentSession, log = S.log;
  const res = await BR.traceTools(stateDir, sid);
  // A faster second click in the sidebar must not stamp this session's numbers on another transcript.
  if (S.agentSession !== sid || S.log !== log) return false;
  if (!res || !res.ok || !Array.isArray(res.rows)) return false;
  // The store lists a batched step in batch-index order; the trace writes rows in
  // completion order. Keep file order (turn indices restart when a later `serve`
  // appends to the file) and stable-sort only each run of one (turn, step) by batchIndex.
  const rows = []; let group = [];
  const flush = () => { group.sort((a, b) => a.batchIndex - b.batchIndex); rows.push(...group); group = []; };
  for (const r of res.rows) {
    if (r.tool === 'reply' || r.tool === 'finish') continue;   // assistant_reply in the store, never a card
    if (group.length && (group[0].turnIndex !== r.turnIndex || group[0].stepIndex !== r.stepIndex)) flush();
    group.push(r);
  }
  flush();
  const cards = log.filter((m) => m.k === 'tool');
  let k = 0, hit = 0;
  for (const card of cards) {
    // A live card still running keeps observedMs and halts the walk; a store card whose
    // result never landed (an interrupted turn) is skipped so the cards after it are still measured.
    if (card.ok === null) { if (card.startedAt) break; continue; }
    const at = card.at || 0;                         // = step finish, stamped after the whole batch returned
    let found = -1;
    for (let j = k; j < rows.length; j++) {
      if (at && rows[j].ts > at + 5000) break;       // the trace has moved past this card
      // No lower bound against `at`: a fast sibling of a slow batched call finishes long before the step's `at`.
      // A card born on this window's stream has its own lower bound: startedAt is stamped on
      // tool_call_parsed, always before the trace row is written. Without it a fresh window
      // ("New session" + a first prompt whose derived id already exists) would take the earliest
      // row of the reused session — a stale number shown as the agent's measurement.
      if (card.startedAt && rows[j].ts < card.startedAt - 2000) continue;
      if (rows[j].tool !== card.name) continue;
      if (card.argsKey && rows[j].argsKey !== card.argsKey) continue;
      found = j; break;
    }
    if (found < 0) continue;                         // leave unmeasured, never 0
    k = found + 1;                                   // forward-only: a repeated identical call takes the next row
    if (rows[found].ms != null) { card.ms = rows[found].ms; card.msSource = 'trace'; card.traceTs = rows[found].ts; hit++; }
  }
  return hit > 0;
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
    ms: m.msSource === 'trace' ? m.ms : (m.observedMs || 0),   // item 4
    source: m.msSource || (m.observedMs ? 'observed' : null), ok: m.ok,
    traceTs: m.traceTs || null, startedAt: m.startedAt || null,   // item 4: the row a live card took must be its own
    argsKey: m.argsKey || null,   // item 4: what the trace merge matches on
    live: !!m.startedAt,   // born on the stream this run, as opposed to loaded from the store
  }));
  window.__pushAssistant = (t) => { S.log.push({id:nid(), k:'assistant', text:t}); render(); return document.querySelectorAll('.filechip').length; };
}

/* Hooks for --smoke: scroll-stable cards. Every toggle goes through the REAL
   click path (the document click listener → [data-toggle] / [data-group]), so
   the checks fail if that branch ever goes back to a full render(). */
if (typeof window !== 'undefined') {
  window.__scroll = () => { const sc = $('#scroller'); return sc ? {top:sc.scrollTop, height:sc.scrollHeight, client:sc.clientHeight, stick:S.stick} : null; };
  window.__foldState = (i) => {
    const m = S.log.filter((x) => x.k === 'tool')[i]; if (!m) return null;
    return {id:m.id, open:!!m.open, body:!!document.querySelector('#card-' + m.id + ' .cardbody')};
  };
  window.__scrollCardTo = (i, px) => {
    const m = S.log.filter((x) => x.k === 'tool')[i]; const sc = $('#scroller');
    if (m && !document.getElementById('card-' + m.id)) { // folded into a group: unfold the run it belongs to
      let s = S.log.indexOf(m); while (s > 0 && S.log[s - 1].k === 'tool' && S.log[s - 1].name === m.name) s--;
      if (document.getElementById('group-' + S.log[s].id)) { OPEN_GROUPS.add(S.log[s].id); expandGroupInPlace(S.log[s].id); }
    }
    const h = m && document.querySelector('#card-' + m.id + ' .cardhead');
    if (!sc || !h) return null;
    sc.scrollTop += h.getBoundingClientRect().top - sc.getBoundingClientRect().top - px;
    S.stick = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40;
    return {scrollTop:sc.scrollTop, stick:S.stick, below:sc.scrollHeight - sc.scrollTop - sc.clientHeight};
  };
  window.__toggleCard = (i) => {
    const m = S.log.filter((x) => x.k === 'tool')[i]; const sc = $('#scroller');
    const head = () => m && document.querySelector('#card-' + m.id + ' .cardhead');
    const h0 = head(); if (!sc || !h0) return null;
    const headBefore = h0.getBoundingClientRect().top, scrollBefore = sc.scrollTop, openBefore = !!m.open;
    h0.click();                       // the document click listener → [data-toggle] branch → repaintEntry
    const h1 = head();
    return {id:m.id, open:!!m.open, flipped:m.open !== openBefore, body:!!document.querySelector('#card-' + m.id + ' .cardbody'),
            headBefore, headAfter:h1 ? h1.getBoundingClientRect().top : NaN, scrollBefore, scrollAfter:sc.scrollTop};
  };
  window.__unfoldGroup = () => {
    const g = document.querySelector('[data-group]'); const sc = $('#scroller'); if (!g || !sc) return null;
    const id = g.dataset.group; sc.scrollTop += g.getBoundingClientRect().top - sc.getBoundingClientRect().top - 120;
    // the hook's own scrollTop write happens BEFORE `before` is measured, so the assertion isolates the click
    const before = g.getBoundingClientRect().top, scrollBefore = sc.scrollTop;
    g.click();                        // [data-group] branch → expandGroupInPlace
    const h = document.querySelector('#turn-' + id + ' .cardhead');
    return {id, members:OPEN_GROUPS.has(id), headBefore:before, headAfter:h ? h.getBoundingClientRect().top : NaN, scrollBefore, scrollAfter:sc.scrollTop};
  };
}

/* Hooks for --smoke: item 4 — cards stay inside the transcript column, durations
   come from the trace. __pushTool pushes an ordinary finished card (no demo words),
   __overflow measures what could widen the column. */
if (typeof window !== 'undefined') {
  window.__session = () => S.agentSession;
  window.__newSession = () => { act('session:new'); return S.log.length; };   // exactly what the toolbar button does
  window.__busy = () => S.busy;
  window.__stateDir = () => (LIVE_CAPS && LIVE_CAPS.paths && LIVE_CAPS.paths.stateDir) || null;
  // Deterministic stand-in for "a fresh window on a session whose trace already holds an identical
  // row" (New session + a first prompt whose derived id already exists) — no model in the loop.
  // Sets the session id as the stream would, pushes a live-shaped card (startedAt now, so the
  // existing row predates it) and a store-shaped copy of the same call, then runs the real merge:
  // the live card must stay unmeasured, the store copy takes the row.
  window.__probeTrace = async (sid, name, argsKey) => {
    S.agentSession = sid;
    const mk = (live) => Object.assign({id:nid(), k:'tool', name, args: argsKey, argsKey, at: 0, ok:true, out:'', open:false, where:'local'}, live ? {startedAt: Date.now()} : {});
    const liveCard = mk(true), storeCard = mk(false);
    S.log.push(liveCard, storeCard);
    const changed = await applyTraceDurations();
    render();
    const pick = (c) => ({source: c.msSource || null, traceTs: c.traceTs || null, ms: c.ms == null ? null : c.ms, startedAt: c.startedAt || null});
    return {changed, live: pick(liveCard), stored: pick(storeCard)};
  };
  window.__pushTool = (name, args, summary, open = true) => {
    S.log.push({id:nid(), k:'tool', name, args: JSON.stringify(args), argsKey: JSON.stringify(args), ok:true, out:summary, open, where:'local'});
    render();
    return document.querySelectorAll('.card').length;
  };
  window.__overflow = () => {
    const sc = document.getElementById('scroller'); const col = document.querySelector('.col720');
    const els = Array.from(document.querySelectorAll('.card,.prose,.cardbody pre,.appr'));
    const turn = document.querySelector('.turn');
    const track = turn ? parseFloat(getComputedStyle(turn).gridTemplateColumns.split(' ')[1]) : 0;
    return {sw: sc ? sc.scrollWidth : 0, cw: sc ? sc.clientWidth : 0,
            colRight: col ? Math.round(col.getBoundingClientRect().right) : 0, colWidth: col ? col.clientWidth : 0, track,
            maxRight: Math.round(Math.max(0, ...els.map((c) => c.getBoundingClientRect().right))),
            durations: Array.from(document.querySelectorAll('.card .du')).map((d) => d.textContent),
            lastTitle: (() => { const d = document.querySelectorAll('.card .du'); return d.length ? d[d.length - 1].title : ''; })()};
  };
}

/* ============================================================
   Lane B — backend switch: helpers and smoke hooks
   ============================================================ */

/** The TUI's runtime_info lines for a switch result, as system rows. */
function bswReport(res, extra) {
  if (!res || !res.ok) return;
  if (res.providerId && res.transport) {
    S.log.push({id:nid(), k:'system', text: esc('Switched active text provider to "' + res.providerId + '". New messages use ' + res.transport + '.')});
  }
  if (extra) S.log.push({id:nid(), k:'system', text: esc(extra)});
  if (res.daemonLine) S.log.push({id:nid(), k:'system', text: esc(res.daemonLine)});
  if (res.daemon === 'start-failed' && res.error) S.log.push({id:nid(), k:'system', text: esc('local-llm: ' + res.error)});
  // No "restarting" line: main has already restarted `atag serve` by the
  // time this runs, and applyStatus reports the reconnect itself.
  render();
}

/** The TUI's answer to a provider without a key: its configure step. */
function bswOpenKey(id) {
  // The entry's kind decides which configure step opens (the TUI's
  // openProviderConfigFor), so a hand-named entry gets one too; the id
  // only matches a preset when the entry was created from it.
  const entry = selProviders().find((p) => p.id === id);
  const row = (entry && KIND_ROWS.find((k) => k.kind === entry.kind)) || KIND_ROWS.find((k) => k.id === id);
  const env = (entry && entry.apiKeyEnvVar) || (row && row.env);
  SEL.err = 'no API key for ' + id + (env ? ' — enter one or export ' + env : '');
  if (row) { WIZ.row = row; WIZ.forId = id; WIZ.phase = 'configure'; WIZ.apiKey = ''; WIZ.baseUrl = (entry && entry.baseUrl) || ''; WIZ.error = SEL.err; }
  render();
}

/** Which providers have a key (the rows' `ready` copy) and, on the local route, the catalogue snapshot the chip and the gate read. */
function bswRefreshFacts() {
  if (!BR) return;
  BR.providersReady().then((r) => {
    // A failed read keeps the previous ids (and the previous "loaded" state).
    if (!(r && r.ok && Array.isArray(r.ids))) return;
    const was = JSON.stringify([BSW.readyLoaded, BSW.readyIds]);
    BSW.readyIds = r.ids; BSW.readyLoaded = true;
    if (JSON.stringify([BSW.readyLoaded, BSW.readyIds]) !== was) bswRepaint();
  });
  if (selBackend() === 'local' && !SEL.localBusy && !SEL.pulling) bswSnapshot();
}
/** The catalogue snapshot (`atag models list`): what is on disk, which is active. Resolves either way. */
function bswSnapshot() {
  if (!BR) return Promise.resolve();
  return BR.modelsList().then((res) => {
    if (!(res && res.ok)) return;
    const was = JSON.stringify([BSW.localLoaded, SEL.local]);
    SEL.local = res.models.filter((m) => !/embed|bge|nomic|jina/i.test(m.id)); BSW.localLoaded = true;
    if (JSON.stringify([BSW.localLoaded, SEL.local]) !== was) bswRepaint();
  }).catch(() => {});
}
/** The model chip, as the composer draws it: nothing when there is no model (the TUI renders no control then). */
function modelChipHtml() {
  const label = activeModel();
  return label ? '<button class="cchip modelchip" data-sel-open="model">' + esc(shortModel(label)) + ic('chevD') + '</button>' : '';
}
/**
 * What the two facts change on screen, repainted in place. These land
 * seconds after a switch or the boot — two atag subprocesses — while the
 * user may already be typing the first message; a full render() would
 * rebuild #composer, and afterChat restores the text but not the caret.
 * So: the model chip by an outerHTML swap (as repaintContextChip does),
 * and the selector overlay only while it is open, with the filter box's
 * caret carried across.
 */
function bswRepaint() {
  const foot = document.querySelector('.cfoot');
  if (foot) {
    const html = modelChipHtml();
    const el = foot.querySelector('.modelchip');
    if (el) { if (!html) el.remove(); else if (el.outerHTML !== html) el.outerHTML = html; }
    else if (html) { const spacer = foot.querySelector(':scope > span'); if (spacer) spacer.insertAdjacentHTML('beforebegin', html); }
  }
  if (!SEL.open || OB.open) return;
  const f = document.getElementById('sel-filter');
  const caret = f && document.activeElement === f ? [f.selectionStart, f.selectionEnd] : null;
  renderOverlays();
  if (caret) { const n = document.getElementById('sel-filter'); if (n) { n.focus(); n.setSelectionRange(caret[0], caret[1]); } }
}
/**
 * downloadProgressFor (src/tui/local-turn-gate.ts): the live pull line for
 * this model, in the TUI's words — `downloading now — N% · X / Y` once the
 * size is known, `downloading now…` before that, null when no pull of this
 * model is in flight. The figures are the CLI's own progress line
 * (`[=====     ] 45%  1.20 GB / 2.60 GB  file (4.2 GB)`), which is where the
 * desktop's pull boxes get them too.
 */
function bswDownloadProgress(modelId) {
  let line = null;
  if (SEL.pulling === modelId) line = SEL.pullLine || '';
  else if (MP.pulling === modelId) line = MP.pullLog[MP.pullLog.length - 1] || '';
  else if (OB.pulling && OB.pulling.id === modelId) line = OB.log[OB.log.length - 1] || '';
  if (line === null) return null;
  const m = /(\d+)%\s+([\d.]+ [KMG]B)\s*\/\s*([\d.]+ [KMG]B)/.exec(line);
  return m ? 'downloading now — ' + m[1] + '% · ' + m[2] + ' / ' + m[3] : 'downloading now…';
}

/** evaluateLocalTurnGate over LIVE_CONFIG and the cached catalogue. */
function localTurnGate() {
  const cfg = LIVE_CONFIG;
  if (!cfg) return {kind:'run'};
  const llm = cfg.llm || {};
  const providers = llm.providers || [];
  const active = providers.find((p) => p.id === llm.activeTextProvider);
  const activeIsLocal = active === undefined || active.kind === 'llama-server';
  const lm = cfg.localModels || {};
  if (!activeIsLocal || lm.mode !== 'managed') return {kind:'run'};
  const modelId = (lm.managed && lm.managed.modelId) || null;
  // Disk state comes from the catalogue snapshot; until it has landed the
  // verdict is 'pending' and submit() takes the snapshot before deciding.
  if (modelId !== null && !BSW.localLoaded) return {kind:'pending'};
  const row = modelId !== null ? SEL.local.find((m) => m.id === modelId) : null;
  if (modelId !== null && row && row.downloaded) return {kind:'run'};
  const status = modelId === null
    ? 'no local model is selected — open Models (/local) to pick and download one'
    : (bswDownloadProgress(modelId) || 'not downloaded — open Models (/local) and press Enter on it to download');
  const subject = modelId === null ? status : 'local model ' + modelId + ' is ' + status;
  // resolveFallbackChain: the configured chain (or just the active id), with local-llama appended unless appendLocal is false.
  const ids = new Set(providers.map((p) => p.id));
  const fb = llm.fallback || {};
  const requested = (fb.chain && fb.chain.length) ? fb.chain : [llm.activeTextProvider];
  const chain = [llm.activeTextProvider].concat(requested.filter((id) => ids.has(id) && id !== llm.activeTextProvider));
  if (fb.appendLocal !== false) { const local = providers.find((p) => p.kind === 'llama-server'); if (local && !chain.includes(local.id)) chain.push(local.id); }
  const length = chain.filter((id, i) => ids.has(id) && chain.indexOf(id) === i).length;
  if (length > 1) return {kind:'notice', text: subject + ' — running this turn through the fallback chain'};
  return {kind:'block', text: subject};
}

if (typeof window !== 'undefined') {
  window.__switchBackend = (kind) => selChooseBackend(kind);
  window.__activeProvider = () => selActiveProviderId() || null;
  window.__lastSystem = () => {
    for (let i = S.log.length - 1; i >= 0; i--) if (S.log[i].k === 'system') return S.log[i].text || '';
    return '';
  };
  window.__bsw = () => ({line:BSW.line, readyIds:BSW.readyIds.slice(), readyLoaded:BSW.readyLoaded, localLoaded:BSW.localLoaded, gating:BSW.gating, turnBusy:S.busy, gate:localTurnGate()});
  // What the editor holds (the gate's block path hands the message back to it).
  window.__draft = () => { const e = document.getElementById('entry'); return {draft:S.draft, entry:e ? e.value : null, users:S.log.filter((m) => m.k === 'user').length}; };
  // The late-facts repaint must leave the composer's caret where it was.
  window.__bswRepaintKeepsCaret = () => {
    const e = document.getElementById('entry'); if (!e) return null;
    e.focus(); e.value = 'typing mid-word'; e.setSelectionRange(6, 6);
    bswRepaint(); // the path both late callbacks take
    const n = document.getElementById('entry');
    const out = {same: n === e, focused: document.activeElement === n, start: n ? n.selectionStart : -1, end: n ? n.selectionEnd : -1};
    if (n) n.value = S.draft;
    return out;
  };
  // Every system line, entities decoded, so the smoke can pin the TUI's runtime_info copy.
  window.__systemLines = () => S.log.filter((m) => m.k === 'system').map((m) => {
    const t = document.createElement('textarea'); t.innerHTML = m.text || ''; return t.value;
  });
}

/* Lane B — context before the first message (item 3): smoke hooks. */
if (typeof window !== 'undefined') {
  window.__ctxOpen = () => { S.overlay = 'context'; render(); return !!document.querySelector('.popover .ctxdial'); };
  window.__ctxTitle = () => ((document.querySelector('.popover .hd') || {}).textContent || '');
  window.__ctxBasis = () => ((document.querySelector('.popover .ctxbasis') || {}).textContent || '');
  window.__ctxDraft = (t) => { S.draft = t; CTX.draftTokens = estimateTokens(t); if (CTX.source === 'projected') CTX.tokens = CTX.stablePrefix + CTX.draftTokens; render(); return CTX.tokens; };
  window.__ctxClose = () => { act('close'); render(); };
  window.__ctxChip = () => { const el = document.querySelector('.cfoot .ctxbtn'); return el ? {label:(el.querySelector('.gaugelb') || {}).textContent || '', proj:el.classList.contains('proj')} : null; };
  window.__ctxNew = () => { act('session:new'); return refreshContext().then(() => window.__ctx()); };
  // The no-trace state, against a real empty directory: the caller restores with __ctxRefresh().
  window.__ctxEmpty = (dir) => refreshContext(dir).then(() => window.__ctx());
}
