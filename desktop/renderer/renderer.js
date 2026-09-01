"use strict";

/* The Electron preload exposes window.atomic. Without it (opened as a
   plain page) the app runs the scripted demo instead of a real agent. */
const BR = typeof window !== "undefined" ? window.atomic : null;
let WORKSPACE = '';
let LIVE_CAPS = null, LIVE_CONFIG = null;

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
  agentSession:null, reasonId:null,
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
    + '<button class="sb-foot" data-act="settings:models">'
      + '<span class="dot ' + (!BR ? 'ok' : S.live.state === 'connected' ? 'ok' : S.live.state === 'starting' ? 'run' : 'bad') + '"></span>'
      + '<span>' + esc(BR ? liveLabel() : 'llama-server · ' + shortModel(S.localModel)) + '</span></button>';
}

/* ---------------- content ---------------- */
function renderContent() {
  const c = $('#content');
  if (S.room === 'chat')   { c.innerHTML = chatView(); afterChat(); return; }
  if (S.room === 'tasks')  { c.innerHTML = tasksView(); return; }
  c.innerHTML = skillsView();
}

function chatView() {
  const body = S.log.length ? '<div class="col720">' + S.log.map(item).join('') + '</div>' : emptyChat();
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
    + '<div class="prose">' + esc(m.text) + '</div></div>';
  if (m.k === 'system') return '<div class="sysrow"><span></span><span>' + m.text + '</span></div>';
  if (m.k === 'reason') return '<div class="turn"><div></div><div>'
    + '<button class="disc" data-toggle="' + m.id + '">' + ic(m.open ? 'chevD' : 'chevR') + 'Reasoning · ' + m.steps + ' steps</button>'
    + (m.open ? '<div class="discbody">' + esc(m.text) + '</div>' : '') + '</div></div>';
  if (m.k === 'tool') return '<div class="turn"><div></div><div>' + toolCard(m) + '</div></div>';
  if (m.k === 'approval') return '<div class="turn"><div></div><div>' + apprCard(m) + '</div></div>';
  return '';
}

function toolCard(m) {
  const running = m.ok === null;
  const glyph = running ? '<span class="dot run"></span>'
    : m.ok ? '<span style="color:var(--success);display:flex">' + ic('check') + '</span>'
           : '<span style="color:var(--danger);display:flex">' + ic('warn') + '</span>';
  return '<div class="card' + (running ? ' running' : '') + (m.ok === false ? ' err' : '') + '" id="card-' + m.id + '">'
    + '<button class="cardhead" data-toggle="' + m.id + '" aria-expanded="' + (!!m.open) + '">'
      + glyph + '<span class="nm">' + esc(m.name) + '</span><span class="ar">' + esc(m.arg) + '</span>'
      + '<span class="du tnum">' + (running ? '…' : dur(m.ms)) + '</span>'
      + '<span class="ter" style="display:flex">' + ic(m.open ? 'chevD' : 'chevR') + '</span>'
    + '</button>'
    + (m.open ? '<div class="cardbody">'
        + (m.args ? '<div class="micro sec">Args</div><pre>' + esc(m.args) + '</pre>' : '')
        + '<div class="micro sec">Result</div><pre>' + esc(m.out || '—') + '</pre></div>' : '')
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
  const gaugePct = Math.max(2, Math.min(100, Math.round((ctxUsed() / ctxTotal()) * 100)));
  return '<div class="composerwrap">' + status + q
    + '<div class="composer' + (running ? ' running' : '') + '" id="composer">'
      + (S.slash ? slashPopover() : '')
      + '<div class="field"><textarea id="entry" rows="1" placeholder="' + (running ? 'Send to steer this turn…' : 'Ask for an outcome, or / for a command') + '"></textarea>'
      + sendButton() + '</div>'
      + '<div class="cfoot">'
        + '<button class="cchip" data-act="settings:models">' + ic('cpu')
          + esc(shortModel(activeModel())) + ic('chevD') + '</button>'
        + '<span style="flex:1"></span>'
        + '<button class="cchip ctxbtn" data-act="context" title="Context window">'
          + '<span class="gauge"><i style="width:' + gaugePct + '%"></i></span>'
          + '<span class="tnum gaugelb">' + tok(ctxUsed()) + '/' + tok(ctxTotal()) + '</span></button>'
        + '<button class="cchip" data-act="settings:privacy">' + ic('key') + 'L' + S.level + ' ' + LEVEL_NAMES[S.level].toLowerCase() + ic('chevD') + '</button>'
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



function contextHTML() {
  const total = ctxTotal(), used = ctxUsed();
  return '<div class="scrim" data-close="1" style="background:transparent">'
    + '<div class="popover" style="width:300px;' + anchorStyle('.ctxbtn', 300) + '">'
    + '<div style="padding:12px 16px 10px"><div class="hstack"><span class="hd">Context window</span>'
      + '<span class="mono tnum sec" style="margin-left:auto">' + tok(used) + ' / ' + tok(total) + '</span></div>'
    + '<div class="ctxbar"><i style="width:' + Math.min(100, (used / total) * 100) + '%;background:var(--accent)"></i>'
      + '<i style="flex:1;background:var(--bg-sunken)"></i></div>'
    + '<p class="cap" style="margin:10px 0 0">An estimate from the transcript this window has sent. '
      + 'The agent also carries a system prompt, tool definitions and tool output that it does not report back, '
      + 'so the real figure is higher.</p></div>'
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
    '<button class="stopwrap' + (n <= S.level ? ' filled' : '') + (n === S.level ? ' on' : '') + '" data-act="level:' + n + '">'
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
  const close = () => { S.overlay = null; S.menuOpen = null; S.scope = null; S.q = ''; S.cur = 0; S.alert = null; };

  if (a === 'close') { close(); render(); return; }
  if (a === 'palette') { close(); S.overlay = 'palette'; render(); return; }
  if (a === 'palette:slash') { close(); S.overlay = 'palette'; S.q = ''; render(); toast('Slash commands', 'Type / in the composer for the in-context list'); return; }
  if (a === 'shortcuts') { close(); S.overlay = 'shortcuts'; render(); return; }
  if (a === 'context') { close(); S.overlay = 'context'; render(); return; }
  if (a === 'runmode') { close(); S.dialShare = S.share; S.overlay = 'runmode'; render(); return; }
  if (a === 'applydial') { S.share = S.dialShare; if (S.mode !== 'fusion' && S.dialShare > 0) S.mode = 'fusion'; close(); render(); toast('Run type applied', S.mode + (S.mode === 'fusion' ? ' · cloud share ' + S.share : '')); return; }
  if (a === 'session:new') { close(); S.log = []; S.history = []; S.agentSession = null; S.busy = false; S.pending = null; S.room = 'chat'; render(); toast('New session', 'The next turn starts fresh'); return; }
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
  if (k === 'level')     { S.level = +v; close(); S.settings = 1; S.settingsPane = 'privacy'; render(); toast('Approval level ' + v, LEVEL_NAMES[+v]); return; }
  if (k === 'cards')     { close(); S.log.forEach((m) => { if (m.k === 'tool') m.open = v === 'expand'; }); render(); return; }
  if (k === 'ses')       { close(); S.sessionId = v; render(); return; }
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
  const [caps, cfg, skills, tasks, sessions] = await Promise.all([
    BR.capabilities(), BR.config(), BR.skills(), BR.tasks(), BR.sessions(),
  ]);
  if (caps && caps.ok && caps.data) {
    LIVE_CAPS = caps.data;
    if (caps.data.agent && typeof caps.data.agent.approvalLevel === 'number') {
      S.level = Math.max(1, Math.min(5, caps.data.agent.approvalLevel));
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
      id:x.id || ('s' + i), t:x.title || x.goal || x.id, g:'RECENT',
      sub:(x.turns ? x.turns + ' turns' : 'session'), st:'',
    }));
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
  BR.chat(S.history.slice()).then((res) => {
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
    const arg = summariseArgs(pick(ev.payload, 'arguments', 'args', 'input'));
    const card = {id:nid(), k:'tool', name, arg, where:S.mode === 'cloud' ? 'cloud' : 'local',
                  ok:null, open:false, args:JSON.stringify(pick(ev.payload, 'arguments', 'args', 'input') ?? {}, null, 2)};
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
    S.log.forEach((m) => {
      if (m.k === 'tool' && m.ok === null) { m.ok = true; m.out = m.out || '(result not exposed by the HTTP stream)'; m.ms = 0; }
    });
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
    if (p && p.kind !== 'llama-server' && p.defaultChatModel) return p.defaultChatModel;
    return S.localModel;
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
