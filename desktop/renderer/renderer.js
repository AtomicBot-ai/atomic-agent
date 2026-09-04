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
/* `seq` counts the mode POSTs this window has issued — the CTX.seq idiom
   one surface over. Both writers capture it before the request and drop
   their reply if a newer choice has been made since, so a re-assert that
   was already in flight cannot repaint the chip over an explicit click. */
/* `known` is the review fix: `current` starts on the SEED 'default', which is
   a guess, not the agent's answer. Before the first GET resolves — and after a
   GET or POST that came back !ok (agent-client returns {ok:false,
   supported:true} for a timeout or a network error) — the window has no
   confirmed stance, and at the operator's approvalLevel 5 the live stance is
   really `bypass`. `known` goes true only when the route answers, and the chip
   prints the same blank it prints for a routeless agent until then. */
const MODE = { current:'default', supported:null, baseLevel:null, approvalLevel:null, seq:0, known:false };
/* src/approval/approval-level.ts MAX_APPROVAL_LEVEL. The two base-5
   disclosures below and clampLevel all read it rather than the literal, so a
   ladder that grows a rung moves the copy with it instead of leaving
   "5 of 5" firing at the wrong ceiling. */
const MAX_APPROVAL_LEVEL = 5;
/* Item 6 (coding mode): the last mode this window explicitly chose. The
   stance is process state in the agent, so a backend switch — which
   restarts it — drops back to the boot stance; this is what lets the
   reconnect re-assert the operator's choice instead of painting a stale
   label. `null` until something is chosen, and nothing is re-asserted
   then. */
let LAST_MODE = null;
/* Item 6 (coding mode): a re-assert waiting for a running turn to end.
   `{mode, timer}` while one is queued, `null` otherwise. The reconnect
   path must not drop the operator's choice just because a turn happened
   to be in flight when the agent came back. */
let MODE_REASSERT = null;
/* The add-provider wizard: pick_kind → configure → verifying.
   r5 item 7 review fix: `cur` and `q` exist because the onboarding cloud
   step's footer is the TUI's `↑/↓ move   / search   enter select …` and a
   hint strip must not advertise a chord the step does not accept. `q` is
   null while the search box is closed; the Settings-side wizard ignores
   both fields and renders exactly as it did. */
const WIZ = { phase:null, row:null, apiKey:'', baseUrl:'', error:null, busy:false, cur:0, q:null };
/* Kind rows in the TUI's KIND_ROW_ORDER, minus the two subscription-CLI
   kinds, whose config shape the desktop does not write. */
const KIND_ROWS = [
  {id:'openrouter', kind:'openrouter', label:'OpenRouter (cloud chat + optional cloud embed)', env:'OPENROUTER_API_KEY', defaultModel:'openrouter/auto'},
  {id:'aimlapi', kind:'aimlapi', label:'AI/ML API (1000+ models, OpenAI-compatible)', env:'AIMLAPI_API_KEY'},
  {id:'gemini', kind:'gemini', label:'Gemini (Google AI)', env:'GEMINI_API_KEY'},
  {id:'openai-compatible', kind:'openai-compatible', label:'OpenAI-compatible API (custom base URL)', custom:true, defaultModel:'gpt-5.4-mini'},
];
const OPEN_GROUPS = new Set();
/* item 5 review fix (attachment strip): every file chip — the inline ones and
   the strip's — opens through this one seam, so the smoke can assert that a
   strip chip really is clickable (which path the click hands to BR.openPath)
   without launching an application on the operator's Mac. */
let LAST_OPEN_PATH = null, OPEN_PATH_DRYRUN = false;
function openFilePath(p) {
  LAST_OPEN_PATH = p;
  if (OPEN_PATH_DRYRUN) return Promise.resolve({ok:true, dryRun:true});
  return BR.openPath(p);
}
/* Lane B — context before the first message (item 3). `source` is
   'provider' | 'estimate' (the trace, after a turn), 'built' (the branch
   route's own prompt), or 'projected' — the turn-0 scaffold of the last
   prompt this agent built in this workspace plus the draft's estimate,
   always drawn with a '~' and the word "projected" until something real
   replaces it. `previewSupported` caches the route's 404 per connection
   the way MODE.supported does; `seq` drops a refresh that lost the race. */
const CTX = { tokens:0, source:null, stablePrefix:0, tail:0, draftTokens:0, cacheHitTokens:null, modelId:null,
  window:null, windowLabel:'', baseline:null, sections:null, pairsCap:0, reserved:0,
  previewSupported:null, seq:0, chipTimer:null, draftTimer:null };
/* All four modes are live over GET/POST /api/coding-mode, plan included:
   the route moves the runtime's approval ladder AND its plan flag, the
   same pair the TUI's onCodingModeChanged moves, and writes nothing to
   config. Copy is the TUI's verbatim; the route also returns its own
   `look`, which setCodingMode prefers so the two cannot drift. */
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
/* What is left of the prototype's Models pane after Settings › LLM replaced
   it (review fix): no rows of its own any more — only the provider-add and
   model-search writers, which the `--smoke --models` harness drives directly
   and which write through the same main-process helpers the LLM tab uses. */
const MP = {
  addOpen: false, presetCur: 0, apiKey: '',
  pickFor: null, pickQuery: '', picks: [], pickBusy: false, pickErr: null,
  busy: false, err: null,
};
/* ============================================================
   r5 item 7 — SETUP WIZARD: state, copy and constants.
   Hoisted because the render path reads every name in here and the
   prototype's first synchronous render() runs long before the wizard's
   own code.  The flow itself (reducer, key router, screens, star field)
   is a block of function declarations further down.

   OB is `OnboardingUiState` (src/tui/onboarding/onboarding-state.ts:59-98)
   verbatim: sixteen fields, same names, same nulls, same meanings.
   `open` stands in for the TUI's `TuiState.onboarding === null` render
   switch, and the desktop-side caches under it hold what the TUI reads
   from hooks this window does not have.
   ============================================================ */
const OB = {
  open: false,
  // --- OnboardingUiState, verbatim ---
  step: 'intro',
  offer: null,
  resumeAfterCloud: null,
  localModelId: null,
  outcome: null,
  skipSecondOffer: false,
  cursor: 0,
  chatUrl: '',
  embeddingUrl: '',
  busy: false,
  error: null,
  hfReference: '',
  hfRepo: null,
  importAgents: [],
  importOptions: [],
  importReport: null,
  // --- desktop-side caches the screens render from ---
  /** `atag models list` (chat half), the only catalogue this window has. */
  models: [],
  ram: 0,
  keyEnv: {},
  /** providersReady() ids — the cloud offer is hidden once one exists. */
  cloudReady: false,
  /** Intro two-stage advance (use-intro-input.ts:57-67): first input
   *  finishes the typewriter, the second dismisses. */
  introTyped: false,
  /** The operator's existing ~/.atomic-agent, from the isolation lane's
   *  tuiSetupPresent(); null until scanned, {present:false} when absent. */
  tuiSetup: null,
  /** True while the flow is closing itself down (the finished effect). */
  settling: false,
  /** Smoke only — see the note in obSettle. Never set outside the harness. */
  testClose: false,
  /** A vision model's projector, fetched after its weights land. */
  pendingMmproj: null,
  /** Whether an IPC on the way here already bounced `atag serve`. */
  restarted: false,
  /** r5 item 7 review fix: the in-flight `useManagedMode()` write. Picking
   *  local records managed mode NOW so a quit mid-download does not lose
   *  the choice — but `models update` REFUSES outside managed mode
   *  (models-handlers.ts:728-731), so the runtime phase has to wait for
   *  that write to land rather than race it. */
  managedWrite: null,
};

/* ONBOARDING_CHOICES (onboarding-state.ts:130-155), verbatim and in order
   — the order is load-bearing, the 1–3 digits are positional. */
const OB_CHOICES = [
  {id:'local', label:'Local models', detail:[
    'llama.cpp on this machine. Private, free per token,',
    'one download of 2.7–22 GB.']},
  {id:'cloud', label:'Cloud models', detail:[
    'OpenRouter, Anthropic, Gemini, Groq and 20 more.',
    'Fastest to a working agent — needs an API key.']},
  {id:'custom', label:'Custom endpoint', detail:[
    'An OpenAI-compatible or llama-server URL you already run.',
    'Nothing is downloaded, nothing else is asked.']},
];

/* ONBOARDING_SUBTITLES (onboarding-chrome.ts:13-29), verbatim. */
const OB_SUBTITLES = {
  intro: '',
  choose: 'setup · step 1 of 2',
  local_pick: 'local models · step 2 of 2',
  local_hf_ref: 'local models · hugging face',
  local_hf_pick: 'local models · choose a file',
  local_download: 'local models · downloading',
  propose_second: 'one more thing',
  wait_or_jump: 'almost there',
  import_pick: 'bring your data · one last step',
  import_preview: 'bring your data · preview',
  import_done: 'bring your data · done',
  cloud: 'cloud model · step 2 of 2',
  custom_chat_url: 'custom endpoint · step 2 of 2',
  custom_embedding_url: 'custom endpoint · embeddings',
  finished: 'setting up…',
};

/* Copy tables, each verbatim from the component named beside it. */
const OB_COPY = {
  // onboarding-choose-step.tsx:30-33
  chooseExplainer: [
    'atomic-agent can drive models three ways. Nothing here is permanent — you',
    'can add the others at any time from the menu.'],
  // onboarding-intro-step.tsx:53 / :12, logo.tsx TAGLINE
  tagline: 'Local AI-First Agent',
  taglineMsPerChar: 45,
  pressAnyKey: '[ press any key to continue ]',
  wordmark: 'ATOMIC',
  // onboarding-header.tsx:9
  headerWordmark: 'atomic',
  // onboarding-local-pick-step.tsx:25-27, :108
  localHeading: 'Recommended models',
  // onboarding-url-step.tsx:8-19
  urlHealthNote: '(must answer GET /health)',
  urlChatTitle: 'Base URL of your chat llama-server ',
  urlEmbeddingTitle: 'Base URL of your embedding llama-server ',
  urlEmbeddingNote: 'Optional — leave it empty to continue without hybrid embedding recall.',
  urlChatPlaceholder: 'http://127.0.0.1:8080',
  urlEmbeddingPlaceholder: 'http://127.0.0.1:19092',
  urlProbing: 'probing /health…',
  // onboarding-download-step.tsx:18-38
  cloudOffer: ['Don’t want to wait? Set up a cloud model in the meantime —',
               'it takes about a minute, and the download keeps running.'],
  cloudOfferFailed: 'Set up a cloud model instead — it takes about a minute.',
  cloudOfferKey: 'press c',
  skipOffer: ['Or skip the wait — start using the agent now. The download',
              'keeps running; progress shows in the top bar.'],
  skipOfferFailed: 'Or skip — start using the agent without a local model.',
  skipOfferKey: 'press s',
  // onboarding-download-progress.tsx:63-79
  phaseRuntime: 'llama.cpp runtime',
  phaseWeights: 'model weights',
  starting: 'starting…',
  // onboarding-wait-or-jump-step.tsx / onboarding-screen.tsx:63
  cloudReadyLabel: 'Cloud model ready',
  // onboarding-propose-step.tsx:11-33
  proposeExplainer: [
    'atomic-agent runs both side by side — local for private or offline work,',
    'cloud for the heavy turns, switchable mid-session. You have one of the two.'],
  proposeSkip: {label:'Skip — take me to the agent', detail:'you can add it later from the menu (esc)'},
  // onboarding-import-step.tsx:25-34, :200-212; import-step.ts:80-85
  importExplainer: [
    'Other agents keep skills, memory, sessions and keys on this machine.',
    'Tick which ones to bring into atomic-agent — nothing is written before',
    'you see a preview, and nothing is ever removed from the source.'],
  importSkipLabel: 'Skip adding data from other agents',
  importSkipDetail: 'Go straight to your agent — /import works any time later.',
  importScanning: 'scanning the sources…',
  importRunning: 'importing…',
  importPreviewActionable: 'Here is what an import would do:',
  importPreviewNothing: 'Nothing new to import — everything is already here or empty.',
};

/* ---- the intro's star field ----------------------------------------
   Ports src/tui/onboarding/star-field.ts, star-tiers.ts, orbit-field.ts
   and mark-clear-space.ts.  Every tuned constant is carried over; TWO
   are deliberately re-tuned for a pixel canvas, and this is the record
   of that call rather than a claim that they carried over unchanged:

   (1) CELL_ASPECT is 1, not orbit-field.ts's 2.2.  That constant exists
       because a terminal cell is ~2.2× taller than it is wide; a square
       pixel cell is 1, and with it the halo ellipse becomes the circle
       the TUI was only ever approximating.
   (2) The cell is 14 CSS px.  At the intro's real size (~1000×700) that
       is a ~71×50 grid, so `columns × rows × 0.08` targets ~284 stars —
       past the 220 the frame budget allows.  The CAP GOVERNS THE COUNT
       there, not STARS_PER_CELL; the density constant still governs the
       relative weight of clusters against open field, which is what it
       is really for.  CLUSTER_SPACING 11 over that grid's geometric mean
       side (~60) asks for 5 clusters against the TUI's 4, and
       `columns / 8` lands at ~8.9 cells — inside the [5,16] clamp, and
       the same fraction of the canvas width the TUI's 12-of-96 is, so
       the clamp does not bind and a cluster reads at the size it was
       tuned to read at.
   ------------------------------------------------------------------ */
const OB_SKY = {
  CELL_ASPECT: 1,
  CELL_PX: 14,
  STARS_PER_CELL: 0.08,
  CLUSTERED_SHARE: 0.62,
  MIN_CLUSTERS: 2,
  MAX_CLUSTERS: 6,
  CLUSTER_SPACING: 11,
  MIN_CLUSTER_RADIUS: 5,
  MAX_CLUSTER_RADIUS: 16,
  PLACEMENT_ATTEMPTS: 4,
  CENTRE_ATTEMPTS: 24,
  HALO_JITTER_COLUMNS: 2,
  HALO_JITTER_ROWS: 1,
  HALO_GAP_CHANCE: 0.25,
  HALO_PHASE: Math.PI / 12,
  DEFAULT_SEED: 82,
  HALO_COUNT: 26,          // SKY_BY_TIER.full.halo (onboarding-intro-step.tsx)
  CLEAR_GAP_ROWS: 2,       // intro-art.ts CLEAR_GAP_ROWS
  CLEAR_GAP_COLUMNS: 4,    // intro-art.ts CLEAR_GAP_COLUMNS
  MAX_STARS: 220,          // the desktop's frame budget; see (2) above
  FPS: 30,
  MARK_PX: 88,
};
/* star-tiers.ts CLUSTER_TIERS / FIELD_TIERS / HALO_TIERS, verbatim. */
const OB_CLUSTER_TIERS = [['bright',0.06],['mid',0.18],['dim',0.3],['faint',0.46]];
const OB_FIELD_TIERS   = [['bright',0.01],['mid',0.08],['dim',0.26],['faint',0.65]];
const OB_HALO_TIERS    = [['bright',0.14],['mid',0.28],['dim',0.34],['faint',0.24]];
/* The glyph ramp becomes radius, alpha and a theme token — the four
   brightnesses the TUI encodes in `· ✧ ✦ ✛`, drawn instead of written. */
const OB_TIER_LOOK = {
  faint:  {r:0.6, a:0.35, token:'--text-tertiary', drift:0.35},
  dim:    {r:0.9, a:0.55, token:'--accent-text',   drift:0.55},
  mid:    {r:1.3, a:0.80, token:'--accent-text',   drift:0.80},
  bright: {r:1.8, a:1.00, token:'--text-primary',  drift:1.00},
};
/** Live canvas state for the intro sky. Never read outside obSky*. */
const OBSKY = {
  canvas:null, ctx:null, stars:[], raf:0, t0:0, frames:0, running:false,
  reduced:false, tick:0, w:0, h:0, dpr:1, cx:0, cy:0, colours:null, mq:null,
  typer:0, typed:0,
  /* r5 item 7 review fix: ONE reduced-motion source. `reduced` is the
     resolved answer every path reads (the canvas loop, the typewriter and
     obIntroHTML's first paint alike); `override` is null in production and
     is the only thing a test-only setter is allowed to move, so forcing
     the flag drives the same code the media query drives. */
  override:null,
};

/* ---- the persistent download strip (#dlbar) -------------------------
   The TUI's DownloadChip (download-chip.tsx) lives in the status bar and
   its doc says the download "survives the screen that started it"; the
   onboarding copy promises the same thing twice in words.  So the
   desktop's download lives here, in the window chrome, and BOTH the
   strip and the wizard's own download screen render from this one slice.

   `job` is the head of the queue; `queue` the rest.  Main single-flights
   downloads, so a runtime phase and a weights phase are two jobs run in
   order, not two bars.  Nothing here is interpolated: the CLI emits one
   sample per 5% and these numbers move in those steps.
   ------------------------------------------------------------------ */
const DL = {
  job: null,        // {kind, id, label, percent, transferredBytes, totalBytes, at}
  queue: [],        // [{kind, id, label}]
  rate: null,       // bytes/s, EMA over the real samples only
  last: null,       // {bytes, at} — the previous sample
  error: null,
  /** r5 item 7 review fix: a failed `models update` is NOT the model
      download failing, and it must not be reported as one — nor may it
      clear itself when the weights land. Kept apart from `error`, which
      dlStatus() reads to decide the wait_or_jump screen's three states. */
  runtimeError: null,
  /** The two rows the TUI's OnboardingDownloadProgress draws.
      `drove` records whether THIS window moved bytes for the phase —
      `models update` exits 0 having downloaded nothing when the version
      file already names the latest tag (models-handlers.ts:734-745). */
  runtime: {state:'done', percent:0, transferredBytes:0, totalBytes:0, drove:false},
  weights: {state:'waiting', percent:0, transferredBytes:0, totalBytes:0, drove:false},
  /** Smoke only: a seeded queue drives the bar without spawning a child. */
  dry: false,
};
/* r5 item 7 review fix (hoisting): every const the render path reads has
   to be declared above the first top-level render(). These five sat next
   to the functions that use them, several hundred lines below it — safe
   only because OB.open starts false, and a TDZ ReferenceError inside the
   first paint the moment anything opens the flow synchronously. */
const OB_DEFAULT_LLAMA_URL = 'http://127.0.0.1:8080';   // USER_CONFIG_DEFAULTS.localModels.url
/* Which leading tokens of a hint are the chord rather than the sentence.
   The footer is one string in the TUI because a terminal has no chips;
   this splits it back apart so the desktop can draw the keycaps it has. */
const OB_KEY_TOKEN = /^(↑\/↓|enter|esc|ctrl\+[a-z]|space|any|key|empty|1–3|\/|c|s)$/;
/* The tui.onboarding.* stamps already written in THIS window session. */
const OB_STAMPED = {};
/* Smoke only: every stamp write this session attempted, in order, so the
   suite can assert the TUI's write-on-ARRIVAL timing rather than merely
   that a stamp exists somewhere in a config file earlier runs also wrote. */
const OB_STAMP_LOG = [];
/* The step obAfterStep last ran its arrival effects for. */
let OB_LAST_STEP = null;
/* The import row for the operator's own terminal setup (see the note by
   obImportRegistry): no `atag import` source can reach it. */
const OB_TUI_AGENT_ID = 'atomic-tui';
/* Lane B — backend switch. What the chips and rows read while a switch
   runs in main: `line` is the popup's status text, `readyIds` the cloud
   providers with a usable key (the TUI's hasApiKey), `localLoaded`
   whether the local catalogue snapshot has landed — the model chip only
   says "download model" once it has, as the TUI's does — and `readyLoaded`
   whether the key facts have landed at all: until they have, the rows say
   "checking keys…" rather than a "no API key" that is not known yet. */
const BSW = { line:'', readyIds:[], readyLoaded:false, localLoaded:false, gating:false };

/* ---- Item 7: settings surface — the TUI menu tree + the Manage tabs ----
   MENU_GROUPS mirrors src/tui/menu/menu-registry.ts (MENU_GROUP_ORDER,
   MENU_GROUP_LABELS, every node label and its ctrl+g chord, in registry
   order) with ONE deliberate divergence, made on the user's instruction
   ("Remove Go and Observe points from the menu"): the `Go` group and its
   `Observe` submenu are not rendered. Manage's eight children are hoisted
   to a top-level group labelled `Manage`, keeping their node ids, labels
   and chords, so every settings tab stays reachable and the group list
   reads Manage · Session · Model · Run · Setup · Help · Danger zone.
   Nothing became unreachable: Run is ⌘1 and the palette's Chat row;
   Observe's Feed/World/Reasoning are the toolbar's inspector button, the
   palette rows and the slash verbs; Logs and LLM logs are ⌘⇧Y plus the
   console's own Agent/LLM segment; the debug pane is that same ⌘⇧Y and
   the toolbar's console button. What DOES go dead is six ctrl+g chords —
   r, f, w, e, o and L. chordKey swallows an unmatched key silently, so
   ctrl+g r now eats one keystroke and does nothing; that is left silent
   deliberately, because a toast naming a route the user asked to remove
   would reintroduce the menu entry in another form.
   A node with `tab` switches the right-hand panel; `na` marks a node the
   desktop has no implementation for — it is drawn with the TUI label and
   a muted note, never dropped. */
const MENU_GROUPS = [
  ['Manage', [
    {id:'go.manage.tasks', label:'Tasks', chord:'t', tab:'tasks'},
    {id:'go.manage.skills', label:'Skills', chord:'s', tab:'skills'},
    {id:'go.manage.memory', label:'Memory', chord:'m', tab:'memory'},
    {id:'go.manage.mcp', label:'MCP', chord:'c', tab:'mcp'},
    {id:'go.manage.llm', label:'LLM', chord:'l', tab:'llm'},
    {id:'go.manage.telegram', label:'Telegram', chord:'g', tab:'telegram'},
    {id:'go.manage.import', label:'Import', chord:'i', tab:'import'},
    {id:'go.manage.privacy', label:'Privacy', chord:'p', tab:'privacy'},
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
    {id:'run.steer', label:'Steer the running turn'},
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
  // The `go.run`, `go.observe.*` and `go.debug` entries went with their nodes
  // (see the divergence note above); their destinations keep every other route.
  'session.new':'session:new', 'session.switch':'session:switch', 'session.clear':'clear',
  'session.context':'context', 'session.id':'session:id',
  'model.chat':'selector:model',
  'run.mode':'modes', 'run.abort':'stop', 'run.expand':'cards:expand', 'run.collapse':'cards:collapse',
  'run.steer':'steer',
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
/* r4-ui item 5: Escape opened the settings window on its menu column, so the
   first menu row should carry the focus ring. renderSettings removes and
   rebuilds #settings on EVERY render() — a stream frame, the tasks poll, the
   diagnostics poll — which would drop that focus after a single frame. So the
   intent is a flag and renderSettings re-applies it; the flag is dropped the
   moment the focus is no longer on that first row — moved to another control,
   or blurred to <body> by a click on dead space — or the window closes. */
const MENUFOCUS = { want: false };
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

/* ---- Item 7 part B: the Skills, Memory and MCP tabs ----
   Render-visible state for the three panels, in the hoisted block for the
   same TDZ reason as everything above it. */
/* Skills panel — the TUI's SkillsPanelState minus `rows` (those live in
   SK.rows, from `atag skill list`). `msg` is the orchestrator's runtime_info
   line for the last action; `restart` marks the ones the running `atag
   serve` only picks up after a restart (its registry is boot-time). */
const SKP = {
  mode:'list', cursor:0, filter:'all', auto:true, busy:false,
  detailName:null, detailBody:null, lastError:null, msg:null,
  hubRows:[], hubCursor:0, hubQuery:'', hubSearchEditing:false, hubLoading:false, hubError:null, hubSeq:0,
  installing:false, installError:null, installConfirm:null,
  hubCard:null, hubCardLoading:false, cardScroll:0, removeConfirm:null, timer:null,
  detailSource:null, // 'route' (GET /api/skills/{name}) | 'skillShow' (`atag skill show`) — which source filled detailBody
  routeOverride:null, // --smoke only: a substitute answer for the route, so the skill-show fallback can be driven on 0.5.4 (its registry never 404s a skill disabled after boot)
};
const SKP_FILTERS = ['all','enabled','disabled']; // skills-filter.ts FILTER_ORDER
const SKP_MAX_ROWS = 14, SKP_HUB_ROWS = 12, SKP_DETAIL_LINES = 32, SKP_CARD_LINES = 24; // skills-panel.tsx / skills-hub-list.tsx / skills-detail.tsx / HUB_CARD_BODY_WINDOW
/* Memory panel — the TUI's MemoryPanelState. Rows come from read-only
   sqlite over <stateDir>/memory.sqlite (app:memoryQuery, named statements). */
const MEM = {
  mode:'list', channel:'profile', available:['profile','notes'], rows:[], cursor:0, search:'',
  notesFilter:'active', lastRefreshedAt:null, loading:false, auto:true,
  detailRowKey:null, detail:null, lastError:null, channelHint:null, timer:null, seq:0,
  cfg:null, cfgBusy:false, // `atag config get memory` — the effective flags when the user file has no memory.* key
  expandRuns:0, expandQueries:0, // g expand graph: completed walks and the links.outgoing/incoming statements they ran (the smoke tells a walk from the no-op)
};
const MEM_CHANNEL_ORDER = ['profile','notes','lessons','procedures','links','votes'];
const MEM_NOTES_FILTERS = ['active','archived','all'];
const MEM_MAX_ROWS = 14, MEM_DETAIL_LINES = 28, MEM_NOTES_LIMIT = 200, MEM_INDEX_LIMIT = 100, MEM_LINKS_LIMIT = 500, MEM_VOTES_LIMIT = 100; // memory-panel.tsx / memory-detail.tsx / memory-orchestrator.ts (lesson/procedure index max 100 in their stores)
/* MCP panel — the TUI's McpPanelState. Rows come from config (mcp.servers)
   and the `mcp.<name>.*` tools in /api/capabilities; there is no MCP status
   route on this agent, so no state / resources / prompts. */
const MCP = {
  mode:'list', cursor:0, detailTab:'tools', detailCursor:0, detailName:null,
  lastRefreshedAt:null, loading:false, auto:true, lastError:null, msg:null,
  addModal:null, removeConfirm:null, timer:null, seq:0, inflight:null,
};
const MCP_TAB_ORDER = ['tools','resources','prompts'];
const MCP_MAX_ROWS = 14;

/* ---- Item 7 part C: the LLM, Telegram and Import tabs ----
   Render-visible state for the three panels, hoisted for the same TDZ
   reason as everything above. */
/* LLM panel — the TUI's LlmPanelState (mode + one cursor per pane) with
   what the desktop reads instead of the TUI's in-process orchestrators:
   `atag models list` / `list-embeddings` / `status`, the provider's model
   list from `atag models search --json`, /health for the External row,
   and the key names present in the Electron env ∪ <stateDir>/.env. */
const LLMP = {
  mode:'local', cursor:{local:0, cloud:0, external:0, fallback:0}, view:'panel', // view: 'panel' | 'logs' (the `L` LLM-logs screen)
  status:null, statusBusy:false, statusErr:null, // `atag models status`
  local:null, localBusy:false, localErr:null, lastRefreshedAt:null, // `atag models list` rows
  emb:null, embDaemon:null, // `atag models list-embeddings` rows + its trailer
  models:[], modelsFor:null, modelsBusy:false, modelsErr:null, // `atag models search --json` for the Cloud text-models block
  filter:'', filterFocused:false, pricing:'all',
  health:null, // /health.llama for the External row's status
  envKeys:null, dotenvKeys:null, // key NAMES present (never values)
  busy:false, statusLine:null, statusSource:null, msg:null,
  confirm:null, // {kind:'removeProvider'|'removeLocal'|'removeEmbedding', id, error, submitting}
  externalDraft:null, externalInvalid:false, steerUrl:null,
  fallbackPicker:null, // {cursor}
  daemonPhase:null, // 'starting' | 'stopping' while a `models start|stop` runs (the TUI's daemonPhase)
  logs:null, logsTimer:null, logsBusy:false,
  pulling:null, pullLog:[], // {kind:'chat'|'embedding', id} while a `models pull[-embedding]` streams
  timer:null, seq:0, inflight:null,
};
const LLM_PANEL_MODES = ['local','cloud','external','fallback']; // llm-panel-state.ts LLM_PANEL_MODES
const LLM_MODE_LABELS = {local:'Local', cloud:'Cloud', external:'External llama.cpp', fallback:'Fallback'}; // llm-panel.tsx MODE_LABELS
const LLM_MODEL_WINDOW = 12; // llm-mode-rows.tsx MODEL_WINDOW
const LLM_LOG_LINES = 30; // local-llm-logs-panel.tsx DEFAULT_MAX_LINES
/* Telegram panel — the TUI's TelegramPanelState minus the channel facts
   the serve API does not expose (channelState, botUsername, botId). */
const TG = {
  // `keysChain` serializes tgRefresh — see the note on that function.
  keysKnown:false, dotenvKeys:[], envKeys:[], keysBusy:false, keysChain:null,
  showAdvanced:false, mode:'list', token:{error:null, submitting:false},
  message:null, lastError:null, busy:false,
  cfg:null, cfgBusy:false, // `atag config get telegram` — the effective values when the user file has no telegram.* key
};
/* Import panel — the TUI's ImportPanelState; the form is
   createInitialImportFormState (hermes, ~/.hermes, sessions+cron on). */
const IMP = {
  mode:'configure', form:{source:'hermes', sourceDir:'', sessions:true, cron:true, secrets:false, overwrite:false, limit:'', focus:'sourceType'},
  report:null, reportExecuted:false, notice:null, state:null, defaults:null, runs:0, busy:false,
};
const IMP_TOGGLE_FIELDS = ['sessions','cron','secrets','overwrite'];
const IMP_REPORT_ROWS = 12; // import-panel.tsx maxRows
const PROVIDER_KEY_ENV_FALLBACK = {openrouter:'OPENROUTER_API_KEY', anthropic:'ANTHROPIC_API_KEY', gemini:'GEMINI_API_KEY', groq:'GROQ_API_KEY', aimlapi:'AIMLAPI_API_KEY', openai:'OPENAI_API_KEY'}; // agent-cli.ts PROVIDER_KEY_ENV, the env names the LLM tab asks about
const TG_PAIRING_NOTE = 'Pairing needs the live channel — open the Telegram tab in `atag tui` to pair';

/* ---- Item 5: file attachments — what a turn actually wrote ----
   The strip under an assistant reply is sourced ONLY from write-tool cards.
   A path the reply merely mentions is already a chip inline (renderProse);
   calling it "Saved to" would be provenance the turn never had. os.fs.trash
   deletes, os.shell.run / skill.run_script name nothing they wrote (their
   results carry cmd/args/cwd/exitCode only), so shell redirects are NOT
   inferred — those tools are deliberately absent from this set.
   The complete inventory of file-producing tools on this agent is these four
   plus os.fs.trash as a deleter; memory.* writes the agent's own store and
   os.git.* here is blame/branch/diff/log/show/status only. */
const WRITE_TOOLS = new Set(['os.fs.write', 'os.fs.edit', 'os.fs.patch', 'os.fs.archive.extract']);
/* One `Saved to <path>` line per file, then `…and N more`; the chips below
   still carry every file. */
const ATTACH_MAX_LINES = 8;
/* app:statPaths stats at most 64 paths per call, so longer lists are chunked. */
const ATTACH_STAT_CHUNK = 64;


/* ---- Item 2: voice input ----
   State the render path reads, hoisted for the same TDZ reason as
   everything above it. Dictation is Apple's on-device SpeechAnalyzer behind
   the main process's speech helper: the renderer opens the microphone, the
   helper transcribes on this Mac, and nothing is uploaded.
   `state` is idle | starting | recording | finishing | error.
   `final` is every finished segment concatenated in order — the helper
   emits one final per SEGMENT, not one per session — and `partial` is the
   last volatile line, cleared the moment its final lands (otherwise the
   closing sentence is inserted twice, because every segment ends
   partial-then-final with the same words).
   `available` is null until voice:probe answers; it is never guessed. */
const VOICE = {
  available:null, reason:'', code:'', detail:'',
  supported:[], installed:[], speechLocales:[], dictationLocales:[],
  locales:['en-US'], activeLocales:[],
  state:'idle', final:'', partial:'', level:0, winner:null, err:null,
  menu:false, installing:null, installFraction:0, installErr:null,
  offMachine:false,           // this route is on-device; kept so a future one cannot ship undisclosed
  pressAt:0, pressStarted:false, pointerCycle:0,
  stream:null, ac:null, node:null, src:null, gain:null,
  doneResolve:null, doneTimer:null, synthetic:false, seq:0,
  /* Review fix: the take voiceStop gave up waiting for. A `final` that misses
     the 2.5 s finalize window used to be accumulated into VOICE.final and then
     wiped by the next voiceStart — the tail of a dictation vanished with no
     message at all. `lateTake` holds the seq of that take, and a segment that
     turns up while it is still the current one is inserted where the on-time
     one would have gone. */
  lateTake:null,
};
/* One sentence per impossible case, and never an empty one. The main
   process names the case; this table owns the words. */
const VOICE_REASONS = {
  'voice-not-macos':'Voice input works only on macOS',
  'voice-os-too-old':'Voice input needs macOS 26 or later',
  'voice-helper-missing':'Voice input needs the speech helper, which this build was packaged without',
  'voice-helper-failed':'The speech helper did not answer, so voice input is off',
  'voice-no-model':'macOS has no on-device model for this language yet',
  'voice-mic-denied':'Microphone access was refused in System Settings › Privacy & Security',
  'voice-no-mic':'No microphone was found',
  'voice-no-bridge':'Voice input needs the desktop app',
};
/* Measured before it shipped, not taken from documentation. A Russian
   dictation fed at real time through two analyzers at once (en-US speech +
   ru-RU dictation) was watched with `nettop -P -x -L 6 -p <helper pid>`:
   the per-process capture is column headers and nothing else, and the
   all-process capture taken in the same window holds 612 rows — none of
   them corespeechd, com.apple.siri.embeddedspeech or any other speech
   daemon — while recording other processes moving hundreds of megabytes. */
const VOICE_ONDEVICE = 'On-device — the audio never leaves this Mac';
/* Item 2 (voice input): the one call site for a model download. It is a
   binding rather than a direct BR.voiceInstall() call so the smoke can watch
   where an uninstalled language routes — to the download, never to the
   selection — without spending a real multi-minute Apple model download on
   the operator's machine. Nothing but the harness ever replaces it. */
let voiceInstallBridge = (id) => (BR && BR.voiceInstall
  ? BR.voiceInstall(id)
  : Promise.resolve({ok:false, error:'voice-no-bridge'}));
/* Item 2 (voice input): what the strip and the button last painted. The audio
   tap repaints ten times a second, and re-creating an element restarts its
   CSS animation — so these keys decide when a repaint is actually a new
   picture. See refreshVoice()/refreshMic(). */
let VOICE_STRIP_KEY = null;
let VOICE_MIC_KEY = null;

/* ---- Item 7A: add a model from Hugging Face ----
   The branch the TUI reaches with `a` in Manage › LLM › Local
   (local-models-hf-branch.tsx). `open`/`step` are the desktop's own: the
   TUI keeps them on LocalModelsPanelMode as "hfRef"|"hfPick", and the
   remaining five fields are LocalModelsHfState field for field. `repo`
   deliberately survives a step back, so re-opening the pick list costs no
   second request. `ram` is app:hostRam (the same
   Math.max(1, floor(totalmem()/1e9)) the TUI's warning is computed from).
   `pendingMmproj` carries the projector across the weights download,
   because `atag models pull` never fetches it. */
const LLMHF = {open:false, step:'ref', reference:'', busy:false, error:null, repo:null, cursor:0, ram:0, pendingMmproj:null};
const HF_PICK_WINDOW = 6;   // hf-pick-list.tsx HF_PICK_WINDOW
const HF_REF_TITLE_TAIL = '(it has to be a GGUF build)';               // hf-reference-editor.tsx HF_REF_TITLE_LINE
const HF_REF_EXAMPLES_LINE = 'unsloth/Qwen3.5-4B-GGUF · https://huggingface.co/owner/repo · a link to one .gguf'; // :11-12
const HF_MMPROJ_LINE = '   vision projector in this repo — it is pulled alongside';                   // hf-pick-list.tsx HF_MMPROJ_LINE
const HF_ROW_LABEL = 'Add a model from Hugging Face…';  // onboarding/local-model-picks.ts HUGGING_FACE_ROW_LABEL
/* Authored here — the TUI has no counterpart, because the TUI's Local
   pane never has to explain why Ollama is not in it. */
const OLLAMA_SIGNPOST = 'Ollama (local) is a provider here: add the running server under Cloud › n add provider › Ollama (local), http://localhost:11434. Ollama is not a download source on this agent — nothing on this pane downloads from it.';

/* ---- Item 7C: what v0.5.5 answers that the desktop was projecting ----
   `stored` is GET /api/sessions/{id}.contextUsage verbatim — the whole
   prompt breakdown the agent now persists per session (sections, both
   conversation caps, the pair costs, the physical window). `route` is the
   `<providerId> <chatModel>` the current CTX.window was gauged for, so a
   provider switch releases a prompt-derived window instead of drawing the
   new model against the old model's scale. `stamp` is metadata.llm — the
   provider/model the open session last ran on. */
const CTX055 = {stored:null, route:null, stamp:null};
/* Mid-turn steering. `ahead` is ChatOrchestrator.steeredAhead: a refused
   steer is parked AHEAD of ordinary backlog and behind steers already
   re-routed for the same turn, so typing order survives. `chain`
   sequences steers per submit — the path is async where the queue was
   synchronous and two Enters can otherwise interleave. */
// `recovery` records the last GET /api/sessions/{id}/steer this window ran
// (item 7C review fix) so the wiring on openSession is assertable.
/* `mine` is the review fix for the steer_applied de-dupe: the frame that comes
   back for a steer THIS window sent must not print a second bubble, but keying
   that on the text alone swallowed the second of two identical steers ("keep
   going", "stop that") and made the transcript understate what the turn was
   told. Each accepted steer this window put in the transcript adds one entry
   here and the matching frame consumes exactly one. */
const STEER = {ahead:0, chain:Promise.resolve(), recovery:null, mine:[]};
const MAX_QUEUED = 20; // chat-orchestrator.ts:66 MAX_QUEUED_MESSAGES

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
  // item 6: pin / unpin a chat row
  pin:'<path d="M9.6 2.4 13.6 6.4l-2.1.7-2 2 .3 2.4-4.8-4.8 2.4.3 2-2z"/><path d="M5 11 2.6 13.4"/>',
  // item 2: voice input — capsule + stand, on the same 1.5-stroke grid
  mic:'<rect x="6" y="2" width="4" height="7.5" rx="2"/><path d="M3.8 7.6a4.2 4.2 0 0 0 8.4 0"/><path d="M8 11.8v2M5.8 13.8h4.4"/>',
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
  localModel:'qwen3-8b-instruct', cloudModel:'claude-opus-5', modelQuery:'',
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

/* ---------------- item 6: the sidebar's two lists ----------------
   Render-visible state, so it lives up here with the rest (the first render()
   runs while this file is still being evaluated — anything below it is in its
   temporal dead zone and would blank the window). */
const SIDEBAR_PAGE = 15;                 // rows per list before "Load more"
const PAGE = {chats:1, tasks:1};         // how many pages each list is showing
const PREFS = {pinned:[], seen:{}, loaded:false};  // userData/prefs.json, never the agent config
const PENDING_APPROVALS = new Map();     // sessionId → approvalId, from /api/events
const ATTN = new Set();                  // sessions whose last desktop-run turn ended in error
const RUNNING = new Map();               // turnId → sessionId, fed only by the turn stream's own frames
let TASKS_ERR = null;                    // GET /api/tasks failed — the honest line, not an empty list
const STATUS_RANK = {running:0, pending:1, blocked:2, failed:3, cancelled:4, completed:5}; // sidebar-tasks-selector.ts

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
  // r5 item 7: the download strip is chrome, painted before the overlay
  // layer so renderOverlays can measure it and sit under it.
  renderDlbar();
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

/* ============================================================
   Item 6 — the side menu is two lists.

   The user's words, which override the TUI here: "In the side menu there is
   no real need for the current structure chats / tasks / skills. There should
   be a Chats header and a list of recent chats; if there are more than ten or
   twenty, a 'load more' button. You should be able to pin and unpin chats.
   Remove the second line with 'one turn, thirty-six turns' — no one needs
   that. Instead a small round dot on the left of the line […] Tasks go on top
   of chats: two lists one after another, Tasks then Chats, both with the same
   dot rules. Skills can be removed from the menu."

   So: no nav rows, no group headers, no "N turns" second line; Tasks above
   Chats (the TUI's rail is Sessions above Tasks and calls them "Sessions" —
   the user wins); the Tasks list is EVERY task, not the rail's
   pending/running/recurring projection, because the user's dot rules are
   about tasks that have already executed. Skills leaves the sidebar only —
   ⌘3, the palette rows and View › Skills still reach it (they open Settings ›
   Skills on this tree).
   ============================================================ */
function renderSidebar() {
  const tk = sidebarTasks(), ch = sidebarChats();
  // Review fix: .sb-lists is the scroll container and this rebuilds it whole,
  // so every render used to snap it back to the top — the "Load more" button
  // scrolled itself off screen the moment it was clicked, and the list could
  // not be scrolled at all while a turn streamed (a render per delta frame).
  // Same capture-then-restore as renderContent/afterChat do for #scroller;
  // the README calls holding the pixel position a deliberate divergence from
  // the TUI's bottom-anchored offset, made because the user asked for the
  // scroll not to move.
  const prevLists = $('#sidebar').querySelector('.sb-lists');
  const keepScroll = prevLists ? prevLists.scrollTop : 0;
  $('#sidebar').innerHTML =
    '<div class="sb-head">' + MARK_COLOR
      // r4-ui item 4: "On the line in the top left part with the user's workspace
      // thing, there should not be any plus." The head row is the lockup and the
      // workspace chip now, nothing else; both pluses live on the list headers.
      + '<button class="wschip" data-act="workspace"><span>' + esc(BR ? WORKSPACE : '~/Teletubbies') + '</span>' + ic('chevD') + '</button></div>'
    + '<div class="sb-lists">'
      + '<div class="sb-list" data-list="tasks">'
        + '<div class="sb-list-head micro"><span>Tasks</span>'
          // countRunningTasks (sidebar-tasks-selector.ts) counts the FULL snapshot, not the page.
          // r4-ui item 4: the counter is emitted BEFORE the plus, so "N running"
          // sits to its left — the label takes flex:1, so both headers' plus
          // buttons share one right edge whether or not a counter precedes them.
          // Review fix: with the tasks fetch failed there is no snapshot to
          // count, and "0 running" directly above "could not load tasks: …"
          // states a number this window does not have. The counter is dropped
          // for that state — the error line below is the honest report.
          + (TASKS_ERR ? '' : '<span class="ct tnum">' + tk.running + ' running</span>')
          // `tasks:new` reaches tasksAct('new'), which opens Settings › Tasks with
          // the create form already up — the same destination the TUI's `+ new`
          // chip on its Tasks header has.
          + '<button class="iconbtn sb-add" data-act="tasks:new" title="New task" aria-label="New task">' + ic('plus') + '</button></div>'
        + (TASKS_ERR ? '<div class="sb-empty">' + esc(TASKS_ERR) + '</div>'
           : tk.rows.length ? tk.rows.map(taskRow).join('')
           // Not the TUI's "(no active tasks)" (sidebar.tsx:714), on purpose:
           // that list is the rail's running/pending/recurring projection,
           // while this one is EVERY task the agent holds (see the list-scope
           // note above), so "no active tasks" would be the wrong claim about
           // an empty one. The Chats list below keeps the TUI's string verbatim.
           : '<div class="sb-empty">(no tasks yet)</div>')
        + (tk.hidden > 0 ? '<button class="loadmore" data-more="tasks">Load more · ' + tk.hidden + ' more</button>' : '')
      + '</div>'
      + '<div class="sb-list" data-list="chats">'
        // r4-ui item 4: "When I click on plus in the same line as chats, it
        // creates a new chat." No counter on this list — the TUI's Sessions
        // header carries none either.
        + '<div class="sb-list-head micro"><span>Chats</span>'
          + '<button class="iconbtn sb-add" data-act="session:new" title="New chat (⌘N)" aria-label="New chat">' + ic('plus') + '</button></div>'
        + (ch.rows.length ? ch.rows.map(chatRow).join('')
           : '<div class="sb-empty">(no sessions yet)</div>')   // sidebar.tsx:502
        + (ch.hidden > 0 ? '<button class="loadmore" data-more="chats">Load more · ' + ch.hidden + ' more</button>' : '')
      + '</div>'
    + '</div>'
    // Item 7: the bottom-left settings entry. Lands on Manage › Tasks, the TUI's default Manage tab.
    + '<button class="sb-foot" data-act="settings:tasks" title="Settings (⌘ ,)">' + ic('gear') + '<span>Settings</span>' + keycaps('⌘ ,') + '</button>'
    ;
  if (keepScroll) {
    const lists = $('#sidebar').querySelector('.sb-lists');
    // The rebuilt list can be shorter (a delete, a collapsed page); the browser
    // clamps to scrollHeight on its own, so nothing here has to.
    if (lists) lists.scrollTop = keepScroll;
  }
}

/** Every task, ordered as the TUI orders its rail (STATUS_RANK, then newest). */
function sidebarTasks() {
  const all = TASKS.slice().sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 9, rb = STATUS_RANK[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  const rows = all.slice(0, SIDEBAR_PAGE * PAGE.tasks);
  return {rows, hidden: all.length - rows.length, running: TASKS.filter((t) => t.status === 'running').length};
}

/** Chats: sessions with at least one saved turn, pinned first, newest first. */
function sidebarChats() {
  const pinnedSet = new Set(PREFS.pinned);
  const all = SESSIONS.filter((s) => pinnedSet.has(s.id)).concat(SESSIONS.filter((s) => !pinnedSet.has(s.id)));
  const rows = all.slice(0, SIDEBAR_PAGE * PAGE.chats);
  return {rows, hidden: all.length - rows.length};
}

/* The dot, in the user's three states. "Running" is NOT S.busy: an approval
   or an abort clears that while the agent is still working, which would draw
   a still dot over a live turn. It is the RUNNING map, which only the turn
   stream's own session_id/done/aborted/error frames write. */
function chatDot(s) {
  if (!s) return ['empty', ''];
  const seen = PREFS.seen[s.id];
  const unread = !(seen >= 0) || (s.updatedAt || 0) > seen;
  for (const sid of RUNNING.values()) if (sid === s.id) return ['running', 'the agent is running here — wait'];
  if (PENDING_APPROVALS.has(s.id)) return ['filled', 'waiting for your approval'];
  if (unread && ATTN.has(s.id)) return ['filled', 'the last turn failed'];
  if (unread && s.status === 'stalled') return ['filled', 'stopped: max steps reached without a reply'];
  if (unread && s.status === 'failed') return ['filled', 'the last turn failed'];
  if (unread) return ['filled', 'finished — not read yet'];
  return ['empty', 'read'];
}

/* Same rules for tasks. A task that has not run yet has none of the user's
   three states — it has not executed, so there is nothing to have read — and
   is drawn empty with a tooltip that says which. */
function taskDot(t) {
  if (t.status === 'running') return ['running', 'running now — wait'];
  if (t.status === 'pending') return ['empty', t.when === 'once' ? 'queued — not run yet' : 'scheduled · ' + t.when];
  if (t.status === 'cancelled') return ['empty', 'cancelled'];
  const seen = PREFS.seen['task:' + t.id];
  const unread = !(seen >= 0) || (t.updatedAt || 0) > seen;
  if (!unread) return ['empty', 'read'];
  if (t.status === 'failed') return ['filled', 'failed: ' + (t.lastError || 'no error recorded')];
  if (t.status === 'blocked') return ['filled', 'blocked: ' + (t.lastError || 'no error recorded')];
  return ['filled', 'finished — not read yet'];
}

/* The name and the dot's meaning ride on the row, not on the dot: in the
   collapsed rail the dot is the only part of the row still on screen, and it
   has to say which chat or task it stands for. */
function taskRow(t) {
  const [state, tip] = taskDot(t);
  return '<button class="sesrow" data-task="' + esc(t.id) + '" title="' + esc(t.t + ' · ' + tip) + '">'
    + '<span class="sdot ' + state + '"></span>'
    + '<span class="t1">' + esc(t.t) + '</span></button>';
}

function chatRow(s) {
  const [state, tip] = chatDot(s);
  const pinned = PREFS.pinned.includes(s.id);
  return '<button class="sesrow' + (s.id === S.sessionId ? ' on' : '') + (pinned ? ' pinned' : '') + '" data-ses="' + esc(s.id) + '"'
    + ' title="' + esc(s.t + ' · ' + tip + (pinned ? ' · pinned' : '')) + '">'
    + '<span class="sdot ' + state + '"></span>'
    + '<span class="t1">' + esc(s.t) + '</span>'
    + '<span class="pinbtn iconbtn" data-pin="' + esc(s.id) + '" title="' + (pinned ? 'Unpin' : 'Pin') + '" role="button">' + ic('pin') + '</span>'
    + '</button>';
}

/** The row's one-word state, where the removed "N turns" line used to sit. */
function chatStatusWord(s) {
  const dot = chatDot(s)[0];
  return dot === 'running' ? 'running' : dot === 'filled' ? 'needs attention' : 'read';
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
  return '<div class="emptychat"><span style="opacity:.25;color:var(--text-primary)">'
    + '<svg width="48" height="48" viewBox="0 0 64 64" fill="currentColor"><path d="M35.24 49.92a1.25 1.25 0 0 0 1.3-1.24 12.2 12.2 0 0 1 12.14-12.14 1.25 1.25 0 0 0 1.24-1.3v-6.47c0-.69-.56-1.24-1.24-1.24H37.72c-.69 0-1.24-.56-1.24-1.25V15.32c0-.69-.56-1.24-1.24-1.24h-6.47c-.69 0-1.24.56-1.3 1.24A12.2 12.2 0 0 1 15.32 27.46c-.68.06-1.24.61-1.24 1.3v6.47c0 .69.56 1.24 1.24 1.24h10.96c.69 0 1.24.56 1.24 1.25v10.95c0 .69.56 1.24 1.24 1.24z"/></svg></span>'
    + '<div style="font-size:22px;line-height:28px;font-weight:600;letter-spacing:-.02em">Ask it to do something on this machine</div>'
    + '<div class="ghost">'
      + ['what can you do?','summarise the files in this folder','check the disk space on this Mac']
          .map((g) => '<button class="ghostchip" data-fill="' + esc(g) + '">' + esc(g) + '</button>').join('')
    + '</div></div>';
}

/* r4-ui item 3: `end` is true for the one item that closes a finished turn
   (endMarkIds decides which). The user's words: "not use the cross from agent
   or this weird line from user inside the chat. Use the cross from agent only
   at the end of the whole message from the agent, the last message from the
   agent only, so that it shows that the whole process is finished". So the
   per-message glyphs are gone from both sides; the user row becomes a bubble
   that leaves the grid, and the agent row keeps the grid with an EMPTY first
   cell so its content column stays where it is. Tool cards, reasoning blocks
   and approvals keep their own check/warn/running glyphs — those describe a
   call's RESULT, not a message, and the fold depends on them. */
function item(m, end) {
  // The bubble text still goes through esc() only. A user message has never
  // been run through renderProse and must not start being, or a path someone
  // typed turns into a clickable chip inside their own message.
  if (m.k === 'user') return '<div class="turn usr"><div class="prose usr bubble">' + esc(m.text) + '</div></div>';
  // item 5: the reply, then the files this turn wrote, as an attachment footer.
  if (m.k === 'assistant') return '<div class="turn"><div></div>'
    + '<div><div class="prose">' + renderProse(m.text) + '</div>' + attachStrip(m)
    + (end ? '<div class="endmark" title="turn complete">' + MARK_MONO + '</div>' : '') + '</div></div>';
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
    // Item 2 (voice input): the strip is ALWAYS emitted, hidden and empty
    // when there is nothing to say, so refreshVoice() can repaint it by
    // outerHTML without a render() that would move the caret.
    + voiceStripHTML()
    + '<div class="composer' + (running ? ' running' : '') + '" id="composer">'
      + (S.slash ? slashPopover() : '')
      + '<div class="field"><textarea id="entry" rows="1" placeholder="' + (running ? 'Send to steer this turn…' : 'Ask for an outcome, or / for a command') + '"></textarea>'
      + micButton() + sendButton() + '</div>'
      + '<div class="cfoot">'
        + '<button class="cchip modechip" data-sel-open="backend">'
          + ic(selBackend() === 'cloud' ? 'cloud' : 'cpu') + selBackend() + ic('chevD') + '</button>'
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
    // Item 7C: this sends a steer into the running turn. It is parked as
    // the next turn only when the agent refuses it, which is a fact the
    // route answers and this button cannot know in advance.
    if (S.draft.trim()) return '<button class="sendbtn" data-act="send" title="Steer this turn">' + ic('up') + '</button>';
    return '<button class="sendbtn stop" data-act="stop" title="Stop (Ctrl+.)">' + ic('stop') + '</button>';
  }
  return '<button class="sendbtn' + (S.draft.trim() ? '' : ' mute') + '" data-act="send" title="Send">' + ic('up') + '</button>';
}


/* ---- Item 2: voice input — the composer's microphone ----
   The user's word was "unclick", which reads as release-to-stop, but a
   click/click toggle is what a short tap has to mean or the button would be
   unusable from the keyboard and would die on a window blur. So both are
   served, and the split is made on the press itself: mousedown arms,
   mouseup after more than 400 ms stops (hold-to-talk, the literal reading
   of "unclick"), and a shorter press promotes the session to a toggle that
   the next click ends. Said out loud here because it is a deliberate
   divergence from the composer's every other button, which is a plain
   click. */
const VOICE_HOLD_MS = 400;

function micButton() {
  const rec = VOICE.state === 'recording' || VOICE.state === 'starting' || VOICE.state === 'finishing';
  const off = VOICE.available === false;
  const title = off ? VOICE.reason
    : VOICE.available === null ? 'Checking for the on-device speech model…'
    : rec ? 'Stop and insert · Esc to discard'
    : 'Dictate (click to start, click again to insert) · right-click to choose the language';
  return '<button class="micbtn' + (rec ? ' rec' : '') + '" data-mic="1"'
    + (off || VOICE.available === null ? ' disabled' : '')
    + ' title="' + esc(title) + '" aria-label="' + esc(title) + '">' + ic('mic') + '</button>';
}

/** A locale's name in the reader's own language, never a bare tag.
    Deliberate copy substitution: the spec quoted the chip as `English (US)`.
    A menu of 43 locales that has to distinguish en-US from en-GB, and
    pt-BR from pt-PT, cannot use hand-written labels, so the chip and the
    menu share this one function — `en-US` reads `American English` here. */
function voiceLangName(id) {
  try {
    const n = new Intl.DisplayNames(undefined, {type:'language'}).of(id);
    if (n && n !== id) return n;
  } catch (e) { /* Intl.DisplayNames is present in this Chromium; the tag is the honest fallback */ }
  return id;
}

/** Which on-device module serves a locale — they do not read the same.
    SpeechTranscriber punctuates and cases; DictationTranscriber covers
    thirteen more languages (Russian among them) in plainer text. */
function voiceEngineOf(id) {
  if (VOICE.speechLocales.indexOf(id) >= 0) return 'speech';
  if (VOICE.dictationLocales.indexOf(id) >= 0) return 'dictation';
  return '';
}

function voiceStripHTML() {
  const rec = VOICE.state === 'recording' || VOICE.state === 'starting' || VOICE.state === 'finishing';
  if (!rec && !VOICE.menu && VOICE.state !== 'error') return '<div class="voicestrip" hidden></div>';
  let h = '<div class="voicestrip">';
  if (rec) {
    h += '<div class="vsrow">'
      + '<span class="vsdot' + (VOICE.state === 'recording' ? ' live' : '') + '"></span>'
      + '<span class="vslevel"><i style="width:' + voiceLevelPct() + '%"></i></span>'
      + '<span class="vstext">' + voiceTextInner() + '</span>'
      + voiceChipHTML()
      + '</div>';
  } else if (VOICE.state === 'error' && VOICE.err) {
    // Its own dismiss, because Escape no longer clears this state — see the
    // note on the Escape handler.
    h += '<div class="vsrow"><span class="vserr">' + esc(VOICE.err) + '</span>' + voiceChipHTML()
      + '<button class="vsx" data-act="voice:dismiss" title="Dismiss">' + ic('x') + '</button></div>';
  } else {
    h += '<div class="vsrow"><span class="vstext ter">Dictation language</span>' + voiceChipHTML() + '</div>';
  }
  // The sentence has to be true in the state it is painted in: while the
  // helper is finalizing, Enter no longer stops anything — submit() holds it
  // until the insert lands (see the `finishing` guard there).
  h += '<div class="vsnote">' + VOICE_ONDEVICE
    + (VOICE.state === 'finishing' ? ' · inserting what you said — Enter and Send wait for it'
      : rec ? ' · Enter or Send stops the recording and inserts the text; it does not send' : '')
    + '</div>';
  if (VOICE.menu) h += voiceMenuHTML();
  return h + '</div>';
}

/* The two things that change on every 100 ms audio chunk, split out so the
   repaint can patch them in place instead of re-creating the strip — see
   refreshVoice(). */
function voiceLevelPct() {
  return Math.max(0, Math.min(100, Math.round(VOICE.level * 140)));
}
function voiceTextInner() {
  return esc(VOICE.final)
    + (VOICE.partial ? '<span class="vspart">' + esc(VOICE.partial) + '</span>' : '')
    + (!VOICE.final && !VOICE.partial
        ? '<span class="vswait">' + (VOICE.state === 'starting' ? 'opening the microphone…' : 'listening…') + '</span>'
        : '');
}
/* Everything the strip's *structure* depends on. When this is unchanged the
   markup is identical apart from the two volatile parts above, so the strip
   keeps its elements — and with them the CSS animations that a replaced node
   restarts from frame one. */
function voiceShapeKey() {
  return [VOICE.state, VOICE.menu ? 1 : 0, VOICE.err || '', VOICE.winner || '',
    VOICE.available, VOICE.reason, VOICE.offMachine ? 1 : 0,
    VOICE.locales.join(','), VOICE.supported.join(','), VOICE.installed.join(','),
    VOICE.speechLocales.join(','), VOICE.dictationLocales.join(','),
    VOICE.installing || '', VOICE.installErr || '', VOICE.installFraction].join('|');
}

function voiceChipHTML() {
  const primary = VOICE.locales[0] || 'en-US';
  const second = VOICE.locales[1];
  const won = VOICE.winner && VOICE.winner !== primary;
  const label = won
    ? voiceLangName(VOICE.winner) + ' matched'
    : voiceLangName(primary) + (second ? ' + ' + voiceLangName(second) : '');
  return '<button class="vschip' + (won ? ' won' : '') + '" data-act="voice:lang" title="Choose the dictation language">'
    + esc(label) + ic('chevD') + '</button>';
}

function voiceMenuHTML() {
  if (!VOICE.supported.length) {
    return '<div class="vsmenu"><div class="vsmempty">' + esc(VOICE.reason || 'No on-device languages were reported') + '</div></div>';
  }
  const installed = VOICE.supported.filter((id) => VOICE.installed.indexOf(id) >= 0);
  const rest = VOICE.supported.filter((id) => VOICE.installed.indexOf(id) < 0);
  const row = (id) => {
    const on = VOICE.locales.indexOf(id) >= 0;
    const primary = VOICE.locales[0] === id;
    const here = VOICE.installed.indexOf(id) >= 0;
    const eng = voiceEngineOf(id);
    const note = here
      ? (eng === 'dictation' ? 'on this Mac · plain text, no punctuation' : 'on this Mac')
      : (VOICE.installing === id
          ? 'downloading ' + Math.round(VOICE.installFraction * 100) + '%'
          : (eng === 'dictation' ? 'downloads a model · plain text, no punctuation' : 'downloads a model'));
    return '<div class="vsmrow' + (on ? ' on' : '') + '">'
      + '<button class="vsmpick" data-act="voice:pick:' + esc(id) + '">'
      + '<span class="vsmname">' + esc(voiceLangName(id)) + '</span>'
      + '<span class="vsmtag mono ter">' + esc(id) + '</span>'
      + '<span class="vsmnote ter">' + esc(note) + '</span>'
      + (primary ? '<span class="vsmbadge">first</span>' : '')
      + '</button>'
      + (here && !primary
          ? '<button class="vsmadd' + (on ? ' on' : '') + '" data-act="voice:add:' + esc(id) + '" title="Also listen for this language">'
            + (on ? ic('check') : ic('plus')) + '</button>'
          : '')
      + '</div>';
  };
  return '<div class="vsmenu">'
    + '<div class="vsmhead">On this Mac</div>' + installed.map(row).join('')
    + (rest.length ? '<div class="vsmhead">Downloads a model the first time</div>' + rest.map(row).join('') : '')
    + (VOICE.installErr ? '<div class="vsmerr">' + esc(VOICE.installErr) + '</div>' : '')
    + '<div class="vsmfoot">Transcribed on this Mac. One language is active at a time unless you add a second with +: '
    + 'then both models hear the same audio and the higher-scoring one wins the whole dictation. '
    + 'The live text always follows the first language. Russian, Arabic, Dutch, Turkish and ten more come from '
    + 'macOS’s dictation model, which is on-device too but writes without punctuation.</div>'
    + '</div>';
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
  // r4-ui item 3: only tool and reason rows carry a `#turn-<id>` anchor, and
  // this is the only way in here, so the end mark never applies to a repaint.
  old.outerHTML = item(m, false);
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
  // r4-ui item 3 review fix: `.map(item)` handed Array.prototype.map's INDEX
  // to item()'s second parameter, so every member after the first unfolded
  // with a truthy `end`. Harmless while the run is all tool cards, but the
  // sibling call site (repaintEntry) passes an explicit false for a reason.
  old.outerHTML = S.log.slice(i, j + 1).map((m) => item(m, false)).join('');
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
  // Item 7: the Tasks room is the settings window's Tasks tab — one implementation.
  return '<div class="scroller"><div class="tuiwrap">' + tasksTab() + '</div></div>';
}

function skillsView() {
  // Item 7 part B: the Skills room is the settings window's Skills tab — one implementation.
  return '<div class="scroller"><div class="tuiwrap">' + skillsTab() + '</div></div>';
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
    .forEach((s) => hits.push({ic:'chat', t:s.t, cx:'Session · ' + chatStatusWord(s), sc:'', act:'ses:' + s.id, badge:'session'}));
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
  /* r5 item 7: NOT `inset: 0` any more. An inline inset beats any
     stylesheet rule, so the overlay layer covered the download strip —
     and the strip is the surface the wizard's own copy promises the
     download keeps reporting on. `--dlbar-h` is 0 while nothing is
     downloading, so the wizard still covers the toolbar as it did. */
  o.style.position = 'absolute';
  o.style.top = 'var(--dlbar-h, 0px)';
  o.style.left = '0'; o.style.right = '0'; o.style.bottom = '0';
  o.style.zIndex = '20';
  const pq = $('#palq');
  if (pq) { pq.focus(); pq.setSelectionRange(pq.value.length, pq.value.length); }
  const cur = o.querySelector('.palrow.on');
  if (cur) cur.scrollIntoView({block:'nearest'});
  // r5 item 7: the intro's canvas is destroyed by the rebuild above.
  obIntroMounted();
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

/**
 * Item 7C — which limit is trimming the transcript, when one is.
 *
 * Nothing here is inferred: `conversationBoundBy` is the agent's own
 * verdict on the session row, and it is `null` on a transcript nothing is
 * trimming, in which case this line is absent rather than reassuring.
 * The knob is named only when the configured cap is what bound the
 * transcript — when the cap is auto, or the window clamped it below what
 * was configured, the cap is not the thing to change and saying so would
 * send the user to the wrong dial.
 */
function ctxBoundLine() {
  const u = CTX055.stored;
  if (!u || !u.conversationBoundBy) return '';
  let text;
  if (u.conversationBoundBy === 'pairs') {
    text = 'older turns are being dropped — ' + (u.conversationPairs || 0) + ' of ' + (u.conversationPairsCap || 0) + ' turns kept';
  } else if (u.conversationCapAuto === false && u.conversationCap === u.conversationCapConfigured) {
    text = 'older turns are being dropped — the ' + fmtTokens(u.conversationCap) + '-token transcript cap (agent.conversationMaxTokens) is the limit';
  } else {
    text = 'older turns are being dropped — the window is the limit, not a configured cap';
  }
  if (u.droppedPairs > 0) text += ' · ' + u.droppedPairs + ' dropped so far';
  return '<p class="cap ctxbound" style="margin:8px 0 0">' + esc(text) + '</p>';
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
    if ((CTX.source === 'built' || CTX.source === 'measured') && CTX.sections && CTX.sections.length) {
      body = CTX.sections.map((s) => row(s.label, fmtTokens(s.tokens))).join('');
    }
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
    + ctxBoundLine()
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
  let rows = '';
  // item 6: the "N turns" subtitle is gone everywhere, so this sheet carries
  // the same dot and the same one-word state the sidebar row carries.
  SESSIONS.forEach((s) => {
    const [state] = chatDot(s);
    rows += '<button class="row" style="padding:0;height:40px" data-ses="' + esc(s.id) + '">'
      + '<span class="sdot ' + state + '"></span>'
      + '<span class="main"><span class="t" style="font-weight:400">' + esc(s.t) + '</span></span>'
      + '<span class="meta">' + esc(chatStatusWord(s)) + '</span></button>';
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
  const old = $('#settings');
  // r4-ui item 5: stop re-applying the Escape focus as soon as the focus is off
  // the first menu row — otherwise the next render would steal it back out of
  // whatever the operator tabbed or clicked into. The test is deliberately NOT
  // `old.contains(document.activeElement)`: clicking any non-focusable surface
  // blurs to <body>, which is an ANCESTOR of #settings and not a descendant, so
  // a containment test misses exactly that case and the next full render — a
  // stream frame, the tasks poll, the diagnostics poll — would drag focus back
  // onto the Tasks row seconds after an ordinary click on dead space.
  if (MENUFOCUS.want && old && document.activeElement !== old.querySelector('.setmenu button.menurow')) MENUFOCUS.want = false;
  if (old) old.remove();
  if (!S.settings) { MENUFOCUS.want = false; return; }
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
  if (MENUFOCUS.want) { const first = el.querySelector('.setmenu button.menurow'); if (first) first.focus(); }
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
  else if (id === 'memory') n = MEM.rows.length; // Item 7 part B: rows of the selected channel (debug-pane.tsx:160)
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
  // r4-ui item 5: no node carries `sub` any more — `Observe` and `Manage` were
  // the only two, and both left. The branch (and `.menurow.sub` / `.parent` in
  // styles.css) is kept on purpose: MENU_GROUPS is a copy of the TUI registry
  // and the next node pulled across may well be a parent, and it is what
  // __menuSubRows() asserts zero of — delete the branch and that check stops
  // meaning anything.
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
  // Review fix: the guard reads the CAPABILITIES field, not S.level. S.level
  // is seeded with the prototype's demo 3 and is only replaced when
  // GET /api/capabilities carries agent.approvalLevel, so `typeof S.level ===
  // 'number'` was always true and a capabilities payload without the field
  // would have printed `approval L3` — a number this window never read.
  const lvl = LIVE_CAPS && LIVE_CAPS.agent && typeof LIVE_CAPS.agent.approvalLevel === 'number' ? S.level : null;
  // Which agent answered. The desktop prefers a locally built agent at
  // ~/atag-agent/bin/atag over the released install, so "it works here
  // and not there" has to be answerable from the window — and it matters
  // whether or not the coding-mode route is present, so this is printed
  // in both cases. It sits before the approval segment deliberately: the
  // TUI's line ends `approval L<n> | skills <n>` and the smoke pins that
  // tail.
  const bin = S.live.binary || '';
  parts.push('agent ' + (bin ? (home && bin.startsWith(home) ? '~' + bin.slice(home.length) : bin) : '—'));
  parts.push('approval L' + (lvl === null ? '—' : lvl));
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
  if ((S.settings || skillsVisible()) && before !== JSON.stringify([SK.rows, SK.err]) && !tkTyping() && !skpTyping()) render(); // same guard as refreshHealth (+ the hub search box and the Skills room (⌘3), which paints the same rows — Item 7 part B)
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
  // Item 7 part B: the Skills / Memory / MCP tabs start their own 5 s poll and first load on entry.
  const pane = settingsPaneId(S.settingsPane);
  if (pane === 'skills') skillsTabEntered();
  else if (pane === 'memory') memoryTabEntered();
  else if (pane === 'mcp') mcpTabEntered();
  // Item 7 part C: the LLM / Telegram / Import tabs' first load on entry.
  else if (pane === 'llm') llmTabEntered();
  else if (pane === 'telegram') telegramTabEntered();
  else if (pane === 'import') importTabEntered();
}

function settingsPane() {
  const p = settingsPaneId(S.settingsPane);
  if (p === 'tasks') return tasksTab();
  if (p === 'privacy') return privacyPane();
  // Item 7 part B: the Skills, Memory and MCP tabs.
  if (p === 'skills') return skillsTab();
  if (p === 'memory') return memoryTab();
  if (p === 'mcp') return mcpTab();
  // Item 7 part C: the LLM, Telegram and Import tabs.
  if (p === 'llm') return llmTab();
  if (p === 'telegram') return telegramTab();
  if (p === 'import') return importTab();
  return comingNote(SETTINGS_TABS.find((t) => t[0] === p)[1]);
}
function comingNote(label) {
  return '<div class="tui"><b>' + esc(label) + '</b><div class="ter">coming in the next step of this branch</div></div>';
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
  /* Item 7 lane fix, found by the suite rather than by a spec: `split(':')`
     took only the FIRST segment as the value, and this agent's own session
     ids are not colon-free — `hermes:20260511_162944_79a9e8` is a real row
     in the store. So `ses:`, `pin:`, `unpin:`, `del:` and `delask:` all
     acted on the string `hermes`: opening such a chat did nothing and
     pinning it wrote a phantom id into prefs.json (which is exactly what
     was sitting there when this was found). Every branch below wants the
     whole tail; the multi-segment verbs (`llm:`, `tasks:`, `menu:` …) take
     it with their own `a.slice(n)` and never read `v`. */
  const colon = a.indexOf(':');
  const k = colon < 0 ? a : a.slice(0, colon);
  const v = colon < 0 ? undefined : a.slice(colon + 1);
  const close = () => { S.overlay = null; S.menuOpen = null; S.scope = null; S.q = ''; S.cur = 0; S.alert = null; SEL.open = false; SEL.addOpen = false; WIZ.phase = null; };

  // Item 2 (voice input): one seam for every voice verb.
  if (a === 'voice' || a.indexOf('voice:') === 0) { voiceAct(a); return; }
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
  if (a === 'session:new') { close(); S.log = []; S.history = []; S.agentSession = null; S.busy = false;
                             forgetApprovalCard();   // item 6 review fix: a fresh thread does not answer the open gate — the other chat's dot keeps saying it is waiting
                             S.room = 'chat';
                             S.sessionId = '';   // item 6: a fresh thread has no row of its own yet, so no row is highlighted
                             render(); toast('New session', 'The next turn starts fresh');
                             // Lane B — item 3: a new thread has a new window fill (the TUI resets contextUsage on session_created), so the chip goes back to the projection.
                             refreshContext(); return; }
  if (a === 'session:switch') { close(); S.overlay = 'sessions'; render(); return; }
  if (a === 'clear') { close(); S.log = []; S.history = []; render(); toast('Transcript cleared', 'The next turn starts fresh'); return; }
  if (a === 'stop') { close(); abort(); return; }
  if (a === 'sessmodel:apply') { applySessionModelStamp(); return; }
  /* Item 7C — the menu's `Steer the running turn`. There is no separate
     steer box: the composer IS the steer box while a turn runs, so the
     verb puts the caret there and says what Enter will do. */
  if (a === 'steer') {
    close(); S.room = 'chat';
    S.log.push({id:nid(), k:'system', text: S.busy || S.pending
      ? 'type here — a message sent while the turn runs is folded into it at the next step'
      : 'nothing is running here, so the next message starts a turn'});
    render();
    const el = $('#entry'); if (el) el.focus();
    return;
  }
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
  // Item 7 part B: the Skills / Memory / MCP tabs' verbs.
  if (k === 'skills') { close(); skillsAct(a.slice(7)); return; }
  if (k === 'memory') { close(); memoryAct(a.slice(7)); return; }
  if (k === 'mcp') { close(); mcpAct(a.slice(4)); return; }
  // Item 7 part C: the LLM / Telegram / Import tabs' verbs.
  if (k === 'llm') { close(); llmAct(a.slice(4)); return; }
  if (k === 'telegram') { close(); telegramAct(a.slice(9)); return; }
  if (k === 'import') { close(); importAct(a.slice(7)); return; }
  if (a === 'na') return;

  if (k === 'room') {
    close();
    // Integration seam (sidebar rows, ⌘2/⌘3, palette hits, View › Tasks/Skills): lane C made the
    // Tasks and Skills tabs the one implementation, so a room switch to either opens the settings
    // window on that tab. Item 6 took the Tasks and Skills nav rows out of the sidebar, but every
    // other way in still lands here: ⌘2/⌘3, the palette rows, the slash verbs and View ›
    // Tasks/Skills. The chat room closes the settings window, so ⌘1 always lands on the transcript.
    if (v === 'tasks' || v === 'skills') { act('settings:' + v); return; }
    if (v === 'chat') S.settings = null;
    S.room = v; render(); return;
  }
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
  // item 6: a real delete. The old branch only spliced the array, so the row
  // came back on the next load — DELETE /api/sessions/{id} removes it for good
  // (idempotent, so an id that is already gone still answers 200).
  if (k === 'del')       { if (!BR || !BR.deleteSession) return;
                           BR.deleteSession(v).then((res) => {
                             if (!res || !res.ok) { close(); render(); toast('Could not delete the session', (res && res.error) || ''); return; }
                             const i = SESSIONS.findIndex((x) => x.id === v);
                             const gone = i >= 0 ? SESSIONS[i].t : v;
                             if (i >= 0) SESSIONS.splice(i, 1);
                             PREFS.pinned = PREFS.pinned.filter((x) => x !== v);
                             delete PREFS.seen[v];
                             savePrefs();
                             if (S.sessionId === v) { S.sessionId = ''; S.agentSession = null; S.log = []; }
                             close(); render(); toast('Session deleted', gone);
                           });
                           return; }
  // item 6: pin / unpin, and the two lists' pagination.
  if (k === 'pin')       { if (!PREFS.pinned.includes(v)) PREFS.pinned.unshift(v); savePrefs(); render(); nameVisibleSessions(); return; }
  if (k === 'unpin')     { PREFS.pinned = PREFS.pinned.filter((x) => x !== v); savePrefs(); render(); nameVisibleSessions(); return; }
  if (k === 'more')      { if (PAGE[v] != null) PAGE[v]++; render(); nameVisibleSessions(); return; }
  // Opening a task = reading it. The Tasks tab is the only place with a task
  // detail on this tree, so the row lands there with that task selected.
  if (k === 'task')      { const t = TASKS.find((x) => x.id === v);
                           PREFS.seen['task:' + v] = Math.max(PREFS.seen['task:' + v] || 0, (t && t.updatedAt) || 0, Date.now());
                           savePrefs();
                           close(); act('settings:tasks'); tkFocusTask(v); return; }
  if (k === 'scope')     { S.scope = v; S.q = ''; S.cur = 0; S.dialShare = S.share; render(); return; }
  if (k === 'taskfilter'){ S.taskFilter = v; render(); return; }
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

/**
 * Item 7C — a message typed while a turn runs.
 *
 * The composer has promised "Send to steer this turn…" all along and the
 * window parked the text in a local array instead, announcing that it
 * "will reach the agent at the next step boundary". It did not: it ran as
 * a separate turn afterwards. `POST /api/sessions/{id}/steer` folds it
 * into the running turn for real, and has since ≤0.5.3.
 *
 * Ported from ChatOrchestrator.steerMessage (src/tui/chat-orchestrator.ts):
 * the route's answer is the ONLY fact consulted — not S.busy, which is
 * cleared by an approval and by abort() while the agent is still working
 * — and on a refusal the text is parked AHEAD of ordinary backlog
 * (queueAsSteer) rather than lost. The agent's own 409 sentence names
 * POST /v1/chat/completions, which is advice for an API client and not
 * for someone typing here, so it is translated, never printed.
 */
function steerOrQueue(text) {
  // Sequenced: submit() clears the editor optimistically and returns, so
  // two Enters in quick succession would otherwise interleave.
  STEER.chain = STEER.chain.then(() => steerOrQueueRun(text)).catch(() => {});
  return STEER.chain;
}
async function steerOrQueueRun(text, post) {
  const sid = S.agentSession;
  const send = post || ((id, t) => (BR && BR.steer ? BR.steer(id, t) : Promise.resolve(null)));
  let steered = false;
  /* Review fix: "it cannot take this one" is a REFUSAL, and there is one
     branch where nothing was refused because nothing was asked — a brand-new
     chat whose first turn has not reported its session_id yet (S.busy is
     already true and the composer already says "Send to steer this turn"), or
     an older preload with no BR.steer. The outcome is the same, the
     attribution is not, so that case gets its own sentence. */
  let asked = false;
  if (sid && (post || (BR && BR.steer))) {
    asked = true;
    const res = await send(sid, text);
    steered = !!(res && res.ok && res.steered);
  }
  /* Review fix: the POST above is a round trip, and the user can click
     another chat inside it. openSession replaces S.log and clears
     S.streamId, so pushSteerEntry's `S.log.push` fallback would stamp
     chat A's user bubble — and A's system line — into chat B's
     transcript, and the full-queue arm would overwrite a draft the user
     has since typed in B (S.draft is this window's one editor). Same
     defect class as the `!item` guards on the stream frames. The queue is
     window-global by design, so the park itself still happens; only the
     transcript and the editor are held back. */
  const here = S.agentSession === sid;
  if (steered) {
    // The message the user typed belongs in the transcript, not only in a
    // system line — spliced before the streaming item, as tool cards are.
    // After a switch it belongs in neither transcript: the agent really
    // did take it, and reopening that chat reads it back from the store.
    if (here) {
      STEER.mine.push(text);
      pushSteerEntry(text);
      S.log.push({id:nid(), k:'system', text:'steering the running turn — the agent reads it at the next step'});
      render();
    }
    return;
  }
  if (S.queued.length >= MAX_QUEUED) {
    // chat-orchestrator.ts: the optimistic submit already cleared the
    // editor, so hand the text back rather than eat it — but only into an
    // editor that is still the one it was typed in, or, after a switch,
    // one the user has not typed into since. Stamping over another chat's
    // draft is worse than losing a steer that could not be parked.
    const e = $('#entry');
    if (here || (!S.draft && !(e && e.value))) {
      S.draft = text;
      if (e) { e.value = text; autosize(e); }
      ctxDraftChanged();
    }
    if (here) S.log.push({id:nid(), k:'system', text:'queue: full at ' + MAX_QUEUED + ' — the steer could not be parked (returned to the editor)'});
    render(); return;
  }
  S.queued.splice(STEER.ahead, 0, text);
  STEER.ahead += 1;
  // The queue tray is window-global and shows the parked text either way;
  // the sentence explaining it is only true in the chat it was typed in.
  if (here) S.log.push({id:nid(), k:'system', text: asked
    ? 'steering the running turn — it cannot take this one, so it runs as the next turn'
    : 'the running turn has not reported its session yet — it could not be asked, so this runs as the next turn'});
  render();
}
/** The steered message, positioned before the streaming assistant item. */
function pushSteerEntry(text) {
  const entry = {id:nid(), k:'user', text, steered:true};
  const item = S.log.find((m) => m.id === S.streamId);
  if (item) S.log.splice(S.log.indexOf(item), 0, entry);
  else S.log.push(entry);
}

function submit() {
  // Item 2 (voice input): Enter, the Send button and Ctrl+Enter all land
  // here. While the microphone is open they stop the recording and insert
  // the text instead of sending — sending would post the draft as it stood
  // before the user spoke and throw the transcript away. The strip says so,
  // and a second Enter sends.
  if (VOICE.state === 'recording' || VOICE.state === 'starting') { voiceStop(); return; }
  // `finishing` is the up-to-2.5 s window where the helper is still emitting
  // the last segment and the strip is still on screen saying "it does not
  // send". Falling through here would do exactly what that sentence
  // promises it will not: post the pre-dictation draft and land the
  // transcript in an empty composer afterwards. So Enter waits.
  if (VOICE.state === 'finishing') return;
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
  if (S.busy || S.pending) { steerOrQueue(text); return; }
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
  // item 6: stop the turn for real. Without this the agent kept running while
  // the window said it had stopped, and the sidebar dot would have to lie one
  // way or the other. The `aborted` frame clears the RUNNING entry, so the dot
  // pulses until the agent has actually stopped.
  if (S.turnId && BR) BR.cancel(S.turnId);
  S.busy = false; dropPendingApproval();
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

  // Item 2 (voice input): the mic button is driven by mousedown/mouseup
  // (hold-to-talk) — a click that followed our own mousedown has already
  // been decided there. A click with no press before it is a keyboard
  // activation, and that one toggles.
  const mic = t.closest('[data-mic]');
  if (mic) {
    e.preventDefault();
    const fromOurPress = VOICE.pointerCycle && Date.now() - VOICE.pointerCycle < 1000;
    VOICE.pointerCycle = 0;
    if (fromOurPress) return;
    voiceToggle();
    return;
  }
  // a real control always wins over the dismiss-on-scrim handler behind it
  const a = t.closest('[data-act]'); if (a) { e.preventDefault(); act(a.dataset.act); return; }
  if (t.closest('[data-close]') && !t.closest('.pal, .sheet, .popover, .alertbox')) { act('close'); return; }
  const ap = t.closest('[data-appr]'); if (ap) { answer(ap.dataset.appr); return; }
  const rm = t.closest('[data-room]'); if (rm) { act('room:' + rm.dataset.room); return; }
  // item 6: the pin button sits inside the row, so it has to win over it
  const pn = t.closest('[data-pin]');
  if (pn) { e.preventDefault(); e.stopPropagation(); act((PREFS.pinned.includes(pn.dataset.pin) ? 'unpin:' : 'pin:') + pn.dataset.pin); return; }
  const mo = t.closest('[data-more]'); if (mo) { act('more:' + mo.dataset.more); return; }
  const tkr = t.closest('[data-task]'); if (tkr) { act('task:' + tkr.dataset.task); return; }
  const ss = t.closest('[data-ses]'); if (ss) { act('ses:' + ss.dataset.ses); return; }
  const grp = t.closest('[data-group]');
  if (grp) { OPEN_GROUPS.add(grp.dataset.group); expandGroupInPlace(grp.dataset.group); return; }  // scroll-stable cards: in place, no scrollTop write
  const fchip = t.closest('[data-file]');
  if (fchip && BR) { openFilePath(fchip.dataset.file.replace(/^~/, homeDir() || '~')).then((r) => { if (r && r.ok === false) toast('Could not open', r.error || ''); }); return; }
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
  const uq = t.closest('[data-unqueue]'); if (uq) { const at = +uq.dataset.unqueue; S.queued.splice(at, 1); if (at < STEER.ahead) STEER.ahead -= 1; render(); return; }
  const rv = t.closest('[data-revoke]'); if (rv) { S.grants.splice(+rv.dataset.revoke, 1); render(); toast('Grant revoked'); return; }
  const ask = t.closest('[data-ask]'); if (ask) { const q = S.q; act('close'); S.draft = q; render(); submit(); return; }
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
  // Item 7: Tasks tab inputs edit state in place; only the preview block repaints.
  if (e.target.dataset && e.target.dataset.tkField) { tkFieldInput(e.target.dataset.tkField, e.target.value); return; }
  // Item 7 part B: the hub search box and the MCP add-modal textarea edit state in place.
  if (e.target.id === 'skp-hubq') { SKP.hubQuery = e.target.value; return; }
  if (e.target.id === 'mcp-json') { if (MCP.addModal) { MCP.addModal.json = e.target.value; MCP.addModal.error = null; } return; }
  // Item 7 part C: the LLM filter / URL prompt, the Telegram token prompt and the Import form edit state in place.
  if (e.target.id === 'llm-filter') { LLMP.filter = e.target.value; LLMP.cursor.cloud = llmCloudSectionStart(); llmRepaintList(); return; }
  // Item 7A: editing the reference clears its error (local-models-reducer.ts:101-110).
  // Nothing else repaints on a keystroke — a full render would drop the caret.
  if (e.target.id === 'llm-hf-ref') {
    LLMHF.reference = e.target.value;
    if (LLMHF.error) { LLMHF.error = null; llmRepaint(); llmHfFocus(); }
    return;
  }
  if (e.target.id === 'llm-url') { LLMP.externalDraft = e.target.value; if (LLMP.externalInvalid) { LLMP.externalInvalid = false; llmRepaint(); const n = $('#llm-url'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } } return; }
  if (e.target.id === 'tg-token') { if (TG.token.error) { TG.token.error = null; } return; }
  if (e.target.dataset && e.target.dataset.impField) { IMP.form[e.target.dataset.impField] = e.target.value; return; }
  if (e.target.id === 'tk-search') { TK.search = e.target.value; TK.cursor = 0; const at = e.target.selectionStart; tkRepaint();
    const n = $('#tk-search'); if (n) { n.focus(); n.setSelectionRange(at, at); } return; }
  if (e.target.id === 'sel-filter') { SEL.filter = e.target.value; const at = e.target.selectionStart; render();
    const n = document.getElementById('sel-filter'); if (n) { n.focus(); n.setSelectionRange(at, at); } return; }
  if (e.target.id === 'modelq') { S.modelQuery = e.target.value; const at = e.target.selectionStart; render();
    const n = $('#modelq'); if (n) { n.focus(); n.setSelectionRange(at, at); } return; }
  if (e.target.id === 'dial') { S.dialShare = +e.target.value; refreshDial(); return; }
});


/* ============================================================
   Item 2: voice input — behaviour
   Renderer captures, main supervises, the Swift helper transcribes on this
   Mac with Apple's SpeechAnalyzer. Nothing here talks to the agent: 0.5.5
   has no audio route, no transcription tool and no config key, so no HTTP
   call is made, nothing is written to the agent's config.json, and no
   `atag serve` restart is involved.
   ============================================================ */

/** Repaint just the strip and the button. A render() here would rebuild the
    textarea from S.draft and move the caret mid-sentence — the trap the
    comment on the composer's input handler already warns about. */
function refreshVoice() {
  const strip = document.querySelector('.voicestrip');
  const key = voiceShapeKey();
  if (strip && key === VOICE_STRIP_KEY) {
    // Only the words and the level moved. The audio tap calls this ten times
    // a second, and replacing an element restarts its CSS animation from the
    // first frame — so the pulse on .vsdot.live only ever animates because
    // this branch leaves the dot where it is.
    const t = strip.querySelector('.vstext');
    if (t) t.innerHTML = voiceTextInner();
    const l = strip.querySelector('.vslevel i');
    if (l) l.style.width = voiceLevelPct() + '%';
  } else {
    VOICE_STRIP_KEY = key;
    if (strip) strip.outerHTML = voiceStripHTML();
  }
  // The strip grows as the sentence does, so it is kept scrolled to the
  // words being said right now rather than to the start of the take.
  const t = document.querySelector('.voicestrip .vstext');
  if (t) t.scrollTop = t.scrollHeight;
  refreshMic();
}
function refreshMic() {
  const b = document.querySelector('.micbtn');
  if (!b) { VOICE_MIC_KEY = null; return; }
  // Same reason as above: .micbtn.rec carries the recording pulse, and this
  // ran on every audio chunk. Nothing but these four fields reaches
  // micButton(), so anything else is a repaint with no new pixels.
  const key = VOICE.state + '|' + VOICE.available + '|' + VOICE.reason + '|' + VOICE.locales.join(',');
  if (key === VOICE_MIC_KEY) return;
  VOICE_MIC_KEY = key;
  b.outerHTML = micButton();
}

/** Ask main what is actually possible. Never guessed, never cached over a
    language install. */
function voiceProbe() {
  if (!BR || !BR.voiceProbe) {
    VOICE.available = false; VOICE.code = 'voice-no-bridge'; VOICE.reason = VOICE_REASONS['voice-no-bridge'];
    refreshVoice(); return Promise.resolve();
  }
  return BR.voiceProbe().then((r) => {
    const d = (r && r.data) || {};
    VOICE.supported = d.supported || [];
    VOICE.installed = d.installed || [];
    VOICE.speechLocales = d.speech || [];
    VOICE.dictationLocales = d.dictation || [];
    VOICE.offMachine = !!d.offMachine;
    if (d.ok) {
      VOICE.available = true; VOICE.code = ''; VOICE.reason = ''; VOICE.detail = '';
      const chosen = (d.chosen || []).filter((id) => VOICE.supported.indexOf(id) >= 0);
      if (chosen.length) VOICE.locales = chosen.slice(0, 2);
      else if (VOICE.supported.indexOf('en-US') < 0 && VOICE.supported.length) VOICE.locales = [VOICE.supported[0]];
    } else {
      VOICE.available = false;
      VOICE.code = d.reason || 'voice-helper-failed';
      VOICE.reason = VOICE_REASONS[VOICE.code] || VOICE_REASONS['voice-helper-failed'];
      VOICE.detail = d.detail || '';
    }
    refreshVoice();
  }).catch((e) => {
    VOICE.available = false; VOICE.code = 'voice-helper-failed';
    VOICE.reason = VOICE_REASONS['voice-helper-failed']; VOICE.detail = String(e && e.message || e);
    refreshVoice();
  });
}

/** Every voice verb the click dispatcher can raise. */
function voiceAct(a) {
  if (a === 'voice') { voiceToggle(); return; }
  if (a === 'voice:lang') { VOICE.menu = !VOICE.menu; VOICE.installErr = null; refreshVoice(); return; }
  // The error strip's own ×. Escape does not clear this state on purpose.
  if (a === 'voice:dismiss') {
    if (VOICE.state === 'error') { VOICE.state = 'idle'; VOICE.err = null; }
    VOICE.menu = false; refreshVoice(); return;
  }
  if (a.indexOf('voice:pick:') === 0) { voicePick(a.slice(11), false); return; }
  if (a.indexOf('voice:add:') === 0) { voicePick(a.slice(10), true); return; }
}

/** Choose the first language, or toggle a second one alongside it. */
function voicePick(id, second) {
  if (VOICE.supported.indexOf(id) < 0) return;
  if (second) {
    if (VOICE.installed.indexOf(id) < 0) { voiceInstall(id); return; }
    if (VOICE.locales[1] === id) VOICE.locales = [VOICE.locales[0]];
    else VOICE.locales = [VOICE.locales[0], id];
  } else {
    if (VOICE.installed.indexOf(id) < 0) { voiceInstall(id); return; }
    VOICE.locales = VOICE.locales[1] && VOICE.locales[1] !== id ? [id, VOICE.locales[1]] : [id];
  }
  VOICE.winner = null;
  if (BR && BR.voiceSetLocales) BR.voiceSetLocales(VOICE.locales.slice());
  refreshVoice();
}

/** Download an on-device model. The strip shows the fraction; nothing here
    pretends the language works before the model has landed. */
function voiceInstall(id) {
  if (VOICE.installing) return;
  VOICE.installing = id; VOICE.installFraction = 0; VOICE.installErr = null;
  refreshVoice();
  voiceInstallBridge(id).then((r) => {
    VOICE.installing = null; VOICE.installFraction = 0;
    if (r && r.ok) {
      if (VOICE.installed.indexOf(id) < 0) VOICE.installed = VOICE.installed.concat([id]);
      voicePick(id, false);
    } else {
      VOICE.installErr = 'That language did not install (' + ((r && r.error) || 'unknown') + ')';
    }
    refreshVoice();
  }).catch((e) => {
    // Without this the rejection pins VOICE.installing forever — the guard on
    // the first line of this function then silently refuses every later
    // install for the rest of the session — and lands as an unhandled
    // rejection that the smoke mirrors to stderr.
    VOICE.installing = null; VOICE.installFraction = 0;
    VOICE.installErr = 'That language did not install (' + String((e && e.message) || e) + ')';
    refreshVoice();
  });
}

/** Hold-to-talk and click/click, decided on the press. See VOICE_HOLD_MS. */
function voiceMouseDown(e) {
  const b = e.target.closest && e.target.closest('[data-mic]');
  if (!b || e.button !== 0 || b.disabled) return;
  e.preventDefault();                       // keep the caret in the textarea
  VOICE.pointerCycle = Date.now();
  VOICE.pressAt = VOICE.pointerCycle;
  VOICE.pressStarted = VOICE.state === 'idle' || VOICE.state === 'error';
  if (VOICE.pressStarted) voiceToggle();
}
function voiceMouseUp() {
  if (!VOICE.pressAt) return;
  const held = Date.now() - VOICE.pressAt;
  VOICE.pressAt = 0;
  // A release only ever STOPS. Never voiceToggle() here: if the press had
  // failed to open the microphone the state is 'error', and a toggle would
  // start a second session on the way up.
  const live = VOICE.state === 'recording' || VOICE.state === 'starting';
  if (!VOICE.pressStarted) { if (live) voiceStop(); return; }   // the second click of a toggle
  if (held > VOICE_HOLD_MS && live) voiceStop();                // held down: release stops — the user's "unclick"
  // a short tap leaves it recording; the next click ends it
}

function voiceToggle() {
  if (VOICE.available === false) return;
  if (VOICE.state === 'idle' || VOICE.state === 'error') voiceStart();
  else if (VOICE.state === 'recording' || VOICE.state === 'starting') voiceStop();
}

function voiceStart() {
  if (!BR || !BR.voiceStart) return Promise.resolve();
  const seq = ++VOICE.seq;
  VOICE.state = 'starting'; VOICE.final = ''; VOICE.partial = ''; VOICE.level = 0;
  VOICE.winner = null; VOICE.err = null; VOICE.synthetic = false;
  refreshVoice();
  return BR.voiceStart(VOICE.locales.slice()).then((r) => {
    if (seq !== VOICE.seq) return;
    if (!r || !r.ok) {
      // main answers with a case name; `unsupported-locale` is the one that
      // means the model for this language is not on this Mac.
      const code = r && r.error === 'unsupported-locale' ? 'voice-no-model' : (r && r.error);
      voiceFail(VOICE_REASONS[code] || 'Voice input could not start');
      return;
    }
    VOICE.activeLocales = r.locales || VOICE.locales.slice();
    return voiceCapture(seq);
  }).catch((e) => voiceFail(String((e && e.message) || e)));
}

/** getUserMedia → a 16 kHz AudioContext (Chromium resamples the device for
    us) → the AudioWorklet tap → main → the helper's stdin. */
function voiceCapture(seq) {
  return navigator.mediaDevices.getUserMedia({audio:{channelCount:1, echoCancellation:true, noiseSuppression:true}})
    .then((stream) => {
      if (seq !== VOICE.seq) { stream.getTracks().forEach((t) => t.stop()); return; }
      VOICE.stream = stream;
      const ac = new AudioContext({sampleRate:16000});
      VOICE.ac = ac;
      return ac.audioWorklet.addModule('voice-worklet.js').then(() => {
        // Cancelled while the module loaded: give the device back rather
        // than leaving an open context holding the microphone indicator.
        if (seq !== VOICE.seq) { voiceTeardownAudio(); return; }
        const src = ac.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(ac, 'pcm-tap');
        // A muted sink: the processor writes nothing, and a zero gain makes
        // that explicit rather than trusting an empty output buffer.
        const gain = ac.createGain(); gain.gain.value = 0;
        node.port.onmessage = (ev) => {
          if (VOICE.state !== 'recording' || !ev.data) return;
          VOICE.level = ev.data.peak || 0;
          BR.voiceAudio(new Uint8Array(ev.data.pcm.buffer));
          // Repaint even with the language menu open. The chip that opens it
          // is inside the recording strip, so the menu is openable mid-take,
          // and skipping this froze the words and the level meter for as
          // long as it stayed open — the one thing the user asked to see.
          // refreshVoice()'s fast path only patches `.vstext` and the meter,
          // neither of which is inside `.vsmenu`, so the menu survives it.
          refreshVoice();
        };
        src.connect(node); node.connect(gain); gain.connect(ac.destination);
        VOICE.src = src; VOICE.node = node; VOICE.gain = gain;
        VOICE.state = 'recording';
        refreshVoice();
      });
    })
    .catch((err) => {
      const name = (err && err.name) || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        VOICE.available = false; VOICE.code = 'voice-mic-denied'; VOICE.reason = VOICE_REASONS['voice-mic-denied'];
        voiceFail(VOICE.reason);
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        VOICE.available = false; VOICE.code = 'voice-no-mic'; VOICE.reason = VOICE_REASONS['voice-no-mic'];
        voiceFail(VOICE.reason);
      } else {
        voiceFail('The microphone could not be opened (' + (name || String(err)) + ')');
      }
    });
}

function voiceFail(message) {
  voiceTeardownAudio();
  if (BR && BR.voiceCancel) BR.voiceCancel();
  VOICE.state = 'error'; VOICE.err = message; VOICE.final = ''; VOICE.partial = ''; VOICE.level = 0;
  refreshVoice();
  toast('Voice input', message);
}

function voiceTeardownAudio() {
  if (VOICE.node) { try { VOICE.node.port.onmessage = null; VOICE.node.disconnect(); } catch (e) {} }
  if (VOICE.src) { try { VOICE.src.disconnect(); } catch (e) {} }
  if (VOICE.gain) { try { VOICE.gain.disconnect(); } catch (e) {} }
  if (VOICE.stream) { try { VOICE.stream.getTracks().forEach((t) => t.stop()); } catch (e) {} }
  if (VOICE.ac) { try { VOICE.ac.close(); } catch (e) {} }
  VOICE.node = null; VOICE.src = null; VOICE.gain = null; VOICE.stream = null; VOICE.ac = null;
  VOICE.level = 0;
}

/** Stop and insert. The helper finalizes what it has, so the last segment
    is waited for — bounded, because a wait that never ends is worse than a
    sentence that never arrives. */
function voiceStop() {
  if (VOICE.state !== 'recording' && VOICE.state !== 'starting') return Promise.resolve();
  VOICE.seq++;
  VOICE.lateTake = null;
  VOICE.state = 'finishing';
  refreshVoice();
  voiceTeardownAudio();
  if (VOICE.synthetic || !BR || !BR.voiceStop) { voiceInsert(); return Promise.resolve(); }
  BR.voiceStop();
  return new Promise((resolve) => {
    VOICE.doneResolve = resolve;
    VOICE.doneTimer = setTimeout(() => {
      VOICE.doneTimer = null;
      // The helper did not finish inside the window. Whatever it still owes is
      // claimable until the next take starts — see VOICE.lateTake.
      VOICE.lateTake = VOICE.seq;
      voiceSettle();
    }, 2500);
  }).then(() => voiceInsert());
}
function voiceSettle() {
  if (VOICE.doneTimer) { clearTimeout(VOICE.doneTimer); VOICE.doneTimer = null; }
  const r = VOICE.doneResolve; VOICE.doneResolve = null;
  if (r) r();
}

/** Splice the transcript into the draft at the caret. Text the user typed
    is never replaced and the message is never auto-sent. */
function voiceInsert() {
  const text = (VOICE.final + VOICE.partial).trim();
  const heard = VOICE.activeLocales.length ? VOICE.activeLocales : VOICE.locales;
  VOICE.final = ''; VOICE.partial = ''; VOICE.state = 'idle';
  // A take that produced no words is not the same as a take that inserted
  // nothing on purpose. Say so rather than leaving the composer unchanged
  // with no explanation — that silence reads as a broken button.
  if (!text) {
    refreshVoice();
    toast('Voice input', 'Nothing was heard' + (heard.length ? ' in ' + heard.map(voiceLangName).join(' or ') : ''));
    return '';
  }
  const e = $('#entry');
  const at = e && typeof e.selectionStart === 'number' ? e.selectionStart : S.draft.length;
  const before = S.draft.slice(0, at);
  const after = S.draft.slice(at);
  let piece = text;
  if (before && !/\s$/.test(before)) piece = ' ' + piece;
  if (after && !/^\s/.test(after)) piece = piece + ' ';
  S.draft = before + piece + after;
  if (e) {
    e.value = S.draft;
    const caret = (before + piece).length;
    try { e.setSelectionRange(caret, caret); } catch (err) {}
    autosize(e);
    e.focus();
  }
  S.slash = S.draft.startsWith('/');
  ctxDraftChanged();
  refreshVoice();
  refreshSend();
  return text;
}

/** A segment that arrived after voiceStop gave up waiting. The take is
    already closed and the strip is gone, so nothing on screen would ever show
    it and the next take would wipe it — insert it where the on-time segment
    would have gone, and say that it was late so the words do not simply appear
    in the composer a second after the operator stopped talking. */
function voiceInsertLate() {
  if (VOICE.lateTake === null || VOICE.lateTake !== VOICE.seq) return;
  if (!(VOICE.final + VOICE.partial).trim()) return;
  VOICE.lateTake = null;
  const text = voiceInsert();
  if (text) toast('Voice input', 'The end of that take arrived late — it was added to the message');
}

/** Throw the take away: kill the helper, close the microphone, insert
    nothing. Also what Escape does. */
function voiceCancel(reason) {
  VOICE.seq++;
  VOICE.lateTake = null;
  if (VOICE.doneTimer) { clearTimeout(VOICE.doneTimer); VOICE.doneTimer = null; }
  VOICE.doneResolve = null;
  voiceTeardownAudio();
  if (!VOICE.synthetic && BR && BR.voiceCancel) BR.voiceCancel();
  VOICE.state = 'idle'; VOICE.final = ''; VOICE.partial = ''; VOICE.err = null;
  VOICE.winner = null; VOICE.menu = false; VOICE.synthetic = false;
  refreshVoice();
  // Review fix: a discard the user did not ask for has to say so. Escape and
  // the explicit abandons pass nothing and stay silent — the operator knows
  // what they just pressed; the window-blur discard passes its reason, because
  // otherwise a notification or a Cmd-Tab mid-sentence reads as the button
  // randomly stopping. Same argument as voiceInsert's "Nothing was heard".
  if (reason) toast('Voice input', reason);
}

/** One helper event. The accumulation rule lives here and it is the one
    thing a naive implementation gets wrong: the helper emits a final per
    SEGMENT, and every segment ends partial-then-final with the same words,
    so a final must both append to `final` AND clear `partial`. Without the
    clear, the closing sentence is inserted twice. */
function voiceEvent(o) {
  if (!o || typeof o !== 'object') return;
  const t = o.type;
  if (t === 'ready') { VOICE.activeLocales = o.locales || VOICE.locales.slice(); }
  else if (t === 'partial') { VOICE.partial = String(o.text == null ? '' : o.text); }
  else if (t === 'final') { VOICE.final += String(o.text == null ? '' : o.text); VOICE.partial = ''; voiceInsertLate(); }
  else if (t === 'replace') {
    // Two languages heard the same audio and the second one scored higher.
    VOICE.final = String(o.text == null ? '' : o.text); VOICE.partial = '';
    VOICE.winner = o.locale || null;
    voiceInsertLate();
  }
  else if (t === 'install') { VOICE.installFraction = +o.fraction || 0; }
  else if (t === 'installed') { if (o.locale && VOICE.installed.indexOf(o.locale) < 0) VOICE.installed = VOICE.installed.concat([o.locale]); }
  else if (t === 'error') {
    if (o.code === 'install') { VOICE.installErr = String(o.message || 'install failed'); }
    else if (VOICE.state === 'recording' || VOICE.state === 'starting') {
      voiceFail(String(o.message || o.code || 'the speech helper failed'));
      return;
    }
  }
  else if (t === 'done') { voiceSettle(); }
  else if (t === 'closed') {
    if (o.cancelled) { VOICE.final = ''; VOICE.partial = ''; }
    else if (VOICE.state === 'recording' || VOICE.state === 'starting') {
      voiceFail('Voice input stopped unexpectedly');
      return;
    }
    voiceSettle();
  }
  refreshVoice();
}

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

  // Item 2 (voice input): Escape cancels a live recording BEFORE anything
  // else looks at it. Five later Escape branches return first — a pending
  // approval, the palette, the settings/tasks/skills key layers, any open
  // overlay or menu, and the slash popover — and every one of them is a
  // perfectly normal state to be dictating in. A swallowed Escape would
  // leave the microphone hot with no way to discard the take.
  // `error` is deliberately NOT in this list: an error strip is not
  // time-critical and nothing else clears it, so leaving it here would let a
  // stale failure outrank whatever modal the user is actually looking at for
  // the rest of the session. It has its own × instead (voice:dismiss).
  if (k === 'Escape' && (VOICE.state === 'recording' || VOICE.state === 'starting'
      || VOICE.state === 'finishing' || VOICE.menu)) {
    e.preventDefault(); voiceCancel(); return;
  }

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
  // Item 7 part B: the Skills room is the same Skills tab, so its keys work there too.
  if (!S.settings && !S.overlay && S.menuOpen === null && S.room === 'skills') {
    if (skillsKey(e, k, inText)) return;
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
    // r4-ui item 5: renderOverlays draws four surfaces that are NOT S.overlay,
    // so the gate above (S.overlay || S.settings || S.menuOpen) does not catch
    // them and Escape reaches this block with a modal on screen. The selector,
    // the provider wizard and the alert box are what act('close') clears.
    // Onboarding is the exception and Escape is DELIBERATELY inert during it:
    // the wizard has no cancel (act('close') does not clear OB.open), and
    // there is no other handler for the key while it is up — first-run setup
    // is a sequence the operator finishes or quits the app out of. Correction
    // to an earlier comment here: nothing else "owns" Escape in that state.
    // Without these two lines the menu below would open ON TOP of a live
    // modal instead of dismissing it.
    if (OB.open) return;
    if (SEL.open || WIZ.phase || S.alert) { act('close'); return; }
    /* "Escape button should open the menu" — the user's words, and the TUI's
       own last-resort branch (tui-app.tsx onEscape). It is LAST on purpose:
       scroll-to-bottom, abort, the toast pop, every overlay/settings/palette/
       slash/approval/per-tab Escape above all outrank it, so the key keeps
       every meaning it already had and gains one only where it would otherwise
       have done nothing. The desktop's only menu is the settings window's menu
       column (the README's contract: "Settings is the TUI menu"), so that is
       what opens — not a second tree, and not the native macOS menu bar, which
       is a different vocabulary altogether.
       Deliberately NOT done here: clearing a half-written draft first, which is
       the branch the TUI puts immediately above its own. The user asked for
       Escape to open the menu, full stop, and clearing a composer draft on one
       keypress with no undo is a destructive behaviour nobody asked for. So a
       draft survives and the menu opens over it.
       S.settingsPane is not reset either: it defaults to 'tasks' and otherwise
       reopens where the operator left it. */
    S.settings = 1;
    MENUFOCUS.want = true;
    render();
    settingsPaneEntered(true);
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
  loadCodingMode();
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
  // item 6: the sidebar's Tasks list is every task the agent holds.
  if (tasks && tasks.ok && tasks.data && Array.isArray(tasks.data.tasks)) {
    TASKS_ERR = null;
    applyTasks(tasks.data.tasks);
  } else if (tasks && tasks.ok === false) {
    // route-tasks.ts answers 404 — and only 404 — when tasks are switched off.
    // Any other failure is a failure and says so; claiming "disabled" would be
    // a fact this window does not have.
    TASKS_ERR = /HTTP 404/.test(tasks.error || '')
      ? 'tasks are disabled in this agent'
      : 'could not load tasks: ' + ((tasks.error || 'unknown error'));
  }
  applySessions(sessions);
  render();
  nameVisibleSessions();
  bswRefreshFacts();
  // Lane B — item 3: caps + config are in, so the chip can carry a figure
  // before any message. A fresh connection re-probes the preview route.
  CTX.previewSupported = null;
  refreshContext();
}

/* ---------------- item 6: the two lists' data ---------------- */

/** One task row. `userMessage` is the payload's field — `message` never was. */
function taskEntry(t) {
  return {
    id:t.id,
    t:(t.userMessage || '').trim().replace(/\s+/g, ' ').slice(0, 72) || '(empty)',
    when:t.schedule ? formatScheduleLabel(t.schedule) : 'once',
    status:t.status || 'pending',
    recurring:!!t.recurring,
    updatedAt:t.updatedAt || 0,
    sessionId:t.sessionId || null,
    lastError:t.lastError || null,
  };
}
function applyTasks(list) { TASKS.length = 0; list.forEach((t) => { if (t && t.id) TASKS.push(taskEntry(t)); }); }

/** GET /api/sessions → the Chats rows. turnCount > 0 is the desktop's
    hasFirstPrompt: the store is written at turn end, so a row with no turn has
    no first prompt to name it with (chat-orchestrator.ts:388-399). */
function applySessions(res) {
  if (!res || !res.ok || !res.data || !Array.isArray(res.data.sessions)) return false;
  const before = new Map(SESSIONS.map((s) => [s.id, s]));
  SESSIONS.length = 0;
  res.data.sessions.forEach((x) => {
    if (!x || !x.id || !((x.turnCount || 0) > 0)) return;
    const was = before.get(x.id);
    SESSIONS.push({
      id:x.id,
      t:was && was.named ? was.t : x.id,
      named:!!(was && was.named),
      updatedAt:x.updatedAt || 0,
      status:x.status || '',
      turnCount:x.turnCount || 0,
    });
  });
  return true;
}

/** Re-read the list: after a turn ends, after a delete, after a page grows. */
async function refreshSessions() {
  if (!BR) return;
  const res = await BR.sessions();
  if (!applySessions(res)) return;
  render();
  nameVisibleSessions();
}

/* A session id says nothing; its first message says what it is about. That
   costs one GET /api/sessions/{id} (the whole transcript) per row, so only the
   rows actually on screen are named — with limit=200 naming everything would
   fire 200 requests at boot. */
function nameVisibleSessions() {
  if (!BR) return;
  sidebarChats().rows.filter((row) => !row.named).forEach((row) => {
    row.named = true;
    BR.session(row.id).then((res) => {
      /* Review fix: applySessions rebuilds SESSIONS with fresh objects while a
         naming fetch is in flight (refreshSessions runs after every turn), and
         the new object copies `named: true` with the id still standing in for
         the name. Writing the name onto the discarded object left that row
         showing `api-2931b30b63359b7d` for the life of the window, so find the
         row that is on the list now. */
      const cur = SESSIONS.find((x) => x.id === row.id);
      if (!cur) return;
      const turns = res && res.ok && res.data && res.data.turns;
      if (!Array.isArray(turns)) { cur.named = false; return; }
      const first = turns.find((t) => t.kind === 'user' && t.text);
      cur.t = first ? first.text.trim().replace(/\s+/g, ' ').slice(0, 72) : '(empty)';
      cur.named = true;
      render();
    });
  });
}

/* Pin and read state: Electron userData/prefs.json, per machine and per
   viewer. The agent has no route and no store field for either, so there is
   nothing to read them from and nothing to pretend. */
async function loadPrefs() {
  if (!BR || !BR.prefsGet) { PREFS.loaded = true; return; }
  const res = await BR.prefsGet();
  if (res && res.ok && res.data) {
    PREFS.pinned = Array.isArray(res.data.pinned) ? res.data.pinned.slice() : [];
    PREFS.seen = res.data.seen && typeof res.data.seen === 'object' ? Object.assign({}, res.data.seen) : {};
  }
  PREFS.loaded = true;
  render();
}
function savePrefs() {
  if (!BR || !BR.prefsSet) return;
  BR.prefsSet({pinned:PREFS.pinned.slice(), seen:Object.assign({}, PREFS.seen)}).then((res) => {
    if (res && res.ok === false) toast('Could not save the sidebar state', res.error || '');
  });
}
/** Opening a chat is reading it: the dot goes empty and stays empty. */
function markSeen(id) {
  if (!id) return;
  const row = SESSIONS.find((s) => s.id === id);
  PREFS.seen[id] = Math.max(PREFS.seen[id] || 0, (row && row.updatedAt) || 0, Date.now());
  ATTN.delete(id);
  savePrefs();
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
    // item 6: the sidebar's running dot follows the stream, not S.busy.
    RUNNING.set(res.turnId, S.agentSession || null);
    renderSidebar();
  });
}

function onChatEvent(ev) {
  /* item 6 — the running dot, bookkept BEFORE the turnId guard below.
     A turn keeps streaming after the user opens another chat, and its
     done/aborted/error is the only truthful end-of-run signal there is:
     S.busy is cleared by an approval and by abort() while the agent is still
     working, so it cannot drive a "the agent is running here" dot. */
  if (ev && RUNNING.has(ev.turnId)) {
    if (ev.kind === 'session_id') { RUNNING.set(ev.turnId, pick(ev.payload, 'sessionId', 'session_id', 'id')); renderSidebar(); }
    if (ev.kind === 'done' || ev.kind === 'aborted' || ev.kind === 'error') {
      const sid = RUNNING.get(ev.turnId);
      RUNNING.delete(ev.turnId);
      if (ev.kind === 'error' && sid) ATTN.add(sid);
      // Review fix: the turn is over, so nothing of it is waiting for an
      // approval any more. Without this the row kept saying "waiting for your
      // approval" for the rest of the window's life when the turn ended (an
      // abort, an error, the backend-switch restart) with a request open.
      if (sid) PENDING_APPROVALS.delete(sid);
      // Review fix: the composer's busy flag belongs to the chat on screen.
      // When this turn's frames are no longer the ones S.turnId points at, the
      // branch below never runs and the composer would stay busy for good.
      if (sid && sid === S.sessionId && ![...RUNNING.values()].includes(sid)) S.busy = false;
      // The chat on screen is being read as it lands, so it is never unread.
      if (sid && sid === S.sessionId) { PREFS.seen[sid] = Date.now(); savePrefs(); }
      // Review fix: openSession promises "the reply lands when it finishes"
      // for a chat whose turn is running but whose stream is not in this log
      // (the user left and came back). Nothing reloaded it, so the reply never
      // arrived. It finished — load the stored transcript that now holds it.
      if (sid && sid === S.sessionId && !S.log.some((m) => m.id === S.streamId)) openSession(sid);
      refreshSessions().then(() => {
        if (sid && sid === S.sessionId) {
          const row = SESSIONS.find((x) => x.id === sid);
          if (row) { PREFS.seen[sid] = Math.max(PREFS.seen[sid] || 0, row.updatedAt); savePrefs(); }
        }
        render();
      });
    }
  }
  if (!ev || ev.turnId !== S.turnId) return;
  const item = S.log.find((m) => m.id === S.streamId);
  /* Review fix: `item` is undefined when the user opened another chat while
     this turn was still streaming — openSession replaced S.log, so the
     streaming item is gone. Every branch that positions a card against it
     would then run `S.log.splice(S.log.indexOf(undefined), 0, card)`, i.e.
     `splice(-1, …)`, and drop chat A's tool card, reasoning block or "turn
     failed" line second-to-last into chat B's transcript. The branches below
     therefore write into the log only while the stream is on screen; the
     end-of-turn bookkeeping (busy, queue, dot, reload) still runs. */
  // Any frame after a running tool card brackets that tool's wall time as
  // observed here. The trace's own measurement replaces it after the turn.
  for (let i = S.log.length - 1; i >= 0; i--) {
    const c = S.log[i];
    if (c.k === 'tool' && c.ok === null && c.startedAt && !c.observedMs) { c.observedMs = Math.max(1, Date.now() - c.startedAt); break; }
    if (c.k === 'tool') break;
  }

  if (ev.kind === 'session_id') {
    S.agentSession = pick(ev.payload, 'sessionId', 'session_id', 'id');
    // item 6: the streaming item being in the visible log is the proof that
    // this is the chat the user is looking at — so its row is the current one.
    if (S.log.some((m) => m.id === S.streamId)) S.sessionId = S.agentSession;
    renderSidebar();
    return;
  }
  if (ev.kind === 'reasoning_progress') {
    const text = pick(ev.payload, 'delta', 'text', 'content') || '';
    if (!text || !item) return;   // review fix: no streaming item on screen, nothing to splice against
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
    if (name === 'reply' || name === 'finish' || !item) return;   // review fix: see above
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
  /* Item 7C — the agent read a steer at a step boundary. The frame comes
     UNNAMED on the wire and is recognised in agent-client.ts by its
     `object`. A steer sent from this window is already in the transcript;
     one that arrived from anywhere else (a scheduled task, another
     client, `atag tui`) is added here so the log says what the turn was
     actually told. */
  if (ev.kind === 'steer_applied') {
    const text = String(ev.text || '');
    if (!text || !item) return;
    // One entry per steer this window sent, consumed once — so two identical
    // steers in one turn show as two bubbles, and a frame for a steer sent
    // from anywhere else always shows.
    const mine = STEER.mine.indexOf(text);
    if (mine >= 0) { STEER.mine.splice(mine, 1); return; }
    pushSteerEntry(text); render();
    return;
  }
  /* Item 7C — accepted, and then the turn ended before it was read.
     `steer` already answered "yes" to whoever sent these, so dropping
     them would lose a message the user watched being accepted. They go to
     the FRONT of the queue, ahead even of refused steers: they are
     corrections aimed at the turn that just ran. */
  if (ev.kind === 'steer_undelivered') {
    const list = (ev.payload && Array.isArray(ev.payload.undelivered)) ? ev.payload.undelivered : [];
    if (!list.length) return;
    S.queued.unshift.apply(S.queued, list.map((u) => String((u && u.text) || '')));
    STEER.ahead += list.length;
    // `note:true`: a notice about the SESSION, appended after a turn that may
    // well have finished — endMarkIds steps over it rather than treating it as
    // the turn's outcome and deleting the turn's full stop.
    if (item) S.log.push({id:nid(), k:'system', note:true, text: list.length + ' message' + (list.length === 1 ? '' : 's')
      + ' arrived too late for that turn — sending ' + (list.length === 1 ? 'it' : 'them') + ' next'});
    // The parked store is the server's; ack it or it accumulates.
    const seq = list.reduce((max, u) => Math.max(max, (u && Number(u.seq)) || 0), 0);
    const sid = RUNNING.get(ev.turnId) || S.agentSession;
    if (sid && BR && BR.ackSteers) BR.ackSteers(sid, seq, 0);
    render();
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
    // Review fix: only into the transcript this turn is actually streaming
    // into — otherwise the failure of chat A is announced inside chat B.
    // DRIFT FIX (D2 of the 0.5.5 review): the frame carries `{error, category}`
    // and the desktop was reading `ev.error` off a payload it never lifted,
    // so a failed turn printed the bare sentence `turn failed: `. The
    // bracketed category mirrors the TUI's `failed [${category}]: …`.
    if (ev.kind === 'error' && item) S.log.push({id:nid(), k:'system',
      text:'turn failed' + (ev.category ? ' [' + esc(ev.category) + ']' : '') + ': ' + esc(ev.error || 'the agent gave no message')});
    // A turn ended: the steer watermark belongs to the turn that is over
    // (chat-orchestrator.ts resets steeredAhead with the queue). The
    // sent-and-not-yet-echoed list goes with it — a `steer_applied` for this
    // turn cannot arrive after its done frame, and carrying entries into the
    // next turn would swallow a bubble there.
    STEER.ahead = 0;
    STEER.mine.length = 0;
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
    // item 6: which chat is waiting. The agent's ApprovalRequest carries it,
    // and it is the one attention signal that works for a turn this window did
    // not start (a scheduled task's, say).
    sessionId: payload.sessionId || null,
  };
  if (req.sessionId) PENDING_APPROVALS.set(req.sessionId, req.approvalId);
  S.pending = req;
  S.log.push(req);
  S.apprFocused = false;
  S.busy = false;
  render();
}

/* Review fix: an approval that leaves the window without a verdict — an abort
   — must also leave PENDING_APPROVALS, which only answerLive used to clear.
   Otherwise the row goes on claiming "waiting for your approval" although
   nothing here can answer it any more.
   Second review fix: this is ONLY for the paths that actually end the turn
   (abort(), which cancels it). Switching chat or starting a new session
   changes nothing about whether the gate is open — the agent is still blocked
   on it — so those paths call forgetApprovalCard() instead, which drops the
   card from this view and leaves the map (and therefore the filled dot) alone.
   The map's other exit is the turn's own done/aborted/error frame. */
function dropPendingApproval() {
  const req = S.pending;
  S.pending = null;
  if (req && req.sessionId) PENDING_APPROVALS.delete(req.sessionId);
}

/** The approval card leaves this view; the request itself is untouched. */
function forgetApprovalCard() {
  S.pending = null;
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
  if (req.sessionId) PENDING_APPROVALS.delete(req.sessionId);   // item 6: the row stops asking
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
  // item 6: nothing is open at boot, so no row is highlighted. The old code
  // pointed S.sessionId at the newest row without opening it — a row that read
  // as "the thread you are in" over an empty transcript.
  S.sessionId = '';
  loadPrefs();
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


/* ---- live projections: what the chips read when an agent is attached ----
   Item 3 review fix: ctxTotal()/ctxUsed() are gone. They were the prototype's
   fallbacks — a hardcoded 128k window and an 18k "used" figure — left
   unreferenced when the context chip and panel moved to CTX. Nothing
   fabricated ever reached the screen, but a live-looking helper carrying the
   exact numbers the spec forbids is an invitation to a regression.
   `tok()` went with them: model context windows are formatted by
   fmtContextWindow (the TUI's own formatContextWindow), so the picker and the
   chip no longer print two different numbers for one window. */
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
    // Review fix: selectPromptLlmMeta takes the catalogue id ONLY in managed
    // mode; on an external route the model is whatever the operator's own
    // server has loaded, which it reports through /props and this window has
    // not probed. Naming localModels.managed.modelId there would be a label
    // for a file the route does not use, so the chip goes unrendered instead.
    if (selBackend() === 'custom') return '';
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
   r5 item 7 — SETUP WIZARD.

   A one-to-one port of the TUI's first-run flow: the fifteen steps of
   src/tui/onboarding/onboarding-state.ts, one pure reducer transcribing
   onboarding-reducer.ts case for case, ONE key router transcribing
   onboarding-step-keys.ts that every clickable row also goes through
   (which is the invariant that file exists to hold), the TUI's copy
   verbatim, and a real hint strip built from onboardingFooterFor.

   Five things cannot be reproduced against the shipped agent, and each
   is degraded here in the open rather than faked:

   1. BYTE-EXACT PULL PROGRESS.  The TUI reads typed events with byte
      counts on every chunk from an in-process orchestrator; the agent
      publishes no local-models HTTP route, so the only channel is
      `atag models pull`, which in non-TTY writes ONE line per 5%
      (src/cli/models-handlers.ts:107-109).  Everything here moves in
      those steps, the rate comes from the timestamps of those samples,
      and nothing is smoothed into a continuous-looking number.

   2. THE `llama.cpp runtime` PHASE.  `models pull` never fetches the
      backend; only `models update` does, labelled `backend zip`.  The
      flow probes `models status` for `binary missing` and runs
      `models update` as a first queue entry when it is — but
      runLocalModelsUpdate returns 0 WITHOUT downloading when the
      version file already names the latest tag, so when no progress
      sample arrives the row is drawn as PASSED (which is what the TUI
      shows once the phase is over) and never as a bar nothing drives.

   3. THE KEY VERIFICATION GATE.  `verifyWizardBeforeSave` and
      `probeWizardContract` have no CLI or HTTP surface.  The cloud step
      keeps the desktop's own check — upsert, then list the provider's
      models under the key — and says only what that proves.

   4. THE VISION PROJECTOR AS A THIRD PHASE.  `models pull` fetches the
      GGUF alone, so a curated vision model shows two phases and says
      nothing about a projector.  The Hugging Face branch keeps its own
      projector fetch, which now rides the pull stream under its own
      `kind` so its percent cannot be folded into the weights bar.

   5. THE CURATED PICK METADATA.  `atag models list` prints only
      id/family/size/context/downloaded/active, so `recommendLocalModel`,
      `orderLocalModelPicks`, `fitFor(def, ram)` and the row `note()`
      cannot be ported: there is no `recommendedRamGb`, no `minRamGb`, no
      `description`, no catalogue `tag` and — the one with a safety edge
      — no `uncensored` flag.  So NO ROW IS STARRED: `★ recommended`, the
      ⚠ warning tag and the description are dropped from the row rather
      than invented, and the uncensored-last pinning the TUI does is not
      reproducible until the agent exposes the field.  The rows are
      ordered by the desktop's existing size-vs-RAM heuristic and say so.
   ============================================================ */

/**
 * decideOnboarding() (needs-onboarding.ts:24-32) with both readiness
 * predicates this window can actually evaluate.
 *
 * Two divergences from the old desktop gate are closed here:
 * `isCloudTextProviderReady` (local-backend-readiness.ts:25-38) wants a
 * resolved KEY, not just an active non-llama entry — `readyIds` is
 * providersReady(), which is that same key check in main; and
 * `isLocalBackendConfigured` (:76-77) explicitly refuses the shipped
 * default URL, which the old gate accepted as "configured".
 * `isManagedModeReadyOnDisk`'s stat of the weights file stays out: the
 * renderer cannot see the data dir.
 */
function needsOnboarding(cfg, readyIds) {
  const ob = (cfg && cfg.tui && cfg.tui.onboarding) || {};
  if (ob.completedAt || ob.skippedAt) return false;
  const lm = (cfg && cfg.localModels) || {};
  const managedReady = lm.mode === 'managed' && lm.managed && lm.managed.modelId;
  const localConfigured = lm.mode === 'external' && !!lm.url && lm.url !== OB_DEFAULT_LLAMA_URL;
  const llm = (cfg && cfg.llm) || {};
  const active = (llm.providers || []).find((p) => p.id === llm.activeTextProvider);
  const cloudReady = !!active && active.kind !== 'llama-server'
    && (!Array.isArray(readyIds) || readyIds.indexOf(active.id) >= 0);
  return !(managedReady || localConfigured || cloudReady);
}

/** The desktop's size-vs-RAM heuristic — all the catalogue gives us. */
function fitFor(sizeLabel, ram) {
  const gb = parseFloat(String(sizeLabel)) || 0;
  const needed = Math.ceil(gb * 1.6);
  if (needed <= ram) return {v:'fits', rank:0, label:'fits this Mac'};
  if (needed <= ram * 1.4) return {v:'tight', rank:1, label:'tight on ' + ram + ' GB'};
  return {v:'over', rank:2, label:'needs about ' + needed + ' GB'};
}

/* ---------------- state: the pure reducer ---------------- */

/** moveOnboardingCursor (onboarding-state.ts:179-186): wrapping, never clamping. */
function moveOnboardingCursor(cursor, delta, length) {
  const count = Math.max(1, length === undefined ? OB_CHOICES.length : length);
  return (((cursor + delta) % count) + count) % count;
}

/** stepOwnsItsKeyboard (onboarding-state.ts:195-197). */
function obStepOwnsKeyboard(step) {
  return step === 'cloud' || step === 'local_hf_ref' || step.indexOf('custom_') === 0;
}

/** The sixteen fields, as a plain value the reducer can fold. */
function obSnapshot() {
  return {
    step: OB.step, offer: OB.offer, resumeAfterCloud: OB.resumeAfterCloud,
    localModelId: OB.localModelId, outcome: OB.outcome, skipSecondOffer: OB.skipSecondOffer,
    cursor: OB.cursor, chatUrl: OB.chatUrl, embeddingUrl: OB.embeddingUrl,
    busy: OB.busy, error: OB.error, hfReference: OB.hfReference, hfRepo: OB.hfRepo,
    importAgents: OB.importAgents, importOptions: OB.importOptions, importReport: OB.importReport,
  };
}

/**
 * reduceOnboardingAction (onboarding-reducer.ts:19-335), case for case.
 * Pure: `s` in, a new `s` out, `null` for an action that is not ours.
 * The two guards that make it correct are kept — a late repo resolve is
 * ignored off `local_hf_ref`, and a late import report off the two
 * import screens — because both answers arrive seconds after they were
 * asked for and must not yank a flow that moved on.
 */
function obReduce(s, action) {
  switch (action.type) {
    case 'onboarding_step_set':
      // Each list owns its own cursor.
      return Object.assign({}, s, {step: action.step, cursor: 0, error: null, busy: false});
    case 'onboarding_cursor_moved':
      return Object.assign({}, s, {cursor: moveOnboardingCursor(s.cursor, action.delta, action.length)});
    case 'onboarding_cursor_set':
      return Object.assign({}, s, {cursor: action.cursor});
    case 'onboarding_url_changed':
      return Object.assign({}, s, action.field === 'chat' ? {chatUrl: action.value} : {embeddingUrl: action.value});
    case 'onboarding_busy_set':
      return Object.assign({}, s, {busy: action.busy});
    case 'onboarding_error_set':
      return Object.assign({}, s, {error: action.error});
    case 'onboarding_local_model_picked':
      return Object.assign({}, s, {step: 'local_download', localModelId: action.modelId, error: null});
    case 'onboarding_hf_reference_changed':
      return Object.assign({}, s, {hfReference: action.value});
    case 'onboarding_hf_repo_resolved':
      if (s.step !== 'local_hf_ref') return s;
      return Object.assign({}, s, {step:'local_hf_pick', hfRepo: action.repo, cursor:0, busy:false, error:null});
    case 'onboarding_cloud_meanwhile_opened': {
      const from = s.step === 'wait_or_jump' ? 'wait_or_jump' : 'local_download';
      return Object.assign({}, s, {step:'cloud', resumeAfterCloud: from, cursor:0, error:null});
    }
    case 'onboarding_import_opened':
      return Object.assign({}, s, {step:'import_pick', importAgents: action.agents,
        importOptions: [], importReport: null, cursor: 0, error: null, busy: false});
    case 'onboarding_import_agent_toggled':
      return Object.assign({}, s, {importAgents: s.importAgents.map((row, index) =>
        index === action.index ? Object.assign({}, row, {enabled: !row.enabled}) : row)});
    case 'onboarding_import_run_started':
      return Object.assign({}, s, {busy: true, error: null,
        importOptions: action.options === undefined ? s.importOptions : action.options});
    case 'onboarding_import_report':
      if (s.step !== 'import_pick' && s.step !== 'import_preview') return s;
      return Object.assign({}, s, {step: action.executed ? 'import_done' : 'import_preview',
        importReport: action.report, cursor: 0, busy: false, error: null});
    case 'onboarding_import_failed':
      return Object.assign({}, s, {busy: false, error: action.error});
    case 'onboarding_second_backend_offered':
      return Object.assign({}, s, {step:'propose_second', offer: action.offer, cursor:0, error:null, busy:false});
    case 'onboarding_finished':
      // Only this action can request the bypass.
      return Object.assign({}, s, {step:'finished', outcome: action.outcome,
        skipSecondOffer: action.skipSecondOffer === true, busy:false, error:null});
    case 'local_models_pull_finished': {
      if (s.step !== 'local_download' && s.step !== 'wait_or_jump') return null;
      if (action.kind !== 'chat') return null;
      // A cloud model configured mid-download is the outcome that matters.
      return Object.assign({}, s, {step:'finished', outcome: s.outcome === null ? 'local' : s.outcome});
    }
    case 'providers_wizard_succeeded': {
      if (s.step !== 'cloud') return null;
      const stillOpen = action.pullRunning || action.pullFailed;
      const step = s.resumeAfterCloud !== null && stillOpen ? 'wait_or_jump' : 'finished';
      return Object.assign({}, s, {step, outcome:'cloud', resumeAfterCloud:null, cursor:0});
    }
    case 'providers_wizard_closed': {
      if (s.step !== 'cloud') return null;
      const resume = s.resumeAfterCloud;
      // A pull that landed cleanly while the wizard was up is exactly
      // what local_models_pull_finished would have concluded: done.
      const step = resume === null ? 'choose'
        : (resume === 'local_download' && action.pullLandedCleanly) ? 'finished' : resume;
      return Object.assign({}, s, {step,
        outcome: step === 'finished' ? (s.outcome === null ? 'local' : s.outcome) : s.outcome,
        resumeAfterCloud: null, cursor: 0, error: null, busy: false});
    }
    default:
      return null;
  }
}

/** Fold one action onto OB and repaint. Every screen and key goes here. */
function obDispatch(action) {
  if (!OB.open) return;
  // The two wizard outcomes need the live pull state the TUI reads off
  // its panel slice; supply it here so the reducer stays pure.
  if (action.type === 'providers_wizard_succeeded') {
    action = Object.assign({}, action, {pullRunning: DL.job !== null, pullFailed: DL.job === null && DL.error !== null});
  }
  if (action.type === 'providers_wizard_closed') {
    action = Object.assign({}, action, {pullLandedCleanly: DL.job === null && DL.error === null});
  }
  const next = obReduce(obSnapshot(), action);
  if (next) Object.assign(OB, next);
  obAfterStep();
  render();
}

/**
 * The stamps useOnboardingLifecycle writes on ARRIVAL rather than on
 * success (:77-81, :107-110, :127) and the effects a step change starts.
 * Written in the same tick the step is entered: a run interrupted by a
 * crash must not re-pitch a screen the operator already saw.
 */
function obAfterStep() {
  if (OB.step === OB_LAST_STEP) return;
  const was = OB_LAST_STEP;
  OB_LAST_STEP = OB.step;
  if (was === 'intro' && OB.step !== 'intro') obSkyStop();
  // isLocalSetupStep (propose-second-backend.ts:57-59): the list itself
  // and the two download screens. Walking in and back out is an answer.
  if (OB.step === 'local_pick' || OB.step === 'local_download' || OB.step === 'wait_or_jump') {
    obStampOnce('localSetupSeenAt');
  }
  if (OB.step === 'local_pick' && !OB.models.length && !OB.busy) obLoadModels();
  if (OB.step === 'finished') obSettle();
}

/** Write a tui.onboarding.* stamp once, without blocking the repaint. */
function obStampOnce(leaf) {
  if (OB_STAMPED[leaf] || !BR) return;
  OB_STAMPED[leaf] = true;
  const at = new Date().toISOString();
  OB_STAMP_LOG.push({leaf, at, step: OB.step});
  BR.configSet('tui.onboarding.' + leaf, at);
}

/* ---------------- chrome: subtitles and the hint strip ---------------- */

/** onboardingFooterFor (onboarding-chrome.ts:31-88), verbatim.
 *  `ctrlCArmed` is always false here: the desktop has no Ctrl+C chord. */
function obFooter() {
  const quit = 'ctrl+c quit';
  switch (OB.step) {
    case 'choose': return '↑/↓ move   enter select   1–3 jump   esc skip   ' + quit;
    case 'cloud': return WIZ.phase === 'pick_kind'
      ? '↑/↓ move   / search   enter select   esc back   ' + quit
      : '↑/↓ move   enter select   esc back   ' + quit;
    case 'custom_chat_url': return 'enter test & continue   esc back   ' + quit;
    case 'custom_embedding_url': return 'enter test & save   empty enter skips embeddings   esc back   ' + quit;
    case 'local_pick': return '↑/↓ move   enter select   esc back   ' + quit;
    case 'local_hf_ref': {
      if (OB.busy) return 'esc cancel the lookup   ' + quit;
      const clear = OB.hfReference.length > 0 ? 'ctrl+l clear   ' : '';
      return 'enter look it up   ' + clear + 'esc back   ' + quit;
    }
    case 'local_hf_pick': return '↑/↓ move   enter download   esc back   ' + quit;
    case 'local_download': return 'c set up cloud meanwhile   s skip to the agent   ' + quit;
    case 'propose_second': return '↑/↓ move   enter select   esc skip   ' + quit;
    case 'import_pick': return OB.busy ? 'scanning…   ' + quit
      : '↑/↓ move   space tick   enter select   esc skip   ' + quit;
    case 'import_preview': return OB.busy ? 'importing…   ' + quit : 'enter import   esc adjust   ' + quit;
    case 'import_done': return 'any key to start   ' + quit;
    case 'wait_or_jump': return '↑/↓ move   enter start or add a provider   ' + quit;
    case 'finished': return '';
    case 'intro': return quit;
    default: return quit;
  }
}

/** The hint strip, split back into chords and sentences by OB_KEY_TOKEN. */
function obHintsHTML() {
  const footer = obFooter();
  if (!footer) return '';
  const hints = footer.split(/\s{3,}/).filter(Boolean).map((chunk) => {
    const words = chunk.split(' ');
    let n = 0;
    while (n < words.length && OB_KEY_TOKEN.test(words[n])) n += 1;
    const caps = words.slice(0, n).join(' ');
    const rest = words.slice(n).join(' ');
    return '<span class="hint">' + keycaps(caps) + (rest ? '<span>' + esc(rest) + '</span>' : '') + '</span>';
  }).join('');
  return '<div class="ob-hints">' + hints + '</div>';
}

/** The header lockup (onboarding-header.tsx:42-72). The intro draws none. */
function obHeadHTML() {
  return '<div class="ob-head"><div class="ob-lock">'
    + '<span class="ob-mark">' + MARK_COLOR.replace('width="16" height="16"', 'width="34" height="34"') + '</span>'
    + '<span><span class="ob-wm">' + esc(OB_COPY.headerWordmark) + '</span><br>'
    + '<span class="ob-sub2">' + esc(OB_SUBTITLES[OB.step] || '') + '</span></span>'
    + '</div></div>';
}

/* ============================================================
   The intro's sky.  star-field.ts + orbit-field.ts + star-tiers.ts +
   mark-clear-space.ts, ported onto a canvas, with the motion the TUI
   cannot have: a per-star pulse, a whole-field parallax drift scaled by
   tier so the depth the tiers encode is visible, and the halo turning
   slowly about the mark — the static ellipse made literal.
   ============================================================ */

/** mulberry32 (star-field.ts:254-266), verbatim. `Math.random` is not an
 *  option: the field must be the same on every render. */
function obMulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** pickTier (star-tiers.ts:64-72), verbatim. */
function obPickTier(weights, roll) {
  let carried = 0;
  for (const pair of weights) { carried += pair[1]; if (roll < carried) return pair[0]; }
  return weights[weights.length - 1][0];
}

/** computeOrbitField (orbit-field.ts:39-72) with CELL_ASPECT 1. */
function obOrbitField(o) {
  const phase = o.phase || 0;
  if (o.count <= 0 || o.radius <= 0) return [];
  const verticalRadius = o.radius / OB_SKY.CELL_ASPECT;
  const cells = [];
  const seen = {};
  for (let i = 0; i < o.count; i += 1) {
    const angle = (2 * Math.PI * i) / o.count + phase;
    const column = Math.round(o.center.column + Math.cos(angle) * o.radius);
    const row = Math.round(o.center.row + Math.sin(angle) * verticalRadius);
    if (column < 0 || column >= o.columns || row < 0 || row >= o.rows) continue;
    const key = column + ',' + row;
    if (seen[key]) continue;
    seen[key] = 1;
    cells.push({column, row});
  }
  return cells;
}

function obVisualDistance(a, b) {
  return Math.hypot(a.column - b.column, (a.row - b.row) * OB_SKY.CELL_ASPECT);
}
function obJitter(roll, reach) { return Math.round((roll - 0.5) * 2 * reach); }
function obClamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/**
 * computeStarField (star-field.ts:104-143 and its four placement
 * helpers), transcribed.  One addition, and it is the desktop's frame
 * budget rather than a design change: `maxStars` caps the count the
 * density asks for — see the note on OB_SKY.
 */
function obComputeStarField(options) {
  const columns = options.columns, rows = options.rows;
  if (columns <= 0 || rows <= 0) return [];
  const density = Math.max(0, options.density === undefined ? 1 : options.density);
  const random = obMulberry32(options.seed === undefined ? OB_SKY.DEFAULT_SEED : options.seed);
  const occupied = {};
  for (const span of (options.clearSpans || [])) {
    if (span.row < 0 || span.row >= rows) continue;
    for (let c = Math.max(0, span.from); c <= Math.min(columns - 1, span.to); c += 1) occupied[span.row * columns + c] = 1;
  }
  const stars = [];
  const sky = {
    columns, rows, random,
    free: (column, row) => column >= 0 && column < columns && row >= 0 && row < rows
      && !occupied[row * columns + column],
    place: (column, row, tier) => { occupied[row * columns + column] = 1; stars.push({column, row, tier, halo: false}); },
  };
  // The arc first: it is the one part of the field with a shape to keep.
  if (options.halo) {
    const cells = obOrbitField({columns, rows, center: options.halo.center,
      radius: options.halo.radius, count: options.halo.count, phase: OB_SKY.HALO_PHASE});
    for (const cell of cells) {
      if (sky.random() < OB_SKY.HALO_GAP_CHANCE) continue;
      for (let attempt = 0; attempt < OB_SKY.PLACEMENT_ATTEMPTS; attempt += 1) {
        const column = cell.column + obJitter(sky.random(), OB_SKY.HALO_JITTER_COLUMNS);
        const row = cell.row + obJitter(sky.random(), OB_SKY.HALO_JITTER_ROWS);
        if (!sky.free(column, row)) continue;
        occupied[row * columns + column] = 1;
        stars.push({column, row, tier: obPickTier(OB_HALO_TIERS, sky.random()), halo: true});
        break;
      }
    }
  }
  const wanted = Math.round(columns * rows * OB_SKY.STARS_PER_CELL * density);
  const target = Math.min(options.maxStars === undefined ? wanted : options.maxStars, wanted);
  if (target <= 0) return stars;
  // buildClusters (star-field.ts:172-196).
  const side = Math.sqrt(columns * rows);
  const wantedClusters = obClamp(Math.round(side / OB_SKY.CLUSTER_SPACING), OB_SKY.MIN_CLUSTERS, OB_SKY.MAX_CLUSTERS);
  const radius = obClamp(columns / 8, OB_SKY.MIN_CLUSTER_RADIUS, OB_SKY.MAX_CLUSTER_RADIUS);
  const clusters = [];
  for (let i = 0; i < wantedClusters; i += 1) {
    for (let attempt = 0; attempt < OB_SKY.CENTRE_ATTEMPTS; attempt += 1) {
      const column = Math.floor(sky.random() * columns);
      const row = Math.floor(sky.random() * rows);
      if (!sky.free(column, row)) continue;
      if (options.halo && obVisualDistance(options.halo.center, {column, row}) < options.halo.radius) continue;
      if (clusters.some((other) => obVisualDistance(other, {column, row}) < radius)) continue;
      clusters.push({column, row, radius});
      break;
    }
  }
  const clustered = clusters.length > 0 ? Math.round(target * OB_SKY.CLUSTERED_SHARE) : 0;
  for (let i = 0; i < clustered; i += 1) {
    // placeClusterStar: squaring the roll packs members toward the core.
    const cluster = clusters[i % clusters.length];
    for (let attempt = 0; attempt < OB_SKY.PLACEMENT_ATTEMPTS; attempt += 1) {
      const angle = sky.random() * Math.PI * 2;
      const reach = cluster.radius * Math.pow(sky.random(), 2);
      const column = Math.round(cluster.column + Math.cos(angle) * reach);
      const row = Math.round(cluster.row + (Math.sin(angle) * reach) / OB_SKY.CELL_ASPECT);
      if (!sky.free(column, row)) continue;
      sky.place(column, row, obPickTier(OB_CLUSTER_TIERS, sky.random()));
      break;
    }
  }
  for (let i = 0; i < target - clustered; i += 1) {
    for (let attempt = 0; attempt < OB_SKY.PLACEMENT_ATTEMPTS; attempt += 1) {
      const column = Math.floor(sky.random() * columns);
      const row = Math.floor(sky.random() * rows);
      if (!sky.free(column, row)) continue;
      sky.place(column, row, obPickTier(OB_FIELD_TIERS, sky.random()));
      break;
    }
  }
  return stars;
}

/**
 * computeMarkClearSpans (mark-clear-space.ts:38-59) over the mark's real
 * box.  The TUI follows the cross's silhouette per row because at 96×20
 * the bounding box is nearly the whole canvas; here the mark is 88 px in
 * a canvas hundreds of pixels wide, so the box IS the silhouette's
 * envelope and one rectangle — widened by the same 4 columns and 2 rows
 * — is the same reservation.
 */
function obMarkClearSpans(box, columns, rows) {
  const spans = [];
  const from = box.col0 - OB_SKY.CLEAR_GAP_COLUMNS;
  const to = box.col1 + OB_SKY.CLEAR_GAP_COLUMNS;
  for (let row = box.row0 - OB_SKY.CLEAR_GAP_ROWS; row <= box.row1 + OB_SKY.CLEAR_GAP_ROWS; row += 1) {
    if (row < 0 || row >= rows) continue;
    spans.push({row, from, to});
  }
  return spans;
}

/** Resolve the four tier colours off the live theme once per build. */
function obSkyColours() {
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const tier of Object.keys(OB_TIER_LOOK)) {
    out[tier] = (cs.getPropertyValue(OB_TIER_LOOK[tier].token) || '#8899aa').trim();
  }
  return out;
}

/** Build the field for the canvas's current size. */
function obSkyBuild() {
  const canvas = OBSKY.canvas;
  if (!canvas) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w <= 0 || h <= 0) return;
  OBSKY.dpr = Math.min(2, window.devicePixelRatio || 1);
  OBSKY.w = w; OBSKY.h = h;
  canvas.width = Math.round(w * OBSKY.dpr);
  canvas.height = Math.round(h * OBSKY.dpr);
  OBSKY.ctx = canvas.getContext('2d');
  OBSKY.colours = obSkyColours();
  const cell = OB_SKY.CELL_PX;
  const columns = Math.max(1, Math.floor(w / cell));
  const rows = Math.max(1, Math.floor(h / cell));
  // The mark, centred, in cells — plus the wordmark and tagline block
  // under it, which the sky must also keep clear.
  const markCells = Math.ceil(OB_SKY.MARK_PX / cell);
  const blockRows = markCells + 6;
  const centreCol = Math.floor(columns / 2);
  const centreRow = Math.floor(rows / 2) - Math.floor(blockRows / 2) + Math.floor(markCells / 2);
  const box = {
    col0: centreCol - Math.ceil(markCells / 2), col1: centreCol + Math.ceil(markCells / 2),
    row0: centreRow - Math.ceil(markCells / 2), row1: centreRow + Math.ceil(markCells / 2) + 5,
  };
  const verticalRadius = Math.max(0, rows / 2 - 1);
  const haloRadius = Math.min(verticalRadius * OB_SKY.CELL_ASPECT, Math.floor(columns / 2) - 2);
  const halo = haloRadius >= (box.col1 - box.col0) / 2 + OB_SKY.CLEAR_GAP_COLUMNS
    ? {center: {column: centreCol, row: centreRow}, radius: haloRadius, count: OB_SKY.HALO_COUNT}
    : null;
  const field = obComputeStarField({
    columns, rows, clearSpans: obMarkClearSpans(box, columns, rows),
    density: 1, seed: OB_SKY.DEFAULT_SEED, maxStars: OB_SKY.MAX_STARS,
    halo: halo || undefined,
  });
  OBSKY.cx = (centreCol + 0.5) * cell;
  OBSKY.cy = (centreRow + 0.5) * cell;
  // One more mulberry32, seeded off the field seed, so the per-star
  // motion is as reproducible as the placement is.
  const rnd = obMulberry32(OB_SKY.DEFAULT_SEED + 1);
  OBSKY.stars = field.slice(0, OB_SKY.MAX_STARS).map((star) => {
    const look = OB_TIER_LOOK[star.tier];
    const x = (star.column + 0.5) * cell;
    const y = (star.row + 0.5) * cell;
    return {
      x, y, tier: star.tier, halo: star.halo,
      r: look.r, a: look.a, drift: look.drift,
      phase: rnd() * Math.PI * 2,
      hz: 0.12 + rnd() * 0.2,                     // [0.12, 0.32)
      angle: Math.atan2(y - OBSKY.cy, x - OBSKY.cx),
      dist: Math.hypot(x - OBSKY.cx, y - OBSKY.cy),
    };
  });
}

/** One frame. At 220 stars this is a clearRect plus 220 arc fills. */
function obSkyDraw(elapsed) {
  const ctx = OBSKY.ctx;
  if (!ctx) return;
  const dpr = OBSKY.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, OBSKY.w, OBSKY.h);
  const t = elapsed / 1000;
  // Whole-field parallax, scaled per tier: the bright stars are near, so
  // they move; the faint dust barely does. That is the depth the four
  // tiers already encode, made visible.
  const dx = 6 * Math.sin(t / 23);
  const dy = 4 * Math.sin(t / 31);
  const spin = (0.6 * Math.PI / 180) * t;   // 0.6°/s about the mark
  for (const star of OBSKY.stars) {
    const wave = Math.sin(2 * Math.PI * star.hz * t + star.phase);
    const alpha = star.a * (0.72 + 0.28 * wave);
    const radius = star.r * (0.9 + 0.15 * wave);
    let x, y;
    if (star.halo) {
      const angle = star.angle + spin;
      x = OBSKY.cx + Math.cos(angle) * star.dist;
      y = OBSKY.cy + Math.sin(angle) * star.dist;
    } else {
      x = star.x + dx * star.drift;
      y = star.y + dy * star.drift;
    }
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.fillStyle = OBSKY.colours[star.tier];
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.3, radius), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  OBSKY.frames += 1;
}

function obSkyFrame(now) {
  OBSKY.raf = 0;
  if (!OBSKY.running) return;
  // 30 fps by skipping alternate ticks — the budget, not a smoothing.
  OBSKY.tick += 1;
  if ((OBSKY.tick & 1) === 0) obSkyDraw(now - OBSKY.t0);
  OBSKY.raf = requestAnimationFrame(obSkyFrame);
}

/**
 * The resolved reduced-motion answer.  Every path reads THIS, never a
 * fresh matchMedia of its own — a second reader is a second source, and
 * the two drift the moment either one is forced.
 */
function obReducedMotion() {
  if (OBSKY.override !== null) return OBSKY.override;
  if (!OBSKY.mq && window.matchMedia) {
    OBSKY.mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    // Re-check on the media query's own change event, not once at load.
    const relisten = () => {
      OBSKY.reduced = obReducedMotion();
      obSkyStop();
      if (OB.open && OB.step === 'intro') render();
    };
    if (OBSKY.mq.addEventListener) OBSKY.mq.addEventListener('change', relisten);
  }
  return !!(OBSKY.mq && OBSKY.mq.matches);
}

function obSkyStart() {
  const canvas = document.getElementById('ob-sky');
  if (!canvas) return;
  if (OBSKY.canvas === canvas && OBSKY.stars.length) { obSkyResume(); return; }
  OBSKY.canvas = canvas;
  OBSKY.frames = 0;
  OBSKY.tick = 0;
  OBSKY.t0 = performance.now();
  obSkyBuild();
  OBSKY.reduced = obReducedMotion();
  if (OBSKY.reduced) {
    // Exactly one frame at t=0, no rAF ever scheduled. The tagline is
    // rendered complete by obIntroHTML for the same reason.
    obSkyDraw(0);
    OBSKY.running = false;
    return;
  }
  obSkyResume();
}

function obSkyResume() {
  if (OBSKY.reduced || OBSKY.running || document.hidden) return;
  OBSKY.running = true;
  OBSKY.raf = requestAnimationFrame(obSkyFrame);
}

/** Stop on leaving the intro, on hide, and on close. A leaked rAF
 *  closure would keep painting behind every later screen. */
function obSkyStop() {
  OBSKY.running = false;
  if (OBSKY.raf) { cancelAnimationFrame(OBSKY.raf); OBSKY.raf = 0; }
  if (OBSKY.typer) { clearInterval(OBSKY.typer); OBSKY.typer = 0; }
}

/** Two-stage advance (use-intro-input.ts:57-67): the first input finishes
 *  the reveal, the second dismisses. A splash that cannot be hurried is a
 *  wait; one that vanishes on the key meant to hurry it is never read. */
function obIntroAdvance() {
  if (!OB.open || OB.step !== 'intro') return;
  if (!OB.introTyped) {
    OB.introTyped = true;
    if (OBSKY.typer) { clearInterval(OBSKY.typer); OBSKY.typer = 0; }
    OBSKY.typed = OB_COPY.tagline.length;
    obPaintTagline();
    return;
  }
  // Recorded as it is dismissed, not at the end of the flow
  // (onboarding-screen.tsx:109-115).
  obStampOnce('introSeenAt');
  obSkyStop();
  obDispatch({type:'onboarding_step_set', step:'choose'});
}

function obPaintTagline() {
  const el = document.getElementById('ob-tag');
  if (!el) return;
  const done = OB.introTyped || OBSKY.typed >= OB_COPY.tagline.length;
  el.textContent = OB_COPY.tagline.slice(0, done ? OB_COPY.tagline.length : OBSKY.typed);
  const cur = document.getElementById('ob-cur');
  if (cur) cur.textContent = done ? '' : '▌';
}

/** TAGLINE_MS_PER_CHAR = 45 (onboarding-intro-step.tsx:12). */
function obStartTyping() {
  if (OBSKY.typer) clearInterval(OBSKY.typer);
  if (obReducedMotion() || OB.introTyped) { OBSKY.typed = OB_COPY.tagline.length; obPaintTagline(); return; }
  OBSKY.typed = 0;
  obPaintTagline();
  OBSKY.typer = setInterval(() => {
    OBSKY.typed += 1;
    obPaintTagline();
    if (OBSKY.typed >= OB_COPY.tagline.length) { clearInterval(OBSKY.typer); OBSKY.typer = 0; OB.introTyped = true; }
  }, OB_COPY.taglineMsPerChar);
}

/** The intro screen. No header — onboarding-step-body.tsx:62-64. */
function obIntroHTML() {
  // The SAME source obSkyStart reads (review fix) — a second matchMedia
  // read here is a second source, and a forced flag would move only one.
  const done = obReducedMotion() || OB.introTyped;
  return '<div id="ob-intro">'
    + '<canvas id="ob-sky"></canvas>'
    + '<div class="ob-introc">'
      + '<span class="ob-markbig">' + MARK_COLOR.replace('width="16" height="16"', 'width="88" height="88"') + '</span>'
      + '<span class="ob-word">' + esc(OB_COPY.wordmark) + '</span>'
      + '<span class="ob-tag"><span id="ob-tag">' + esc(done ? OB_COPY.tagline : '') + '</span>'
      + '<span class="ob-cur" id="ob-cur">' + (done ? '' : '▌') + '</span></span>'
      + '<span class="ob-any">' + esc(OB_COPY.pressAnyKey) + '</span>'
    + '</div></div>';
}

/* ============================================================
   The download.  It does NOT live in the wizard: the strip under the
   toolbar owns it, and the wizard's own download screen renders the same
   slice.  That is the literal reading of the copy this screen already
   carries — "the download keeps running; progress shows in the top bar".
   ============================================================ */

/**
 * formatBytes (use-transfer-rate.ts:52-57) with BINARY divisors.
 *
 * The deliberate divergence, and the reason: the CLI's own `formatGb`
 * (src/cli/models-handlers.ts:46-48) divides by 1024³, so the `4.70 GB`
 * on the wire is 4.70 GiB.  Parsing that and re-rendering it through the
 * TUI's decimal formatter prints `5.0 GB` for a model whose catalogue
 * size label and whose source line both say 4.7 GB — a number nobody
 * wrote.  Same base in and out, so the text round-trips.
 */
function dlBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' kB';
  return Math.round(bytes) + ' B';
}

/** formatEta (use-transfer-rate.ts:59-67), verbatim. */
function dlEta(seconds) {
  if (seconds === null || seconds === undefined) return 'estimating…';
  if (seconds < 60) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return 'about ' + minutes + ' minute' + (minutes === 1 ? '' : 's') + ' left';
  const hours = Math.floor(minutes / 60);
  return 'about ' + hours + 'h ' + (minutes % 60) + 'm left';
}

/** capLabel (download-chip.tsx:33-38): 30 columns, ellipsis included. */
function dlCapLabel(label) {
  const s = String(label);
  return s.length <= 30 ? s : s.slice(0, 29) + '…';
}
function dlJobLabel(job) {
  return dlCapLabel(job.kind === 'runtime' ? 'llama.cpp' : job.id);
}

/** A bar of `n` segments, filled to `percent`. */
function dlBarHTML(percent, width) {
  const p = Math.min(100, Math.max(0, percent || 0));
  const filled = Math.round((p / 100) * width);
  return '<b>' + '█'.repeat(filled) + '</b><i>' + '░'.repeat(width - filled) + '</i>';
}

/** waitOrJumpPullStatus (onboarding-wait-or-jump-step.tsx:25-31). */
function dlStatus() {
  if (DL.job !== null) return 'running';
  return DL.error !== null ? 'failed' : 'ready';
}

/** Reset the two phase rows for a fresh run. */
function dlResetPhases(withRuntime) {
  // No runtime job in the queue means the backend is already installed,
  // which is exactly the state the TUI draws as a passed phase.
  DL.runtime = {state: withRuntime ? 'waiting' : 'done', percent: 0, transferredBytes: 0, totalBytes: 0, drove: false};
  DL.weights = {state: 'waiting', percent: 0, transferredBytes: 0, totalBytes: 0, drove: false};
  DL.runtimeError = null;
}

/**
 * Queue one or more downloads. Main single-flights them (one child, one
 * data dir), so a runtime phase and a weights phase are two jobs in
 * order — the strip shows the head and says how many are behind it.
 */
function dlStart(jobs) {
  DL.queue = jobs.slice();
  DL.error = null;
  DL.rate = null; DL.last = null;
  dlResetPhases(jobs.some((j) => j.kind === 'runtime'));
  dlNext();
}

function dlNext() {
  const job = DL.queue.shift();
  if (!job) { DL.job = null; render(); return; }
  DL.job = Object.assign({percent: 0, transferredBytes: 0, totalBytes: 0, sawProgress: false}, job);
  DL.rate = null; DL.last = null;
  /* r5 item 7 review fix: a phase becomes `active` when its FIRST real
     sample lands, not when the child is spawned. `models update` spends
     its opening seconds deciding whether there is anything to fetch, and
     often fetches nothing at all — a phase drawn `active` at 0% for that
     whole stretch is a bar this window is not driving. `waiting` ("it has
     not started") is the true trailing text until bytes move, so neither
     phase state is touched here; dlResetPhases and dlOnPull own them. */
  render();
  if (!BR || DL.dry) return;
  const started = job.kind === 'runtime' ? BR.modelsUpdateStream() : BR.modelsPull(job.id);
  started.then((res) => {
    if (res && res.ok === false) {
      DL.job = null;
      if (job.kind === 'runtime') {
        // A runtime step that would not even start is still not the model
        // download failing: say so, and run the weights job behind it.
        DL.runtimeError = res.error || 'could not start the llama.cpp runtime download';
        dlNext();
        return;
      }
      DL.error = res.error || 'could not start the download';
      DL.weights.state = 'waiting';
      render();
    }
  });
}

/** One structured `cli:pull` sample. Never interpolated between them. */
function dlOnPull(ev) {
  if (!ev || !DL.job) return false;
  // The projector rides the same stream under its own kind and is not
  // this bar: folding its percent into the weights bar would report a
  // download the operator is not waiting on.
  if (ev.kind === 'projector') return false;
  if (ev.done) {
    const finished = DL.job;
    DL.job = null;
    if (finished.kind === 'runtime') {
      /* r5 item 7 review fix: `sawProgress` and `upToDate` are READ here,
         which is what main computes them for. `models update` exits 0
         without downloading a byte when the version file already names
         the latest tag (models-handlers.ts:734-745); the phase passed,
         so it is drawn as passed — but `drove` records that this window
         never moved it, and nothing claims otherwise.
         A FAILED update is not the model download failing: it is kept
         apart from `error`, the queued weights job is not discarded, and
         the phase stays `waiting`, which is the truth about the bytes. */
      DL.runtime.drove = ev.sawProgress === true || DL.runtime.drove;
      if (ev.ok === false) {
        DL.runtimeError = ev.error || 'the llama.cpp runtime download failed';
      } else {
        DL.runtime.state = 'done';
        if (ev.upToDate === true) DL.runtime.drove = false;
      }
    } else {
      DL.weights.state = 'done';
      if (ev.ok) DL.error = null;
      else DL.error = ev.error || 'the download failed';
    }
    obPullFinished(finished, ev);
    return true;
  }
  if (typeof ev.percent !== 'number') return false;
  const job = DL.job;
  job.percent = ev.percent;
  if (typeof ev.totalBytes === 'number' && ev.totalBytes > 0) {
    job.totalBytes = ev.totalBytes;
    job.transferredBytes = ev.transferredBytes || 0;
    // The rate is the slope between two REAL samples, smoothed the way
    // useTransferRate smooths it (SMOOTHING 0.3) — nothing else.
    const now = Date.now();
    if (DL.last && job.transferredBytes >= DL.last.bytes) {
      const seconds = (now - DL.last.at) / 1000;
      if (seconds > 0) {
        const sample = (job.transferredBytes - DL.last.bytes) / seconds;
        DL.rate = DL.rate === null ? sample : DL.rate + 0.3 * (sample - DL.rate);
      }
    }
    DL.last = {bytes: job.transferredBytes, at: now};
  }
  job.sawProgress = true;
  const phase = job.kind === 'runtime' ? DL.runtime : DL.weights;
  phase.state = 'active';
  phase.drove = true;
  phase.percent = job.percent;
  phase.transferredBytes = job.transferredBytes;
  phase.totalBytes = job.totalBytes;
  renderDlbar();
  if (OB.open && OB.step === 'local_download') renderOverlays();
  if (OB.open && OB.step === 'wait_or_jump') renderOverlays();
  return true;
}

function dlEtaSeconds() {
  const job = DL.job;
  if (!job || !DL.rate || DL.rate <= 0 || !job.totalBytes) return null;
  return Math.round(Math.max(0, job.totalBytes - job.transferredBytes) / DL.rate);
}

/**
 * The strip.  download-chip.tsx's own shape: `⇣`, the label, a
 * ten-segment bar, the percent, the ETA — plus the queue depth, which
 * the chip never needed because the TUI's orchestrator runs one pull.
 */
function renderDlbar() {
  const el = document.getElementById('dlbar');
  if (!el) return;
  const job = DL.job;
  if (!job) {
    el.hidden = true;
    el.innerHTML = '';
    document.documentElement.style.setProperty('--dlbar-h', '0px');
    return;
  }
  const percent = Math.min(100, Math.max(0, Math.round(job.percent || 0)));
  const eta = dlEtaSeconds();
  /* r5 item 7 review fix: no bar and no percent before the first REAL
     sample. The CLI emits one line per 5%, and `models update` can spend
     its whole run deciding there is nothing to fetch — a 0% bar for that
     stretch is a bar nothing is driving. The TUI's own word for the
     no-pull-reporting-yet state is `starting…`. */
  const measured = job.sawProgress === true;
  el.innerHTML = '<span class="dl-g">⇣</span>'
    + '<span class="dl-l">' + esc(dlJobLabel(job)) + '</span>'
    + (measured
        ? '<span class="dl-bar">' + dlBarHTML(percent, 10) + '</span>'
          + '<span class="dl-pct">' + percent + '%</span>'
          + '<span class="dl-eta">' + esc(dlEta(eta)) + '</span>'
        : '<span class="dl-eta">' + esc(OB_COPY.starting) + '</span>')
    + (DL.queue.length ? '<span class="dl-q">· ' + DL.queue.length + ' more queued</span>' : '')
    + '<button class="dl-x" data-act="dl:cancel">Cancel</button>';
  el.hidden = false;
  /* The overlay layer's top inset, so the wizard starts BELOW the strip.
     Measured rather than assumed: it is the strip's bottom edge inside
     #window, which is the toolbar's height plus the strip's own. */
  const win = document.getElementById('window');
  const inset = win ? Math.round(el.getBoundingClientRect().bottom - win.getBoundingClientRect().top) : 30;
  document.documentElement.style.setProperty('--dlbar-h', Math.max(0, inset) + 'px');
}

/** OnboardingDownloadProgress (onboarding-download-progress.tsx:63-99). */
function obProgressHTML() {
  if (DL.job === null && DL.error !== null) {
    return '<div class="ob-err">✗  ' + esc(DL.error) + '</div>';
  }
  const row = (label, phase) => {
    const percent = phase.state === 'done' ? 100 : (phase.percent || 0);
    const trailing = phase.state === 'done' ? 'done'
      : phase.state === 'active' && phase.totalBytes > 0
        ? Math.round(percent) + '%   ' + dlBytes(phase.transferredBytes) + ' / ' + dlBytes(phase.totalBytes)
        : phase.state === 'active' ? Math.round(percent) + '%' : 'waiting';
    return '<div class="ob-phase ' + phase.state + '"><span class="pl">' + esc(label) + '</span>'
      + '<span class="pb">' + dlBarHTML(percent, 36) + '</span>'
      + '<span class="pt">' + esc(trailing) + '</span></div>';
  };
  const rate = DL.job && DL.job.sawProgress
    ? (DL.rate ? dlBytes(DL.rate) + '/s · ' : '') + dlEta(dlEtaSeconds())
    : OB_COPY.starting;
  // The runtime step's own failure, said once and not folded into the
  // weights bar: the model download below it is still running.
  const runtimeErr = DL.runtimeError
    ? '<div class="ob-err">✗  ' + esc(DL.runtimeError) + '</div>' : '';
  return row(OB_COPY.phaseRuntime, DL.runtime) + runtimeErr + row(OB_COPY.phaseWeights, DL.weights)
    + '<div class="ob-rate">' + esc(rate) + '</div>';
}

/* ---------------- rows and screens ---------------- */

/** rowPrefix (onboarding-rows.ts): `›  ` selected, three spaces otherwise. */
function obRow(index, selected, label, detail, extraClass) {
  return '<button class="ob-row' + (selected ? ' on' : '') + (extraClass ? ' ' + extraClass : '')
    + '" data-obrow="' + index + '">'
    + '<span class="mk">' + (selected ? '›' : '') + '</span>'
    + '<span><span class="t">' + label + '</span>'
    + (detail ? '<span class="d">' + detail + '</span>' : '') + '</span></button>';
}

/** describeDownloadingModel (local-model-picks.ts:139-145). */
function obModelLabel() {
  if (!OB.localModelId) return 'the model';
  const id = String(OB.localModelId);
  return id.indexOf('custom-') === 0 ? id.replace(/^custom-/, '') : id;
}

/** configuredLabel (onboarding-screen.tsx:298-302). */
function obConfiguredLabel() {
  if (OB.outcome === 'local') return 'Local model ready';
  if (OB.outcome === 'cloud') return OB_COPY.cloudReadyLabel;
  return 'Backend ready';
}

/**
 * The local pick rows.  buildLocalPickRows (local-model-picks.ts:124-131):
 * the curated picks, then the Hugging Face row pinned OUTSIDE the window
 * as the last cursor position.  Ordering is degraded — see the header
 * note: fit rank, then size, and no row is starred.
 */
function obPickRows() {
  const ram = OB.ram;
  const models = OB.models.slice().sort((a, b) => {
    const fa = fitFor(a.size, ram).rank, fb = fitFor(b.size, ram).rank;
    if (fa !== fb) return fa - fb;
    return (parseFloat(a.size) || 0) - (parseFloat(b.size) || 0);
  });
  const rows = models.map((model) => ({kind: 'model', model}));
  rows.push({kind: 'hugging_face'});
  return rows;
}

function obChooseHTML() {
  const rows = OB_CHOICES.map((choice, i) =>
    obRow(i, OB.cursor === i, esc(choice.label), esc(choice.detail[0]) + '<br>' + esc(choice.detail[1]))).join('');
  return '<div class="ob-explain">' + esc(OB_COPY.chooseExplainer.join('\n')) + '</div>'
    + '<div class="ob-list">' + rows + '</div>';
}

function obLocalPickHTML() {
  const rows = obPickRows();
  const models = rows.filter((r) => r.kind === 'model');
  const onHf = OB.cursor >= models.length;
  // windowLocalPicks: six rows, plus `↓ N more`.
  const cursor = Math.min(OB.cursor, Math.max(0, models.length - 1));
  const start = Math.max(0, Math.min(cursor - HF_PICK_WINDOW + 2, models.length - HF_PICK_WINDOW));
  const visible = models.slice(start, start + HF_PICK_WINDOW);
  const below = models.length - (start + visible.length);
  const body = models.length
    ? visible.map((row, i) => {
        const at = start + i;
        const model = row.model;
        const fit = fitFor(model.size, OB.ram);
        // The TUI's note() joins its parts with " · ". The parts the
        // catalogue cannot give (★ recommended, the RAM figure, the
        // warning tag, the description) are dropped, not invented.
        const note = [model.size, model.context + ' context', fit.label]
          .concat(model.downloaded ? ['already on disk'] : []).join(' · ');
        return obRow(at, !onHf && at === OB.cursor,
          '<span class="ob-mono">' + esc(model.id) + '</span>', esc(note));
      }).join('')
    : '<div class="ob-explain">' + (OB.busy ? 'reading the catalogue…' : 'no models listed') + '</div>';
  const more = below > 0 ? '<div class="ob-explain">' + esc('   ↓ ' + below + ' more') + '</div>' : '';
  const hf = obRow(models.length, onHf, esc(HF_ROW_LABEL),
    esc('paste an owner/repo id or a huggingface.co URL'));
  return '<div class="ob-explain">'
      + esc('One download, then it runs offline. This machine reports ' + OB.ram + ' GB of RAM.') + '</div>'
    + '<div class="ob-h">' + esc(OB_COPY.localHeading) + '</div>'
    + '<div class="ob-list ob-models">' + body + '</div>' + more + hf;
}

/** hf-reference-editor.tsx, as its own step rather than a jump into Settings. */
function obHfRefHTML() {
  return '<div>' + esc('Which model? ') + '<span class="ob-explain">' + esc(HF_REF_TITLE_TAIL) + '</span></div>'
    + '<div class="ob-explain">' + esc(HF_REF_EXAMPLES_LINE) + '</div>'
    + '<div><input id="ob-hf-ref" class="ob-inp" autocomplete="off" spellcheck="false" placeholder="owner/repo" value="'
      + esc(OB.hfReference) + '"' + (OB.busy ? ' disabled' : '') + '></div>'
    + (!OB.busy && OB.hfReference.length > 0
        ? '<div><button class="ob-offer" data-obact="hf:clear">[ clear ]</button></div>' : '')
    + (OB.busy ? '<div class="ob-explain">asking huggingface.co…</div>' : '');
}

/** hf-pick-list.tsx, ported column for column. */
function obHfPickHTML() {
  const repo = OB.hfRepo;
  const choices = (repo && repo.choices) || [];
  const cursor = Math.min(OB.cursor, Math.max(0, choices.length - 1));
  const start = Math.max(0, Math.min(cursor - HF_PICK_WINDOW + 2, choices.length - HF_PICK_WINDOW));
  const visible = choices.slice(start, start + HF_PICK_WINDOW);
  const below = choices.length - (start + visible.length);
  const selected = choices[cursor];
  const warning = selected ? llmHfRamWarning(selected.fileSizeGb, OB.ram) : null;
  return '<div class="ob-h">' + esc(repo ? repo.repoId : '') + '</div>'
    + visible.map((choice, i) => {
        const at = start + i;
        const line = (at === cursor ? '›  ' : '   ') + String(choice.filename).padEnd(44) + String(choice.sizeLabel).padStart(9);
        return '<button class="ob-row' + (at === cursor ? ' on' : '') + '" data-obrow="' + at + '">'
          + '<span class="mk"></span><span class="ob-mono">' + esc(line) + '</span></button>';
      }).join('')
    + (below > 0 ? '<div class="ob-explain">' + esc('   ↓ ' + below + ' more') + '</div>' : '')
    + (repo && repo.hidden ? '<div class="ob-explain">' + esc('   ' + repo.hidden) + '</div>' : '')
    + (repo && repo.mmproj ? '<div class="ob-explain">' + esc(HF_MMPROJ_LINE) + '</div>' : '')
    + (warning ? '<div class="ob-warn ob-mono">' + esc('   ⚠ ' + warning) + '</div>' : '');
}

/** onboarding-url-step.tsx:8-19, both halves. */
function obUrlHTML(kind) {
  const chat = kind === 'chat';
  return '<div>' + esc(chat ? OB_COPY.urlChatTitle : OB_COPY.urlEmbeddingTitle)
      + '<span class="ob-explain">' + esc(OB_COPY.urlHealthNote) + '</span></div>'
    + (chat ? '' : '<div class="ob-explain">' + esc(OB_COPY.urlEmbeddingNote) + '</div>')
    + '<div><input id="ob-url" class="ob-inp" autocomplete="off" spellcheck="false" placeholder="'
      + esc(chat ? OB_COPY.urlChatPlaceholder : OB_COPY.urlEmbeddingPlaceholder) + '" value="'
      + esc(chat ? OB.chatUrl : OB.embeddingUrl) + '"' + (OB.busy ? ' disabled' : '') + '></div>'
    + (OB.busy ? '<div class="ob-explain">' + esc(OB_COPY.urlProbing) + '</div>' : '');
}

/** onboarding-download-step.tsx:18-38 / :87-124. */
function obDownloadHTML() {
  const failed = dlStatus() === 'failed';
  const label = obModelLabel();
  // offerCloudMeanwhile: "hidden once a cloud provider is configured —
  // nothing left to offer" (:110-111).
  const offerCloud = !OB.cloudReady;
  const cloud = offerCloud
    ? '<button class="ob-offer cloud" data-obact="key:c">'
      + (failed ? esc(OB_COPY.cloudOfferFailed) : esc(OB_COPY.cloudOffer[0]) + '<br>' + esc(OB_COPY.cloudOffer[1]))
      + '<b>' + esc(OB_COPY.cloudOfferKey) + '</b></button>'
    : '';
  const skip = '<button class="ob-offer" data-obact="key:s">'
    + (failed ? esc(OB_COPY.skipOfferFailed) : esc(OB_COPY.skipOffer[0]) + '<br>' + esc(OB_COPY.skipOffer[1]))
    + '<b>' + esc(OB_COPY.skipOfferKey) + '</b></button>';
  return '<div class="ob-explain">'
      + esc(failed ? 'The ' + label + ' download failed.'
                   : 'Downloading ' + label + '. You can leave this running.') + '</div>'
    + obProgressHTML() + cloud + skip;
}

/** onboarding-wait-or-jump-step.tsx:38-55, :139-150. */
function obWaitOrJumpHTML() {
  const status = dlStatus();
  const label = obModelLabel();
  const rows = [
    {label:'Start using the agent now', detail: status === 'running'
      ? 'the download keeps running; progress shows in the top bar'
      : status === 'ready' ? 'local and cloud are both set up' : 'the cloud model is ready to use'},
    {label:'Add another cloud provider', detail:'one more key or endpoint, then straight back to this screen'},
  ];
  if (status === 'failed') rows.push({label:'Retry the download', detail:'starts the same download again'});
  const cursor = OB.cursor % rows.length;
  return '<div class="ob-h"><span class="ob-ok">✓</span>  ' + esc(OB_COPY.cloudReadyLabel) + '</div>'
    + (status === 'running'
        ? '<div class="ob-explain">' + esc('Still downloading ' + label + ' — it keeps running whichever row you pick.') + '</div>' : '')
    + (status === 'ready'
        ? '<div class="ob-h"><span class="ob-ok">✓</span>  ' + esc(label + ' downloaded — the local model is ready too') + '</div>' : '')
    + (status === 'failed'
        ? '<div class="ob-explain">' + esc('The ' + label + ' download failed — the cloud model still works.') + '</div>' : '')
    + (status === 'ready' ? '' : obProgressHTML())
    + '<div class="ob-list">' + rows.map((row, i) => obRow(i, cursor === i, esc(row.label), esc(row.detail))).join('') + '</div>';
}

/** onboarding-propose-step.tsx:11-33. */
function obProposeHTML() {
  const accept = OB.offer === 'local'
    ? {label:'Set up local models too', detail:'one download, then it runs offline and costs nothing per token'}
    : {label:'Set up a cloud model too', detail:'an API key and a model — about a minute, for the heavy turns'};
  const rows = [accept, OB_COPY.proposeSkip];
  return '<div class="ob-h"><span class="ob-ok">✓</span>  ' + esc(obConfiguredLabel()) + '</div>'
    + '<div class="ob-explain">' + esc(OB_COPY.proposeExplainer.join('\n')) + '</div>'
    + '<div class="ob-list">'
    + rows.map((row, i) => obRow(i, (OB.cursor % 2) === i, esc(row.label), esc(row.detail))).join('') + '</div>';
}

/** buildImportPickRows (import-step.ts:101-113): agents, then the import
 *  action once at least one is ticked, then the skip row LAST. */
function obImportRows() {
  const rows = OB.importAgents.map((agent, index) => ({kind:'agent', index, agent}));
  const picked = OB.importAgents.filter((a) => a.enabled).length;
  if (picked > 0) rows.push({kind:'import', picked});
  rows.push({kind:'skip'});
  return rows;
}
/** importActionLabel (import-step.ts:87-89). */
function obImportActionLabel(picked) {
  return picked === 1 ? 'Import from 1 agent' : 'Import from ' + picked + ' agents';
}

function obImportPickHTML() {
  const rows = obImportRows();
  const cursor = OB.cursor % rows.length;
  return '<div class="ob-explain">' + esc(OB_COPY.importExplainer.join('\n')) + '</div>'
    + '<div class="ob-list">' + rows.map((row, i) => {
        if (row.kind === 'agent') {
          return obRow(i, cursor === i,
            '<span class="box">' + (row.agent.enabled ? '[x]' : '[ ]') + '</span>' + esc(row.agent.label),
            esc(row.agent.dir));
        }
        if (row.kind === 'import') return obRow(i, cursor === i, esc(obImportActionLabel(row.picked)), '');
        return obRow(i, cursor === i, esc(OB_COPY.importSkipLabel), esc(OB_COPY.importSkipDetail));
      }).join('') + '</div>'
    + (OB.busy ? '<div class="ob-explain">' + esc(OB_COPY.importScanning) + '</div>' : '');
}

/** summarizeImportReport (import-step.ts:167-189) + reportHeadline (:200-212). */
function obImportSummary(report) {
  const byKind = [];
  const index = {};
  for (const item of (report.items || [])) {
    if (!index[item.kind]) { index[item.kind] = {migrated:0, skipped:0, conflict:0, error:0}; byKind.push(item.kind); }
    if (index[item.kind][item.status] !== undefined) index[item.kind][item.status] += 1;
  }
  const migratedLabel = report.executed ? 'migrated' : 'to migrate';
  const lines = [];
  for (const kind of byKind) {
    const counts = index[kind];
    const parts = [];
    if (counts.migrated > 0) parts.push(counts.migrated + ' ' + migratedLabel);
    if (counts.skipped > 0) parts.push(counts.skipped + ' skipped');
    if (counts.conflict > 0) parts.push(counts.conflict + ' in conflict');
    if (counts.error > 0) parts.push(counts.error + ' failed');
    if (!parts.length) continue;
    lines.push(kind + ': ' + parts.join(', '));
  }
  return lines;
}
function obImportHeadline(report, executed) {
  if (!report) return '';
  const s = report.summary;
  if (executed) {
    return s.error > 0
      ? '⚠  Imported with ' + s.error + ' failure' + (s.error === 1 ? '' : 's')
      : '✓  Imported';
  }
  return (s.migrated + s.conflict) > 0 ? OB_COPY.importPreviewActionable : OB_COPY.importPreviewNothing;
}
function obImportReportHTML(executed) {
  const report = OB.importReport;
  return '<div class="ob-h">' + esc(obImportHeadline(report, executed)) + '</div>'
    + (report ? '<div class="ob-explain">' + esc(obImportSummary(report).join('\n')) + '</div>' : '')
    + (OB.busy ? '<div class="ob-explain">' + esc(OB_COPY.importRunning) + '</div>' : '');
}

/**
 * The cloud step IS the add-provider wizard — same rows, same upsert,
 * same verification — rendered on the wizard layer instead of inside the
 * anchored popover `selShell` builds, because there is no model chip on
 * screen during first run for a popover to hang off.
 */
/** The rows the cloud step's list is showing — KIND_ROWS through `/`. */
function obWizRows() {
  const q = (WIZ.q || '').trim().toLowerCase();
  if (!q) return KIND_ROWS.map((k, i) => ({k, i}));
  return KIND_ROWS.map((k, i) => ({k, i})).filter(({k}) => k.label.toLowerCase().indexOf(q) >= 0);
}

function obWizardHTML() {
  if (WIZ.phase === 'pick_kind' || !WIZ.row) {
    const taken = {};
    selProviders().forEach((p) => { taken[p.id] = 1; });
    const rows = obWizRows();
    const cur = rows.length ? WIZ.cur % rows.length : 0;
    return '<div class="ob-wiz">'
      // providers-wizard.tsx:359 — the screen title the copy contract names.
      + '<div class="ob-h">LLM provider — add provider</div>'
      + (WIZ.q === null ? ''
          : '<input class="ob-inp" id="wiz-q" placeholder="search" value="' + esc(WIZ.q) + '">')
      + '<div class="ob-wizlist">' + rows.map(({k}, n) =>
      '<button class="modelrow' + (taken[k.id] ? ' dim' : '') + (n === cur ? ' on' : '')
      + '" data-obwiz="' + n + '">'
      + '<span class="col"><span class="nm">' + esc(k.label) + '</span>'
      + '<span class="cap">' + esc(k.custom ? 'you supply the URL' : k.baseUrl || k.kind)
      + (taken[k.id] ? ' · already configured' : '') + '</span></span></button>').join('')
      + '</div>'
      // Esc is the TUI's way out of the list; the desktop needs a control
      // for it too, and it routes through the same action.
      + '<div class="ob-foot"><button class="btn btn-g" data-act="wiz:cancel">Back</button><span class="grow"></span></div>'
      + '</div>';
  }
  const k = WIZ.row;
  const verifying = WIZ.phase === 'verifying';
  /* COPY, disclosed rather than silently dropped: providers-wizard.tsx
     also has an `Embedding backend` (:445) and a `Chat model id` (:450)
     screen. The desktop's add-provider wizard has neither phase — it
     takes the kind's default chat model and never offers a cloud
     embedding backend — so those two titles have nowhere honest to go
     and are NOT rendered. `LLM provider — add provider`, `API key —
     ${service}` and the .env sentence are all present, verbatim. */
  return '<div class="ob-wiz"><div class="ob-h">' + esc('API key — ' + k.label.split(' (')[0]) + '</div>'
    + (k.custom ? '<label class="ob-explain">API base URL</label>'
        + '<input class="ob-inp" id="wiz-url" placeholder="https://host/v1" value="' + esc(WIZ.baseUrl) + '">' : '')
    + (k.env ? '<div class="ob-explain">' + esc('Saved to .env as ' + k.env + ' (mode 0600).') + '</div>' : '')
    + '<input class="ob-inp" id="wiz-key" type="password" value="' + esc(WIZ.apiKey) + '">'
    + (verifying ? '<div class="ob-explain">checking the key against the provider’s model list…</div>' : '')
    + (WIZ.error ? '<div class="ob-err">' + esc(WIZ.error) + '</div>' : '')
    + '<div class="ob-foot"><button class="btn btn-g" data-act="wiz:back"' + (verifying ? ' disabled' : '') + '>Back</button>'
    + '<span class="grow"></span>'
    + '<button class="btn btn-p" data-act="wiz:next"' + (verifying ? ' disabled' : '') + '>'
    + (verifying ? 'Verifying…' : 'Next') + '</button></div></div>';
}

/** The whole surface. The intro draws no header and no column. */
function obHTML() {
  if (OB.step === 'intro') {
    return '<div id="onboarding" class="ob-intro-layer">' + obIntroHTML() + obHintsHTML() + '</div>';
  }
  let body = '';
  if (OB.step === 'choose') body = obChooseHTML();
  else if (OB.step === 'local_pick') body = obLocalPickHTML();
  else if (OB.step === 'local_hf_ref') body = obHfRefHTML();
  else if (OB.step === 'local_hf_pick') body = obHfPickHTML();
  else if (OB.step === 'local_download') body = obDownloadHTML();
  else if (OB.step === 'cloud') body = obWizardHTML();
  else if (OB.step === 'custom_chat_url') body = obUrlHTML('chat');
  else if (OB.step === 'custom_embedding_url') body = obUrlHTML('embedding');
  else if (OB.step === 'propose_second') body = obProposeHTML();
  else if (OB.step === 'wait_or_jump') body = obWaitOrJumpHTML();
  else if (OB.step === 'import_pick') body = obImportPickHTML();
  else if (OB.step === 'import_preview') body = obImportReportHTML(false);
  else if (OB.step === 'import_done') body = obImportReportHTML(true);
  else body = '<div class="ob-explain">' + esc(OB_SUBTITLES[OB.step] || '') + '</div>';
  const err = OB.error ? '<div class="ob-err">' + esc(OB.error) + '</div>' : '';
  return '<div id="onboarding"><div class="ob">' + obHeadHTML() + body + err + '</div>' + obHintsHTML() + '</div>';
}

/* ============================================================
   The key router.  ONE table, transcribing onboarding-step-keys.ts
   (:61-428) and onboarding-key-bindings.ts (:33-73).  Every clickable
   row calls it with a synthesised key, which is the invariant those
   files exist to hold: the mouse and the keyboard cannot drift because
   there is only one implementation for them to drift between.
   ============================================================ */

/** A key object in the shape the transcription expects. */
function obSynth(spec) {
  const k = {upArrow:false, downArrow:false, return:false, escape:false, ctrl:false};
  if (spec === 'up') k.upArrow = true;
  else if (spec === 'down') k.downArrow = true;
  else if (spec === 'enter') k.return = true;
  else if (spec === 'esc') k.escape = true;
  return {input: (spec === 'space') ? ' ' : (spec.length === 1 ? spec : ''), key: k};
}
/**
 * Drive the flow from a spec string exactly as a key would — the intro's
 * two-stage advance and the editors' own Enter/Escape included, so a
 * driven pass cannot reach a transition the keyboard cannot.
 */
function obPress(spec) {
  const s = obSynth(String(spec));
  if (OB.step === 'intro') { obIntroAdvance(); return true; }
  if (obStepOwnsKeyboard(OB.step)) {
    if (s.key.escape) { obOwnEscape(); return true; }
    if (s.key.return) { obOwnEnter(); return true; }
    /* The cloud list's own chords (review fix): `↑/↓ move` and `/ search`
       are advertised by that step's footer, so a driven pass reaches them
       through the SAME router the keyboard and the mouse use. */
    if (OB.step === 'cloud' && (s.key.upArrow || s.key.downArrow || s.input === '/')) return obKey(s.input, s.key);
    return false;
  }
  return obKey(s.input, s.key);
}

/** handleOnboardingStepKey (onboarding-step-keys.ts:61-89). */
function obKey(input, key) {
  if (!OB.open) return false;
  switch (OB.step) {
    case 'choose': return obChooseKey(input, key);
    case 'local_pick': return obLocalPickKey(input, key);
    case 'local_hf_pick': return obHfPickKey(input, key);
    case 'local_download': return obDownloadKey(input, key);
    case 'wait_or_jump': return obWaitOrJumpKey(input, key);
    case 'propose_second': return obProposeKey(input, key);
    case 'import_pick': return obImportPickKey(input, key);
    case 'import_preview': return obImportPreviewKey(input, key);
    case 'import_done': return obImportDoneKey(input, key);
    case 'cloud': return obCloudKey(input, key);
    default: return false;
  }
}

/** handleOnboardingKey (onboarding-key-bindings.ts:33-73) + pickBackend. */
function obChooseKey(input, key) {
  // Ctrl+C is deliberately never claimed.
  if (key.ctrl && input === 'c') return false;
  if (key.escape) { obDispatch({type:'onboarding_finished', outcome:'skipped'}); return true; }
  if (key.upArrow || input === 'k') { obDispatch({type:'onboarding_cursor_moved', delta:-1}); return true; }
  if (key.downArrow || input === 'j') { obDispatch({type:'onboarding_cursor_moved', delta:1}); return true; }
  if (key.return) {
    const choice = OB_CHOICES[OB.cursor];
    if (choice) obPickBackend(choice.id);
    return true;
  }
  const digit = parseInt(input, 10);
  if (Number.isInteger(digit) && digit >= 1 && digit <= OB_CHOICES.length) {
    obDispatch({type:'onboarding_cursor_set', cursor: digit - 1});
    obPickBackend(OB_CHOICES[digit - 1].id);
    return true;
  }
  // Every other key is swallowed: nothing is behind this surface.
  return true;
}

/** pickBackend (onboarding-step-keys.ts:95-115). */
function obPickBackend(choice) {
  if (choice === 'cloud') { obOpenCloudWizard(); obDispatch({type:'onboarding_step_set', step:'cloud'}); return; }
  if (choice === 'custom') { obDispatch({type:'onboarding_step_set', step:'custom_chat_url'}); return; }
  // Managed mode is recorded NOW so a quit mid-download does not lose
  // the choice; the model id follows when the pull completes. The promise
  // is kept because `models update` refuses outside managed mode.
  if (BR) OB.managedWrite = BR.useManagedMode();
  obDispatch({type:'onboarding_step_set', step:'local_pick'});
}

/** handleLocalPickKey (:129-158). */
function obLocalPickKey(input, key) {
  const rows = obPickRows();
  if (key.escape) { obDispatch({type:'onboarding_step_set', step:'choose'}); return true; }
  if (key.upArrow || input === 'k') { obDispatch({type:'onboarding_cursor_moved', delta:-1, length:rows.length}); return true; }
  if (key.downArrow || input === 'j') { obDispatch({type:'onboarding_cursor_moved', delta:1, length:rows.length}); return true; }
  if (key.return) {
    const row = rows[OB.cursor % Math.max(1, rows.length)];
    if (!row) return true;
    if (row.kind === 'hugging_face') { obDispatch({type:'onboarding_step_set', step:'local_hf_ref'}); return true; }
    obDispatch({type:'onboarding_local_model_picked', modelId: row.model.id});
    obStartLocalPull(row.model.id, row.model.downloaded);
    return true;
  }
  return false;
}

/** handleHfPickKey (onboarding-hf-keys.ts) — the file list. */
function obHfPickKey(input, key) {
  const choices = (OB.hfRepo && OB.hfRepo.choices) || [];
  if (key.escape) { obDispatch({type:'onboarding_step_set', step:'local_hf_ref'}); return true; }
  if (key.upArrow || input === 'k') { obDispatch({type:'onboarding_cursor_moved', delta:-1, length:choices.length}); return true; }
  if (key.downArrow || input === 'j') { obDispatch({type:'onboarding_cursor_moved', delta:1, length:choices.length}); return true; }
  if (key.return) { obHfAdd(); return true; }
  return false;
}

/** handleDownloadKey (:160-196). */
function obDownloadKey(input, key) {
  if (input === 'c' && !key.ctrl) {
    // Hidden once a cloud provider is configured — nothing left to offer.
    if (OB.cloudReady) return true;
    obOpenCloudWizard();
    obDispatch({type:'onboarding_cloud_meanwhile_opened'});
    return true;
  }
  if (input === 's' && !key.ctrl) {
    // Outcome "local" because local is the backend they committed to;
    // the pull survives this screen and reports in the top strip.
    // skipSecondOffer because this screen already pitched cloud.
    obDispatch({type:'onboarding_finished', outcome:'local', skipSecondOffer:true});
    return true;
  }
  return false;
}

/** handleWaitOrJumpKey (:198-240). */
function obWaitOrJumpKey(input, key) {
  const rows = dlStatus() === 'failed' ? 3 : 2;
  if (key.upArrow || key.downArrow || input === 'j' || input === 'k') {
    obDispatch({type:'onboarding_cursor_moved', delta: (key.upArrow || input === 'k') ? -1 : 1, length: rows});
    return true;
  }
  if (key.return) {
    const row = OB.cursor % rows;
    if (row === 0) { obDispatch({type:'onboarding_finished', outcome: OB.outcome || 'cloud'}); return true; }
    if (row === 1) { obOpenCloudWizard(); obDispatch({type:'onboarding_cloud_meanwhile_opened'}); return true; }
    if (OB.localModelId) obStartLocalPull(OB.localModelId, false);
    return true;
  }
  return false;
}

/** handleProposeKey (:242-284). */
function obProposeKey(input, key) {
  const skip = () => obDispatch({type:'onboarding_finished', outcome: OB.outcome || 'skipped'});
  if (key.escape) { skip(); return true; }
  if (key.upArrow || key.downArrow || input === 'j' || input === 'k') {
    obDispatch({type:'onboarding_cursor_moved', delta: (key.upArrow || input === 'k') ? -1 : 1, length: 2});
    return true;
  }
  if (key.return) {
    if (OB.cursor % 2 !== 0) { skip(); return true; }
    if (OB.offer === 'local') {
      if (BR) OB.managedWrite = BR.useManagedMode();
      obDispatch({type:'onboarding_step_set', step:'local_pick'});
      return true;
    }
    obOpenCloudWizard();
    obDispatch({type:'onboarding_step_set', step:'cloud'});
    return true;
  }
  return false;
}

/** finishImport (:286-291). */
function obFinishImport() {
  obDispatch({type:'onboarding_finished', outcome: OB.outcome || 'skipped'});
}

/** handleImportPickKey (:305-366). */
function obImportPickKey(input, key) {
  if (OB.busy) return true;
  if (key.escape) { obFinishImport(); return true; }
  const rows = obImportRows();
  if (key.upArrow || key.downArrow || input === 'j' || input === 'k') {
    obDispatch({type:'onboarding_cursor_moved', delta: (key.upArrow || input === 'k') ? -1 : 1, length: rows.length});
    return true;
  }
  const toggle = input === ' ' && !key.ctrl;
  if (!toggle && !key.return) return false;
  const row = rows[OB.cursor % rows.length];
  if (!row) return true;
  if (row.kind === 'agent') {
    // Space and Enter both flip the tick — on a checkbox row there is
    // nothing else Enter could honestly mean.
    obDispatch({type:'onboarding_import_agent_toggled', index: row.index});
    return true;
  }
  if (row.kind === 'skip') { if (!toggle) obFinishImport(); return true; }
  if (toggle) return true;
  // Straight to the dry run with the defaults — every non-secret domain
  // of the ticked agents. The preview stays the gate before any write.
  const options = obBuildImportOptions(OB.importAgents);
  obDispatch({type:'onboarding_import_run_started', options});
  obRunImport(options, false);
  return true;
}

/** handleImportPreviewKey (:368-400). */
function obImportPreviewKey(input, key) {
  if (OB.busy) return true;
  if (key.escape) { obDispatch({type:'onboarding_step_set', step:'import_pick'}); return true; }
  if (key.return) {
    const report = OB.importReport;
    const actionable = report !== null && (report.summary.migrated + report.summary.conflict) > 0;
    // Nothing to do is not a write to confirm: the flow ends here.
    if (!actionable) { obFinishImport(); return true; }
    obDispatch({type:'onboarding_import_run_started'});
    obRunImport(OB.importOptions, true);
    return true;
  }
  return false;
}

/** handleImportDoneKey (:402-413): any key hands over to the agent. */
function obImportDoneKey(input, key) {
  if (key.ctrl) return false;
  obFinishImport();
  return true;
}

/**
 * The cloud step is the wizard; its own controls own its keys.
 *
 * r5 item 7 review fix: the list phase now accepts every chord its footer
 * advertises — `↑/↓ move   / search   enter select   esc back`. It used to
 * accept only `esc`, so three of the four hints named nothing.
 */
function obCloudKey(input, key) {
  const listing = WIZ.phase === 'pick_kind' || !WIZ.row;
  if (key.escape) {
    if (listing && WIZ.q !== null) { WIZ.q = null; WIZ.cur = 0; render(); return true; }
    if (WIZ.phase === 'configure' || WIZ.phase === 'verifying') {
      if (WIZ.phase === 'verifying') return true;
      WIZ.phase = 'pick_kind'; WIZ.error = null; render(); return true;
    }
    WIZ.phase = null; WIZ.q = null; WIZ.cur = 0;
    obDispatch({type:'providers_wizard_closed'});
    return true;
  }
  if (listing) {
    const rows = obWizRows();
    if (key.upArrow || key.downArrow) {
      WIZ.cur = moveOnboardingCursor(WIZ.cur, key.upArrow ? -1 : 1, rows.length);
      render();
      return true;
    }
    if (input === '/' && WIZ.q === null) { WIZ.q = ''; WIZ.cur = 0; render(); return true; }
    if (key.return) {
      const picked = rows[rows.length ? WIZ.cur % rows.length : 0];
      if (!picked) return true;
      WIZ.row = picked.k; WIZ.phase = 'configure'; WIZ.error = null;
      render();
      return true;
    }
    return false;
  }
  if (key.return && WIZ.phase === 'configure') { wizNext(); return true; }
  return false;
}

/* ---------------- effects ---------------- */

function obOpenCloudWizard() {
  WIZ.phase = 'pick_kind'; WIZ.row = null; WIZ.apiKey = ''; WIZ.baseUrl = ''; WIZ.error = null; WIZ.forId = null;
  WIZ.cur = 0; WIZ.q = null;
}

async function obLoadModels() {
  if (!BR) return;
  OB.busy = true; OB.error = null; render();
  // Embedding models are a separate daemon; the chat wizard does not
  // offer them (chatModelsList subtracts the embedding catalogue by id).
  const res = await BR.chatModelsList();
  OB.busy = false;
  if (!res || !res.ok) { OB.error = (res && res.error) || 'could not read the model catalogue'; render(); return; }
  OB.models = res.models || [];
  render();
}

/**
 * Start the download for a picked model.  The runtime phase is probed
 * for, never assumed: `models status` prints `binary ok|missing`
 * (models-handlers.ts:202-204), and only a missing binary earns a
 * `models update` in front of the weights.
 */
async function obStartLocalPull(id, alreadyDownloaded) {
  if (!BR) return;
  DL.error = null;
  if (alreadyDownloaded) {
    // Nothing to download: the TUI's pull-completion path straight away.
    dlResetPhases(false);
    DL.weights.state = 'done';
    render();
    await obActivateLocal(id);
    return;
  }
  // The managed-mode write has to have landed before `models status` is
  // read and `models update` is spawned — both answer differently while
  // the file still says something else (review fix).
  if (OB.managedWrite) { try { await OB.managedWrite; } catch (e) { /* the status read below is the real gate */ } OB.managedWrite = null; }
  let needsRuntime = false;
  try {
    const st = await BR.modelsStatus();
    if (st && st.ok && st.status && /binary\s+missing/.test(String(st.status.backend || ''))) needsRuntime = true;
  } catch (e) { needsRuntime = false; }
  const jobs = [];
  if (needsRuntime) jobs.push({kind:'runtime', id:'llama.cpp'});
  jobs.push({kind:'weights', id});
  dlStart(jobs);
}

/** The TUI's pull-completion path: write the model and start the daemon. */
async function obActivateLocal(id) {
  if (!BR) return;
  const res = await BR.selectLocalModel(id);
  if (!res || !res.ok) {
    DL.error = (res && res.error) || 'could not select the model';
    if (OB.open) obDispatch({type:'onboarding_error_set', error: DL.error});
    return;
  }
  bswReport(res);
  OB.restarted = !!res.restart;
  obDispatch({type:'local_models_pull_finished', kind:'chat'});
}

/** A queue entry finished. Called from the one `cli:pull` subscriber. */
function obPullFinished(job, ev) {
  const ok = ev.ok !== false;
  if (job.kind === 'runtime') {
    /* r5 item 7 review fix: the weights job is NOT discarded when the
       runtime step fails. `runLocalModelsUpdate` exits 1 for reasons
       that say nothing about the model download — it refuses outside
       managed mode (models-handlers.ts:728-731) and fails on any network
       hiccup — and dropping the queue left the download screen's `model
       weights` row reading `waiting` for ever with no way back to it.
       The failure is reported on its own line instead (DL.runtimeError),
       and the model download the operator actually asked for runs. */
    dlNext();
    return;
  }
  renderDlbar();
  if (!ok) { render(); return; }
  if (DL.dry) { render(); return; }
  const pending = OB.pendingMmproj;
  OB.pendingMmproj = null;
  const after = () => obActivateLocal(job.id);
  if (pending && BR && BR.hfProjector) {
    BR.hfProjector(pending.id, pending.mmprojUrl, pending.mmprojFilename, pending.name)
      .then((res) => {
        if (!res || res.ok !== true) {
          // The daemon would serve a vision model text-only; say so and
          // do not activate behind the operator's back.
          DL.error = ((res && res.error) || 'the vision projector did not download')
            + ' — the model was not started: it would serve text only';
          render();
          return;
        }
        after();
      });
    return;
  }
  after();
}

/* ---- the Hugging Face branch, as its own two steps ---- */

function obHfInputValue() {
  const el = document.getElementById('ob-hf-ref');
  return el ? el.value : OB.hfReference;
}

async function obHfLook() {
  if (!BR || !BR.hfResolve) return;
  const value = obHfInputValue();
  OB.hfReference = value;
  obDispatch({type:'onboarding_busy_set', busy:true});
  const res = await BR.hfResolve(value);
  if (!OB.open || OB.step !== 'local_hf_ref') return;
  OB.busy = false;
  if (!res || res.ok !== true) {
    if (res && res.cancelled) { render(); return; }
    obDispatch({type:'onboarding_error_set', error: (res && res.error) || 'the lookup failed'});
    return;
  }
  obDispatch({type:'onboarding_hf_repo_resolved', repo: res.repo});
}

async function obHfAdd() {
  if (!BR || !BR.hfAdd || !OB.hfRepo) return;
  if (DL.job) { obDispatch({type:'onboarding_error_set', error:'a download is already running'}); return; }
  const res = await BR.hfAdd(OB.hfRepo, OB.cursor);
  if (!res || res.ok !== true) {
    obDispatch({type:'onboarding_error_set', error: (res && res.error) || 'could not add the model'});
    return;
  }
  const def = res.def || {};
  OB.pendingMmproj = def.supportsVision && def.mmprojUrl && def.mmprojFilename
    ? {id: res.id, mmprojUrl: def.mmprojUrl, mmprojFilename: def.mmprojFilename, name: def.name} : null;
  obDispatch({type:'onboarding_local_model_picked', modelId: res.id});
  obStartLocalPull(res.id, false);
}

/* ---- the custom-endpoint branch ---- */

function obUrlInputValue() {
  const el = document.getElementById('ob-url');
  return el ? el.value.trim() : (OB.step === 'custom_chat_url' ? OB.chatUrl : OB.embeddingUrl);
}

async function obUrlSubmit() {
  if (!BR) return;
  const value = obUrlInputValue();
  const chat = OB.step === 'custom_chat_url';
  const from = OB.step;
  obDispatch({type:'onboarding_url_changed', field: chat ? 'chat' : 'embedding', value});
  // An empty Enter on the embedding step saves the chat URL alone.
  if (!chat && !value) { obWriteCustomEndpoint(OB.chatUrl, ''); return; }
  if (!value) { obDispatch({type:'onboarding_error_set', error:'Type the base URL of your llama-server.'}); return; }
  obDispatch({type:'onboarding_busy_set', busy:true});
  const res = await BR.llamaProbe(value);
  // The step is part of the guard, not just `open`: a probe that answers
  // after the flow has moved on must not paint on the screen it reaches.
  if (!OB.open || OB.step !== from) return;
  OB.busy = false;
  const probe = res && res.probe;
  if (!res || !res.ok || !probe || !probe.reachable) {
    // describeLlamaHealthFailure's own sentence, from main.
    obDispatch({type:'onboarding_error_set',
      error: (probe && probe.message) || (res && res.error) || 'that URL did not answer GET /health'});
    return;
  }
  if (chat) { obDispatch({type:'onboarding_step_set', step:'custom_embedding_url'}); return; }
  obWriteCustomEndpoint(OB.chatUrl, value);
}

/** ONE whole-file write — persistUserRemoteLlmUrls, in main. */
async function obWriteCustomEndpoint(chatUrl, embeddingUrl) {
  const from = OB.step;
  obDispatch({type:'onboarding_busy_set', busy:true});
  const res = await BR.setExternalLlamaUrls(chatUrl, embeddingUrl || '');
  // Same guard as the probe: the write is done either way, but its
  // outcome belongs on the screen that asked for it.
  if (!OB.open || OB.step !== from) return;
  OB.busy = false;
  if (!res || res.ok === false) {
    obDispatch({type:'onboarding_error_set', error: 'could not save the endpoint: ' + ((res && res.error) || 'unknown error')});
    return;
  }
  OB.restarted = false;
  obDispatch({type:'onboarding_finished', outcome:'custom'});
}

/* ---- the import step ------------------------------------------------
   Four sources through `atag import` (src/cli/import-command.ts accepts
   hermes, openclaw, claude-code and codex and nothing else), plus one
   the import machinery cannot reach at any level: the operator's OWN
   ~/.atomic-agent, the terminal setup this desktop keeps its own state
   dir beside.  There is no `atomic-agent` import source to route that
   through, so it is a row of its own backed by the isolation lane's
   two-call contract — tuiSetupPresent() / importFromTui() — which never
   mutates the source, never copies the managed daemon port, and reports
   key ENV VAR NAMES rather than values.  Absent that bridge the row is
   simply not offered; nothing here throws when it is missing.
   ------------------------------------------------------------------ */
/** The four registries under src/import (import-options.ts), plus the bridge's. */
function obImportRegistry(id) {
  if (id === 'hermes') return [
    {id:'sessions', label:'Sessions', description:'Conversation history (state.db) -> sessions.sqlite'},
    {id:'cron', label:'Cron jobs', description:'Scheduled jobs (cron/jobs.json) -> tasks.sqlite'},
    {id:'secrets', label:'Provider key', description:'OPENROUTER_API_KEY / AIMLAPI_API_KEY -> <stateDir>/.env'},
  ];
  if (id === 'openclaw') return [
    {id:'sessions', label:'Sessions', description:'Transcript logs (agents/<agent>/sessions/*.jsonl) -> sessions.sqlite'},
    {id:'cron', label:'Cron jobs', description:'Scheduled jobs (state/openclaw.sqlite cron_jobs) -> tasks.sqlite'},
  ];
  if (id === 'claude-code') return [
    {id:'skills', label:'Skills', description:'Skill directories (skills/*/SKILL.md) -> global skills dir'},
    {id:'memory', label:'Memory', description:'Auto-memory notes + CLAUDE.md -> memory.sqlite'},
    {id:'mcp', label:'MCP servers', description:'mcpServers (~/.claude.json) -> config.mcp.servers'},
    {id:'sessions', label:'Sessions', description:'Transcripts (projects/*/*.jsonl) -> sessions.sqlite'},
    {id:'secrets', label:'Provider key', description:'ANTHROPIC_API_KEY (settings.json env) -> <stateDir>/.env'},
  ];
  if (id === 'codex') return [
    {id:'skills', label:'Skills', description:'Skill directories (skills/*/SKILL.md) -> global skills dir'},
    {id:'memory', label:'Instructions', description:'AGENTS.md -> memory.sqlite'},
    {id:'sessions', label:'Sessions', description:'Rollouts (sessions/**/*.jsonl) -> sessions.sqlite'},
    {id:'secrets', label:'Provider key', description:'OPENAI_API_KEY (auth.json) -> <stateDir>/.env'},
  ];
  // The bridge's own domains. `keys` is the secret row and starts off,
  // exactly as `secrets` does everywhere else.
  return [
    {id:'providers', label:'LLM providers', description:'the providers block of your terminal config'},
    {id:'skills', label:'Skills', description:'installed skills -> this window’s state dir'},
    {id:'sessions', label:'Sessions', description:'chat history -> sessions.sqlite'},
    {id:'memory', label:'Memory', description:'memory.sqlite'},
    {id:'keys', label:'Provider keys', description:'the API key variables named in your terminal .env'},
  ];
}

/** buildImportOptionRows (import-step.ts:121-141): secrets rows start off. */
function obBuildImportOptions(agents) {
  const rows = [];
  for (const agent of agents) {
    if (!agent.enabled) continue;
    for (const meta of obImportRegistry(agent.id)) {
      const secret = meta.id === 'secrets' || meta.id === 'keys';
      rows.push({agent: agent.id, agentLabel: agent.label, option: meta.id,
        label: meta.label, description: meta.description, secret, enabled: !secret});
    }
  }
  return rows;
}

/** detectImportAgents + the terminal-setup row. All rows start unticked. */
async function obDetectAgents() {
  const rows = [];
  if (BR && BR.detectImportAgents) {
    try {
      const res = await BR.detectImportAgents();
      if (res && res.ok) for (const agent of (res.agents || [])) {
        rows.push({id: agent.id, label: agent.label, dir: agent.dir, enabled: false});
      }
    } catch (e) { /* a scan that cannot run offers nothing */ }
  }
  if (BR && BR.tuiSetupPresent) {
    try {
      const t = await BR.tuiSetupPresent();
      OB.tuiSetup = t || null;
      if (t && t.ok && t.present) {
        const has = t.has || {};
        rows.push({id: OB_TUI_AGENT_ID, label: 'Atomic Agent in the terminal',
          dir: t.path + '  ·  ' + [
            has.providers + ' provider' + (has.providers === 1 ? '' : 's'),
            (has.keys || []).length + ' key' + ((has.keys || []).length === 1 ? '' : 's'),
            has.skills + ' skill' + (has.skills === 1 ? '' : 's'),
            has.sessions + ' session' + (has.sessions === 1 ? '' : 's'),
          ].join(' · '), enabled: false});
      }
    } catch (e) { /* absent is not an error — the row is just not offered */ }
  }
  return rows;
}

/**
 * Run the dry run or the write. One report, concatenated over the ticked
 * agents; the counts come from each source's own summary line and
 * nothing is claimed that a summary did not give.
 */
async function obRunImport(options, execute) {
  const items = [];
  const summary = {migrated:0, skipped:0, conflict:0, error:0};
  let failed = null;
  for (const agent of OB.importAgents) {
    if (!agent.enabled) continue;
    const mine = options.filter((o) => o.agent === agent.id);
    if (agent.id === OB_TUI_AGENT_ID) {
      const part = await obRunTuiImport(mine, execute);
      if (part.error) { failed = part.error; break; }
      for (const item of part.items) items.push(item);
      summary.migrated += part.summary.migrated;
      summary.error += part.summary.error;
      continue;
    }
    const exclude = mine.filter((o) => !o.enabled && !o.secret).map((o) => o.option);
    const secrets = mine.some((o) => o.secret && o.enabled);
    const res = await BR.importRun({source: agent.id, dir: agent.dir, exclude, secrets,
      overwrite: false, limit: '', execute});
    if (!res || !res.ok) { failed = (res && res.error) || 'the import failed'; break; }
    for (const item of (res.report.items || [])) items.push(item);
    summary.migrated += res.report.summary.migrated;
    summary.skipped += res.report.summary.skipped;
    summary.conflict += res.report.summary.conflict;
    summary.error += res.report.summary.error;
  }
  if (!OB.open) return;
  if (failed !== null) { obDispatch({type:'onboarding_import_failed', error: failed}); return; }
  obDispatch({type:'onboarding_import_report', executed: execute, report: {items, summary, executed: execute}});
}

/**
 * The terminal-setup row.  A preview here is the SCAN, not a dry run:
 * the bridge reports what ~/.atomic-agent holds and this turns those
 * counts into the same report shape the CLI's own preview produces, so
 * the preview screen stays the gate before anything is written.
 */
async function obRunTuiImport(options, execute) {
  const empty = {items: [], summary: {migrated:0, skipped:0, conflict:0, error:0}};
  const on = {};
  for (const o of options) on[o.option] = o.enabled;
  if (!execute) {
    const has = (OB.tuiSetup && OB.tuiSetup.has) || {};
    const counts = {
      providers: on.providers ? (has.providers || 0) : 0,
      keys: on.keys ? ((has.keys || []).length) : 0,
      skills: on.skills ? (has.skills || 0) : 0,
      sessions: on.sessions ? (has.sessions || 0) : 0,
      memory: on.memory && has.memory ? 1 : 0,
    };
    const items = [];
    for (const kind of Object.keys(counts)) {
      for (let i = 0; i < counts[kind]; i += 1) items.push({kind, status: 'migrated'});
    }
    return {items, summary: {migrated: items.length, skipped:0, conflict:0, error:0}};
  }
  if (!BR.importFromTui) return Object.assign({}, empty, {error: 'this build cannot read the terminal setup'});
  const res = await BR.importFromTui({providers: !!on.providers, keys: !!on.keys,
    skills: !!on.skills, sessions: !!on.sessions, memory: !!on.memory});
  if (!res || !res.ok) return Object.assign({}, empty, {error: (res && res.error) || 'could not copy the terminal setup'});
  const copied = res.copied || {};
  const items = [];
  const push = (kind, n) => { for (let i = 0; i < n; i += 1) items.push({kind, status:'migrated'}); };
  push('providers', copied.providers || 0);
  push('keys', copied.keys || 0);
  push('skills', copied.skills || 0);
  push('sessions', copied.sessions || 0);
  push('memory', copied.memory ? 1 : 0);
  return {items, summary: {migrated: items.length, skipped:0, conflict:0, error:0}};
}

/* ---- closing down: use-onboarding-lifecycle.ts:85-146 ---- */

/** decideSecondBackendOffer (propose-second-backend.ts:44-51), verbatim. */
function obDecideSecondBackend(i) {
  if (i.alreadyProposed) return null;
  if (i.outcome === 'custom' || i.outcome === 'skipped') return null;
  if (i.cloudReady && i.localReady) return null;
  if (i.outcome === 'local') return i.cloudReady ? null : 'cloud';
  if (i.localSetupSeen) return null;
  return i.localReady ? null : 'local';
}

/** isCloudTextProviderReady / isLocalBackendConfigured, as far as this
 *  window can see them (see the note on needsOnboarding). */
async function obReadiness() {
  const out = {cloudReady: false, localReady: false, stamps: {}};
  if (!BR) return out;
  const ready = await BR.providersReady();
  out.cloudReady = !!(ready && ready.ok && (ready.ids || []).length > 0);
  const cfg = await BR.configGet();
  const config = (cfg && cfg.ok && cfg.config) || {};
  const lm = config.localModels || {};
  out.localReady = !!((lm.mode === 'managed' && lm.managed && lm.managed.modelId)
    || (lm.mode === 'external' && lm.url && lm.url !== OB_DEFAULT_LLAMA_URL));
  out.stamps = (config.tui && config.tui.onboarding) || {};
  return out;
}

/**
 * The finished effect.  Second-backend offer first, import second, and
 * only then the closing stamp — both offers stamped when SHOWN, not when
 * answered, so a run interrupted by a crash cannot re-pitch a screen the
 * operator already declined.  Nothing routes around the import screen:
 * its own skip row is the only way past it.
 */
async function obSettle() {
  if (OB.settling || !BR) return;
  OB.settling = true;
  const outcome = OB.outcome || 'skipped';
  const state = await obReadiness();
  if (!OB.open) { OB.settling = false; return; }
  const offer = OB.skipSecondOffer ? null : obDecideSecondBackend({
    outcome,
    cloudReady: state.cloudReady,
    localReady: state.localReady,
    alreadyProposed: !!state.stamps.proposedSecondBackendAt,
    localSetupSeen: !!state.stamps.localSetupSeenAt,
  });
  if (offer) {
    OB.settling = false;
    obDispatch({type:'onboarding_second_backend_offered', offer});
    // Written in the SAME tick the step is entered (use-onboarding-
    // lifecycle.ts:107-110) — after the dispatch, not before, so a run
    // that somehow failed to raise the screen has not spent the offer.
    obStampOnce('proposedSecondBackendAt');
    return;
  }
  if (!state.stamps.importOfferedAt && !OB_STAMPED.importOfferedAt) {
    const agents = await obDetectAgents();
    if (!OB.open) { OB.settling = false; return; }
    if (agents.length > 0) {
      OB.settling = false;
      obDispatch({type:'onboarding_import_opened', agents});
      // Same tick, same rule (use-onboarding-lifecycle.ts:127).
      obStampOnce('importOfferedAt');
      return;
    }
  }
  /* r5 item 7: the ONE smoke-only seam in this flow. The suite walks the
     whole machine several times over, and each pass ends here — with a
     config write and an agent bounce. Everything above this line runs for
     real under the harness (the readiness reads, the offer decision, the
     import scan, the stamps); only the closing write and the restart are
     skipped, because repeating them a dozen times mid-run would be the
     suite testing the harness rather than the flow. */
  /* r5 item 7 review fix: the closing leaf is DECIDED here and recorded
     either way — the harness skips only the write and the agent bounce,
     so `esc` from `choose` can still be asserted to end as `skipped`. */
  const closing = outcome === 'skipped' ? 'skippedAt' : 'completedAt';
  const stamp = new Date().toISOString();
  OB_STAMP_LOG.push({leaf: closing, at: stamp, step: 'finished', written: !OB.testClose});
  if (OB.testClose) { OB.open = false; OB.settling = false; obSkyStop(); render(); return; }
  const res = await BR.configSet('tui.onboarding.' + closing, stamp);
  if (res && res.ok === false) {
    OB.settling = false;
    obDispatch({type:'onboarding_error_set', error: 'could not write the setup stamp: ' + (res.error || 'unknown error')});
    return;
  }
  OB.open = false;
  OB.settling = false;
  obSkyStop();
  toast('Setup complete', outcome === 'skipped' ? 'You can run it again from the menu' : 'Restarting the agent…');
  render();
  if (OB.restarted) { refreshLiveConfig(); return; }
  BR.restart().then(applyStatus);
}

/* ---- opening ---- */

async function openOnboarding() {
  Object.assign(OB, {
    open: true, step: 'intro', offer: null, resumeAfterCloud: null, localModelId: null,
    outcome: null, skipSecondOffer: false, cursor: 0, embeddingUrl: '', busy: false, error: null,
    hfReference: '', hfRepo: null, importAgents: [], importOptions: [], importReport: null,
    introTyped: false, settling: false, testClose: false, pendingMmproj: null, restarted: false,
  });
  // A re-run (the menu's `onboarding`, or --onboarding) stamps again.
  for (const leaf of Object.keys(OB_STAMPED)) delete OB_STAMPED[leaf];
  OB_LAST_STEP = 'intro';
  render();
  if (!BR) return;
  OB.ram = (await BR.hostRam()) || 0;
  OB.keyEnv = (await BR.keyEnv()) || {};
  const cfg = await BR.configGet();
  if (cfg && cfg.ok && cfg.config) {
    // createOnboardingState(chatUrl): the flow opens on the URL the file
    // already carries, so a re-run does not blank it.
    OB.chatUrl = (cfg.config.localModels && cfg.config.localModels.url) || '';
  }
  const ready = await BR.providersReady();
  OB.cloudReady = !!(ready && ready.ok && (ready.ids || []).length > 0);
  render();
}

/**
 * Called by renderOverlays once the flow's DOM is in place: arm the
 * intro's canvas, and give the step's own editor the keyboard — the two
 * URL steps and the Hugging Face reference are text fields, and a screen
 * whose only control is a field nobody focused reads as broken.
 */
function obIntroMounted() {
  if (OB.open && !OB.busy) {
    const field = document.getElementById('ob-url') || document.getElementById('ob-hf-ref')
      || document.getElementById('wiz-q');
    if (field && document.activeElement !== field) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }
  if (!OB.open || OB.step !== 'intro') { obSkyStop(); return; }
  if (!document.getElementById('ob-sky')) return;
  obSkyStop();
  OBSKY.canvas = null;
  OBSKY.stars = [];
  requestAnimationFrame(() => {
    if (!OB.open || OB.step !== 'intro') return;
    obSkyStart();
    if (!OB.introTyped) obStartTyping(); else obPaintTagline();
  });
}

/* ---- keyboard, mouse and the app wiring ---- */

/** Escape on a step that owns its keyboard. */
function obOwnEscape() {
  if (OB.step === 'cloud') { obCloudKey('', {escape:true}); return; }
  if (OB.step === 'local_hf_ref') {
    if (OB.busy) { if (BR && BR.hfCancel) BR.hfCancel(); OB.busy = false; render(); return; }
    obDispatch({type:'onboarding_step_set', step:'local_pick'});
    return;
  }
  if (OB.step === 'custom_chat_url' || OB.step === 'custom_embedding_url') {
    /* r5 item 7 review fix: OnboardingUrlStep passes `focus={!props.busy}`
       to its editor (onboarding-url-step.tsx:74-75), so Escape cannot fire
       while a /health probe is out. Without this the 8 s probe answers
       onto whatever screen the operator moved to. `local_hf_ref` already
       had its own busy branch (it cancels the lookup); this one has no
       socket to drop — llamaProbe carries its own AbortSignal timeout. */
    if (OB.busy) return;
    obDispatch({type:'onboarding_step_set', step: OB.step === 'custom_chat_url' ? 'choose' : 'custom_chat_url'});
    return;
  }
}
/** Enter on a step that owns its keyboard. */
function obOwnEnter() {
  if (OB.step === 'cloud') { obCloudKey('', {return:true}); return; }
  if (OB.step === 'local_hf_ref') { if (!OB.busy) obHfLook(); return; }
  if (OB.step === 'custom_chat_url' || OB.step === 'custom_embedding_url') { if (!OB.busy) obUrlSubmit(); return; }
}

/**
 * The wizard owns the keyboard while it is up — the desktop already
 * guards every other binding with `if (OB.open) return`, so this listener
 * runs in the CAPTURE phase and stops what it consumes rather than
 * competing with them. Ctrl+C and the browser's own Cmd/Alt chords are
 * never claimed, and a keystroke inside one of the flow's own editors
 * reaches that editor.
 */
function obKeydown(e) {
  if (!OB.open) return;
  if (e.metaKey || e.altKey) return;
  if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) return;
  const target = e.target || {};
  const inField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
  if (OB.step === 'intro') {
    // "press any key", taken literally (use-intro-input.ts).
    e.preventDefault(); e.stopPropagation();
    obIntroAdvance();
    return;
  }
  if (obStepOwnsKeyboard(OB.step)) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); obOwnEscape(); return; }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); obOwnEnter(); return; }
    if (e.ctrlKey && (e.key === 'l' || e.key === 'L') && OB.step === 'local_hf_ref') {
      e.preventDefault(); e.stopPropagation();
      obDispatch({type:'onboarding_hf_reference_changed', value:''});
      obDispatch({type:'onboarding_error_set', error:null});
      return;
    }
    /* r5 item 7 review fix: the cloud step's footer promises `↑/↓ move`
       and `/ search`, so the step accepts them. Arrows are handled even
       inside the search box — searching and moving are one gesture. */
    if (OB.step === 'cloud' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault(); e.stopPropagation();
      obKey('', {upArrow: e.key === 'ArrowUp', downArrow: e.key === 'ArrowDown'});
      return;
    }
    if (OB.step === 'cloud' && e.key === '/' && !inField) {
      e.preventDefault(); e.stopPropagation();
      obKey('/', {});
      return;
    }
    if (inField) return;
    e.stopPropagation();
    return;
  }
  if (inField) return;
  const key = {
    upArrow: e.key === 'ArrowUp', downArrow: e.key === 'ArrowDown',
    return: e.key === 'Enter', escape: e.key === 'Escape', ctrl: e.ctrlKey,
  };
  const input = e.key.length === 1 ? e.key : '';
  e.preventDefault(); e.stopPropagation();
  obKey(input, key);
}

/**
 * A row click.  MouseListRow's own two-stage rule (mouse-list-row.tsx):
 * the first click selects, the second activates — and the second click
 * sends the SAME Enter the keyboard sends, through the one key table, so
 * a click can never do something no key can.
 */
/** A click on a cloud-list row. Same two-stage rule, same key router. */
function obWizRowClick(n) {
  const rows = obWizRows();
  const cur = rows.length ? WIZ.cur % rows.length : 0;
  if (cur !== n) { WIZ.cur = n; render(); return; }
  obKey('', {return:true});
}
function obRowClick(index) {
  if (OB.cursor !== index) { obDispatch({type:'onboarding_cursor_set', cursor: index}); return; }
  obKey('', {return:true});
}
/** A click on one of the flow's own controls, routed the same way. */
function obControlClick(spec) {
  if (spec === 'key:c') { obKey('c', {}); return; }
  if (spec === 'key:s') { obKey('s', {}); return; }
  if (spec === 'hf:clear') {
    obDispatch({type:'onboarding_hf_reference_changed', value:''});
    obDispatch({type:'onboarding_error_set', error:null});
    return;
  }
}

if (BR) {
  /* The one pull subscriber the flow needs. The LLM pane keeps its own —
     `dlOnPull` is inert unless this flow started the download. */
  BR.onPull((ev) => { if (ev) dlOnPull(ev); });

  // First run: the wizard opens itself, exactly as the TUI does. The
  // cloud half of the gate needs providersReady()'s key check, which is
  // a second round trip, so the decision waits for it.
  BR.configGet().then(async (res) => {
    if (!res || !res.ok) return;
    let ids = null;
    try { const ready = await BR.providersReady(); if (ready && ready.ok) ids = ready.ids || []; } catch (e) { ids = null; }
    if (needsOnboarding(res.config, ids)) openOnboarding();
  });

  const prevAct = act;
  act = function (a) {
    if (a === 'onboarding') { openOnboarding(); return; }
    if (a === 'dl:cancel') { if (BR.cancelPull) BR.cancelPull(); DL.queue.length = 0; return; }
    if (OB.open && OB.step === 'cloud' && (a === 'wiz:cancel' || a === 'wiz:back')) {
      if (a === 'wiz:back' && WIZ.phase === 'configure') { WIZ.phase = 'pick_kind'; WIZ.error = null; render(); return; }
      WIZ.phase = null;
      obDispatch({type:'providers_wizard_closed'});
      return;
    }
    return prevAct(a);
  };
}

document.addEventListener('keydown', obKeydown, true);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) obSkyStop();
  else if (OB.open && OB.step === 'intro') obSkyResume();
});
/* "press any key" answered on every channel the TUI answers it on —
   keys, a mouse press, a wheel notch and a non-empty paste
   (intro-input.ts:26-41). A release is not a press, and an empty paste
   is not a keystroke. */
document.addEventListener('pointerdown', () => { if (OB.open && OB.step === 'intro') obIntroAdvance(); });
document.addEventListener('wheel', () => { if (OB.open && OB.step === 'intro') obIntroAdvance(); }, {passive:true});
document.addEventListener('paste', (e) => {
  if (!OB.open || OB.step !== 'intro') return;
  const text = e.clipboardData ? e.clipboardData.getData('text') : '';
  if (text && text.length > 0) obIntroAdvance();
});
document.addEventListener('click', (e) => {
  if (!OB.open) return;
  const row = e.target.closest && e.target.closest('[data-obrow]');
  if (row) { obRowClick(+row.dataset.obrow); return; }
  const ctl = e.target.closest && e.target.closest('[data-obact]');
  if (ctl) { obControlClick(ctl.dataset.obact); return; }
  const wr = e.target.closest && e.target.closest('[data-obwiz]');
  if (wr) { obWizRowClick(+wr.dataset.obwiz); return; }
});
document.addEventListener('input', (e) => {
  if (!OB.open) return;
  if (e.target.id === 'ob-hf-ref') {
    /* r5 item 7 review fix: both the footer's `ctrl+l clear` chord and the
       on-screen `[ clear ]` control are gated on there being something to
       clear, and the TUI recomputes its footer on every keystroke. The
       desktop has no ambient render loop while the wizard is up, so
       without this the chord and the button stayed missing until some
       unrelated repaint. Only the EMPTINESS transition repaints — a
       render per keystroke would move the caret. */
    const wasEmpty = OB.hfReference.length === 0;
    OB.hfReference = e.target.value;
    const nowEmpty = OB.hfReference.length === 0;
    if (OB.error) { OB.error = null; render(); return; }
    if (wasEmpty !== nowEmpty) render();
    return;
  }
  if (e.target.id === 'ob-url') {
    if (OB.step === 'custom_chat_url') OB.chatUrl = e.target.value; else OB.embeddingUrl = e.target.value;
    return;
  }
  if (e.target.id === 'wiz-q') { WIZ.q = e.target.value; WIZ.cur = 0; render(); }
});


/* ---- Models pane: everything below drives the real agent ---- */

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
  // The composer's own pull (SEL.pulling). The LLM tab has its own listener
  // for LLMP.pulling; the prototype Models pane's third branch went with it.
  BR.onPull((ev) => {
    if (!ev || !SEL.pulling) return;
    if (ev.line) { SEL.pullLine = ev.line; const box = document.querySelector('.popover .cap'); if (box) box.textContent = ev.line; }
    if (ev.done) {
      const id = SEL.pulling; SEL.pulling = null;
      if (ev.ok) selActivate({type:'localModel', id, downloaded:true});
      else { SEL.err = ev.error || 'the download failed'; render(); }
    }
  });
}

/* Hooks for `electron . --smoke --models`. */
if (typeof window !== 'undefined') {
  // The prototype's Models pane is retired: its two rooms are Settings › LLM's
  // Local and Cloud panes, so the harness looks where the operator does.
  window.__pane = (room, tab) => {
    if (room !== 'models') return;
    act('settings:llm');
    llmSetMode(tab === 'cloud' ? 'cloud' : 'local');
  };
  window.__mp = () => ({
    local: (LLMP.local || []).length,          // `atag models list` rows the LLM tab really draws
    picks: MP.picks.length,
    firstPick: MP.picks[0] ? MP.picks[0].id : '',
    err: MP.err || LLMP.localErr,
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
  if (!(p && p.kind === 'llama-server')) return 'cloud';
  // Review fix: composer-switch-rows.ts selectComposerBackend — `local` and
  // `custom` are the SAME provider entry (local-llama) and are told apart by
  // localModels.mode. Reporting `local` for an external route drew the
  // managed row as active and described a route the operator is not on.
  const mode = LIVE_CONFIG && LIVE_CONFIG.localModels && LIVE_CONFIG.localModels.mode;
  return mode === 'external' ? 'custom' : 'local';
}
/** The managed catalogue is only the route's model list in managed mode. */
function selLocalRoute() { return selBackend() === 'local'; }
function selKinds() { return selBackend() === 'cloud' ? ['backend','provider','model'] : ['backend','model']; }
function selProviders() {
  return ((LIVE_CONFIG && LIVE_CONFIG.llm && LIVE_CONFIG.llm.providers) || [])
    .filter((p) => p.kind !== 'llama-server');
}
function selActiveProviderId() { return LIVE_CONFIG && LIVE_CONFIG.llm && LIVE_CONFIG.llm.activeTextProvider; }

function openSelector(kind) {
  SEL.open = true; SEL.kind = kind || 'backend'; SEL.cursor = 0; SEL.filter = ''; SEL.err = null;
  render();
  if (SEL.kind === 'model') selEnterModelPane();
  if (SEL.kind === 'backend' && selLocalRoute() && !SEL.local.length) selLoadLocal();
}
function closeSelector() { SEL.open = false; SEL.addOpen = false; render(); }

async function selLoadLocal() {
  SEL.localBusy = true; render();
  const res = await BR.chatModelsList();
  SEL.localBusy = false;
  SEL.local = res && res.ok ? res.models : [];
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
  if (selLocalRoute()) { if (!SEL.local.length) selLoadLocal(); return; }
  const id = selActiveProviderId();
  if (id && SEL.modelsFor !== id) selLoadModels(id);
}

/** Rows for the current pane, as objects the delegate can act on by index. */
function selRows() {
  if (SEL.kind === 'backend') {
    // Lane B — backend switch: composer-switch-rows.ts backendRows, in
    // its order (cloud, local, custom) with its details. Review fix: the
    // third row is back, because dropping it made an external route read as
    // the managed one. It carries no editor — the desktop's editor for it is
    // Settings › LLM › External, and the row deep-links there, the way the
    // TUI's "Download more models…" row deep-links into its Local pane.
    const ready = selProviders().filter((p) => BSW.readyIds.includes(p.id)).length;
    const here = selBackend();
    const customUrl = (LIVE_CONFIG && LIVE_CONFIG.localModels && LIVE_CONFIG.localModels.url) || '';
    return [
      {type:'backend', id:'cloud', label:'cloud',
       detail: !BSW.readyLoaded ? 'checking keys…' : ready > 0 ? ready + ' provider' + (ready === 1 ? '' : 's') + ' ready' : 'add a provider first',
       active: here === 'cloud'},
      {type:'backend', id:'local', label:'local',
       detail: 'llama.cpp managed here' + (here === 'custom' ? ' · switches this route to managed' : ''),
       active: here === 'local'},
      {type:'backend', id:'custom', label:'custom',
       detail: 'llama.cpp you run' + (customUrl ? ' · ' + customUrl : '') + ' · Settings › LLM › External',
       active: here === 'custom'},
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
  if (selLocalRoute()) {
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
      detail: (m.contextWindow ? fmtContextWindow(m.contextWindow) + ' context' : '')
        + (m.supportsTools && m.supportsTools !== 'none' ? ' · tools' : '')
        + (m.supportsVision ? ' · vision' : '')}));
}

async function selActivate(row) {
  if (!row) return;
  if (row.type === 'backend') {
    // The custom row has no switch behind it: pointing the route at a server
    // the operator runs needs the URL probed first, which is the External
    // pane's job. Open it instead of writing anything here.
    if (row.id === 'custom') { closeSelector(); act('settings:llm'); llmSetMode('external'); return; }
    selChooseBackend(row.id); return;
  }
  // The TUI's trailing rows: "Add a new provider" opens the wizard,
  // "Download more models…" the local models pane (Settings › Models).
  if (row.type === 'action') {
    if (row.id === 'add') { act('sel:add'); return; }
    // model:local:download-more → Manage › LLM › Local, the pane that
    // downloads. (Review fix: it used to open the same tab but then set the
    // retired Models pane's tab and spawn an `atag models list` nothing drew.)
    closeSelector(); act('settings:llm'); llmSetMode('local');
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

/** Port of src/llm/provider/format-model-details.ts formatContextWindow: the
    string the TUI's model rows (and `models search`) print for a context
    window — 33k / 1.0M — as opposed to formatTokens below, which is the
    context chip's own format. */
function fmtContextWindow(n) {
  if (n >= 1e6) { const m = n / 1e6; return (Number.isInteger(m) ? String(m) : m.toFixed(1)) + 'M'; }
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}
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
    /* DRIFT FIX (D2 of the 0.5.5 review). This used to say the counted
       figure came AFTER the cached prefix, because `timing.promptTokens`
       was llama-server's `prompt_n` — the KV-cache MISS count. As of
       0.5.5 it is evaluated + cached (llama-server-client.ts
       normaliseCompletionResponse), i.e. the whole prompt, and the
       parenthetical now explains the figure's composition rather than a
       discrepancy with it. */
    return 'counted by ' + (CTX.modelId || 'the model')
      + (CTX.cacheHitTokens > 0 ? ' (' + fmtTokens(CTX.cacheHitTokens) + ' of it reused from its cache)' : '');
  }
  // The agent's own breakdown for this session's last turn, persisted on
  // the session row. Still the agent's estimate until a completion
  // refines it, which is why this does not say "measured by the model".
  if (CTX.source === 'measured') return 'measured on this session’s last turn';
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

/**
 * DRIFT FIX (D3 of the 0.5.5 review), on its own so the rule can be
 * exercised directly. A prompt-derived window is set once and then
 * treated as permanent by the two `windowLabel !== 'prompt window'`
 * guards in refreshContext — with nothing anywhere resetting it, so
 * after a provider or model change the gauge kept drawing the new model
 * against the old model's scale for the rest of the window's life.
 *
 * This is the rule 0.5.5 added to the TUI (providers-reducer.ts
 * activeTextRoute nulls contextUsage.contextWindow whenever the active
 * `<providerId> <chatModel>` pair changes). It was latent while the only
 * source of a prompt window was a route the installed binary 404s; the
 * session snapshot makes it a live one.
 */
function ctxReleaseWindowOnRouteChange() {
  const route = String(selActiveProviderId() || '') + ' ' + String(activeModel() || '');
  const changed = CTX055.route !== null && CTX055.route !== route;
  if (changed) { CTX.window = null; CTX.windowLabel = ''; }
  CTX055.route = route;
  return changed;
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
  /* DRIFT FIX (D3 of the 0.5.5 review). A prompt-derived window was set
     once and then treated as permanent by the two guards below, so after a
     provider/model switch the gauge kept drawing against the previous
     model's scale for the rest of the window's life. This is the rule
     0.5.5 added to the TUI (providers-reducer.ts activeTextRoute nulls
     contextUsage.contextWindow whenever the active <providerId>
     <chatModel> pair changes) — and it stops being latent the moment the
     session snapshot below starts supplying a real window. */
  ctxReleaseWindowOnRouteChange();
  const windowP = resolveWindow().catch(() => ({window:null, label:''}));
  let usage = null;
  /* (a) the session's own persisted breakdown. v0.5.5 stamps the last
     turn's whole window occupancy onto SessionState — sections, both
     conversation caps, the pair costs, the physical window — and serves
     it verbatim on GET /api/sessions/{id}. Fetched here rather than
     carried over from openSession, so the gauge cannot go stale:
     refreshContext also runs at the end of every turn. Absent on a
     session that has never finished a turn and on anything written
     before 0.5.5, which is why the rest of the ladder stays.

     r4 INTEGRATION (seam e): this rung led the ladder in the merged tree,
     which is where it was always meant to be — the check below it says so
     in as many words ("`measured` is the session row's own contextUsage
     … which now leads the ladder") — but it shipped BELOW the built
     preview because the agent r4-feat ran against answered
     /api/context-preview with a 404, so the two rungs were never live at
     the same time. r4-mode's resolveBinary change made the locally built
     agent the desktop's first choice, and that one answers the preview
     route, so the preview started winning on every session and this rung
     became unreachable — CTX055.stored stayed null, and with it the
     panel's trimming line and pair costs. Worse, the two figures are not
     interchangeable: the preview is built "before recall", so on the
     session this run measured it read 7,376 tokens against the agent's
     own 10,039 for the same session — a 26% understatement presented as
     the window's occupancy. The session's own record of what the last
     turn really occupied wins; the preview stays as what it is, a
     pre-message projection for a session with no record yet.

     Staged in a local, committed to CTX055 only past the staleness guard
     below. Everything else this ladder produces is funnelled through that
     guard; writing the snapshot here directly would let a late-resolving
     refresh for session A draw its trimming verdict (ctxBoundLine) over
     session B's numbers, and a stale `= null` would blank a binding line
     the current session legitimately has. */
  let stored055 = null;
  // `stateDirOverride` means "run the ladder as if this agent held no
  // record of this session", so the session row is skipped with the trace
  // file — reading it back off the live agent would contradict the very
  // state the probe is exercising.
  if (!stateDirOverride && S.agentSession && BR.session) {
    const r = await BR.session(S.agentSession);
    const u = r && r.ok && r.data ? r.data.contextUsage : null;
    if (u && u.tokens > 0) {
      stored055 = u;
      const sec = (label) => { const x = (u.sections || []).find((y) => y.label === label); return x ? x.tokens : 0; };
      usage = {tokens:u.tokens, source:'measured', stablePrefix:sec('prompt scaffold'),
        tail: typeof u.conversationTokens === 'number' ? u.conversationTokens : sec('conversation'),
        cacheHitTokens:null, modelId:null, baseline:null, sections:u.sections || [],
        pairsCap: u.conversationPairsCap || 0, reserved:0,
        builtWindow: u.contextWindow > 0 ? u.contextWindow : null};
    }
  }
  // (b) the branch route: the agent's own prompt, built now. This is the
  // figure before the first message — a session with no persisted turn of
  // its own — and it keeps costing the draft as it is typed, which is why
  // it is still above the trace scan rather than beneath it.
  if (!usage && BR.contextPreview && CTX.previewSupported !== false) {
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
  // (c) this session's trace, once a turn has run.
  if (!usage && S.agentSession && stateDir) {
    const r = await BR.traceUsage(stateDir, S.agentSession);
    if (r && r.ok && r.usage) usage = Object.assign({}, r.usage, {baseline:null, sections:null, pairsCap:ctxPairsCap(), reserved:0, builtWindow:null});
  }
  // (d) the projection: the last scaffold this agent built here + the draft.
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
  CTX055.stored = stored055; // committed only for the session this refresh still owns
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
  if (CTX.source === 'projected') { CTX.tokens = CTX.stablePrefix + CTX.draftTokens; scheduleChipRepaint(); return; }
  // Review fix: on an agent that HAS /api/context-preview the figure is the
  // agent's own build of a prompt that already includes this draft, so typing
  // must re-ASK rather than add an estimate locally — never add the draft to a
  // measured figure. Debounced, or every keystroke would be a request.
  // Unreachable against installed 0.5.4, whose route 404s (previewSupported
  // false) and whose figure is therefore 'projected' or from the trace.
  if (CTX.source === 'built' && CTX.previewSupported) {
    clearTimeout(CTX.draftTimer);
    CTX.draftTimer = setTimeout(() => { CTX.draftTimer = null; refreshContext(); }, 600);
  }
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
  // No route on this agent build: print the honest blank rather than a
  // mode. Painting 'default' would name a stance the agent does not have.
  if (MODE.supported === false) {
    return '<button class="cchip cmodechip" data-act="modes" '
      + 'title="this agent build has no /api/coding-mode route" '
      + 'style="color:var(--text-disabled)">' + ic('key') + 'mode —' + ic('chevD') + '</button>';
  }
  // The same blank, for the same reason, one state earlier: the route has not
  // answered yet (or its last answer was an error). Painting the seed would
  // name a stance the agent has not confirmed — at approvalLevel 5 it would
  // say a green `default` while the live stance is `bypass`.
  if (!MODE.known) {
    return '<button class="cchip cmodechip" data-act="modes" '
      + 'title="the agent has not reported a stance yet" '
      + 'style="color:var(--text-disabled)">' + ic('key') + 'mode —' + ic('chevD') + '</button>';
  }
  const id = currentMode();
  const look = CODING_MODES.find((m) => m.id === id) || CODING_MODES[0];
  const colour = look.tone === 'bad' ? 'var(--danger)' : look.tone === 'warn' ? 'var(--warn)'
    : look.tone === 'accent' ? 'var(--accent-text)' : 'var(--success)';
  // At a configured level of 5 the agent seeds its stance by inference and
  // reports `bypass`, because default/auto/bypass all resolve to level 5
  // with plan off — so the chip opens red until a mode is chosen. Say so
  // in the tooltip, where it is readable without opening the popover.
  const title = MODE.baseLevel === MAX_APPROVAL_LEVEL
    ? 'what the agent may do without asking — your configured approval level is '
      + MAX_APPROVAL_LEVEL + ' of ' + MAX_APPROVAL_LEVEL + ', so default already approves everything'
    : 'what the agent may do without asking';
  return '<button class="cchip cmodechip" data-act="modes" title="' + esc(title) + '" '
    + 'style="color:' + colour + '">' + ic('key') + esc(look.label) + ic('chevD') + '</button>';
}

function modesHTML() {
  return '<div class="scrim" data-close="1" style="background:transparent">'
    + '<div class="popover" style="width:360px;' + anchorStyle('.cmodechip', 360) + '">'
    + CODING_MODES.map((m) => {
        const off = MODE.supported === false;
        // Nothing is "current" on an agent that has no such state, so no
        // row is marked, and the rows carry no data-mode: the click
        // handler keys off that attribute, so dropping it is what makes
        // them genuinely inert rather than merely grey.
        // ...and nothing is "current" before the route has answered either.
        const on = !off && MODE.known && m.id === currentMode();
        return '<button class="poprow' + (on ? ' on' : '') + (off ? ' dim' : '') + '"'
          + (off ? ' disabled' : ' data-mode="' + m.id + '"') + '>'
          + '<span class="radio"' + (on ? ' style="border-color:var(--accent);border-width:4px"' : '') + '></span>'
          + '<span><span style="font-weight:500">' + esc(m.label) + '</span>'
          + '<span class="cap" style="display:block">' + esc(off ? 'needs an agent with the coding-mode route' : m.detail) + '</span></span>'
          + (on ? '<span class="cap" style="margin-left:auto">current</span>' : '') + '</button>';
      }).join('')
    + '<div style="padding:10px 16px">'
    + (MODE.supported === false
        ? '<p class="cap" style="margin:0">'
          + 'This agent build has no /api/coding-mode route, so the stance cannot be changed. Running '
          + esc(S.live.binary || 'no binary') + '</p>'
        : '<p class="cap" style="margin:0">'
          + 'A stance for this session. It moves the live approval ladder and plan flag and writes nothing to config.'
          + '</p>'
          // The disclosure that stops a level-5 operator reading a working
          // chip as a broken one: three of the four choices genuinely do
          // not change what the agent does at that base.
          + (MODE.baseLevel === MAX_APPROVAL_LEVEL
              ? '<p class="cap" style="margin:6px 0 0">Your configured approval level is ' + MAX_APPROVAL_LEVEL
                + ' of ' + MAX_APPROVAL_LEVEL + ', so default already approves everything — lower agent.approvalLevel to make the modes differ.</p>'
              : ''))
    + '</div>'
    + '<div class="popfoot"><button class="btn btn-s" data-act="close">Done</button></div></div></div>';
}

/* Item 6 review fix: S.level has three writers and the diagnostics line
   prints it raw, so the two that read the route's answer put it back
   inside 1..5 themselves rather than trusting whoever fed them. Mirrors
   clampApprovalLevel in src/tui/coding-mode.ts. `null` for anything that
   is not a number: a missing level leaves S.level alone rather than
   inventing one. */
function clampLevel(n) {
  return typeof n === 'number' ? Math.max(1, Math.min(MAX_APPROVAL_LEVEL, n)) : null;
}

/*
 * Re-assert the stance this window last chose, after the agent came back.
 * Deliberately NOT setCodingMode: that is the click path, and it opens with
 * `S.overlay = null; render()` and a `S.busy` toast-and-return. A reconnect
 * is a background event the operator did not initiate, so it must (a) leave
 * whatever overlay they have open alone, and (b) wait for a running turn
 * instead of silently dropping the choice and leaving MODE on the boot
 * stance. Silent on success — the chip is the report — and silent on
 * failure beyond marking the route unsupported.
 */
function cancelModeReassert() {
  if (!MODE_REASSERT) return;
  clearInterval(MODE_REASSERT.timer);
  MODE_REASSERT = null;
}

/*
 * The connect-time read of the stance, lifted out of loadResources so the
 * race below can be driven in a test.
 *
 * Review fix: this GET takes a seq ticket exactly as the two POST writers
 * do. Without one a reconnect could silently undo a click. The operator
 * presses `plan` while this GET is in flight; the GET's stale reply lands
 * first, repaints the chip to the pre-click stance, sees
 * `res.mode !== LAST_MODE` and re-asserts the OLD mode — which bumps
 * MODE.seq, so the click's own reply is dropped by its own guard and a
 * second POST puts the agent back where it was. The ticket makes the
 * click win: it bumps seq past this one, and the stale reply is discarded
 * whole, re-assert included.
 */
function loadCodingMode() {
  if (!BR) return Promise.resolve();
  const seq = ++MODE.seq;
  return BR.codingMode().then((res) => {
    if (!res) return;
    if (seq !== MODE.seq) return;
    MODE.supported = res.supported;
    // Only an `ok` answer moves the stance. A failed GET leaves `current`
    // where it was and `known` false, so the chip keeps the blank rather than
    // painting the seed as if the agent had confirmed it.
    if (res.ok) { MODE.current = res.mode; MODE.approvalLevel = res.approvalLevel; MODE.baseLevel = res.baseLevel; MODE.known = true; }
    render();
    // The stance is process state in the agent, and the desktop restarts
    // the agent on a backend switch — so re-assert what this window last
    // chose rather than showing the boot stance as if it were the choice.
    if (res.ok && LAST_MODE && res.mode !== LAST_MODE) reassertCodingMode(LAST_MODE);
  });
}

function reassertCodingMode(id) {
  if (!BR || !id) return;
  if (S.busy) {
    // Coalesce: a second reconnect while one is queued replaces the target
    // rather than starting a second timer.
    if (MODE_REASSERT) { MODE_REASSERT.mode = id; return; }
    MODE_REASSERT = { mode: id, timer: setInterval(() => {
      if (S.busy || !MODE_REASSERT) return;
      const want = MODE_REASSERT.mode;
      clearInterval(MODE_REASSERT.timer);
      MODE_REASSERT = null;
      reassertCodingMode(want);
    }, 500) };
    return;
  }
  // A queued re-assert that is no longer the pending one would fire a second
  // POST for a stance the window has moved on from.
  cancelModeReassert();
  const seq = ++MODE.seq;
  BR.codingMode(id).then((res) => {
    // cancelModeReassert only cancels a re-assert still waiting for a turn;
    // this is the same guard for one already in flight. An explicit click
    // that landed while this POST was travelling owns the stance now, and
    // its reply is the one the chip and the diagnostics level must show.
    if (seq !== MODE.seq) return;
    if (!res || !res.ok) { if (res) MODE.supported = res.supported; render(); return; }
    MODE.supported = true; MODE.current = res.mode; MODE.known = true;
    MODE.approvalLevel = res.approvalLevel; MODE.baseLevel = res.baseLevel;
    LAST_MODE = res.mode;
    const lvl = clampLevel(res.approvalLevel);
    if (lvl !== null) {
      S.level = lvl;
      if (LIVE_CAPS && LIVE_CAPS.agent) LIVE_CAPS.agent.approvalLevel = lvl;
    }
    render();
  });
}

async function setCodingMode(id) {
  if (S.busy) { toast('Not while a turn is running'); return; }
  // An explicit click outranks anything the reconnect path is still waiting
  // to re-assert: without this a queued re-assert would land after the turn
  // ends and quietly put the stance back to what the window had before.
  cancelModeReassert();
  S.overlay = null; render();
  const seq = ++MODE.seq;
  const res = await BR.codingMode(id);
  // A later click (or a re-assert fired after this one) already owns the
  // stance: drop this reply rather than repainting the chip backwards.
  if (seq !== MODE.seq) return;
  if (!res || !res.ok) {
    MODE.supported = res ? res.supported : true;
    S.log.push({id:nid(), k:'system', text: res && res.supported === false
      ? 'coding modes need an agent build that carries /api/coding-mode'
      : 'could not change the mode: ' + esc((res && res.error) || '')});
    render();
    return;
  }
  MODE.supported = true; MODE.current = res.mode; MODE.known = true;
  MODE.approvalLevel = res.approvalLevel; MODE.baseLevel = res.baseLevel;
  LAST_MODE = res.mode;
  // The diagnostics line reads the capabilities snapshot taken at connect,
  // and the mode moves the LIVE ladder — so without this the line keeps
  // printing the boot level while the chip says otherwise.
  const lvl = clampLevel(res.approvalLevel);
  if (lvl !== null) {
    S.level = lvl;
    if (LIVE_CAPS && LIVE_CAPS.agent) LIVE_CAPS.agent.approvalLevel = lvl;
  }
  // Prefer the agent's own copy over the local table: the two are
  // identical today and this is what keeps them that way.
  const look = CODING_MODES.find((m) => m.id === res.mode);
  const summary = (res.look && res.look.summary) || (look ? look.summary : res.mode);
  S.log.push({id:nid(), k:'system', text: esc(summary)});
  render();
}

if (typeof window !== 'undefined') {
  window.__sel = () => ({open:SEL.open, kind:SEL.kind, rows:SEL.rows.length, backend:selBackend(), err:SEL.err});
  // Review fix: returns the state the caller is about to Escape out of, so a
  // check on the dismissal cannot pass on a selector that never opened.
  window.__selOpen = (kind) => { openSelector(kind); return SEL.open; };
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
  // item 6: is a turn of this session streaming into this window right now?
  const live = [...RUNNING.values()].includes(id);
  // The TUI's switchSession is a no-op ("already on session <id>") for the
  // session whose turn is running (chat-orchestrator.ts:505-515) — and here
  // reloading would throw away the streaming item the deltas land in, so the
  // reply would vanish mid-sentence.
  if (live && S.sessionId === id) { S.room = 'chat'; markSeen(id); render(); return; }
  S.sessionId = id;
  S.room = 'chat';
  S.log = [{id:nid(), k:'system', text:'loading session…'}];
  // A live turn belonging to another session keeps its own state; only the
  // window's view of "busy" is reset when nothing of this session is running.
  // Review fix: the card leaves the view with the old transcript, but the
  // request is still open at the agent — dropping it from PENDING_APPROVALS
  // here made the waiting chat's dot go empty ("read") while the agent sat
  // blocked on the gate. The map is cleared by a verdict or by the turn's own
  // terminal frame, nowhere else.
  if (!live) { S.busy = false; forgetApprovalCard(); }
  S.stick = true;
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
  // Review fix: the streaming item of a turn that is still running elsewhere
  // did not survive this reload, so no frame may position a card against it.
  S.streamId = null;
  // item 6: a turn of this session is still running, but its stream is not in
  // this log any more (the user left and came back). The desktop cannot replay
  // a stream, so it shows the stored snapshot and says what is still happening
  // — the TUI's "a turn is still running here".
  if (live) {
    S.busy = true;
    S.log.push({id:nid(), k:'system', text:'a turn is still running here — the reply lands when it finishes'});
  }
  // Anything sent from here continues that session rather than starting a new one.
  S.agentSession = id;
  S.history = [];
  markSeen(id);   // item 6: opening a chat is reading it
  noteSessionModelStamp(data);
  render();
  refreshContext();
  // Item 7C review fix: the GET leg of the steer route. The
  // `steer_undelivered` SSE frame only reaches a window that was attached
  // to the turn; a reconnect, an agent restart or a session opened after
  // the fact leaves messages the route already said yes to parked on the
  // server forever. Skipped for a turn this window IS streaming — the
  // frame will carry those, and both paths acking would double-queue.
  if (!live) recoverParkedSteers(id);
  // item 4: durations come from the agent's trace; repaint only if this transcript is still up.
  const shown = S.log;
  applyTraceDurations().then((changed) => { if (changed && S.log === shown) render(); });
  // item 5: the session's own cwd resolves any relative path the write tools took.
  const sessionCwd = typeof data.workingDir === 'string' ? data.workingDir : null;
  refreshAttachments(sessionCwd).then((changed) => { if (changed && S.log === shown) render(); });
}

/**
 * Item 7C — what a turn accepted and never read, recovered by the GET.
 *
 * `GET /api/sessions/{id}/steer` is the server's parked store; the DELETE
 * is its mandatory partner, or the store accumulates. Same treatment as
 * the `steer_undelivered` frame: to the FRONT of the queue, because
 * `steer` already answered "yes" to whoever sent them and they are
 * corrections aimed at the turn that just ran.
 *
 * Silent when there is nothing parked, and silent on any error — this is
 * a recovery path, not something the operator asked for, and a 404 on an
 * agent older than 0.5.5 must not print in the transcript.
 */
async function recoverParkedSteers(id, probe) {
  // `probe` injects the two bridge calls so the recovery BODY — the
  // unshift, the watermark, the line and the mandatory DELETE — can be
  // asserted; a live agent almost never has anything parked, so the
  // check over the real route only ever proved the empty case.
  const fetchParked = probe ? probe.fetch : (BR && BR.undeliveredSteers ? (sid) => BR.undeliveredSteers(sid) : null);
  if (!fetchParked || !id) return;
  const res = await fetchParked(id);
  if (!res || !res.ok || !res.data) return;
  if (S.agentSession !== id) return;   // the user moved on while this was in flight
  const list = Array.isArray(res.data.undelivered) ? res.data.undelivered : [];
  const discarded = Number(res.data.discarded) || 0;
  STEER.recovery = {id, parked:list.length, discarded};
  if (!list.length && !discarded) return;
  /* Review fix: `discarded` is the count of steers this route ACCEPTED —
     the window printed "steering the running turn" for each of them — and
     then evicted when the session's parked store overflowed. It was carried
     into the DELETE and never mentioned, so with nothing left parked the ack
     went out in silence. Same argument as the parked ones: dropping it would
     lose something the user watched being accepted. */
  if (discarded) {
    S.log.push({id:nid(), k:'system', note:true, text: discarded + ' earlier message'
      + (discarded === 1 ? ' was' : 's were') + ' accepted for this session and then dropped by the agent'
      + ' before the turn read ' + (discarded === 1 ? 'it' : 'them') + ' — its parked store overflowed'});
  }
  if (list.length) {
    S.queued.unshift.apply(S.queued, list.map((u) => String((u && u.text) || '')));
    STEER.ahead += list.length;
    S.log.push({id:nid(), k:'system', note:true, text: list.length + ' message' + (list.length === 1 ? '' : 's')
      + ' arrived too late for the last turn here — sending ' + (list.length === 1 ? 'it' : 'them') + ' next'});
  }
  const seq = list.reduce((max, u) => Math.max(max, (u && Number(u.seq)) || 0), 0);
  const ack = probe ? probe.ack : (BR && BR.ackSteers ? (sid, q, d) => BR.ackSteers(sid, q, d) : null);
  if (ack) await ack(id, seq, discarded);
  render();
}

/**
 * Item 7C — the model this session last ran on.
 *
 * v0.5.5 stamps `metadata.llm = {providerId, chatModel}` on every turn
 * and serves it on the session row, which openSession already fetches.
 * The TUI re-applies it on switch; this window cannot. `atag serve` pins
 * its provider at boot, so applying a stamp costs a config write plus a
 * child restart — and a restart kills any turn running in another chat.
 *
 * So: show the stamp, offer the switch, never take it. The offer is
 * refused outright while anything is running, exactly as the composer's
 * backend chip refuses.
 */
function noteSessionModelStamp(data) {
  CTX055.stamp = null;
  const stamp = data && data.metadata && data.metadata.llm;
  if (!stamp || typeof stamp.providerId !== 'string' || !stamp.providerId) return;
  const model = typeof stamp.chatModel === 'string' && stamp.chatModel ? stamp.chatModel : null;
  const liveProvider = selActiveProviderId() || '';
  /* Review fix: compare what the AGENT compares. 0.5.5's planModelRestore
     tests `turn.chatModel === (provider.defaultChatModel ?? provider.model)`
     — the FULL id off the provider entry. The old comparison used
     activeModel() (a display label, blank on an external route) and
     matched on the basename only, so `openai/gpt-4.1` and `azure/gpt-4.1`
     read as the same model and a real difference was suppressed. */
  const liveEntry = llmProvider(liveProvider);
  const liveModel = liveEntry ? (liveEntry.defaultChatModel || liveEntry.model || '') : '';
  const shownModel = activeModel() || liveModel;   // the display label stays the chip's
  if (stamp.providerId === liveProvider && (!model || sameModelId(model, liveModel))) return;
  const known = llmProviders().some((p) => p.id === stamp.providerId);
  const label = stamp.providerId + (model ? '/' + model : '');
  if (!known) {
    // The TUI's own sentence for a stamp whose provider has since been
    // deleted (session-model-restore.ts describeModelRestore in 0.5.5).
    S.log.push({id:nid(), k:'system', note:true, text: esc('this session last ran on "' + label + '", which is no longer configured — keeping the current model')});
    return;
  }
  CTX055.stamp = {providerId: stamp.providerId, chatModel: model};
  // `note:true` (see endMarkIds): this row is appended to a REPLAYED
  // transcript whose last turn finished long ago, so it must not take that
  // turn's full stop away.
  S.log.push({id:nid(), k:'system', note:true, text: esc('this session ran on ' + label + ' — the window is on ' + (liveProvider || 'no provider') + (shownModel ? '/' + shownModel : ''))
    + ' <button class="btn btn-s" style="height:22px" data-act="sessmodel:apply">Switch to it</button>'
    + ' <span class="ter">(a switch restarts the agent, so it is refused while any turn is running)</span>'});
}
/* Full-id comparison, matching 0.5.5's planModelRestore
   (`turn.chatModel === (provider.defaultChatModel ?? provider.model)`).
   Case and surrounding whitespace are normalised because config values
   are typed by hand; the vendor prefix is NOT dropped — `openai/gpt-4.1`
   and `azure/gpt-4.1` are different models to the agent, and collapsing
   them hid a real difference. */
function sameModelId(a, b) {
  const norm = (x) => String(x || '').trim().toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}
async function applySessionModelStamp() {
  const stamp = CTX055.stamp;
  if (!stamp || !BR) return;
  // Not "if S.busy": a restart aborts every turn this process is
  // streaming, including ones in chats the user is not looking at.
  if (RUNNING.size > 0 || S.busy) { toast('Not while a turn is running'); return; }
  // A local route has no cloud model to pick: `selectCloudModel` writes
  // defaultChatModel on the provider entry, which llama-server ignores.
  const entry = llmProvider(stamp.providerId);
  const cloud = !!entry && entry.kind !== 'llama-server';
  const res = cloud && stamp.chatModel && BR.selectCloudModel
    ? await BR.selectCloudModel(stamp.providerId, stamp.chatModel)
    : await BR.activateProvider(stamp.providerId);
  if (!res || res.ok === false) { toast('Could not switch', (res && res.error) || ''); return; }
  bswReport(res);
  CTX055.stamp = null;
  await refreshLiveConfig();
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
  /* r5 item 7: the setup wizard mounts this same wizard inside its cloud
     step, where `closeSelector()` would close a popup that is not open
     and drop the flow on a blank screen. The reducer's own
     `providers_wizard_succeeded` branch decides where it goes next. */
  if (OB.open && OB.step === 'cloud') {
    OB.restarted = !!(sel && sel.restart);
    toast('Provider added', k.label.split(' (')[0] + ' \u00b7 ' + model);
    obDispatch({type:'providers_wizard_succeeded'});
    return;
  }
  closeSelector();
  toast('Provider added', k.label.split(' (')[0] + ' \u00b7 ' + model);
}


/* r4-ui item 3: which item carries the agent's full stop.
   A TURN is the span of S.log from one k:'user' item to the next, so this
   works identically for a live stream and for a session replayed from
   GET /api/sessions/{id}. The mark goes on the span's LAST item, and only
   when that item is a non-empty assistant reply:
     - last ITEM, not last assistant, so a reopened multi-step turn that
       stored its reply before further tool calls does not float a full stop
       above the cards it is supposed to close. On the live path the two rules
       are identical anyway — tool and reasoning rows splice in AHEAD of the
       streaming item;
     - non-empty, because startLiveTurn pushes an empty assistant item before
       the first delta arrives, so a turn aborted or failed before any text
       would otherwise get a bare dot under an empty prose block.
   The TAIL span gets nothing while S.busy or S.pending: that covers the item
   still streaming, a turn blocked on an approval, and a session reopened while
   its turn runs elsewhere. 0.5.5 exposes no turn controller, so a turn running
   under another origin has no stream here and no mark — the same honest limit
   the pulsating sidebar dot already carries. A turn that ends with a system
   row (abort, "turn failed") gets no mark either, which is right: nothing
   says the whole process finished.
   Review fix: NOT every system row says that. A handful are notices ABOUT the
   session rather than about the turn — the model stamp openSession appends
   after replaying a stored transcript, the parked-steer recovery, the
   `steer_undelivered` ack — and they are pushed after a turn that really did
   finish. Left counted, they silently deleted the full stop of the last
   completed turn, which is the one turn the operator is looking at. Those
   rows carry `note:true` and are stepped over here; an abort or a failure
   carries no such flag and still suppresses the mark. */
function endMarkIds() {
  const segs = [[]];
  S.log.forEach((m) => { if (m.k === 'user') segs.push([]); segs[segs.length - 1].push(m); });
  const ids = new Set();
  segs.forEach((seg, i) => {
    if (!seg.length) return;
    if (i === segs.length - 1 && (S.busy || S.pending)) return;
    let at = seg.length - 1;
    while (at >= 0 && seg[at].k === 'system' && seg[at].note) at--;
    const last = at >= 0 ? seg[at] : null;
    if (last && last.k === 'assistant' && String(last.text || '').trim()) ids.add(last.id);
  });
  return ids;
}

/** The transcript, with runs of the same tool folded into one line. */
function renderItems() {
  const items = S.log; let html = '';
  const end = endMarkIds();
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    if (m.k === 'tool') {
      let j = i; while (j + 1 < items.length && items[j + 1].k === 'tool' && items[j + 1].name === m.name) j++;
      const run = items.slice(i, j + 1);
      if (run.length >= 3 && !OPEN_GROUPS.has(m.id)) { html += groupCard(run); i = j; continue; }
    }
    html += item(m, end.has(m.id));
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
      card.forced = false;   // the store answered after all: this card's status is known
    }
  }
  // Whatever the store still does not describe is finished, just unmeasured.
  // item 5 review fix: `forced` records that this card's status was never
  // learned — reconciliation gave up. cardWrittenPaths refuses such a card, so
  // a write whose outcome the store never confirmed cannot produce a
  // "Saved to" line from a stat that only proves the file is there NOW.
  pendingCards.forEach((c) => { if (c.ok === null) { c.ok = true; c.forced = true; c.out = c.out || ''; } });
  await applyTraceDurations();   // item 4: live cards flip from observed wall time to the agent's number
  // item 5: the store is the only place the write tools' args and result lines
  // come from after a live turn, so the attachment strip is built here.
  await refreshAttachments();
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
    // Review fix: the skip still WALKS the cursor past the row that card would have
    // taken (below), because leaving `k` behind let a byte-identical retry after the
    // interrupt take the interrupted call's row and print it as its own measurement.
    const unresolved = card.ok === null;
    if (unresolved && card.startedAt) break;
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
    if (unresolved) continue;                        // its row is consumed, but nothing is claimed for it
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
  if (!e.target.closest) return;
  // item 6: Pin/Unpin · Delete… on a chat row, as a native menu.
  const row = e.target.closest('[data-ses]');
  if (row && BR && BR.sessionMenu) {
    e.preventDefault();
    BR.sessionMenu(row.dataset.ses, PREFS.pinned.includes(row.dataset.ses));
    return;
  }
  const f = e.target.closest('[data-file]');
  if (!f || !BR) return;
  e.preventDefault();
  BR.fileMenu(f.dataset.file.replace(/^~/, homeDir() || '~'));
});

/* ============================================================
   Item 5 — file attachments: "Saved to <path>" under the reply.

   The user asked for it in these words: "When the agent has built
   something, it should say that it saved to /path/to/file and have the
   clickable icon with the filename on top of the message or at the bottom
   of the message". Bottom was chosen of the two he allowed, so the reply's
   first line stays where the eye lands and the strip reads as a mail
   client's attachment footer. The wording is his, literally, one line per
   file — the TUI has no post-turn "saved files" surface at all (a write is
   only ever a tool card, src/tui/components/tool-card.tsx), so there is no
   TUI copy to follow here.

   Provenance rule: a path is only ever labelled "Saved to" when a write
   tool in this same turn said it wrote it, and only after fs.stat confirms
   the file is there. Paths the reply merely mentions stay inline chips.
   ============================================================ */

/** A card's args as an object: live cards carry the 120-char stream label
    (JSON.parse fails on a clipped one → no chip, which is honest), the store
    and loaded sessions carry the real thing. */
function cardArgs(m) {
  const a = m.args || m.arg;
  if (a && typeof a === 'object') return a;
  if (typeof a === 'string') { try { return JSON.parse(a); } catch (e) { return null; } }
  return null;
}

/** Resolved the way the agent resolves it (src/tools/os/expand-home.ts
    resolveUserPath): `~` kept for main to expand, absolute kept, relative
    against the session's — or serve's — cwd. */
function resolveAgentPath(p, cwd) {
  if (!p || typeof p !== 'string') return null;
  if (p === '~' || p.startsWith('~/')) return p;
  if (p.startsWith('/')) return p;
  const base = String(cwd || (S.live && S.live.workingDir) || '').replace(/\/+$/, '');
  if (!base) return null;
  return base + '/' + p.replace(/^\.\//, '');
}

/** Files a tool card wrote — the agent's own result line first, its args
    second. Only ok cards, only the four write tools. */
function cardWrittenPaths(m, cwd) {
  if (m.k !== 'tool' || m.ok !== true || m.forced || !WRITE_TOOLS.has(m.name)) return [];
  const a = cardArgs(m) || {};
  const out = String(m.out || '');
  if (m.name === 'os.fs.write') {
    // fs-write.ts: `wrote N bytes to <abs> (replace|append)`, possibly followed
    // by "; the operator moved this write from <abs>" — the lazy group stops at
    // the first ` (replace)`, so a TUI-side retarget still yields the real target.
    const hit = out.match(/^wrote \d+ bytes to (.+?) \((?:replace|append)\)/m);
    return [resolveAgentPath(hit ? hit[1] : a.path, cwd)];
  }
  if (m.name === 'os.fs.edit') return [resolveAgentPath(a.path, cwd)];   // result is the diff; the path is in args
  if (m.name === 'os.fs.patch') {
    // Dry runs write nothing, and a refused apply landed nothing.
    if (a.apply !== true || !/^patch applied:/m.test(out)) return [];
    const root = resolveAgentPath(a.rootDir, cwd) || cwd || (S.live && S.live.workingDir) || '';
    // fs-patch.ts prints `  ✓ <rel>  +A/-R` per file, relative to rootDir.
    return Array.from(out.matchAll(/^\s*✓ (.+?)\s{2}\+\d+\/-\d+/gm)).map((h) => resolveAgentPath(h[1], root));
  }
  if (m.name === 'os.fs.archive.extract') {
    const hit = out.match(/^extracted \d+ entries \(\d+ bytes\) to (.+)$/m);
    return [resolveAgentPath(hit ? hit[1] : a.destDir, cwd)];
  }
  return [];
}

/** Paths an ok os.fs.trash card named (args.paths / args.path), resolved the
    same way. Not a write tool — this is the delete side, read below only to
    expire a strip whose file has since gone. */
function cardTrashedPaths(m, cwd) {
  if (m.k !== 'tool' || m.ok !== true || m.name !== 'os.fs.trash') return [];
  const a = cardArgs(m) || {};
  const raw = Array.isArray(a.paths) ? a.paths : (a.path ? [a.path] : []);
  return raw.map((p) => resolveAgentPath(p, cwd)).filter(Boolean);
}

/** Every path the write tools of this assistant item's turn reported. The
    reply text is deliberately not read: a file the turn only mentioned is
    not a file the turn saved. */
function turnFilePaths(assistantItem, cwd) {
  const idx = S.log.indexOf(assistantItem);
  if (idx < 0) return [];
  const paths = [];
  for (let i = idx - 1; i >= 0 && S.log[i].k !== 'user'; i--) paths.push.apply(paths, cardWrittenPaths(S.log[i], cwd));
  return Array.from(new Set(paths.filter(Boolean)));
}

/** Verify with fs.stat and cache on the item, so re-renders are stable.
    Called from reconcileToolCards and openSession — never from render(),
    which is synchronous and runs on every keystroke. */
async function refreshAttachments(cwd) {
  if (!BR || !BR.statPaths) return false;
  let changed = false;
  const trashed = new Set();
  for (const m of S.log) for (const p of cardTrashedPaths(m, cwd)) trashed.add(p);
  for (const m of S.log) {
    if (m.k !== 'assistant') continue;
    if (m.id === S.streamId && S.busy) continue;            // still streaming; its cards are not reconciled yet
    const paths = turnFilePaths(m, cwd);
    // item 5 review fix: the signature also carries the attached paths that a
    // LATER os.fs.trash card has named. Without it the cache never re-stated
    // them, and a strip kept saying "Saved to <path>" for a file the agent had
    // since moved to the Trash — the one state the strip could hold that the
    // filesystem no longer backs.
    const gone = paths.filter((p) => trashed.has(p));
    const sig = paths.join('\n') + (gone.length ? '\u0000trashed:' + gone.join('\n') : '');
    if (sig === m.attachSig) continue;
    m.attachSig = sig;
    if (!paths.length) { if ((m.attach || []).length) changed = true; m.attach = []; continue; }
    const found = [], seen = new Set();
    for (let i = 0; i < paths.length; i += ATTACH_STAT_CHUNK) {
      const r = await BR.statPaths(paths.slice(i, i + ATTACH_STAT_CHUNK));
      const files = (r && r.ok && Array.isArray(r.files)) ? r.files : [];
      for (const f of files) {
        if (!f.exists || seen.has(f.path)) continue;
        seen.add(f.path);
        found.push({path:f.path, name:f.path.split('/').pop() || f.path, kind:f.kind});
      }
    }
    m.attach = found;
    changed = true;
  }
  return changed;
}

/** The attachment footer: his sentence per file, then the chips. */
function attachStrip(m) {
  const files = m.attach || [];
  if (!files.length) return '';
  const shown = files.slice(0, ATTACH_MAX_LINES);
  const lines = shown.map((f) => '<div class="attach-label">Saved to <span class="mono">' + esc(f.path) + '</span></div>').join('')
    + (files.length > shown.length ? '<div class="attach-label attach-more">…and ' + (files.length - shown.length) + ' more</div>' : '');
  // The chips are the existing .filechip with an absolute data-file, so the
  // existing click (BR.openPath) and contextmenu (BR.fileMenu) handlers work
  // unchanged; a directory opens in Finder, which is its native viewer.
  return '<div class="attach" data-attach="' + esc(m.id) + '">' + lines + '<div class="attach-chips">'
    + files.map((f) => '<button class="filechip" data-file="' + esc(f.path) + '" title="' + esc(f.path) + '">'
        + ic(f.kind === 'dir' ? 'folder' : 'doc') + '<span>' + esc(f.name) + '</span></button>').join('')
    + '</div></div>';
}


/* Hooks for --smoke. */
if (typeof window !== 'undefined') {
  window.__modeState = () => ({supported:MODE.supported, current:MODE.current,
    approvalLevel:MODE.approvalLevel, baseLevel:MODE.baseLevel, known:MODE.known});
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
  // item 5: counts the chips renderProse made, not the attachment strip's — the
  // strip is a separate surface and must not skew this check.
  window.__pushAssistant = (t) => { S.log.push({id:nid(), k:'assistant', text:t}); render(); return document.querySelectorAll('.prose .filechip').length; };
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
  // `which` names one group (review fix: the fixture's own run, not whichever
  // group happens to be first in the DOM); omitted, it takes the first.
  window.__unfoldGroup = (which) => {
    const g = which ? document.querySelector('[data-group="' + which + '"]') : document.querySelector('[data-group]');
    const sc = $('#scroller'); if (!g || !sc) return null;
    const id = g.dataset.group; sc.scrollTop += g.getBoundingClientRect().top - sc.getBoundingClientRect().top - 120;
    // the hook's own scrollTop write happens BEFORE `before` is measured, so the assertion isolates the click
    const before = g.getBoundingClientRect().top, scrollBefore = sc.scrollTop;
    const cardsBefore = document.querySelectorAll('.card').length, groupsBefore = document.querySelectorAll('[data-group]').length;
    g.click();                        // [data-group] branch → expandGroupInPlace
    const h = document.querySelector('#turn-' + id + ' .cardhead');
    return {id, members:OPEN_GROUPS.has(id), headBefore:before, headAfter:h ? h.getBoundingClientRect().top : NaN, scrollBefore, scrollAfter:sc.scrollTop,
            cardsBefore, cardsAfter:document.querySelectorAll('.card').length,
            groupsBefore, groupsAfter:document.querySelectorAll('[data-group]').length};
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
    // .cardsum is the COLLAPSED card's summary line — measured here since it is
    // one of the three min-content contributors the wrap rules had to defeat.
    const els = Array.from(document.querySelectorAll('.card,.prose,.cardbody pre,.appr,.cardsum'));
    // r4-ui item 3: a user row is `display:block` now (the bubble), so its
    // gridTemplateColumns is "none" and would read back NaN. Only the rows that
    // still use the 28px/1fr grid can answer for the track.
    const turn = document.querySelector('.turn:not(.usr)');
    const track = turn ? parseFloat(getComputedStyle(turn).gridTemplateColumns.split(' ')[1]) : 0;
    return {sw: sc ? sc.scrollWidth : 0, cw: sc ? sc.clientWidth : 0,
            colRight: col ? Math.round(col.getBoundingClientRect().right) : 0, colWidth: col ? col.clientWidth : 0, track,
            maxRight: Math.round(Math.max(0, ...els.map((c) => c.getBoundingClientRect().right))),
            sums: Array.from(document.querySelectorAll('.cardsum')).map((n) => Math.round(n.getBoundingClientRect().right)),
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
  if (selLocalRoute() && !SEL.localBusy && !SEL.pulling) bswSnapshot();
}
/** The catalogue snapshot (`atag models list`): what is on disk, which is active. Resolves either way. */
function bswSnapshot() {
  if (!BR) return Promise.resolve();
  return BR.chatModelsList().then((res) => {
    if (!(res && res.ok)) return;
    const was = JSON.stringify([BSW.localLoaded, SEL.local]);
    SEL.local = res.models; BSW.localLoaded = true;
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
  if (line === null) {
    /* r5 item 7: the setup wizard's download is no longer a log tail on a
       wizard screen — it is the #dlbar strip, driven by parsed samples. So
       the figures come off that slice rather than off a line, and they are
       the same numbers for the same reason. */
    const job = DL.job;
    if (job && job.kind !== 'runtime' && job.id === modelId) {
      return job.totalBytes > 0
        ? 'downloading now — ' + Math.round(job.percent || 0) + '% · '
          + dlBytes(job.transferredBytes) + ' / ' + dlBytes(job.totalBytes)
        : 'downloading now…';
    }
    return null;
  }
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
  /* The model id the AGENT compares a session stamp against —
     `provider.defaultChatModel ?? provider.model`, not the chip's display
     label (item 7C review fix). */
  window.__activeProviderModel = () => {
    const p = llmProvider(selActiveProviderId());
    return p ? (p.defaultChatModel || p.model || '') : '';
  };
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
    // The sidebar's Tasks list reads TASKS; keep it in step with what the tab shows.
    TASKS_ERR = null;
    applyTasks(res.data.tasks);
    renderSidebar();
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
/** item 6: a sidebar task row lands on that task in the Tasks tab. */
function tkFocusTask(id) {
  if (TK.rows.some((r) => r.id === id)) { tasksAct('detail:' + id); return; }
  // The tab's own snapshot has not landed yet; take it, then open the row.
  Promise.resolve(tasksRefresh(true)).then(() => { if (TK.rows.some((r) => r.id === id)) tasksAct('detail:' + id); });
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
  // Item 7 part B: the Skills / Memory / MCP tabs' own keys come first, as the Tasks tab's do.
  if (pane === 'skills' && skillsKey(e, k, inText)) return true;
  if (pane === 'memory' && memoryKey(e, k, inText)) return true;
  if (pane === 'mcp' && mcpKey(e, k, inText)) return true;
  // Item 7 part C: the LLM / Telegram / Import tabs' keys (the LLM pane's ←/→ switch its mode, not the tab).
  if (pane === 'llm' && llmKey(e, k, inText)) return true;
  if (pane === 'telegram' && telegramKey(e, k, inText)) return true;
  if (pane === 'import' && importKey(e, k, inText)) return true;
  if (k === 'Escape') { e.preventDefault(); S.settings = null; render(); return true; }
  if (inText) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  // The open create form owns its keys even when focus sits on one of its
  // buttons: no tab cycling behind a half-filled form (the TUI's Esc closes
  // the form first, and so does this window's).
  if (pane === 'tasks' && TK.mode === 'create') return false;
  if (pane === 'mcp' && MCP.addModal) return false; // Item 7 part B: the add-server modal owns its keys too
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
  window.__menuActivate = (id) => { menuActivate(id); return {settings: !!S.settings, pane: S.settings ? settingsPaneId(S.settingsPane) : null, inspector: S.inspector, inspTab: S.inspTab, overlay: S.overlay}; };
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

/* ============================================================
   Item 7 part B — the Skills, Memory and MCP tabs
   ============================================================ */

/* The settings body (or the room wrapper when the same tab is open as a
   room). Repaint it in place and keep the focus on the button (by its
   data-act) the user was on; with nothing focused a full render() also
   refreshes the tab suffix and the sidebar counts. */
function paneBox() {
  return S.settings ? document.querySelector('#settings .setbody') : document.querySelector('#content .tuiwrap');
}
function paneRepaintKeepFocus(html) {
  const box = paneBox();
  if (!box) { render(); return; }
  const el = document.activeElement;
  const focused = el && box.contains(el) && el.dataset ? el.dataset.act : null;
  if (!focused) { render(); return; }
  box.innerHTML = html;
  const again = box.querySelector('[data-act="' + focused.replace(/"/g, '\\"') + '"]');
  if (again) again.focus();
}
function tuiTrunc(text, max) { text = String(text == null ? '' : text); return text.length <= max ? text : text.slice(0, max - 1) + '…'; }
/* Body lines as the TUI's renderBody draws them (an empty line keeps its height). */
function tuiBodyLines(lines) {
  return '<div class="tuibody">' + lines.map((l) => '<div>' + (l.length ? esc(l) : ' ') + '</div>').join('') + '</div>';
}
function tuiBtn(label, act, opts) {
  return '<button data-act="' + esc(act) + '"' + (opts && opts.disabled ? ' disabled' : '') + (opts && opts.cls ? ' class="' + opts.cls + '"' : '') + (opts && opts.title ? ' title="' + esc(opts.title) + '"' : '') + '>' + esc(label) + '</button>';
}
function tuiHints(parts) {
  return '<div class="tuihint">' + parts.map((p, i) => (i ? '<span>·</span>' : '') + (typeof p === 'string' ? '<span>' + esc(p) + '</span>' : tuiBtn(p[0], p[1], p[2]))).join('') + '</div>';
}
function restartLine(text) {
  return '<div class="tuimsg">' + esc(text) + ' <span class="ter">(applies to the running agent after Restart Agent Runtime)</span> '
    + '<button class="btn btn-s" data-act="agent:restart" style="height:22px">Restart Agent Runtime</button></div>';
}

/* ---------------- Skills tab (skills-panel.tsx, skills-list.tsx, skills-detail.tsx,
   skills-hub-list.tsx, skills-hub-card.tsx, skills-install-confirm.tsx,
   skills-remove-confirm.tsx, skills-orchestrator.ts) ---------------- */

function skpVisibleRows() {
  const f = SKP.filter;
  return (SK.rows || []).filter((r) => f === 'all' ? true : f === 'enabled' ? r.enabled : !r.enabled)
    .slice().sort((a, b) => (a.enabled === b.enabled ? a.name.localeCompare(b.name) : a.enabled ? -1 : 1)); // skills-filter.ts compareSkillRows
}
function skpSelected() {
  const rows = skpVisibleRows();
  if (!rows.length) return null;
  return rows[Math.max(0, Math.min(SKP.cursor, rows.length - 1))];
}
function skillsVisible() {
  return (S.settings && settingsPaneId(S.settingsPane) === 'skills') || (!S.settings && S.room === 'skills');
}
function skpTyping() { const el = document.activeElement; return !!el && el.id === 'skp-hubq'; }
/* skills-orchestrator.ts refreshes every 5 000 ms while the tab is open.
   Here every refresh is an `atag skill list` subprocess, so the timer runs
   only while the tab is visible, restarts on every entry (the first tick is
   5 s after entering, never on the click) and stops while a detail, the
   hub or a modal is open. `a auto` turns it off. */
function ensureSkillsPoll() {
  if (!BR || SKP.timer) return;
  SKP.timer = setInterval(() => {
    if (!skillsVisible()) { clearInterval(SKP.timer); SKP.timer = null; return; }
    if (SKP.auto && SKP.mode === 'list' && !SKP.removeConfirm && !SKP.busy) refreshSkillList();
  }, 5000);
}
function skillsTabEntered() {
  if (SKP.timer) { clearInterval(SKP.timer); SKP.timer = null; }
  ensureSkillsPoll();
}
function skpRender() { paneRepaintKeepFocus(skillsTab()); }
/* `atag skill list` again after a mutation — behind any poll already in flight, never dropped by its SK.busy guard. */
async function skpReloadRows() {
  const deadline = Date.now() + 60000;
  while (SK.busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  await refreshSkillList();
}

function skillsTab() {
  ensureSkillsPoll();
  if (SKP.installConfirm) return '<div class="tui">' + skpInstallConfirmHTML() + '</div>';
  if (SKP.removeConfirm) return '<div class="tui">' + skpRemoveConfirmHTML() + '</div>';
  if (SKP.hubCard) return '<div class="tui">' + skpHubCardHTML() + '</div>';
  if (SKP.mode === 'hub') {
    if (SKP.hubCardLoading) return '<div class="tui"><div class="ter" style="padding:10px 0">loading skill card…</div></div>';
    return '<div class="tui">' + skpHubListHTML() + '</div>';
  }
  const rows = SK.rows || [];
  const visible = skpVisibleRows();
  const enabledCount = rows.filter((r) => r.enabled).length;
  // FilterBar: `filter: all · enabled · disabled   N shown · E enabled · D disabled · auto · …   built-in tools: /tools`
  const bar = '<div class="tuibar"><span class="ter">filter: </span>'
    + SKP_FILTERS.map((f, i) => (i ? '<span class="ter"> · </span>' : '') + '<button class="skpf' + (f === SKP.filter ? ' on' : '') + '" data-act="skills:filter:' + f + '">' + f + '</button>').join('')
    + '<span class="ter">   ' + visible.length + ' shown · ' + enabledCount + ' enabled · ' + (rows.length - enabledCount) + ' disabled'
    + (SKP.auto ? ' · auto' : '') + (SK.busy ? ' · …' : '') + '   built-in tools: </span><button class="skpf" data-act="menu:help.tools">/tools</button></div>';
  return '<div class="tui">' + bar
    + (SKP.lastError ? '<div class="tuierr">! ' + esc(SKP.lastError) + '</div>' : '')
    + (SK.err ? '<div class="tuierr">! ' + esc(SK.err) + '</div>' : '')
    + skpMessages()
    + (SKP.mode === 'detail' ? skpDetailHTML() : skpListHTML(visible)) + '</div>';
}
function skpMessages() {
  if (!SKP.msg) return '';
  return SKP.msg.restart ? restartLine(SKP.msg.text) : '<div class="tuimsg">' + esc(SKP.msg.text) + '</div>';
}
function skpListHTML(visible) {
  if (!SK.rows && !SK.err) return '<div class="ter" style="padding:10px 0">loading skill list…</div>';
  if (!visible.length) {
    return '<div class="ter" style="padding:10px 0">no skills match the current filter — install one with `atomic-agent skill install`, or press `f` to cycle filter / `r` to refresh.</div>'
      + skpHintsHTML() + skpHubCtaHTML();
  }
  const cur = Math.max(0, Math.min(SKP.cursor, visible.length - 1));
  const start = computeWindowStart(cur, visible.length, SKP_MAX_ROWS);
  const page = visible.slice(start, start + SKP_MAX_ROWS);
  const hiddenBefore = start;
  const hiddenAfter = Math.max(0, visible.length - start - page.length);
  return '<div class="tuihead">  state     source   version  name                       description</div>'
    + (hiddenBefore > 0 ? '<button class="tuimore" data-act="skills:page:up">↑ ' + hiddenBefore + ' above</button>' : '')
    + page.map((r, idx) => {
      const i = idx + start, sel = i === cur;
      // SkillRow: `{chevron} {state(9)}` `{[source](9)} {v(8)}` `{name(26)}` `{description(60)}`
      return '<button class="tuirow' + (sel ? ' on' : '') + (r.enabled ? '' : ' dim') + '" data-skill-row="' + esc(r.name) + '" data-act="skills:detail:' + esc(r.name) + '">'
        + (sel ? '▸' : ' ') + ' <span class="' + (r.enabled ? 'sk-on' : 'sk-off') + '">' + (r.enabled ? 'enabled' : 'disabled').padEnd(9) + '</span>'
        + '<span class="ter">' + esc(('[' + r.source + ']').padEnd(9) + ' ' + ('v' + r.version).padEnd(8)) + '</span>'
        + esc(tuiTrunc(r.name, 24).padEnd(26)) + '<span class="' + (r.enabled ? '' : 'ter') + '">' + esc(tuiTrunc(r.description, 60)) + '</span></button>';
    }).join('')
    + (hiddenAfter > 0 ? '<button class="tuimore" data-act="skills:page:down">↓ ' + hiddenAfter + ' below</button>' : '')
    + skpHintsHTML() + skpHubCtaHTML();
}
function skpHintsHTML() {
  return tuiHints(['j/k move', ['Enter detail', 'skills:detail'], ['e toggle', 'skills:toggle'], ['d remove', 'skills:remove'],
    ['r refresh', 'skills:refresh'], ['a auto', 'skills:auto'], ['f filter', 'skills:filter']]);
}
function skpHubCtaHTML() {
  return '<button class="tuimodal skphub" data-act="skills:hub"><b>i</b><span class="skpaccent"> · Skills Hub</span><span class="ter">  browse &amp; install skills from ClawHub</span></button>';
}
function skpDetailHTML() {
  const name = SKP.detailName;
  if (!name) return '<div class="ter" style="padding:10px 0">(no skill selected)</div>';
  const row = (SK.rows || []).find((r) => r.name === name);
  const enabled = row ? row.enabled : true;
  let body;
  if (SKP.detailBody === null) body = '<div class="ter">(loading…)</div>';
  else {
    const lines = SKP.detailBody.split('\n');
    const hidden = lines.length - SKP_DETAIL_LINES;
    body = tuiBodyLines(lines.slice(0, SKP_DETAIL_LINES))
      + (hidden > 0 ? '<div class="ter">… (' + hidden + ' more line' + (hidden === 1 ? '' : 's') + ' hidden)</div>' : '');
  }
  return '<div style="margin-top:6px"><b>' + esc(name) + '</b><span class="ter">  </span><span class="' + (enabled ? 'sk-on' : 'sk-off') + '">' + (enabled ? 'enabled' : 'disabled') + '</span>'
    + (row ? '<span class="ter">  [' + esc(row.source) + '] v' + esc(row.version) + '</span>' : '') + '</div>'
    + (row && row.description ? '<div class="ter" style="margin-top:8px">' + esc(row.description) + '</div>' : '')
    + '<div style="margin-top:8px">' + body + '</div>'
    + tuiHints([['Esc back', 'skills:back'], ['e toggle', 'skills:toggle:' + name], ['r refresh', 'skills:refresh']]);
}
function skpRemoveConfirmHTML() {
  const c = SKP.removeConfirm;
  return '<div class="tuimodal danger"><b style="color:var(--danger)">Remove skill</b>'
    + '<div class="ter">delete global skill ' + esc(c.name) + '?</div>'
    // skills-remove-confirm.tsx warns when the skill is a bundled starter; listStarterSkillNames is not exposed by the agent, so the check cannot run here.
    + '<div class="ter" style="margin-top:8px">(bundled-starter check unavailable)</div>'
    + (c.error ? '<div class="tuierr" style="margin-top:8px">! ' + esc(c.error) + '</div>' : '')
    + (c.submitting ? '<div class="ter" style="margin-top:8px">removing…</div>'
        : tuiHints([['[y] delete', 'skills:removeConfirm'], ['[n] cancel', 'skills:removeCancel']])) + '</div>';
}
function skpInstallConfirmHTML() {
  const c = SKP.installConfirm;
  return '<div class="tuimodal danger"><b style="color:var(--danger)">Security scan: ' + esc(String(c.verdict).toUpperCase()) + '</b>'
    + '<div class="ter">install ' + esc(c.identifier) + '?</div>'
    // The TUI lists the scan findings (`[rule] file:line excerpt`); `atag skill install` prints only its blocked line, shown plainly — no invented rule id in the finding slot.
    + '<div style="margin-top:8px" class="tuierr">' + esc(c.message) + '</div>'
    + '<div class="ter">(findings are not printed by `atag skill install` — the verdict line above is all the CLI reports)</div>'
    + (SKP.installing ? '<div class="ter" style="margin-top:8px">installing…</div>'
        : '<div class="tuihint">' + tuiBtn('[y] install anyway (risk acknowledged)', 'skills:installAck') + '<span>  </span>' + tuiBtn('[n] cancel', 'skills:installCancel') + '</div>') + '</div>';
}
function skpHubIdLabel(identifier) {
  // skills-hub-list.tsx formatHubIdentifier: `owner/…/dir` for nested repo paths
  const segments = identifier.split('/').filter((x) => x.length);
  if (segments.length <= 2) return identifier;
  return segments[0] + '/…/' + segments[segments.length - 1];
}
function formatDownloads(n) {
  // skills/format-downloads.ts: 942 / 1.2k / 464k / 2.1M / — (GitHub taps expose no count)
  if (n === null || n === undefined) return '—';
  const trim = (v) => String(v < 10 ? Math.round(v * 10) / 10 : Math.round(v));
  if (n < 1000) return String(n);
  if (n < 1000000) return trim(n / 1000) + 'k';
  return trim(n / 1000000) + 'M';
}
function skpHubListHTML() {
  const q = SKP.hubQuery;
  const search = SKP.hubSearchEditing
    ? '<input id="skp-hubq" value="' + esc(q) + '" autocomplete="off" spellcheck="false">'
    : '<span>' + esc(q.length ? q : '(all)') + '</span>';
  const n = SKP.hubRows.length;
  let body;
  if (SKP.hubLoading && !n) body = '<div class="ter" style="padding:10px 0">browsing the skill hub…</div>';
  else if (!n) body = '<div class="ter" style="padding:10px 0">no skills found — press `/` to search, `r` to re-browse, or `Esc` to go back.</div>';
  else {
    const cur = Math.max(0, Math.min(SKP.hubCursor, n - 1));
    const start = computeWindowStart(cur, n, SKP_HUB_ROWS);
    const page = SKP.hubRows.slice(start, start + SKP_HUB_ROWS);
    const hiddenAfter = Math.max(0, n - start - page.length);
    body = (start > 0 ? '<button class="tuimore" data-act="skills:hubPage:up">↑ ' + start + ' above</button>' : '')
      + page.map((r, idx) => {
        const i = idx + start, sel = i === cur;
        // HubRow: `{chevron} {claw|gh  } {identifier(32)}{↓dl(9)}{description(48)}`
        return '<button class="tuirow' + (sel ? ' on' : '') + '" data-hub-row="' + esc(r.identifier) + '" data-act="skills:card:' + i + '">'
          + (sel ? '▸' : ' ') + ' <span class="' + (r.source === 'clawhub' ? 'skpaccent' : 'ter') + '">' + (r.source === 'clawhub' ? 'claw' : 'gh  ') + '</span> '
          + esc(tuiTrunc(skpHubIdLabel(r.identifier), 30).padEnd(32)) + '<span class="ter">' + esc(('↓' + formatDownloads(r.downloads)).padEnd(9)) + '</span>'
          + '<span class="' + (sel ? '' : 'ter') + '">' + esc(tuiTrunc(r.description, 48)) + '</span></button>';
      }).join('')
      + (hiddenAfter > 0 ? '<button class="tuimore" data-act="skills:hubPage:down">↓ ' + hiddenAfter + ' below</button>' : '');
  }
  return '<div class="tuibar"><span class="ter">hub search: </span>' + search + (SKP.hubSearchEditing ? '<span class="skpaccent">▌</span>' : '')
    + '<span class="ter">   ' + n + ' result' + (n === 1 ? '' : 's') + (SKP.hubLoading ? ' · …' : '') + '</span></div>'
    + (SKP.hubError ? '<div class="tuierr">! ' + esc(SKP.hubError) + '</div>' : '')
    + (SKP.installError ? '<div class="tuierr">! install failed: ' + esc(SKP.installError) + '</div>' : '')
    + skpMessages()
    + body
    + tuiHints(['j/k move', ['Enter open card', 'skills:card'], ['/ search', 'skills:hubSearch'], ['r re-browse', 'skills:rebrowse'], ['Esc back', 'skills:back']]);
}
function skpHubCardHTML() {
  const c = SKP.hubCard;
  const badge = c.source === 'clawhub' ? 'claw' : 'gh';
  let body;
  if (c.body === null) body = '<div class="ter">' + esc(c.bodyError || 'loading SKILL.md…') + '</div>';
  else {
    const lines = c.body.split('\n');
    const start = Math.max(0, Math.min(SKP.cardScroll, Math.max(0, lines.length - SKP_CARD_LINES)));
    const win = lines.slice(start, start + SKP_CARD_LINES);
    const below = Math.max(0, lines.length - (start + win.length));
    body = (start > 0 ? '<button class="tuimore" data-act="skills:cardScroll:up">↑ ' + start + ' more line' + (start === 1 ? '' : 's') + ' above</button>' : '')
      + tuiBodyLines(win)
      + (below > 0 ? '<button class="tuimore" data-act="skills:cardScroll:down">↓ ' + below + ' more line' + (below === 1 ? '' : 's') + ' below</button>' : '');
  }
  const canInstall = !!c.installId;
  return '<div class="tuimodal"><div><span class="' + (c.source === 'clawhub' ? 'skpaccent' : 'ter') + '">[' + badge + '] </span><b>' + esc(c.name) + '</b><span class="ter">  ' + esc(c.identifier) + '</span></div>'
    + '<div class="ter">owner ' + esc(c.repo) + ' · ↓' + esc(formatDownloads(c.downloads)) + ' · v' + esc(c.version === null ? '—' : c.version) + '</div>'
    + (c.version === null ? '<div class="ter">(version is not printed by `atag skill browse`)</div>' : '')
    + (c.description ? '<div class="ter" style="margin-top:8px">' + esc(c.description) + '</div>' : '')
    + '<div style="margin-top:8px">' + body + '</div>'
    + (SKP.installError ? '<div class="tuierr" style="margin-top:8px">! install failed: ' + esc(SKP.installError) + '</div>' : '')
    + (SKP.installing ? '<div class="ter" style="margin-top:8px">installing…</div>'
        : tuiHints([['[i] install', 'skills:install', {disabled: !canInstall}], ['[n] cancel', 'skills:back'], 'j/k scroll']))
    // `atag skill install` takes `@owner/slug`; a catalog-browse row carries only the slug (ClawHub's browse API prints no owner) and the detail answer carries none either.
    + (!canInstall && c.source === 'clawhub' ? '<div class="ter">(install needs `@owner/slug` — this browse row has no owner; `/` search lists owner-qualified rows)</div>' : '')
    + '</div>';
}

/* Loaders and actions. */
async function skpOpenDetail(name) {
  if (!BR) return;
  SKP.mode = 'detail'; SKP.detailName = name; SKP.detailBody = null; SKP.lastError = null; render();
  // GET /api/skills/{name} is the registry's filtered view: a disabled skill
  // answers 404, and the body then comes from `atag skill show` (the TUI's
  // openDetail reads the manifest path from listAll() for the same reason).
  const res = SKP.routeOverride !== null ? SKP.routeOverride : await BR.skill(name);
  let body = null, err = null, source = null;
  if (res && res.ok && res.data && typeof res.data.body === 'string') { body = res.data.body; source = 'route'; }
  else {
    const shown = await BR.skillShow(name);
    if (shown && shown.ok && typeof shown.body === 'string') { body = shown.body; source = 'skillShow'; }
    else err = (shown && shown.error) || (res && res.error) || 'unknown error';
  }
  if (SKP.detailName !== name || SKP.mode !== 'detail') return;
  if (err !== null) { SKP.msg = {text:'failed to open ' + name + ': ' + err}; SKP.mode = 'list'; SKP.detailSource = null; render(); return; }
  SKP.detailBody = body; SKP.detailSource = source; render();
}
async function skpToggle(name) {
  if (!BR || SKP.busy) return;
  const row = (SK.rows || []).find((r) => r.name === name);
  if (!row) { SKP.msg = {text:'skill ' + name + ' not found'}; render(); return; }
  const disable = row.enabled;
  SKP.busy = true; SKP.lastError = null; render();
  const res = await BR.skillSetDisabled(name, disable);
  SKP.busy = false;
  if (!res || res.ok === false) SKP.lastError = 'toggle ' + name + ' failed: ' + ((res && res.error) || 'unknown error');
  else SKP.msg = {text:(disable ? 'skill disabled: ' : 'skill enabled: ') + name, restart:true}; // skills-orchestrator.ts runtime_info; hot-apply needs the running agent's registry
  await skpReloadRows();
  render();
}
function skpRequestRemove(name) {
  const row = (SK.rows || []).find((r) => r.name === name);
  if (!row) { SKP.msg = {text:'skill ' + name + ' not found'}; render(); return; }
  if (row.source === 'project') { SKP.msg = {text:name + ' is a project-local skill — remove it from .atomic-agent/skills instead'}; render(); return; }
  if (row.source !== 'global') { SKP.msg = {text:'skill ' + name + ' not found'}; render(); return; } // a `[missing]` disable-list entry has no directory to delete
  SKP.removeConfirm = {name, source:row.source, wasDisabled:!row.enabled, submitting:false, error:null};
  render();
}
async function skpConfirmRemove() {
  const c = SKP.removeConfirm;
  if (!BR || !c || c.submitting) return;
  c.submitting = true; c.error = null; render();
  const res = await BR.uninstallSkill(c.name, 'global');
  if (!res || !res.ok) { c.submitting = false; c.error = (res && res.error) || 'unknown error'; render(); return; }
  if (!(res.data && res.data.removed)) { c.submitting = false; c.error = 'not installed globally: ' + c.name; render(); return; }
  // pruneDisabledEntry: drop the stale skills.disabled entry (`atag skill enable` removes it).
  if (c.wasDisabled) await BR.skillSetDisabled(c.name, false);
  SKP.removeConfirm = null;
  SKP.msg = {text:'skill removed: ' + c.name}; // POST /api/skills/uninstall runs runtime.refreshSkills() on the agent — no restart needed
  if (SKP.mode === 'detail' && SKP.detailName === c.name) { SKP.mode = 'list'; SKP.detailName = null; }
  await skpReloadRows();
  render();
}
function skpToHubRow(r) {
  const row = {identifier:r.identifier, source:r.source, downloads:r.downloads, description:String(r.description || '').replace(/\s+/g, ' ').trim(), owner:null, slug:null, name:'', repo:''};
  if (r.source === 'clawhub') {
    const m = /^@([^/]+)\/(.+)$/.exec(r.identifier);
    row.owner = m ? m[1] : null; row.slug = m ? m[2] : r.identifier;
    row.name = row.slug; row.repo = row.owner || 'clawhub';
  } else {
    const seg = r.identifier.split('/').filter((x) => x.length);
    row.name = seg[seg.length - 1] || r.identifier; row.repo = seg.slice(0, 2).join('/');
  }
  return row;
}
async function skpBrowse(query) {
  if (!BR) return;
  SKP.mode = 'hub'; SKP.hubLoading = true; SKP.hubError = null; SKP.hubCard = null; SKP.installConfirm = null; SKP.hubSearchEditing = false;
  SKP.hubQuery = query || '';
  render();
  const seq = ++SKP.hubSeq;
  const res = await BR.skillBrowse(SKP.hubQuery);
  if (seq !== SKP.hubSeq) return;
  SKP.hubLoading = false;
  if (!res || !res.ok) {
    SKP.hubRows = []; SKP.hubError = (res && res.error) || 'skill hub failed';
    SKP.msg = {text:'skill hub failed: ' + SKP.hubError};
  } else {
    SKP.hubRows = (res.rows || []).map(skpToHubRow); SKP.hubError = res.hubError || null; SKP.hubCursor = 0;
  }
  render();
}
async function skpClawhubApiBase() {
  const c = LIVE_CONFIG && LIVE_CONFIG.skills && LIVE_CONFIG.skills.clawhub;
  if (c && typeof c.apiBase === 'string' && c.apiBase) return c.apiBase;
  // The user file has no skills.clawhub.apiBase: the effective value is the schema default the CLI prints.
  const res = BR.configGetKey ? await BR.configGetKey('skills.clawhub.apiBase') : null;
  return res && res.ok && typeof res.value === 'string' ? res.value : null;
}
async function skpOpenCard(i) {
  const row = SKP.hubRows[i];
  if (!BR || !row) return;
  SKP.hubCursor = i; SKP.cardScroll = 0; SKP.installError = null;
  if (row.source !== 'clawhub') {
    SKP.hubCard = {identifier:row.identifier, source:'github', name:row.name, repo:row.repo, description:row.description, version:null, downloads:null,
      body:null, bodyError:'preview unavailable for GitHub taps (SKILL.md is pulled at install)', installId:row.identifier};
    render(); return;
  }
  SKP.hubCardLoading = true; render();
  const apiBase = await skpClawhubApiBase();
  const res = apiBase ? await BR.clawhubSkillDetail(apiBase, row.slug, row.owner) : {ok:false, error:'skills.clawhub.apiBase is not known'};
  SKP.hubCardLoading = false;
  let body = null, bodyError = null, name = row.name, version = null, downloads = row.downloads, repo = row.owner;
  if (res && res.ok && res.detail) {
    const d = res.detail;
    body = d.skillMd && d.skillMd.length ? d.skillMd : null;
    if (body === null) bodyError = 'no SKILL.md published for this skill';
    name = d.displayName || row.slug; version = d.version; downloads = d.downloads; repo = d.ownerHandle || row.owner;
  } else {
    bodyError = (res && res.error) || 'skill detail failed';
  }
  SKP.hubCard = {identifier:row.identifier, source:'clawhub', name, repo:repo || 'clawhub', description:row.description, version, downloads,
    body, bodyError, installId:row.owner ? row.identifier : null};
  render();
}
async function skpInstall(ack) {
  if (!BR || SKP.installing) return;
  const id = (SKP.installConfirm && SKP.installConfirm.identifier) || (SKP.hubCard && SKP.hubCard.installId);
  if (!id) return;
  SKP.installing = true; SKP.installError = null; render();
  const res = await BR.skillInstall(id, !!ack);
  SKP.installing = false;
  if (res && res.ok) {
    SKP.installConfirm = null; SKP.hubCard = null; SKP.mode = 'list';
    SKP.msg = {text:res.line || ('installed from ' + id), restart:true}; // the CLI's own `installed <name> (v…) from <id> — <scan>` line
    await skpReloadRows(); render(); return;
  }
  if (res && res.blocked) { SKP.installConfirm = {identifier:id, verdict:'dangerous', message:res.message || ''}; render(); return; }
  SKP.installConfirm = null;
  SKP.installError = (res && res.error) || 'install failed';
  SKP.msg = {text:'install ' + id + ' failed: ' + SKP.installError};
  render();
}
function skillsAct(what) {
  const [verb, ...rest] = what.split(':');
  const arg = rest.join(':');
  const sel = () => arg || (SKP.mode === 'detail' ? SKP.detailName : (skpSelected() || {}).name);
  if (verb === 'detail') { const name = sel(); if (name) skpOpenDetail(name); return; }
  if (verb === 'toggle') { const name = sel(); if (name) skpToggle(name); return; }
  if (verb === 'remove') { const name = sel(); if (name) skpRequestRemove(name); return; }
  if (verb === 'removeConfirm') { skpConfirmRemove(); return; }
  if (verb === 'removeCancel') { SKP.removeConfirm = null; render(); return; }
  if (verb === 'refresh') {
    refreshSkillList();
    if (SKP.mode === 'detail' && SKP.detailName) skpOpenDetail(SKP.detailName);
    return;
  }
  if (verb === 'auto') { SKP.auto = !SKP.auto; render(); return; }
  if (verb === 'filter') { SKP.filter = arg && SKP_FILTERS.includes(arg) ? arg : SKP_FILTERS[(SKP_FILTERS.indexOf(SKP.filter) + 1) % SKP_FILTERS.length]; SKP.cursor = 0; render(); return; }
  if (verb === 'page') { const n = skpVisibleRows().length; SKP.cursor = Math.max(0, Math.min(SKP.cursor + (arg === 'up' ? -SKP_MAX_ROWS : SKP_MAX_ROWS), n - 1)); render(); return; }
  if (verb === 'back') {
    if (SKP.installConfirm) { SKP.installConfirm = null; render(); return; }
    if (SKP.hubCard) { SKP.hubCard = null; render(); return; }
    if (SKP.mode === 'hub' && SKP.hubSearchEditing) { SKP.hubSearchEditing = false; render(); return; }
    SKP.mode = 'list'; SKP.detailName = null; SKP.detailBody = null; render(); return;
  }
  if (verb === 'hub') { skpBrowse(''); return; }
  if (verb === 'search') { skpBrowse(arg); return; }
  if (verb === 'hubSearch') { SKP.mode = 'hub'; SKP.hubSearchEditing = true; render(); const n = $('#skp-hubq'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } return; }
  if (verb === 'rebrowse') { skpBrowse(SKP.hubQuery); return; }
  if (verb === 'hubPage') { const n = SKP.hubRows.length; SKP.hubCursor = Math.max(0, Math.min(SKP.hubCursor + (arg === 'up' ? -SKP_HUB_ROWS : SKP_HUB_ROWS), n - 1)); render(); return; }
  if (verb === 'card') { const i = arg === '' ? SKP.hubCursor : +arg; skpOpenCard(i); return; }
  if (verb === 'cardScroll') { SKP.cardScroll = Math.max(0, SKP.cardScroll + (arg === 'up' ? -SKP_CARD_LINES : SKP_CARD_LINES)); render(); return; }
  if (verb === 'install') { skpInstall(false); return; }
  if (verb === 'installAck') { skpInstall(true); return; }
  if (verb === 'installCancel') { const id = SKP.installConfirm ? SKP.installConfirm.identifier : ''; SKP.installConfirm = null; SKP.msg = {text:'install cancelled: ' + id}; render(); return; }
}
/* skills-key-bindings.ts, shared by the settings window and the Skills room. */
function skillsKey(e, k, inText) {
  if (e.target.id === 'skp-hubq') {
    if (k === 'Enter') { e.preventDefault(); SKP.hubQuery = e.target.value; skpBrowse(SKP.hubQuery); return true; }
    if (k === 'Escape') { e.preventDefault(); SKP.hubSearchEditing = false; render(); return true; }
    return false;
  }
  if (inText) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (SKP.installConfirm) {
    if (k === 'y') { e.preventDefault(); skpInstall(true); return true; }
    if (k === 'n' || k === 'Escape') { e.preventDefault(); skillsAct('installCancel'); return true; }
    return true;
  }
  if (SKP.removeConfirm) {
    if (k === 'y' || k === 'Enter') { e.preventDefault(); skpConfirmRemove(); return true; }
    if (k === 'n' || k === 'Escape') { e.preventDefault(); SKP.removeConfirm = null; render(); return true; }
    return true;
  }
  if (SKP.hubCard) {
    if (k === 'i' || k === 'y' || k === 'Enter') { e.preventDefault(); if (SKP.hubCard.installId) skpInstall(false); return true; } // handleHubCardKey: i / y / Enter
    if (k === 'n' || k === 'Escape') { e.preventDefault(); skillsAct('back'); return true; }
    if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); SKP.cardScroll++; render(); return true; }
    if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); SKP.cardScroll = Math.max(0, SKP.cardScroll - 1); render(); return true; }
    return false;
  }
  if (SKP.mode === 'hub') {
    const n = SKP.hubRows.length;
    if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); SKP.hubCursor = Math.min(SKP.hubCursor + 1, Math.max(0, n - 1)); render(); return true; }
    if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); SKP.hubCursor = Math.max(SKP.hubCursor - 1, 0); render(); return true; }
    if (k === 'Enter') { e.preventDefault(); if (n) skpOpenCard(Math.min(SKP.hubCursor, n - 1)); return true; }
    if (k === '/') { e.preventDefault(); skillsAct('hubSearch'); return true; }
    if (k === 'r') { e.preventDefault(); skpBrowse(SKP.hubQuery); return true; }
    if (k === 'Escape') { e.preventDefault(); skillsAct('back'); return true; }
    return false;
  }
  if (SKP.mode === 'detail') {
    if (k === 'Escape') { e.preventDefault(); skillsAct('back'); return true; }
    if (k === 'e') { e.preventDefault(); skillsAct('toggle'); return true; }
    if (k === 'r') { e.preventDefault(); skillsAct('refresh'); return true; }
    return false;
  }
  const rows = skpVisibleRows();
  if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); SKP.cursor = Math.min(SKP.cursor + 1, Math.max(0, rows.length - 1)); render(); return true; }
  if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); SKP.cursor = Math.max(SKP.cursor - 1, 0); render(); return true; }
  if (k === 'Enter') { e.preventDefault(); skillsAct('detail'); return true; }
  const map = {e:'toggle', d:'remove', r:'refresh', a:'auto', f:'filter', i:'hub'};
  if (map[k]) { e.preventDefault(); skillsAct(map[k]); return true; }
  return false;
}

/* ---------------- Memory tab (memory-panel.tsx, memory-list.tsx, memory-detail.tsx,
   memory-orchestrator.ts, memory-summary.ts, memory-detail-text.ts,
   memory-filter.ts, memory-key-bindings.ts) ---------------- */

function memStateDir() { return (LIVE_CAPS && LIVE_CAPS.paths && LIVE_CAPS.paths.stateDir) || null; }
/* memory.<section>.enabled: the user file when it carries the key, else the
   effective value `atag config get memory` printed; null until known. */
function memFlag(section) {
  const m = LIVE_CONFIG && LIVE_CONFIG.memory;
  if (m && m[section] && typeof m[section].enabled === 'boolean') return m[section].enabled;
  const c = MEM.cfg && MEM.cfg[section];
  return c && typeof c.enabled === 'boolean' ? c.enabled : null;
}
/* memory-orchestrator.ts resolveAvailableChannels: profile, notes always;
   lessons / procedures / links when memory.<x>.enabled; votes when the vote
   store exists, i.e. memory.voting.enabled (bootstrap.ts). */
function memAvailableChannels() {
  const out = ['profile', 'notes'];
  if (memFlag('lessons') === true) out.push('lessons');
  if (memFlag('procedures') === true) out.push('procedures');
  if (memFlag('links') === true) out.push('links');
  if (memFlag('voting') === true) out.push('votes');
  return out;
}
async function memEnsureCfg() {
  if (MEM.cfg || MEM.cfgBusy || !BR || !BR.configGetKey) return;
  const needed = ['profile','notes','lessons','procedures','links','voting'];
  if (needed.every((s) => memFlag(s) !== null)) return;
  MEM.cfgBusy = true;
  const res = await BR.configGetKey('memory');
  MEM.cfgBusy = false;
  if (res && res.ok && res.value && typeof res.value === 'object') MEM.cfg = res.value;
  const next = memAvailableChannels();
  if (JSON.stringify(next) !== JSON.stringify(MEM.available)) { MEM.available = next; if (memoryVisible()) memRefresh(true); }
}
function memoryVisible() { return !!S.settings && settingsPaneId(S.settingsPane) === 'memory'; }
function ensureMemoryPoll() {
  if (!BR || MEM.timer) return;
  MEM.timer = setInterval(() => {
    if (!memoryVisible()) { clearInterval(MEM.timer); MEM.timer = null; return; }
    if (MEM.auto && MEM.mode === 'list') memRefresh(true);
  }, 5000);
}
function memoryTabEntered() {
  if (MEM.timer) { clearInterval(MEM.timer); MEM.timer = null; }
  ensureMemoryPoll();
  memEnsureCfg();
  if (MEM.lastRefreshedAt === null && !MEM.loading) memRefresh();
}
async function memQ(name, params) {
  const dir = memStateDir();
  if (!dir) throw new Error('no state dir from /api/capabilities');
  const r = await BR.memoryQuery(dir, name, params || []);
  if (!r || !r.ok) throw new Error((r && r.error) || 'memory query failed');
  return r.rows || [];
}
function memParseJsonList(raw) {
  if (!raw) return [];
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch (e) { return []; }
}
function memTrunc(text, max) {
  // memory-summary.ts truncate: collapse whitespace first
  const one = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : one.slice(0, max - 1) + '…';
}
function memTagsMeta(tags) {
  if (!tags.length) return '';
  const head = tags.slice(0, 4).join(', ');
  return tags.length > 4 ? head + '…' : head;
}
function memVote(score) { return score > 0 ? '+' + score : String(score); }
function renderNotePreview(content, maxChars) {
  // memory-store.ts renderNotePreview: the first non-empty line, clipped
  const first = String(content || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length) || '';
  if (first.length <= maxChars) return first;
  if (maxChars <= 1) return first.slice(0, maxChars);
  return first.slice(0, maxChars - 1) + '…';
}
/* Row mappers: the stores' rowTo* + memory-summary.ts to*SummaryRows. */
function memFact(r) {
  return {id:r.id, key:r.key, value:r.value, validFrom:r.valid_from, updatedAt:r.updated_at, pinned:r.pinned !== 0,
    keywords:memParseJsonList(r.keywords).filter((k) => typeof k === 'string'), supersedes:r.supersedes, supersededBy:r.superseded_by, voteScore:r.vote_score || 0};
}
function memNoteEntry(r) {
  return {id:r.id, content:r.content, createdAt:r.created_at, updatedAt:r.updated_at, source:r.source === 'user' ? 'user' : 'agent',
    sessionId:r.session_id, workingDir:r.working_dir, tags:memParseJsonList(r.tags).filter((t) => typeof t === 'string'),
    consolidatedInto:typeof r.consolidated_into === 'number' ? r.consolidated_into : null};
}
function memLink(r) { return {fromId:r.from_id, toId:r.to_id, kind:r.kind, weight:r.weight, createdAt:r.created_at}; }
function memRowsProfile(rows) {
  return rows.map(memFact).map((f) => ({rowKey:'profile:' + f.key, channel:'profile', primary:f.key, secondary:memTrunc(f.value, 56),
    meta:[f.pinned ? 'pinned' : 'contextual', f.voteScore !== 0 ? 'vote ' + memVote(f.voteScore) : null].filter(Boolean).join(' · '), profileKey:f.key}));
}
function memRowsNotes(rows) {
  return rows.map(memNoteEntry).map((e) => ({rowKey:'note:' + e.id, channel:'notes', primary:'#' + e.id,
    secondary:memTrunc(renderNotePreview(e.content, 80), 56), meta:memTagsMeta(e.tags), numericId:e.id}));
}
function memRowsLessons(rows) {
  return rows.map((r) => ({rowKey:'lesson:' + r.id, channel:'lessons', primary:'>' + r.id, secondary:memTrunc(r.activation, 56),
    meta:memTagsMeta(memParseJsonList(r.tags)), numericId:r.id}));
}
function memRowsProcedures(rows) {
  return rows.map((r) => ({rowKey:'procedure:' + r.id, channel:'procedures', primary:'>' + r.id, secondary:memTrunc(r.activation, 56),
    meta:memTagsMeta(memParseJsonList(r.tags)), numericId:r.id}));
}
function memRowsLinks(rows) {
  return rows.map(memLink).map((l) => ({rowKey:'link:' + l.fromId + ':' + l.toId + ':' + l.kind, channel:'links', primary:l.fromId + ' → ' + l.toId,
    secondary:l.kind, meta:'w=' + Number(l.weight).toFixed(2), linkFromId:l.fromId, linkToId:l.toId, numericId:l.fromId}));
}
function memRowsVotes(rows) {
  return rows.map((e) => ({rowKey:'vote:' + e.id, channel:'votes', primary:(e.direction > 0 ? 'UP' : 'DOWN') + ' ' + e.kind + ':' + e.targetId,
    secondary:e.sessionId || '(no session)', meta:'turn ' + (e.turnIndex === null || e.turnIndex === undefined ? '—' : e.turnIndex),
    numericId:e.targetId, voteEventId:e.id, event:{id:e.id, kind:e.kind, targetId:e.targetId, direction:e.direction === -1 ? -1 : 1, sessionId:e.sessionId, turnIndex:e.turnIndex, createdAt:e.createdAt}}));
}
function buildFtsQuery(query) {
  // memory-store.ts buildFtsQuery
  const tokens = String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u).map((t) => t.trim()).filter((t) => t.length);
  if (!tokens.length) return '';
  return tokens.map((t) => '"' + t + '"*').join(' OR ');
}
/* memory-orchestrator.ts loadChannelRows. */
async function memLoadChannelRows(channel) {
  if (channel === 'profile') {
    if (memFlag('profile') === false) return {rows:[], hint:'memory.profile.enabled=false — enable in config to populate profile'};
    return {rows:memRowsProfile(await memQ('profile.list', [])), hint:null};
  }
  if (channel === 'notes') {
    if (memFlag('notes') === false) return {rows:[], hint:'memory.notes.enabled=false — enable in config to store notes'};
    const q = MEM.search.trim();
    if (q.length) {
      const fts = buildFtsQuery(q);
      return {rows:fts ? memRowsNotes(await memQ('notes.recall', [fts, 50])) : [], hint:null};
    }
    if (MEM.notesFilter === 'archived') {
      const all = await memQ('notes.listAll', [MEM_NOTES_LIMIT]);
      return {rows:memRowsNotes(all.filter((r) => typeof r.consolidated_into === 'number')), hint:null};
    }
    return {rows:memRowsNotes(await memQ(MEM.notesFilter === 'active' ? 'notes.listActive' : 'notes.listAll', [MEM_NOTES_LIMIT])), hint:null};
  }
  if (channel === 'lessons') {
    if (memFlag('lessons') === false) return {rows:[], hint:'memory.lessons.enabled=false'};
    return {rows:memRowsLessons(await memQ('lessons.listIndex', [MEM_INDEX_LIMIT])), hint:null};
  }
  if (channel === 'procedures') {
    if (memFlag('procedures') === false) return {rows:[], hint:'memory.procedures.enabled=false'};
    return {rows:memRowsProcedures(await memQ('procedures.listIndex', [MEM_INDEX_LIMIT])), hint:null};
  }
  if (channel === 'links') {
    if (memFlag('links') === false) return {rows:[], hint:'memory.links.enabled=false'};
    return {rows:memRowsLinks(await memQ('links.listAll', [MEM_LINKS_LIMIT])), hint:null};
  }
  if (memFlag('voting') === false) return {rows:[], hint:'memory.voting.enabled=false'};
  return {rows:memRowsVotes(await memQ('votes.listEvents', [MEM_VOTES_LIMIT])), hint:null};
}
function memVisibleRows() {
  const q = MEM.search.trim().toLowerCase();
  if (!q) return MEM.rows;
  return MEM.rows.filter((r) => r.primary.toLowerCase().includes(q) || r.secondary.toLowerCase().includes(q) || r.meta.toLowerCase().includes(q));
}
function memSelected() {
  const rows = memVisibleRows();
  if (!rows.length) return null;
  return rows[Math.max(0, Math.min(MEM.cursor, rows.length - 1))];
}
async function memRefresh(quiet) {
  if (!BR) return;
  MEM.loading = true; MEM.lastError = null;
  MEM.available = memAvailableChannels();
  if (!MEM.available.includes(MEM.channel)) MEM.channel = MEM.available[0] || 'profile';
  if (!quiet) render();
  const seq = ++MEM.seq;
  const channel = MEM.channel;
  const before = JSON.stringify([MEM.rows, MEM.channelHint, MEM.lastError]);
  try {
    const {rows, hint} = await memLoadChannelRows(channel);
    if (seq !== MEM.seq) return;
    MEM.rows = rows; MEM.channelHint = hint; MEM.lastRefreshedAt = Date.now();
    const n = memVisibleRows().length;
    MEM.cursor = n ? Math.max(0, Math.min(n - 1, MEM.cursor)) : 0;
  } catch (err) {
    if (seq !== MEM.seq) return;
    MEM.lastError = err && err.message ? err.message : String(err);
  }
  MEM.loading = false;
  if (quiet && before === JSON.stringify([MEM.rows, MEM.channelHint, MEM.lastError])) {
    const st = document.querySelector('#settings .memstatus');
    if (st) st.textContent = memStatusLine();
    return;
  }
  if (memoryVisible()) paneRepaintKeepFocus(memoryTab()); else if (!quiet) render();
  if (S.settings) { const tab = document.querySelector('#settings .settab.on'); if (tab) tab.textContent = 'Memory' + tabSuffix('memory'); } // the strip's ` (N)` follows the selected channel's rows
}
function memStatusLine() {
  return [MEM.loading ? 'loading' : null, MEM.auto ? 'auto' : 'manual',
    MEM.lastRefreshedAt ? 'refreshed ' + new Date(MEM.lastRefreshedAt).toLocaleTimeString() : null,
    MEM.channel === 'notes' ? 'notes: ' + MEM.notesFilter : null,
    MEM.search.trim() ? 'search: "' + MEM.search.trim() + '"' : null,
    memVisibleRows().length + ' shown'].filter(Boolean).join(' · ');
}
function memoryTab() {
  ensureMemoryPoll();
  const labels = MEM.available.map((ch, idx) => {
    const label = (idx + 1) + ':' + ch;
    return '<button class="memch' + (ch === MEM.channel ? ' on' : '') + '" data-act="memory:ch:' + ch + '">' + esc(ch === MEM.channel ? '[' + label + ']' : label) + '</button>';
  }).join('<span class="ter">  </span>');
  return '<div class="tui"><div class="tuibar">' + labels + '</div>'
    + '<div class="ter memstatus">' + esc(memStatusLine()) + '</div>'
    + (MEM.lastError ? '<div class="tuierr">! ' + esc(MEM.lastError) + '</div>' : '')
    + (MEM.mode === 'list' ? memListHTML() : memDetailHTML()) + '</div>';
}
function memListHTML() {
  if (MEM.channelHint) return '<div style="color:var(--warn);padding:10px 0">' + esc(MEM.channelHint) + '</div>';
  const rows = memVisibleRows();
  if (!rows.length) {
    if (MEM.lastRefreshedAt === null) return '<div class="ter" style="padding:10px 0">(loading…)</div>';
    return '<div class="ter" style="padding:10px 0">(empty) — press `r` to refresh' + (MEM.channel === 'notes' ? ' · `f` cycles active/archived/all' : '') + '</div>' + memHintsHTML();
  }
  const cur = Math.max(0, Math.min(MEM.cursor, rows.length - 1));
  const start = computeWindowStart(cur, rows.length, MEM_MAX_ROWS);
  const page = rows.slice(start, start + MEM_MAX_ROWS);
  const hiddenAfter = Math.max(0, rows.length - start - page.length);
  return '<div class="tuihead">  primary                    secondary / meta     [' + esc(MEM.channel) + ']</div>'
    + (start > 0 ? '<button class="tuimore" data-act="memory:page:up">↑ ' + start + ' above</button>' : '')
    + page.map((r, idx) => {
      const i = idx + start, sel = i === cur;
      // MemoryRow: `{chevron} {primary(30)}{secondary(36)} · {meta(28)}`
      return '<button class="tuirow' + (sel ? ' on' : '') + '" data-mem-row="' + esc(r.rowKey) + '" data-act="memory:open:' + i + '">'
        + (sel ? '▸' : ' ') + ' ' + esc(tuiTrunc(r.primary, 28).padEnd(30)) + '<span class="ter">' + esc(tuiTrunc(r.secondary, 36)) + (r.meta ? ' · ' + esc(tuiTrunc(r.meta, 28)) : '') + '</span></button>';
    }).join('')
    + (hiddenAfter > 0 ? '<button class="tuimore" data-act="memory:page:down">↓ ' + hiddenAfter + ' below</button>' : '')
    + memHintsHTML();
}
function memHintsHTML() {
  const parts = ['j/k', ['Enter detail', 'memory:open'], ['r refresh', 'memory:refresh'], ['a auto', 'memory:auto'], ['[/] channel', 'memory:cycle:1'], '1-6 jump'];
  if (MEM.channel === 'notes') parts.push(['f archive filter', 'memory:filter']);
  else if (MEM.channel === 'links') parts.push(['Enter opens from-note', 'memory:open']);
  return tuiHints(parts);
}
function memDetailHTML() {
  const d = MEM.detail;
  if (!d) return '<div class="ter" style="padding:10px 0">(loading…)</div>';
  const title = d.channel === 'profile' ? 'profile: ' + d.key : d.channel === 'notes' ? 'note #' + d.id : d.channel === 'lessons' ? 'lesson #' + d.id
    : d.channel === 'procedures' ? 'procedure #' + d.id : d.channel;
  const lines = d.body.split('\n');
  const hidden = lines.length - MEM_DETAIL_LINES;
  const hints = [['Esc back', 'memory:back'], ['r refresh', 'memory:refresh']];
  if (d.channel === 'notes') { hints.push(['g expand graph', 'memory:expand']); hints.push(['Enter neighbor', 'memory:neighbor']); }
  return '<div style="margin-top:6px"><b>' + esc(title) + '</b></div>'
    + '<div style="margin-top:8px">' + tuiBodyLines(lines.slice(0, MEM_DETAIL_LINES))
    + (hidden > 0 ? '<div class="ter">… (' + hidden + ' more lines hidden)</div>' : '') + '</div>'
    + tuiHints(hints);
}
/* memory-detail-text.ts, verbatim. */
const MEM_MAX_DETAIL_CHARS = 12000;
function memTruncateDetail(text) { return text.length <= MEM_MAX_DETAIL_CHARS ? text : text.slice(0, MEM_MAX_DETAIL_CHARS) + '\n\n[truncated]'; }
function formatProfileHistoryBody(key, chain) {
  const lines = ['key: ' + key, 'chain (' + chain.length + ' row' + (chain.length === 1 ? '' : 's') + '):', ''];
  chain.forEach((row) => {
    const active = row.supersededBy === null ? ' (active)' : ' → #' + row.supersededBy;
    lines.push('[#' + row.id + '] ' + new Date(row.validFrom).toISOString() + ': ' + row.value + active);
    if (!row.pinned && row.keywords.length) lines.push('  keywords: ' + row.keywords.join(', '));
    if (row.voteScore !== 0) lines.push('  vote_score: ' + row.voteScore);
  });
  return memTruncateDetail(lines.join('\n'));
}
function formatLinkSection(outgoing, incoming, expanded) {
  const parts = ['--- links ---'];
  if (!outgoing.length && !incoming.length && !expanded.length) { parts.push('(none)'); return parts.join('\n'); }
  if (outgoing.length) { parts.push('outgoing:'); outgoing.forEach((e) => parts.push('  → #' + e.toId + ' ' + e.kind + ' (w=' + e.weight + ')')); }
  if (incoming.length) { parts.push('incoming:'); incoming.forEach((e) => parts.push('  ← #' + e.fromId + ' ' + e.kind + ' (w=' + e.weight + ')')); }
  if (expanded.length) parts.push('expanded (g): ' + expanded.map((id) => '#' + id).join(', '));
  return parts.join('\n');
}
function formatNoteDetailBody(entry, consolidatedInto, outgoing, incoming, expanded) {
  const lines = ['#' + entry.id, 'source: ' + entry.source, entry.sessionId ? 'session: ' + entry.sessionId : null,
    entry.workingDir ? 'working_dir: ' + entry.workingDir : null,
    'tags: ' + (entry.tags.length ? entry.tags.join(', ') : '(none)'),
    consolidatedInto !== null ? 'archived → lesson #' + consolidatedInto : null,
    'updated: ' + new Date(entry.updatedAt).toISOString(), '', entry.content].filter((l) => l !== null);
  lines.push('', formatLinkSection(outgoing, incoming, expanded));
  return memTruncateDetail(lines.join('\n'));
}
function formatLessonDetailBody(l) {
  const lines = ['>' + l.id + ' [' + l.status + ']', 'activation: ' + l.activation, 'tags: ' + (l.tags.join(', ') || '(none)'),
    'success: ' + l.successCount + ' · failure: ' + l.failureCount, l.voteScore !== 0 ? 'vote_score: ' + l.voteScore : null,
    'parents: ' + (l.parentIds.map((id) => '#' + id).join(', ') || '(none)'), '', 'principle:', l.principle].filter((x) => x !== null);
  return memTruncateDetail(lines.join('\n'));
}
function formatProcedureDetailBody(p) {
  const lines = ['>' + p.id + ' [' + p.status + ']', 'activation: ' + p.activation, 'tags: ' + (p.tags.join(', ') || '(none)'),
    'use: ' + p.useCount + ' · success: ' + p.successCount + ' · failure: ' + p.failureCount, p.voteScore !== 0 ? 'vote_score: ' + p.voteScore : null,
    'parent lessons: ' + (p.parentLessonIds.join(', ') || '(none)'), 'parent memories: ' + (p.parentMemoryIds.map((id) => '#' + id).join(', ') || '(none)'),
    '', 'steps:'].filter((x) => x !== null);
  p.steps.forEach((step, idx) => lines.push((idx + 1) + '. ' + step.description + (step.toolHint ? ' @' + step.toolHint : '')));
  return memTruncateDetail(lines.join('\n'));
}
function formatVoteDetailBody(event, targetPreview) {
  const lines = ['event #' + event.id, (event.direction > 0 ? 'UPVOTE' : 'DOWNVOTE') + ' ' + event.kind + ':' + event.targetId,
    'session: ' + (event.sessionId || '(none)'), 'turn: ' + (event.turnIndex === null || event.turnIndex === undefined ? '—' : event.turnIndex),
    'at: ' + new Date(event.createdAt).toISOString(), '', targetPreview ? 'target preview:\n' + targetPreview : '(target not found)'];
  return memTruncateDetail(lines.join('\n'));
}
function memLesson(r) {
  return {id:r.id, activation:r.activation, principle:r.principle, tags:memParseJsonList(r.tags), status:r.status === 'deprecated' ? 'deprecated' : 'active',
    successCount:r.success_count, failureCount:r.failure_count, parentIds:memParseJsonList(r.parent_ids).filter((x) => typeof x === 'number'), voteScore:r.vote_score || 0};
}
function memProcedure(r) {
  const steps = memParseJsonList(r.steps).filter((s) => s && typeof s === 'object').map((s) => ({description:String(s.description || ''), toolHint:typeof s.toolHint === 'string' && s.toolHint ? s.toolHint : null}));
  return {id:r.id, activation:r.activation, steps, tags:memParseJsonList(r.tags), status:r.status === 'deprecated' ? 'deprecated' : 'active',
    successCount:r.success_count, failureCount:r.failure_count, useCount:r.use_count, voteScore:r.vote_score || 0,
    parentLessonIds:memParseJsonList(r.parent_lesson_ids).filter((x) => typeof x === 'number'), parentMemoryIds:memParseJsonList(r.parent_memory_ids).filter((x) => typeof x === 'number')};
}
async function memNoteDetail(id, expanded) {
  const rows = await memQ('notes.get', [id]);
  if (!rows.length) return null;
  const entry = memNoteEntry(rows[0]);
  const linksOn = memFlag('links') === true;
  const outgoing = linksOn ? (await memQ('links.outgoing', [id])).map(memLink) : [];
  const incoming = linksOn ? (await memQ('links.incoming', [id])).map(memLink) : [];
  return {channel:'notes', id, body:formatNoteDetailBody(entry, entry.consolidatedInto, outgoing, incoming, expanded), tags:entry.tags,
    consolidatedInto:entry.consolidatedInto,
    outgoing:outgoing.map((e) => ({memoryId:e.toId, kind:e.kind, direction:'out'})),
    incoming:incoming.map((e) => ({memoryId:e.fromId, kind:e.kind, direction:'in'})), expandedNeighbors:expanded};
}
async function memVoteTargetPreview(event) {
  const t = (s, max) => (s.length <= max ? s : s.slice(0, max - 1) + '…');
  if (event.kind === 'memory') { const r = await memQ('notes.get', [event.targetId]); return r.length ? t(String(r[0].content), 400) : null; }
  if (event.kind === 'lesson') { const r = await memQ('lessons.getById', [event.targetId]); return r.length ? t(String(r[0].principle), 400) : null; }
  if (event.kind === 'procedure') { const r = await memQ('procedures.getById', [event.targetId]); return r.length ? t(String(r[0].activation), 400) : null; }
  if (event.kind === 'profile') { const r = await memQ('profile.getById', [event.targetId]); return r.length ? r[0].key + '=' + r[0].value : null; }
  return null;
}
/* memory-orchestrator.ts buildDetail. */
async function memBuildDetail(row) {
  if (row.channel === 'profile') {
    if (!row.profileKey) return null;
    const chain = (await memQ('profile.history', [row.profileKey])).map(memFact);
    return {channel:'profile', key:row.profileKey, body:formatProfileHistoryBody(row.profileKey, chain)};
  }
  if (row.channel === 'notes') return row.numericId === undefined ? null : memNoteDetail(row.numericId, []);
  if (row.channel === 'lessons') {
    const r = await memQ('lessons.getById', [row.numericId]);
    return r.length ? {channel:'lessons', id:row.numericId, body:formatLessonDetailBody(memLesson(r[0]))} : null;
  }
  if (row.channel === 'procedures') {
    const r = await memQ('procedures.getById', [row.numericId]);
    return r.length ? {channel:'procedures', id:row.numericId, body:formatProcedureDetailBody(memProcedure(r[0]))} : null;
  }
  if (row.channel === 'links') {
    if (row.linkFromId === undefined || row.linkToId === undefined) return null;
    return {channel:'links', body:'edge: #' + row.linkFromId + ' → #' + row.linkToId + '\n' + row.secondary + '\n\nPress Enter on from-id to open note #' + row.linkFromId + '.'};
  }
  if (!row.event) return {channel:'votes', body:row.primary};
  return {channel:'votes', body:formatVoteDetailBody(row.event, await memVoteTargetPreview(row.event))};
}
async function memOpenDetail(row) {
  if (!BR || !row) return;
  MEM.mode = 'detail'; MEM.detailRowKey = row.rowKey; MEM.detail = null; render();
  try {
    const detail = await memBuildDetail(row);
    if (MEM.detailRowKey !== row.rowKey || MEM.mode !== 'detail') return;
    if (!detail) { MEM.mode = 'list'; MEM.lastError = 'memory detail unavailable for ' + row.rowKey; render(); return; }
    MEM.detail = detail;
  } catch (err) {
    MEM.mode = 'list'; MEM.lastError = err && err.message ? err.message : String(err);
  }
  render();
}
function memOpenNoteById(id) {
  memOpenDetail({rowKey:'note:' + id, channel:'notes', primary:'#' + id, secondary:'', meta:'', numericId:id});
}
/* link-store.ts expand(seedIds, {depth, maxExpanded}): BFS over outgoing +
   incoming edges, deduplicated. The TUI calls it with depth 2, maxExpanded 24. */
async function memExpandLinks(seedIds, depth, maxExpanded) {
  const seen = new Set(seedIds);
  const result = [];
  let frontier = seedIds.slice();
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const node of frontier) {
      const outgoing = (await memQ('links.outgoing', [node])).map(memLink);
      const incoming = (await memQ('links.incoming', [node])).map(memLink);
      MEM.expandQueries += 2;
      for (const e of outgoing) { if (seen.has(e.toId)) continue; seen.add(e.toId); result.push(e.toId); next.push(e.toId); if (result.length >= maxExpanded) return result; }
      for (const e of incoming) { if (seen.has(e.fromId)) continue; seen.add(e.fromId); result.push(e.fromId); next.push(e.fromId); if (result.length >= maxExpanded) return result; }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return result;
}
async function memExpandNeighbors() {
  const d = MEM.detail;
  if (!BR || !d || d.channel !== 'notes') return;
  if (memFlag('links') !== true) return; // memory-orchestrator.ts expandNoteNeighbors: no-op unless links are enabled
  try {
    const expanded = await memExpandLinks([d.id], 2, 24);
    const next = await memNoteDetail(d.id, expanded);
    if (MEM.detail !== d) return;
    if (next) { next.expandedAt = Date.now(); MEM.expandRuns++; MEM.detail = next; }
  } catch (err) {
    MEM.lastError = err && err.message ? err.message : String(err);
  }
  render();
}
function memPickNeighbor() {
  const d = MEM.detail;
  if (!d || d.channel !== 'notes') return null;
  const all = d.outgoing.map((n) => n.memoryId).concat(d.incoming.map((n) => n.memoryId), d.expandedNeighbors);
  if (!all.length) return null;
  return all[Math.max(0, Math.min(MEM.cursor, all.length - 1))];
}
function memSetChannel(ch) {
  if (!MEM.available.includes(ch)) return;
  MEM.channel = ch; MEM.cursor = 0; MEM.mode = 'list'; MEM.detailRowKey = null; MEM.detail = null;
  memRefresh();
}
function memoryAct(what) {
  const [verb, ...rest] = what.split(':');
  const arg = rest.join(':');
  if (verb === 'ch') { memSetChannel(arg); return; }
  if (verb === 'cycle') {
    const order = MEM.available.length ? MEM.available : MEM_CHANNEL_ORDER;
    const idx = order.indexOf(MEM.channel);
    memSetChannel(order[((idx === -1 ? 0 : idx) + (+arg || 1) + order.length) % order.length]); return;
  }
  if (verb === 'jump') { const ch = MEM.available[+arg - 1]; if (ch) memSetChannel(ch); return; }
  if (verb === 'open') {
    const rows = memVisibleRows();
    const row = arg === '' ? memSelected() : rows[+arg];
    if (!row) return;
    if (arg !== '') MEM.cursor = +arg;
    if (row.channel === 'links' && row.linkFromId !== undefined) { memOpenNoteById(row.linkFromId); return; }
    memOpenDetail(row); return;
  }
  if (verb === 'refresh') { memRefresh(); return; }
  if (verb === 'auto') { MEM.auto = !MEM.auto; render(); return; }
  if (verb === 'filter') {
    if (MEM.channel !== 'notes') return;
    MEM.notesFilter = MEM_NOTES_FILTERS[(MEM_NOTES_FILTERS.indexOf(MEM.notesFilter) + 1) % MEM_NOTES_FILTERS.length]; MEM.cursor = 0;
    memRefresh(); return;
  }
  if (verb === 'page') { const n = memVisibleRows().length; MEM.cursor = Math.max(0, Math.min(MEM.cursor + (arg === 'up' ? -MEM_MAX_ROWS : MEM_MAX_ROWS), n - 1)); render(); return; }
  if (verb === 'back') { MEM.mode = 'list'; MEM.detailRowKey = null; MEM.detail = null; render(); return; }
  if (verb === 'expand') { memExpandNeighbors(); return; }
  if (verb === 'neighbor') { const id = memPickNeighbor(); if (id !== null) memOpenNoteById(id); return; }
}
/* memory-key-bindings.ts. */
function memoryKey(e, k, inText) {
  if (inText) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (MEM.mode === 'detail') {
    if (k === 'Escape') { e.preventDefault(); memoryAct('back'); return true; }
    if (k === 'g' && MEM.detail && MEM.detail.channel === 'notes') { e.preventDefault(); memExpandNeighbors(); return true; }
    if (k === 'r') { e.preventDefault(); memRefresh(); return true; }
    if (k === 'Enter' && MEM.detail && MEM.detail.channel === 'notes') { const id = memPickNeighbor(); if (id !== null) { e.preventDefault(); memOpenNoteById(id); return true; } }
    return false;
  }
  const rows = memVisibleRows();
  if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); MEM.cursor = Math.min(MEM.cursor + 1, Math.max(0, rows.length - 1)); render(); return true; }
  if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); MEM.cursor = Math.max(MEM.cursor - 1, 0); render(); return true; }
  if (k === 'Enter') { e.preventDefault(); memoryAct('open'); return true; }
  if (k === 'r') { e.preventDefault(); memRefresh(); return true; }
  if (k === 'a') { e.preventDefault(); memoryAct('auto'); return true; }
  if (k === 'f' && MEM.channel === 'notes') { e.preventDefault(); memoryAct('filter'); return true; }
  if (k === '[') { e.preventDefault(); memoryAct('cycle:-1'); return true; }
  if (k === ']') { e.preventDefault(); memoryAct('cycle:1'); return true; }
  if (k >= '1' && k <= '6' && k.length === 1) { if (!MEM.available[+k - 1]) return false; e.preventDefault(); memoryAct('jump:' + k); return true; }
  return false;
}

/* ---------------- MCP tab (mcp-panel.tsx, mcp-list.tsx, mcp-detail.tsx,
   mcp-add-modal.tsx, mcp-remove-modal.tsx, mcp-orchestrator.ts,
   persist-mcp-server.ts) ---------------- */

function mcpServers() { return (LIVE_CONFIG && LIVE_CONFIG.mcp && Array.isArray(LIVE_CONFIG.mcp.servers)) ? LIVE_CONFIG.mcp.servers : []; }
function mcpToolsFor(name) {
  const tools = (LIVE_CAPS && Array.isArray(LIVE_CAPS.tools)) ? LIVE_CAPS.tools : [];
  const prefix = 'mcp.' + name + '.';
  return tools.filter((t) => t && typeof t.name === 'string' && t.name.startsWith(prefix)).map((t) => ({rawName:t.name.slice(prefix.length), description:t.description || ''}));
}
/* mcp-orchestrator.ts buildRows, minus the live status: there is no MCP
   status route on this agent, so an enabled server's state is `—`, never
   an inferred up/down; resource and prompt counts are not exposed either. */
function mcpRows() {
  return mcpServers().map((cfg) => ({
    name:String(cfg.name || ''), description:cfg.description || '', enabled:cfg.enabled !== false,
    state:cfg.enabled === false ? 'disabled' : '—', trust:cfg.trust === 'pure_read' ? 'pure_read' : 'approval_gated',
    transportKind:(cfg.transport && cfg.transport.kind) || '—', toolCount:mcpToolsFor(String(cfg.name || '')).length,
  }));
}
function mcpVisible() { return !!S.settings && settingsPaneId(S.settingsPane) === 'mcp'; }
function mcpTyping() { const el = document.activeElement; return !!el && el.id === 'mcp-json'; }
function ensureMcpPoll() {
  if (!BR || MCP.timer) return;
  MCP.timer = setInterval(() => {
    if (!mcpVisible()) { clearInterval(MCP.timer); MCP.timer = null; return; }
    if (MCP.auto && !MCP.addModal && !MCP.removeConfirm) mcpRefresh(true);
  }, 5000);
}
function mcpTabEntered() {
  if (MCP.timer) { clearInterval(MCP.timer); MCP.timer = null; }
  ensureMcpPoll();
  if (MCP.lastRefreshedAt === null && !MCP.loading) mcpRefresh();
}
/* GET /api/config (the user file, the same source as loadResources) +
   /api/capabilities for the registered `mcp.<name>.*` tools. */
async function mcpRefresh(quiet) {
  if (!BR) return;
  if (MCP.inflight) { if (quiet) return; await MCP.inflight; } // a poll in flight: an explicit refresh waits for it, a poll is skipped
  MCP.inflight = mcpRefreshRun(quiet);
  try { await MCP.inflight; } finally { MCP.inflight = null; }
}
async function mcpRefreshRun(quiet) {
  MCP.loading = true; MCP.lastError = null;
  if (!quiet) render();
  const before = JSON.stringify(mcpRows());
  const [cfg, caps] = await Promise.all([BR.config(), BR.capabilities()]);
  MCP.loading = false;
  if (cfg && cfg.ok && cfg.data && cfg.data.config) LIVE_CONFIG = cfg.data.config;
  else MCP.lastError = 'mcp refresh failed: ' + ((cfg && cfg.error) || 'config unavailable');
  if (caps && caps.ok && caps.data) LIVE_CAPS = caps.data;
  MCP.lastRefreshedAt = Date.now();
  if (quiet && (mcpTyping() || before === JSON.stringify(mcpRows()))) {
    const st = document.querySelector('#settings .mcpstatus');
    if (st) st.textContent = mcpStatusLine();
    return;
  }
  if (mcpVisible()) paneRepaintKeepFocus(mcpTab()); else if (!quiet) render();
  if (S.settings) { const tab = document.querySelector('#settings .settab.on'); if (tab && mcpVisible()) tab.textContent = 'MCP' + tabSuffix('mcp'); }
}
function mcpStatusLine() {
  return [MCP.loading ? 'loading' : null, MCP.auto ? 'auto' : 'manual',
    MCP.lastRefreshedAt ? 'refreshed ' + new Date(MCP.lastRefreshedAt).toLocaleTimeString() : null,
    mcpRows().length + ' servers'].filter(Boolean).join(' · ');
}
function mcpHint() {
  if (MCP.addModal) return 'Enter submit · Esc cancel · paste JSON of one MCP server';
  if (MCP.removeConfirm) return 'y / Enter confirm · n / Esc cancel';
  if (MCP.mode === 'list') return tuiHints(['j/k move', ['Enter open', 'mcp:detail'], ['n add', 'mcp:add'], ['d remove', 'mcp:remove'], ['r refresh', 'mcp:refresh'], ['a auto', 'mcp:auto']]);
  return tuiHints([['Esc back', 'mcp:back'], ['1/2/3 tools/res/prompts', 'mcp:dtab:cycle'], ['[ ] cycle', 'mcp:dtab:cycle'], ['d remove', 'mcp:remove'], ['r refresh', 'mcp:refresh']]);
}
function mcpTab() {
  ensureMcpPoll();
  const rows = mcpRows();
  const hint = mcpHint();
  return '<div class="tui"><div class="ter mcpstatus">' + esc(mcpStatusLine()) + '</div>'
    + (hint.startsWith('<') ? hint : '<div class="ter">' + esc(hint) + '</div>')
    + (MCP.lastError ? '<div class="tuierr">! ' + esc(MCP.lastError) + '</div>' : '')
    + (MCP.msg ? (MCP.msg.restart ? '<div class="tuimsg" style="margin-top:6px">' + esc(MCP.msg.text) + ' <button class="btn btn-s" data-act="agent:restart" style="height:22px">Restart Agent Runtime</button></div>' : '<div class="tuimsg">' + esc(MCP.msg.text) + '</div>') : '')
    + (!rows.length ? '<div class="ter" style="margin-top:6px">no MCP servers configured — add entries under `mcp.servers[]` in config.json</div>' : '')
    + (MCP.addModal ? mcpAddModalHTML() : (MCP.mode === 'list' ? mcpListHTML(rows) : mcpDetailHTML()) + (MCP.removeConfirm ? mcpRemoveModalHTML() : ''))
    + '</div>';
}
function mcpPad(text, width) { text = String(text); return text.length >= width ? text.slice(0, width - 1) + ' ' : text.padEnd(width); }
function mcpListHTML(rows) {
  if (!rows.length) return '<div class="ter" style="margin-top:6px">(no servers)</div>';
  const cur = Math.max(0, Math.min(MCP.cursor, rows.length - 1));
  const start = Math.max(0, Math.min(rows.length - MCP_MAX_ROWS, Math.max(0, cur - Math.floor(MCP_MAX_ROWS / 2))));
  const slice = rows.slice(start, Math.min(rows.length, start + MCP_MAX_ROWS));
  const note = rows.some((r) => r.enabled) ? '<div class="ter" style="margin-top:6px">state not exposed — no MCP status route in this agent</div>' : '';
  return '<div style="margin-top:6px">' + slice.map((r, idx) => {
    const i = idx + start, sel = i === cur;
    // Row: `> name(18)[state](11)transport(18)trust(16)<t> tools · — res · — prompts`, then the description
    return '<button class="tuirow tuirow2' + (sel ? ' on' : '') + '" data-mcp-row="' + esc(r.name) + '" data-act="mcp:detail:' + esc(r.name) + '">'
      + '<span>' + (sel ? '&gt;' : ' ') + ' <b>' + esc(mcpPad(r.name, 18)) + '</b>'
      + '<span class="' + (r.state === 'disabled' ? 'ter' : 'ter') + '" title="' + (r.state === 'disabled' ? 'disabled in config.json' : 'state not exposed — no MCP status route in this agent') + '">' + esc(mcpPad('[' + r.state + ']', 11)) + '</span>'
      + '<span class="ter">' + esc(mcpPad(r.transportKind, 18) + mcpPad(r.trust, 16) + r.toolCount + ' tools · — res · — prompts') + '</span></span>'
      + (r.description ? '<span class="ter">  ' + esc(r.description) + '</span>' : '') + '</button>';
  }).join('') + '</div>' + note;
}
function mcpDescribeTransport(cfg) {
  const t = cfg.transport || {};
  if (t.kind === 'stdio') {
    const args = Array.isArray(t.args) && t.args.length ? ' ' + t.args.join(' ') : '';
    return 'stdio: ' + t.command + args + (t.cwd ? ' (cwd: ' + t.cwd + ')' : '');
  }
  if (t.kind === 'streamable_http') return 'streamable_http: ' + t.url;
  if (t.kind === 'sse') return 'sse: ' + t.url;
  return String(t.kind || '—');
}
function mcpDetailHTML() {
  const cfg = mcpServers().find((s) => s.name === MCP.detailName);
  if (!cfg) return '<div class="ter" style="margin-top:6px">(no server selected)</div>';
  const row = mcpRows().find((r) => r.name === cfg.name);
  const tools = mcpToolsFor(cfg.name);
  const counts = {tools:String(tools.length), resources:'—', prompts:'—'};
  const bar = MCP_TAB_ORDER.map((tab, idx) => {
    const label = (idx + 1) + ':' + tab + '(' + counts[tab] + ')';
    return '<button class="memch' + (tab === MCP.detailTab ? ' on' : '') + '" data-act="mcp:dtab:' + tab + '">' + esc(tab === MCP.detailTab ? '[' + label + ']' : label) + '</button>';
  }).join('<span class="ter">  </span>');
  let body;
  if (MCP.detailTab !== 'tools') body = '<div class="ter">not exposed by the agent\'s HTTP API</div>';
  else if (!tools.length) body = '<div class="ter">(empty)</div>';
  else {
    const cur = Math.max(0, Math.min(MCP.detailCursor, tools.length - 1));
    const start = Math.max(0, Math.min(tools.length - MCP_MAX_ROWS, Math.max(0, cur - Math.floor(MCP_MAX_ROWS / 2))));
    body = tools.slice(start, start + MCP_MAX_ROWS).map((t, idx) => {
      const sel = idx + start === cur;
      // mcp-detail.tsx formatTool prints `rawName (resourceClass)`; the resource class is not on /api/capabilities.
      return '<div class="' + (sel ? 'tuimsg' : '') + '">' + (sel ? '&gt; ' : '  ') + esc(t.rawName) + '</div>' + (t.description ? '<div class="ter">  ' + esc(t.description) + '</div>' : '');
    }).join('') + '<div class="ter">(resource class is not exposed by the agent\'s HTTP API)</div>';
  }
  return '<div style="margin-top:6px"><b>' + esc(cfg.name) + ' </b><span class="ter" title="' + (row && row.state === 'disabled' ? 'disabled in config.json' : 'state not exposed — no MCP status route in this agent') + '">[' + esc(row ? row.state : '—') + ']</span><span class="ter"> · trust: ' + esc(row ? row.trust : 'approval_gated') + '</span></div>'
    + (cfg.description ? '<div class="ter">' + esc(cfg.description) + '</div>' : '')
    + '<div class="ter">' + esc(mcpDescribeTransport(cfg)) + '</div>'
    + (row && row.enabled ? '<div class="ter">state not exposed — no MCP status route in this agent</div>' : '')
    + '<div class="tuibar" style="margin-top:8px">' + bar + '</div>'
    + '<div style="margin-top:8px">' + body + '</div>';
}
function mcpAddModalHTML() {
  const m = MCP.addModal;
  return '<div class="tuimodal' + (m.error ? ' danger' : '') + '" style="margin-top:8px"><b>+ add MCP server</b>'
    + '<div class="ter" style="margin-top:8px">Paste one MCP server config as JSON. Bare object, or the Claude Desktop / Cursor envelope `{ "mcpServers": { ... } }`.</div>'
    + '<div class="ter">Top-level `command` + `args` (no `transport` wrapper) is also accepted and auto-promoted to stdio.</div>'
    + '<textarea id="mcp-json" class="tuiarea" rows="6" spellcheck="false" placeholder=\'{"mcpServers":{"github":{"command":"npx","args":["-y","@github/mcp-server"]}}}\'' + (m.submitting ? ' disabled' : '') + '>' + esc(m.json) + '</textarea>'
    + (m.error ? '<div class="tuierr" style="margin-top:8px">! ' + esc(m.error) + '</div>' : '')
    + (m.submitting ? '<div class="ter" style="margin-top:8px">writing config…</div>' : '')
    + '<div class="tuihint">' + tuiBtn('Enter: submit', 'mcp:addSubmit', {disabled: m.submitting}) + '<span>· Shift/Alt+Enter: newline ·</span>' + tuiBtn('Esc: cancel', 'mcp:addCancel') + '<span>· restart atomic-agent for the new server to connect</span></div>'
    + '</div>';
}
function mcpRemoveModalHTML() {
  const c = MCP.removeConfirm;
  return '<div class="tuimodal' + (c.error ? ' danger' : ' warn') + '"><b style="color:var(--' + (c.error ? 'danger' : 'warn') + ')">remove MCP server?</b>'
    + '<div><span class="ter">name:</span> ' + esc(c.name) + '</div>'
    + '<div class="ter">rewrites config.json; restart atomic-agent to drop the live connection.</div>'
    + (c.error ? '<div class="tuierr">! ' + esc(c.error) + '</div>' : '')
    + (c.submitting ? '<div class="ter">working…</div>' : '<div class="tuihint">' + tuiBtn('y / Enter = confirm', 'mcp:removeConfirm') + '<span>·</span>' + tuiBtn('n / Esc = keep', 'mcp:removeCancel') + '</div>')
    + '</div>';
}
/* persist-mcp-server.ts parseAddServerJson: the three accepted shapes —
   a bare object, the `{ mcpServers: { name: {…} } }` envelope with exactly
   one entry, and the `command`/`args` (or `url`/`serverUrl`) shortcut
   promoted into `transport`. The schema itself (name regex, transport
   shape, trust enum) is checked by the CLI on the write. */
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
  if (!trimmed.length) return {ok:false, error:'JSON is empty'};
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch (err) { return {ok:false, error:'invalid JSON: ' + (err && err.message ? err.message : String(err))}; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {ok:false, error:'expected a JSON object'};
  let candidate;
  const envelope = parsed.mcpServers;
  if (envelope !== undefined) {
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return {ok:false, error:'`mcpServers` must be an object keyed by server name'};
    const entries = Object.entries(envelope);
    if (!entries.length) return {ok:false, error:'`mcpServers` is empty — paste exactly one server'};
    if (entries.length > 1) return {ok:false, error:'paste exactly one server — got ' + entries.length + ' entries in `mcpServers`'};
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
/* The write: read the user file right before, append, whole-file
   `atag config set '<json>'` through cli:configSetPath (mcp.servers has no
   leaf spelling). The CLI validates the file and answers with its own
   error text on a bad entry. The running agent is not touched — the modal's
   footer and the success line say to restart. */
async function mcpAddSubmit(json) {
  const m = MCP.addModal;
  if (!BR || !m || m.submitting) return {ok:false, error:'no add modal'};
  m.json = json; m.error = null;
  const parsed = mcpParseAddJson(json);
  if (!parsed.ok) { m.error = parsed.error; render(); return parsed; }
  m.submitting = true; render();
  const cfg = await BR.config();
  const servers = cfg && cfg.ok && cfg.data && cfg.data.config && cfg.data.config.mcp && Array.isArray(cfg.data.config.mcp.servers) ? cfg.data.config.mcp.servers : mcpServers();
  if (servers.some((s) => s && s.name === parsed.server.name)) {
    m.submitting = false; m.error = 'server ' + JSON.stringify(parsed.server.name) + ' already exists in config.mcp.servers'; render(); return {ok:false, error:m.error};
  }
  const res = await BR.configSetPath('mcp.servers', servers.concat([parsed.server]));
  m.submitting = false;
  if (!res || res.ok === false) { m.error = (res && res.error) || 'config write failed'; render(); return {ok:false, error:m.error}; }
  MCP.addModal = null;
  MCP.msg = {text:'mcp: added ' + JSON.stringify(parsed.server.name) + ' (config.json updated, ' + (servers.length + 1) + ' total) — restart atomic-agent for the new server to connect', restart:true};
  await mcpRefresh();
  return {ok:true, name:parsed.server.name};
}
async function mcpRemoveConfirm() {
  const c = MCP.removeConfirm;
  if (!BR || !c || c.submitting) return;
  c.submitting = true; c.error = null; render();
  const cfg = await BR.config();
  const servers = cfg && cfg.ok && cfg.data && cfg.data.config && cfg.data.config.mcp && Array.isArray(cfg.data.config.mcp.servers) ? cfg.data.config.mcp.servers : mcpServers();
  const idx = servers.findIndex((s) => s && s.name === c.name);
  if (idx === -1) { c.submitting = false; c.error = 'server ' + JSON.stringify(c.name) + ' not found in config.mcp.servers'; render(); return; }
  const next = servers.slice(0, idx).concat(servers.slice(idx + 1));
  const res = await BR.configSetPath('mcp.servers', next);
  c.submitting = false;
  if (!res || res.ok === false) { c.error = (res && res.error) || 'config write failed'; render(); return; }
  MCP.removeConfirm = null;
  if (MCP.mode === 'detail' && MCP.detailName === c.name) { MCP.mode = 'list'; MCP.detailName = null; }
  MCP.msg = {text:'mcp: removed ' + JSON.stringify(c.name) + ' (config.json updated, ' + next.length + ' remaining) — restart atomic-agent to drop the live connection', restart:true};
  await mcpRefresh();
}
function mcpAct(what) {
  const [verb, ...rest] = what.split(':');
  const arg = rest.join(':');
  const rows = mcpRows();
  const sel = () => arg || (MCP.mode === 'detail' ? MCP.detailName : (rows[Math.max(0, Math.min(MCP.cursor, rows.length - 1))] || {}).name);
  if (verb === 'detail') { const name = sel(); if (!name) return; MCP.detailName = name; MCP.mode = 'detail'; MCP.detailTab = 'tools'; MCP.detailCursor = 0; const i = rows.findIndex((r) => r.name === name); if (i >= 0) MCP.cursor = i; render(); return; }
  if (verb === 'back') { MCP.mode = 'list'; MCP.detailName = null; render(); return; }
  if (verb === 'dtab') {
    if (arg === 'cycle' || arg === 'cycle:-1') { const d = arg === 'cycle:-1' ? -1 : 1; MCP.detailTab = MCP_TAB_ORDER[(MCP_TAB_ORDER.indexOf(MCP.detailTab) + d + 3) % 3]; }
    else if (MCP_TAB_ORDER.includes(arg)) MCP.detailTab = arg;
    MCP.detailCursor = 0; render(); return;
  }
  if (verb === 'add') { MCP.addModal = {json:'', error:null, submitting:false}; MCP.removeConfirm = null; render(); const n = $('#mcp-json'); if (n) n.focus(); return; }
  if (verb === 'addSubmit') { const n = $('#mcp-json'); mcpAddSubmit(n ? n.value : (MCP.addModal ? MCP.addModal.json : '')); return; }
  if (verb === 'addCancel') { MCP.addModal = null; render(); return; }
  if (verb === 'remove') { const name = sel(); if (!name) return; MCP.removeConfirm = {name, error:null, submitting:false}; render(); return; }
  if (verb === 'removeConfirm') { mcpRemoveConfirm(); return; }
  if (verb === 'removeCancel') { MCP.removeConfirm = null; render(); return; }
  if (verb === 'refresh') { mcpRefresh(); return; }
  if (verb === 'auto') { MCP.auto = !MCP.auto; render(); return; }
}
/* mcp-key-bindings.ts. The add modal's textarea keeps Enter for submit and
   Shift/Alt+Enter for a newline, as the TUI's MultiLineEditor does. */
function mcpKey(e, k, inText) {
  if (e.target.id === 'mcp-json') {
    if (k === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); mcpAddSubmit(e.target.value); return true; }
    if (k === 'Escape') { e.preventDefault(); MCP.addModal = null; render(); return true; }
    return false;
  }
  if (inText) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (MCP.addModal) { if (k === 'Escape') { e.preventDefault(); MCP.addModal = null; render(); return true; } return false; }
  if (MCP.removeConfirm) {
    if (k === 'y' || k === 'Enter') { e.preventDefault(); mcpRemoveConfirm(); return true; }
    if (k === 'n' || k === 'Escape') { e.preventDefault(); MCP.removeConfirm = null; render(); return true; }
    return true;
  }
  if (MCP.mode === 'detail') {
    if (k === 'Escape') { e.preventDefault(); mcpAct('back'); return true; }
    if (k === '1' || k === '2' || k === '3') { e.preventDefault(); mcpAct('dtab:' + MCP_TAB_ORDER[+k - 1]); return true; }
    if (k === '[') { e.preventDefault(); mcpAct('dtab:cycle:-1'); return true; }
    if (k === ']') { e.preventDefault(); mcpAct('dtab:cycle'); return true; }
    if (k === 'd') { e.preventDefault(); mcpAct('remove'); return true; }
    if (k === 'r') { e.preventDefault(); mcpRefresh(); return true; }
    const n = MCP.detailTab === 'tools' ? mcpToolsFor(MCP.detailName || '').length : 0;
    if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); MCP.detailCursor = Math.min(MCP.detailCursor + 1, Math.max(0, n - 1)); render(); return true; }
    if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); MCP.detailCursor = Math.max(MCP.detailCursor - 1, 0); render(); return true; }
    return false;
  }
  const rows = mcpRows();
  if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); MCP.cursor = Math.min(MCP.cursor + 1, Math.max(0, rows.length - 1)); render(); return true; }
  if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); MCP.cursor = Math.max(MCP.cursor - 1, 0); render(); return true; }
  if (k === 'Enter') { e.preventDefault(); mcpAct('detail'); return true; }
  const map = {n:'add', d:'remove', r:'refresh', a:'auto'};
  if (map[k]) { e.preventDefault(); mcpAct(map[k]); return true; }
  return false;
}

/* Hooks for --smoke (Item 7 part B: the Skills, Memory and MCP tabs). */
if (typeof window !== 'undefined') {
  window.__skillsRows = () => (SK.rows ? SK.rows.length : 0); // every `atag skill list` row, as loaded (the list paints a 14-row window of them)
  window.__skillsWindow = () => ({painted: document.querySelectorAll('#settings [data-skill-row]').length, visible: skpVisibleRows().length, max: SKP_MAX_ROWS,
    above: (document.querySelector('#settings [data-act="skills:page:up"]') || {}).textContent || '', below: (document.querySelector('#settings [data-act="skills:page:down"]') || {}).textContent || ''});
  window.__skillsState = () => ({mode: SKP.mode, cursor: SKP.cursor, filter: SKP.filter, auto: SKP.auto, busy: SKP.busy, detailName: SKP.detailName,
    detailBody: SKP.detailBody, detailSource: SKP.detailSource, lastError: SKP.lastError, msg: SKP.msg ? SKP.msg.text : '', restart: !!(SKP.msg && SKP.msg.restart),
    hubRows: SKP.hubRows.map((r) => ({identifier: r.identifier, source: r.source, downloads: r.downloads})), hubLoading: SKP.hubLoading, hubError: SKP.hubError,
    hubCard: SKP.hubCard ? {identifier: SKP.hubCard.identifier, name: SKP.hubCard.name, repo: SKP.hubCard.repo, version: SKP.hubCard.version,
      bodyLines: SKP.hubCard.body === null ? 0 : SKP.hubCard.body.split('\n').length, bodyError: SKP.hubCard.bodyError, installId: SKP.hubCard.installId} : null,
    hubCardLoading: SKP.hubCardLoading, installConfirm: SKP.installConfirm, removeConfirm: SKP.removeConfirm ? Object.assign({}, SKP.removeConfirm) : null, installError: SKP.installError});
  window.__skillsAct = (what) => { skillsAct(what); return window.__skillsState(); };
  // --smoke: stand in for GET /api/skills/{name} (e.g. {ok:false, error:'404'}) so skpOpenDetail's `atag skill show` branch runs; null restores the route.
  window.__skillsRouteOverride = (res) => { SKP.routeOverride = res === undefined ? null : res; return SKP.routeOverride; };
  window.__memory = () => ({channel: MEM.channel, channels: MEM.available.slice(), rows: MEM.rows.length, mode: MEM.mode, hint: MEM.channelHint, error: MEM.lastError,
    refreshed: MEM.lastRefreshedAt, notesFilter: MEM.notesFilter, linksOn: memFlag('links'), expandRuns: MEM.expandRuns, expandQueries: MEM.expandQueries,
    stateDir: memStateDir(), detail: MEM.detail ? {channel: MEM.detail.channel, id: MEM.detail.id, key: MEM.detail.key, body: MEM.detail.body,
      expanded: MEM.detail.expandedNeighbors ? MEM.detail.expandedNeighbors.slice() : null, expandedAt: MEM.detail.expandedAt || null,
      outgoing: MEM.detail.outgoing ? MEM.detail.outgoing.map((n) => n.memoryId) : null} : null});
  window.__memoryOpen = async (channel) => { memSetChannel(channel); await memRefresh(); return window.__memory(); };
  window.__memoryRefresh = async () => { await memRefresh(); return window.__memory(); };
  window.__memoryDetail = async (i) => { const row = memVisibleRows()[i || 0]; if (!row) return null; await memOpenDetail(row); return window.__memory(); };
  window.__memoryExpand = async () => { await memExpandNeighbors(); return window.__memory(); };
  window.__memoryAct = (what) => { memoryAct(what); return window.__memory(); };
  window.__memQuery = (name, params) => (BR && memStateDir() ? BR.memoryQuery(memStateDir(), name, params || []) : Promise.resolve({ok:false, error:'no bridge or state dir'}));
  window.__mcp = () => ({mode: MCP.mode, rows: mcpRows().length, servers: mcpServers().map((s) => s && s.name), detailName: MCP.detailName, detailTab: MCP.detailTab,
    addModal: MCP.addModal ? Object.assign({}, MCP.addModal) : null, removeConfirm: MCP.removeConfirm ? Object.assign({}, MCP.removeConfirm) : null,
    msg: MCP.msg ? MCP.msg.text : '', lastError: MCP.lastError, refreshed: MCP.lastRefreshedAt});
  window.__mcpParse = (json) => mcpParseAddJson(json);
  window.__mcpAct = (what) => { mcpAct(what); return window.__mcp(); };
  window.__mcpAddSubmit = async (json) => { if (!MCP.addModal) mcpAct('add'); const r = await mcpAddSubmit(json); return Object.assign({}, r, {state: window.__mcp()}); };
  window.__mcpRemove = async (name) => { mcpAct('remove:' + name); await mcpRemoveConfirm(); return window.__mcp(); };
  window.__mcpRefresh = async () => { await mcpRefresh(); return window.__mcp(); };
}

/* ============================================================
   Item 7 part C — the LLM, Telegram and Import tabs
   ============================================================ */

/* ---------------- LLM tab (llm-panel.tsx, llm-mode-rows.tsx, llm-panel-row-builders.ts,
   llm-panel-selectors.ts, llm-panel-primary-actions.ts, llm-fallback-rows.tsx,
   fallback-panel-selectors.ts, fallback-chain-edits.ts, llm-panel-modals.tsx,
   local-llm-logs-panel.tsx, llm-panel-key-bindings.ts) ---------------- */

function llmVisible() { return !!S.settings && settingsPaneId(S.settingsPane) === 'llm'; }
/* persist-llm-provider.ts readLlmBlockOrDefault: a user file without an
   `llm` block routes at the built-in local-llama entry. */
function llmBlock() {
  const llm = LIVE_CONFIG && LIVE_CONFIG.llm;
  if (llm && Array.isArray(llm.providers)) return llm;
  const lm = (LIVE_CONFIG && LIVE_CONFIG.localModels) || {};
  const url = lm.mode === 'managed' ? 'http://127.0.0.1:' + ((lm.managed && lm.managed.port) || 19091) : (lm.url || 'http://127.0.0.1:8080');
  return {activeTextProvider:'local-llama', activeEmbeddingProvider:'local-llama', toolTransport:'auto', providers:[{id:'local-llama', kind:'llama-server', url}]};
}
function llmProviders() { return (llmBlock().providers || []).filter((p) => p && typeof p.id === 'string'); }
function llmCloudProviders() { return llmProviders().filter((p) => p.kind !== 'llama-server'); }
function llmActiveTextId() { return llmBlock().activeTextProvider || 'local-llama'; }
function llmActiveEmbId() { return llmBlock().activeEmbeddingProvider || 'local-llama'; }
function llmProvider(id) { return llmProviders().find((p) => p.id === id) || null; }
function llmLocalActive() { const p = llmProvider(llmActiveTextId()); return !!p && p.kind === 'llama-server'; }
function llmLocalEmbActive() { const p = llmProvider(llmActiveEmbId()); return !!p && p.kind === 'llama-server'; }
function llmLocalModels() { return (LIVE_CONFIG && LIVE_CONFIG.localModels) || {}; }
function llmManaged() { return llmLocalModels().managed || {}; }
function llmEmbCfg() { return llmLocalModels().embeddings || {}; }
/* src/config/resolve-llm-api-key.ts: the entry's own key, its
   apiKeyEnvVar, else the kind's shared variable(s); a subscription-CLI
   entry authenticates through its CLI. */
function llmKeyEnvNames(p) {
  if (p.apiKeyEnvVar) return [p.apiKeyEnvVar];
  if (p.kind === 'openrouter') return ['OPENROUTER_API_KEY'];
  if (p.kind === 'aimlapi') return ['AIMLAPI_API_KEY'];
  if (p.kind === 'gemini') return ['GEMINI_API_KEY'];
  if (p.kind === 'openai-compatible' || p.kind === 'qwen-openai-compatible') return ['OPENAI_COMPAT_API_KEY', 'OPENAI_API_KEY', 'ATOMIC_AGENT_OPENAI_API_KEY'];
  return [];
}
function llmKeyNamesPresent() { return new Set([].concat(LLMP.envKeys || [], LLMP.dotenvKeys || [])); }
function llmHasKey(p) {
  if (p.kind === 'subscription-cli') return true;
  if (p.apiKey && String(p.apiKey).length) return true;
  const present = llmKeyNamesPresent();
  return llmKeyEnvNames(p).some((n) => present.has(n));
}
function llmKeysKnown() { return LLMP.envKeys !== null && LLMP.dotenvKeys !== null; }
function llmDaemonPort() {
  const st = LLMP.status;
  if (st && st.daemonUrl) { try { return new URL(st.daemonUrl).port || '19091'; } catch (err) { /* fall through */ } }
  return String(llmManaged().port || 19091);
}
/* llm-panel.tsx formatDaemon, from `atag models status` (daemon: running (pid N) | stopped; health: ok | …). */
function llmFormatDaemon() {
  if (LLMP.daemonPhase === 'starting') return 'starting';
  if (LLMP.daemonPhase === 'stopping') return 'stopping';
  const st = LLMP.status;
  if (!st) return LLMP.statusErr ? 'unknown' : '…';
  if (!st.daemonRunning) return 'stopped';
  const health = String(st.health || '').toLowerCase();
  if (/loading/.test(health)) return 'loading pid ' + st.daemonPid;
  if (health === 'ok') return 'running pid ' + st.daemonPid + ' on 127.0.0.1:' + llmDaemonPort();
  return 'pid ' + st.daemonPid + ' health unreachable';
}
function llmDaemonUp() { const st = LLMP.status; return LLMP.daemonPhase === 'starting' || !!(st && st.daemonRunning); }
function llmDaemonHealthy() { const st = LLMP.status; return !!(st && st.daemonRunning && String(st.health || '').toLowerCase() === 'ok'); }
function llmEmbDaemonHealthy() { const d = LLMP.embDaemon; return !!(d && d.running && String(d.health || '').toLowerCase() === 'ok'); }

/* --- data --- */
function llmTabEntered() {
  if (LLMP.timer) { clearInterval(LLMP.timer); LLMP.timer = null; }
  llmEnsurePoll();
  if (LLMP.lastRefreshedAt === null && !LLMP.inflight) llmRefresh();
  else if (!LLMP.inflight) llmRefreshStatus();
}
/* local-models-orchestrator refreshes the daemon status every 5 s while the tab is open; here that is one `atag models status` subprocess per tick. */
function llmEnsurePoll() {
  if (!BR || LLMP.timer) return;
  LLMP.timer = setInterval(() => {
    if (!llmVisible()) { clearInterval(LLMP.timer); LLMP.timer = null; llmStopLogs(); return; }
    if (LLMP.view === 'panel' && !LLMP.inflight && !LLMP.pulling && !LLMP.daemonPhase && !LLMP.statusBusy && !llmTyping()) llmRefreshStatus(true);
  }, 5000);
}
function llmTyping() { const el = document.activeElement; return !!el && (el.id === 'llm-filter' || el.id === 'llm-url' || el.id === 'wiz-key' || el.id === 'wiz-url' || el.id === 'sel-key'); }
async function llmRefresh() {
  if (!BR) return;
  if (LLMP.inflight) return LLMP.inflight;
  LLMP.inflight = llmRefreshRun();
  try { await LLMP.inflight; } finally { LLMP.inflight = null; }
}
async function llmRefreshRun() {
  const seq = ++LLMP.seq;
  LLMP.localBusy = true; LLMP.localErr = null; LLMP.busy = true;
  llmRepaint();
  const stateDir = memStateDir();
  const names = new Set(['TELEGRAM_BOT_TOKEN', 'ATOMIC_AGENT_LLAMA_API_KEY']);
  llmProviders().forEach((p) => llmKeyEnvNames(p).forEach((n) => names.add(n)));
  Object.keys(PROVIDER_KEY_ENV_FALLBACK).forEach((k) => names.add(PROVIDER_KEY_ENV_FALLBACK[k]));
  const [cfg, list, emb, status, health, env, dotenv] = await Promise.all([
    BR.configGet(), BR.chatModelsList(), BR.modelsListEmbeddings(), BR.modelsStatus(), BR.health(),
    BR.envPresent([...names]), stateDir ? BR.dotenvKeys(stateDir) : Promise.resolve({ok:true, keys:[]}),
  ]);
  if (seq !== LLMP.seq) return;
  if (cfg && cfg.ok && cfg.config) LIVE_CONFIG = cfg.config;
  LLMP.localBusy = false; LLMP.busy = false; LLMP.lastRefreshedAt = Date.now();
  if (list && list.ok) { LLMP.local = list.models; } // the chat catalog (chatModelsList subtracts list-embeddings); embeddings come from list-embeddings
  else { LLMP.local = LLMP.local || []; LLMP.localErr = (list && list.error) || 'could not read the catalogue'; }
  if (emb && emb.ok) { LLMP.emb = emb.models; LLMP.embDaemon = emb.daemon || null; }
  else { LLMP.emb = LLMP.emb || []; if (!LLMP.localErr) LLMP.localErr = (emb && emb.error) || 'could not read the embedding catalogue'; }
  llmApplyStatus(status);
  LLMP.health = health && health.ok && health.data && health.data.llama ? health.data.llama : null;
  LLMP.envKeys = Array.isArray(env) ? env : [];
  LLMP.dotenvKeys = dotenv && dotenv.ok ? dotenv.keys : [];
  llmClampCursors();
  llmRepaint();
  llmEnsureModels();
}
function llmApplyStatus(status) {
  if (status && status.ok && status.status) { LLMP.status = status.status; LLMP.statusErr = null; }
  else { LLMP.statusErr = (status && status.error) || 'models status failed'; }
}
async function llmRefreshStatus(quiet) {
  if (!BR || LLMP.statusBusy) return;
  LLMP.statusBusy = true;
  const before = JSON.stringify([LLMP.status, LLMP.statusErr, LLMP.health]);
  const [status, health] = await Promise.all([BR.modelsStatus(), BR.health()]);
  LLMP.statusBusy = false;
  llmApplyStatus(status);
  LLMP.health = health && health.ok && health.data && health.data.llama ? health.data.llama : null;
  if (!quiet || before !== JSON.stringify([LLMP.status, LLMP.statusErr, LLMP.health])) llmRepaint();
}
/* The Cloud text-models block lists the active (or first) cloud provider's catalogue. */
function llmCloudSectionProvider() {
  const cloud = llmCloudProviders();
  return cloud.find((p) => p.id === llmActiveTextId()) || cloud[0] || null;
}
async function llmEnsureModels() {
  const p = llmCloudSectionProvider();
  if (!p || !BR) return;
  if (LLMP.modelsFor === p.id && (LLMP.modelsBusy || LLMP.models.length || LLMP.modelsErr)) return;
  LLMP.modelsFor = p.id; LLMP.models = []; LLMP.modelsBusy = true; LLMP.modelsErr = null;
  llmRepaint();
  const res = await BR.providerModels(p.id, p.kind || '');
  if (LLMP.modelsFor !== p.id) return;
  LLMP.modelsBusy = false;
  if (!res || !res.ok) LLMP.modelsErr = (res && res.error) || 'could not list models';
  else LLMP.models = res.models || [];
  llmClampCursors();
  llmRepaint();
}
function llmRepaint() { if (llmVisible()) paneRepaintKeepFocus(llmTab()); }
/* Only the model list repaints on a filter keystroke (the input keeps its caret). */
function llmRepaintList() {
  const box = document.getElementById('llm-cloud-models');
  if (!box) { llmRepaint(); return; }
  box.innerHTML = llmCloudModelListHTML();
}

/* --- rows (llm-panel-row-builders.ts) --- */
function llmLocalRows() {
  const rows = [];
  const localActive = llmLocalActive();
  const daemonWorks = llmDaemonHealthy();
  (LLMP.local || []).forEach((m) => {
    const active = localActive && m.active && daemonWorks;
    const pull = LLMP.pulling && LLMP.pulling.kind === 'chat' && LLMP.pulling.id === m.id;
    let primary, effect;
    if (pull) { primary = 'downloading'; effect = 'Downloading…'; }
    else if (!m.downloaded) { primary = 'download'; effect = 'Enter: download'; }
    else if (!localActive || !m.active) { primary = 'use'; effect = 'Enter: select model'; }
    else { const running = llmDaemonUp(); primary = running ? 'current' : 'start'; effect = running ? 'Current: local-llama/' + m.id : 'Enter: start local daemon for ' + m.id; }
    // `models list` prints DL yes/no, not the mmproj state, so a downloaded row reads [downloaded] (never the TUI's gguf+mmproj variants).
    rows.push({kind:'localTextModel', id:'local-text:' + m.id, model:m, active, primaryAction:primary, enterEffect:effect,
      text:m.id + ' ' + m.size + ' [' + (m.downloaded ? 'downloaded' : 'remote') + ']'});
  });
  const embActive = llmLocalEmbActive();
  const embWorks = llmEmbDaemonHealthy();
  const embEnabled = llmEmbCfg().enabled === true;
  (LLMP.emb || []).forEach((m) => {
    const active = embActive && m.active && embWorks;
    const pull = LLMP.pulling && LLMP.pulling.kind === 'embedding' && LLMP.pulling.id === m.id;
    let primary, effect;
    if (pull) { primary = 'downloading'; effect = 'Downloading…'; }
    else if (!m.downloaded) { primary = 'download'; effect = 'Enter: download'; }
    else if (!embActive || !m.active) { primary = 'use'; effect = 'Enter: select model'; }
    else if (!embEnabled) { primary = 'enable'; effect = 'Enter: enable local embeddings for ' + m.id; }
    else { primary = embWorks ? 'current' : 'start'; effect = embWorks ? 'Current: local embeddings/' + m.id : 'Enter: start embedding daemon for ' + m.id; }
    rows.push({kind:'localEmbeddingModel', id:'local-embedding:' + m.id, model:m, active, primaryAction:primary, enterEffect:effect,
      text:m.id + ' ' + m.size + ' [' + (m.downloaded ? 'downloaded' : 'remote') + ']'});
  });
  return rows;
}
function llmProviderRow(p) {
  const hasKey = llmHasKey(p);
  const active = p.id === llmActiveTextId();
  const auth = p.kind === 'subscription-cli' ? 'cli auth' : hasKey ? 'key ok' : 'missing key';
  return {kind:'cloudProvider', id:'cloud-provider:' + p.id, provider:p, active, available:hasKey,
    primaryAction: !hasKey ? 'configure' : active ? 'current' : 'use',
    enterEffect: !hasKey ? 'Enter: configure API key for ' + p.id : active ? 'Current provider: ' + p.id : 'Enter: switch cloud route to ' + p.id,
    text: p.id + ' [' + p.kind + '] ' + auth};
}
function llmChatRow(p, modelId) {
  const hasKey = llmHasKey(p);
  const active = p.id === llmActiveTextId() && (p.defaultChatModel || p.model) === modelId;
  // OpenRouter/AI-ML rows show formatOpenRouterChatModelDetails / formatAimlapiChatModelDetails in the TUI — an in-process catalogue
  // formatter the CLI does not print, so every kind gets the generic effect here.
  return {kind:'cloudChatModel', id:'cloud-text:' + p.id + ':' + modelId, provider:p, providerId:p.id, modelId, active, available:hasKey,
    primaryAction: !hasKey ? 'configure' : active ? 'current' : 'use',
    enterEffect: !hasKey ? 'Enter: configure ' + p.id + ' before using ' + modelId : active ? 'Current: ' + p.id + '/' + modelId : 'Enter: use ' + p.id + '/' + modelId,
    text: p.id + '/' + modelId + ' [text]'};
}
function llmEmbRow(p, modelId) {
  const hasKey = llmHasKey(p);
  const active = p.id === llmActiveEmbId() && p.defaultEmbeddingModel === modelId;
  return {kind:'cloudEmbeddingModel', id:'cloud-embedding:' + p.id + ':' + modelId, provider:p, providerId:p.id, modelId, active, available:hasKey,
    primaryAction: !hasKey ? 'configure' : active ? 'current' : 'use',
    enterEffect: !hasKey ? 'Enter: configure ' + p.id + ' before using embeddings' : active ? 'Current embedding: ' + p.id + '/' + modelId : 'Enter: use embedding ' + p.id + '/' + modelId,
    text: p.id + '/' + modelId + ' [embedding]'};
}
/* llm-panel-row-builders.ts inlineModelsForProvider: chatModelOptions + the
   current model first, then the catalogue (`atag models search --json`,
   the same list the composer's selector reads). */
function llmCloudSection() {
  const p = llmCloudSectionProvider();
  if (!p) return {provider:null, status:'ready', error:null, models:[], filtered:[], sectionStart:llmCloudProviders().length};
  const out = [];
  const add = (id) => { if (id && !out.includes(id)) out.push(id); };
  add(p.defaultChatModel || p.model);
  const chat = (LLMP.modelsFor === p.id ? LLMP.models : []).filter((m) => m && m.kind !== 'embedding');
  chat.forEach((m) => add(m.id));
  const status = LLMP.modelsFor === p.id ? (LLMP.modelsBusy ? 'loading' : LLMP.modelsErr ? 'error' : 'ready') : 'loading';
  const f = LLMP.filter.trim().toLowerCase();
  const filtered = f ? out.filter((id) => modelMatches(id, '', f)) : out;
  return {provider:p, status, error:LLMP.modelsErr, models:out, filtered, sectionStart:llmCloudProviders().length};
}
function llmCloudSectionStart() { return llmCloudProviders().length; }
function llmEmbModelsFor(p) {
  const out = [];
  if (p.defaultEmbeddingModel) out.push(p.defaultEmbeddingModel);
  (LLMP.modelsFor === p.id ? LLMP.models : []).filter((m) => m && m.kind === 'embedding').forEach((m) => { if (!out.includes(m.id)) out.push(m.id); });
  return out;
}
function llmCloudRows() {
  const rows = llmCloudProviders().map(llmProviderRow);
  const section = llmCloudSection();
  if (section.provider) {
    section.filtered.forEach((id) => rows.push(llmChatRow(section.provider, id)));
    llmEmbModelsFor(section.provider).forEach((id) => rows.push(llmEmbRow(section.provider, id)));
  }
  return rows;
}
/* The External pane is one row: an external llama.cpp IS one base URL. */
function llmExternalRows() {
  const lm = llmLocalModels();
  const active = lm.mode === 'external' && llmLocalActive();
  const url = lm.url || 'http://127.0.0.1:8080';
  return [{kind:'externalUrl', id:'external-url', url, active, available:true, primaryAction: active ? 'current' : 'use',
    enterEffect: active ? 'Enter: edit the base URL' : 'Enter: point the chat route at an external llama.cpp',
    text: 'base URL ' + url + ' [' + llmExternalStatus(active) + ']'}];
}
/* Health only describes the active route (llm-mode-rows.tsx externalStatus); the desktop's probe is /health.llama on the serve process. */
function llmExternalStatus(active) {
  if (!active) return 'not active';
  const h = LLMP.health;
  if (!h) return 'unknown';
  const status = h.reachable ? 'healthy' : 'unreachable';
  return typeof h.latencyMs === 'number' ? status + ' · ' + h.latencyMs + 'ms' : status;
}
function llmRows(mode) {
  const m = mode || LLMP.mode;
  if (m === 'cloud') return llmCloudRows();
  if (m === 'external') return llmExternalRows();
  if (m === 'fallback') return [];
  return llmLocalRows();
}
function llmClampCursors() {
  LLM_PANEL_MODES.forEach((m) => {
    const n = m === 'fallback' ? llmFallbackRows().length : llmRows(m).length;
    LLMP.cursor[m] = n ? Math.max(0, Math.min(LLMP.cursor[m], n - 1)) : 0;
  });
}
function llmRowAt(i) { const rows = llmRows(); return rows.length ? rows[Math.max(0, Math.min(i === undefined ? LLMP.cursor[LLMP.mode] : i, rows.length - 1))] : null; }

/* --- Fallback pane (fallback-config.ts resolveFallbackChain + fallback-panel-selectors.ts buildFallbackChainView, ported) --- */
function llmFallbackView() {
  const llm = llmBlock();
  const providers = llmProviders();
  const fb = llm.fallback || {};
  const appendLocal = fb.appendLocal === undefined ? true : !!fb.appendLocal;
  const explicitChain = Array.isArray(fb.chain) ? fb.chain.filter((x) => typeof x === 'string') : [];
  const configured = new Set(providers.map((p) => p.id));
  const activeId = llmActiveTextId();
  const requested = explicitChain.length ? explicitChain : [activeId];
  const filtered = requested.filter((id) => configured.has(id));
  const withPrimary = filtered[0] === activeId ? filtered : [activeId].concat(filtered.filter((id) => id !== activeId));
  const chain = withPrimary.slice();
  const localEntry = providers.find((p) => p.kind === 'llama-server');
  const localId = localEntry ? localEntry.id : null;
  if (appendLocal && localId && !chain.includes(localId)) chain.push(localId);
  const seen = new Set();
  const effective = chain.filter((id) => configured.has(id) && !seen.has(id) && (seen.add(id), true));
  const explicit = new Set(explicitChain);
  const links = effective.map((id, index) => {
    const p = providers.find((x) => x.id === id);
    return {providerId:id, modelLabel: p ? (p.defaultChatModel || p.model || null) : null, kind: p ? p.kind : 'unknown', isActive:index === 0,
      isAppendedLocal: appendLocal && id === localId && !explicit.has(id) && id !== activeId};
  });
  const inChain = new Set(effective);
  return {links, addableProviderIds: providers.map((p) => p.id).filter((id) => !inChain.has(id)), appendLocal};
}
/* fallback-rows.ts selectFallbackPaneRows: one row per link, then the `+ add link` affordance when something is still addable. */
function llmFallbackRows() {
  const view = llmFallbackView();
  const rows = view.links.map((link, index) => ({kind:'link', link, index}));
  if (view.addableProviderIds.length) rows.push({kind:'add'});
  return rows;
}
function llmFallbackRowAt() { const rows = llmFallbackRows(); return rows.length ? rows[Math.max(0, Math.min(LLMP.cursor.fallback, rows.length - 1))] : null; }
function llmDeclaredChain(links) { return links.filter((l) => !l.isAppendedLocal).map((l) => l.providerId); }
/* fallback-chain-edits.ts moveLink / addLink / removeLink, verbatim (null = clamped or refused edit, nothing to persist). */
function llmMoveLink(links, providerId, delta) {
  const chain = llmDeclaredChain(links);
  const from = chain.indexOf(providerId);
  if (from < 0) return null;
  const to = from + delta;
  if (to < 0 || to >= chain.length) return null;
  const next = chain.slice(); const [moved] = next.splice(from, 1); next.splice(to, 0, moved);
  return next;
}
function llmAddLink(links, providerId) { const chain = llmDeclaredChain(links); return chain.includes(providerId) ? null : chain.concat([providerId]); }
function llmRemoveLink(links, providerId) {
  const target = links.find((l) => l.providerId === providerId);
  if (!target || target.isActive || target.isAppendedLocal) return null;
  if (links.filter((l) => !l.isAppendedLocal).length <= 1) return null;
  return llmDeclaredChain(links).filter((id) => id !== providerId);
}

/* --- rendering --- */
function llmTab() {
  llmEnsurePoll();
  if (BR && LLMP.lastRefreshedAt === null && !LLMP.inflight) setTimeout(llmRefresh, 0); // reached without settingsPaneEntered (the --models harness's __pane)
  if (LLMP.view === 'logs') return '<div class="tui">' + llmLogsHTML() + '</div>';
  const modal = llmModalHTML();
  if (modal) return '<div class="tui">' + modal + '</div>';
  // Item 7A: llm-panel.tsx gives the Hugging Face branch the whole pane —
  // "it owns every key while it is open, so drawing the model list behind
  // it would be a list nothing can reach."
  if (LLMHF.open) return '<div class="tui">' + llmHfHTML() + '</div>';
  const mode = LLMP.mode;
  const hint = llmFooterHint(mode);
  return '<div class="tui">'
    + (LLMP.daemonPhase === 'starting' ? '<div class="tuimodal llm-start"><b class="sk-on">⟳ Model is starting — please stand by</b><div class="ter">Loading the model into llama-server. Inputs are paused until it is ready.</div></div>' : '')
    + (mode === 'local' && LLMP.pulling ? llmDownloadBannerHTML() : '')
    + llmRouteCardHTML()
    + '<div class="llm-modehead"><span>Mode: </span>' + LLM_PANEL_MODES.map((m, i) => (i ? '<span class="ter"> | </span>' : '')
        + '<button class="llmmode' + (m === mode ? ' on' : '') + '" data-act="llm:mode:' + m + '">' + esc(LLM_MODE_LABELS[m]) + '</button>').join('') + '</div>'
    + '<div class="ter">Press ←/→ to switch mode</div>'
    + '<div class="ter llm-status" style="margin:4px 0 8px">' + esc(llmStatusLine()) + '</div>'
    + (LLMP.msg ? (LLMP.msg.restart ? restartLine(LLMP.msg.text) : '<div class="tuimsg">' + esc(LLMP.msg.text) + '</div>') : '')
    + (mode === 'fallback' ? llmFallbackHTML() : mode === 'cloud' ? llmCloudHTML() : mode === 'external' ? llmExternalHTML() : llmLocalHTML())
    + hint + '</div>';
}
/* llm-panel.tsx RouteCard. `current:` is the provider's chat model; for the local route the TUI shows the daemon's /props model —
   the desktop has no /props, so `atag models status` "active model:" stands in, then localModels.managed.modelId (the critique's fallback). */
function llmRouteCardHTML() {
  const activeId = llmActiveTextId();
  const active = llmProvider(activeId);
  const local = !!active && active.kind === 'llama-server';
  let model = active ? (active.defaultChatModel || active.model || null) : null;
  if (!model && local) model = (LLMP.status && LLMP.status.activeModel) || llmManaged().modelId || null;
  const emb = llmProvider(llmActiveEmbId());
  const lm = llmLocalModels();
  const mode = lm.mode || 'external';
  return '<div class="llm-route"><b>Active chat route</b>'
    + '<div>current: <b>' + esc(active ? active.id : 'unknown') + '</b>' + (model ? '<span class="ter"> / ' + esc(model) + '</span>' : '') + '</div>'
    + '<div class="ter">tools ' + (local ? 'grammar' : 'native_tools') + ' · cache ' + (local ? 'local slot/cache_prompt' : 'cloud: no slot affinity') + '</div>'
    + '<div class="ter">provider embeddings: ' + (emb ? esc(emb.id) + (emb.defaultEmbeddingModel ? ' · ' + esc(emb.defaultEmbeddingModel) : '') : 'not configured') + '</div>'
    + '<div class="ter">local daemon: ' + esc(llmFormatDaemon()) + ' · mode ' + esc(mode) + (mode === 'external' ? ' · ' + esc(lm.url || '') : '') + '</div>'
    + '</div>';
}
/* llm-panel.tsx StatusLines: one line, the first that applies, else "status: ready". */
function llmStatusLine() {
  const m = LLMP.mode;
  if (m === 'local') {
    if (LLMP.localBusy && LLMP.lastRefreshedAt === null) return 'local catalog: loading';
    if (LLMP.localErr) return 'local catalog: ' + LLMP.localErr;
    if (LLMP.statusErr) return 'local daemon: ' + LLMP.statusErr;
  } else if (m === 'external') {
    if (LLMP.statusLine && LLMP.statusSource === 'external') return LLMP.statusLine;
  } else {
    if (LLMP.busy) return 'cloud providers: updating';
    if (LLMP.statusLine && LLMP.statusSource === 'cloud') return 'cloud providers: ' + LLMP.statusLine;
  }
  return 'status: ready';
}
function llmReport(line, source) { LLMP.statusLine = line; LLMP.statusSource = source || 'cloud'; }
/* llm-panel.tsx footerHint (the full form), each key a button. */
function llmFooterHint(mode) {
  if (mode === 'fallback') return tuiHints(['j/k move', ['< > reorder', 'llm:fb:move:1'], ['a add link', 'llm:fb:add'], ['d remove', 'llm:fb:remove'], ['l toggle local', 'llm:fb:local'], ['←/→ switch pane', 'llm:mode:next'], ['r refresh', 'llm:refresh']]);
  if (mode === 'local') return tuiHints(['j/k move', ['Enter selected action', 'llm:enter'],
    // Item 7A — llm-panel-key-bindings.ts `a`: the reference is parsed and the repo listed in the
    // main process (desktop/main/huggingface.ts, a port of the agent's own huggingface-* modules),
    // the choice is written into localModels.customModels, and the download is `atag models pull`.
    ['a add from hugging face', 'llm:hf'],
    ['←/→ switch Local/Cloud/External/Fallback', 'llm:mode:next'], ['s start/stop', 'llm:daemon'], ['r refresh', 'llm:refresh'],
    ['E embeddings on/off', 'llm:embToggle'], ['d remove', 'llm:remove'], ['B backend update', 'llm:backend'], ['U auto-update', 'llm:autoUpdate'], ['G device', 'llm:device'], ['L LLM logs', 'llm:logs']]);
  return tuiHints(['j/k move', ['Enter selected action', 'llm:enter'], ['←/→ switch Local/Cloud/External/Fallback', 'llm:mode:next'], ['f filter', 'llm:filter'],
    ['n add provider', 'llm:add'], ['c configure', 'llm:configure'], ['r refresh', 'llm:refresh'], ['e embedding', 'llm:embedding'], ['d remove', 'llm:remove'], ['L LLM logs', 'llm:logs']]);
}
function llmRowHTML(row, index, cursor) {
  const selected = index === cursor;
  const mark = row.active ? '*' : selected ? '>' : ' ';
  const extra = row.kind === 'localTextModel' && !row.model.downloaded ? ' data-pull-local="' + esc(row.model.id) + '"' : '';
  return '<button class="tuirow' + (selected ? ' on' : '') + '" data-llm-row="' + esc(row.id) + '"' + extra + ' data-act="llm:row:' + index + '">'
    + esc(mark + ' ' + row.text) + '<span class="ter"> · ' + esc(row.enterEffect) + '</span></button>';
}
function llmSectionHTML(title, rows, offset, cursor, empty, emphasise) {
  return '<div class="llm-section"><b>' + esc(title) + '</b>'
    + (rows.length ? rows.map((r, i) => llmRowHTML(r, offset + i, cursor)).join('')
      : '<div class="' + (emphasise ? 'llm-empty' : 'ter') + '">  ' + esc(empty || 'No rows in this section yet.') + '</div>') + '</div>';
}
function llmLocalHTML() {
  const rows = llmLocalRows();
  const cursor = LLMP.cursor.local;
  const text = rows.filter((r) => r.kind === 'localTextModel');
  const emb = rows.filter((r) => r.kind === 'localEmbeddingModel');
  return llmSectionHTML('Local text models', text, 0, cursor) + llmSectionHTML('Local embeddings', emb, text.length, cursor)
    // Item 7B — the Ollama signpost. atomic-agent has no Ollama download
    // path of any kind: `grep -rni ollama src/` finds provider presets, a
    // health-failure hint and a steer modal, and ZERO hits under
    // src/local-llm. Offering "download from Ollama" here would be a
    // capability this window invented. What does work — adding the running
    // server as an OpenAI-compatible provider — is named first, with its
    // exact route, because that is the question this line exists to answer.
    + '<div class="ter llm-ollama">' + esc(OLLAMA_SIGNPOST) + '</div>';
}
function llmCloudHTML() {
  const rows = llmCloudRows();
  const cursor = LLMP.cursor.cloud;
  const providers = rows.filter((r) => r.kind === 'cloudProvider');
  const emb = rows.filter((r) => r.kind === 'cloudEmbeddingModel');
  const section = llmCloudSection();
  const embOffset = providers.length + section.filtered.length;
  return llmSectionHTML('Cloud providers', providers, 0, cursor, 'No cloud providers configured. Press n to add one.', true)
    + '<div class="llm-section"><b>Cloud text models</b>'
    + '<div class="ter">provider: <b>' + esc(section.provider ? section.provider.id : 'none') + '</b></div>'
    + '<div class="ter">filter: <input id="llm-filter" value="' + esc(LLMP.filter) + '" autocomplete="off" spellcheck="false" placeholder="f to filter"></div>'
    // The price facet needs the catalogue's pricing, which `atag models search --json` does not print: the facet stays at `all` and `p` is inert.
    + '<div class="ter">price: ' + esc(LLMP.pricing) + ' · <button class="skpf" data-act="llm:pricing" disabled title="pricing is not in `atag models search --json` on this agent — the facet stays at all">p cycles free/paid/all</button></div>'
    + '<div id="llm-cloud-models">' + llmCloudModelListHTML() + '</div></div>'
    + llmSectionHTML('Cloud embeddings', emb, embOffset, cursor);
}
/* The 12-row window of the text-model rows around the cursor, with the TUI's counter line. */
function llmCloudModelListHTML() {
  const section = llmCloudSection();
  const cursor = LLMP.cursor.cloud;
  const rows = section.filtered.map((id) => llmChatRow(section.provider, id));
  const cursorInSection = Math.max(0, Math.min(cursor - section.sectionStart, rows.length - 1));
  const start = Math.max(0, Math.min(cursorInSection - Math.floor(LLM_MODEL_WINDOW / 2), rows.length - LLM_MODEL_WINDOW));
  const visible = rows.slice(start, start + LLM_MODEL_WINDOW);
  const counter = rows.length === 0 ? 'no match' : (cursorInSection + 1) + '/' + rows.length + (rows.length !== section.models.length ? ' of ' + section.models.length : '');
  return (section.status === 'loading' ? '<div class="ter">  fetching model list…</div>' : '')
    + (section.status === 'error' ? '<div class="tuierr">  model list unavailable (' + esc(section.error || 'unknown error') + ') - showing current model only</div>' : '')
    + visible.map((r, i) => llmRowHTML(r, section.sectionStart + start + i, cursor)).join('')
    + '<div class="ter">  ↑/↓ move (' + esc(counter) + ')' + (LLMP.filterFocused ? ' · type to filter · Enter select · Esc done' : '') + '</div>';
}
function llmExternalHTML() {
  const rows = llmExternalRows();
  return llmSectionHTML('External llama.cpp', rows, 0, LLMP.cursor.external)
    + '<div class="ter">  managed daemon: ' + esc(llmFormatDaemon()) + ' · <button class="skpf" data-act="llm:daemon">s start/stop</button></div>'
    + '<div class="ter">  ← <button class="skpf" data-act="llm:mode:local">Local pane</button>: pick a managed model to switch back</div>';
}
function llmFallbackHTML() {
  const view = llmFallbackView();
  const cursor = LLMP.cursor.fallback;
  if (LLMP.fallbackPicker) {
    const c = LLMP.fallbackPicker.cursor;
    return '<div class="llm-section"><b>Add fallback link</b>'
      + (view.addableProviderIds.length ? view.addableProviderIds.map((id, i) => '<button class="tuirow' + (i === c ? ' on' : '') + '" data-llm-row="fb-pick:' + esc(id) + '" data-act="llm:fb:pick:' + esc(id) + '">' + (i === c ? '&gt;' : ' ') + ' ' + esc(id) + '</button>').join('')
        : '<div class="ter">  Every configured provider is already in the chain.</div>')
      + '<div class="ter">  ↑/↓ move · Enter add · <button class="skpf" data-act="llm:fb:pickCancel">Esc cancel</button></div></div>';
  }
  const rows = llmFallbackRows();
  // llm-fallback-rows.tsx StatusLine shows the last `provider_switched` event of the TUI process; the serve API exposes no fallover events.
  return '<div class="ter" style="margin-bottom:8px">status: fallover events are not exposed by the agent\'s HTTP API</div>'
    + '<div class="llm-section"><b>Fallback chain</b>'
    + (view.links.length === 0 ? '<div class="ter">  No chain configured. Falls back to the active provider only.</div>' : '')
    + rows.map((r, i) => {
      const sel = i === cursor;
      if (r.kind === 'add') return '<button class="tuirow' + (sel ? ' on' : '') + '" data-llm-row="fb-add" data-act="llm:fb:add">' + (sel ? '&gt;' : ' ') + ' + add link <span class="ter">· Enter or a to choose a provider</span></button>';
      const l = r.link;
      const note = l.isActive ? 'active (primary)' : l.isAppendedLocal ? 'local last resort (appendLocal)' : 'fallover link';
      return '<button class="tuirow' + (sel ? ' on' : '') + '" data-llm-row="fb:' + esc(l.providerId) + '" data-act="llm:fb:select:' + i + '">' + (sel ? '&gt;' : ' ') + ' '
        + esc((r.index + 1) + '. ' + l.providerId + (l.modelLabel ? '/' + l.modelLabel : '') + ' [' + l.kind + ']') + '<span class="ter"> · ' + esc(note) + '</span></button>';
    }).join('') + '</div>'
    + '<div class="ter">append local as last resort: <span class="' + (view.appendLocal ? 'sk-on' : 'ter') + '">' + (view.appendLocal ? 'on' : 'off') + '</span> · <button class="skpf" data-act="llm:fb:local">l to toggle</button></div>'
    + '<div class="ter"><button class="skpf" data-act="llm:fb:move:-1">&lt;</button> <button class="skpf" data-act="llm:fb:move:1">&gt;</button> move priority · <button class="skpf" data-act="llm:fb:add">a add link</button> · <button class="skpf" data-act="llm:fb:remove">d remove</button> · <button class="skpf" data-act="llm:fb:local">l toggle local</button></div>';
}
/* llm-panel-modals.tsx PromptBox copy, one at a time; a modal takes the whole pane as in the TUI. */
function llmModalHTML() {
  const c = LLMP.confirm;
  if (c) {
    const err = c.error ? '<div class="tuierr">! ' + esc(c.error) + '</div>' : '';
    const busy = c.submitting ? '<div class="ter">working…</div>' : '';
    if (c.kind === 'removeProvider') return '<div class="tuimodal danger"><b style="color:var(--danger)">Remove provider ' + esc(c.id) + '?</b>' + err + busy
      + tuiHints([['y confirm', 'llm:confirm', {disabled:c.submitting}], ['n/Esc cancel', 'llm:cancel']]) + '</div>';
    if (c.kind === 'removeLocal') return '<div class="tuimodal danger"><b style="color:var(--danger)">Delete local model ' + esc(c.id) + '?</b>'
      + '<div class="ter">Removes GGUF/mmproj files. y confirm · n/Esc cancel</div>' + err + busy + tuiHints([['y confirm', 'llm:confirm', {disabled:c.submitting}], ['n/Esc cancel', 'llm:cancel']]) + '</div>';
    if (c.kind === 'removeEmbedding') return '<div class="tuimodal danger"><b style="color:var(--danger)">Delete local embedding model ' + esc(c.id) + '?</b>'
      // `atag models remove` accepts chat catalogue ids only (runLocalModelsRemove isKnownLocalModelId), so the desktop cannot delete an embedding GGUF.
      + '<div class="ter">y confirm · n/Esc cancel</div><div class="ter">(no CLI removes an embedding model on this agent — `atag models remove` accepts chat models only)</div>' + err
      + tuiHints([['y confirm', 'llm:confirm', {disabled:true, title:'`atag models remove` accepts chat models only'}], ['n/Esc cancel', 'llm:cancel']]) + '</div>';
  }
  if (LLMP.externalDraft !== null) {
    return '<div class="tuimodal"><b>External llama.cpp base URL</b>'
      + '<div><input id="llm-url" value="' + esc(LLMP.externalDraft) + '" autocomplete="off" spellcheck="false" placeholder="http://host:8080"></div>'
      + (LLMP.externalInvalid ? '<div class="tuierr">invalid URL</div>' : '')
      + '<div class="ter">Saved after a /health probe succeeds. <button class="skpf" data-act="llm:external:save">Enter save</button> · <button class="skpf" data-act="llm:external:cancel">Esc cancel</button></div></div>';
  }
  if (LLMP.steerUrl !== null) {
    const url = LLMP.steerUrl;
    const ollama = llmLooksLikeOllama(url);
    return '<div class="tuimodal"><b>' + (ollama ? 'Ollama detected — add it as a cloud provider?' : 'OpenAI-compatible server — add it as a cloud provider?') + '</b>'
      + '<div>' + esc(url + ' answers like ' + (ollama ? 'Ollama' : 'an OpenAI-compatible server') + ', which the External llama.cpp route cannot drive.') + '</div>'
      + tuiHints([['y open the provider wizard with this URL', 'llm:steer:y'], ['n/Esc dismiss', 'llm:steer:n']]) + '</div>';
  }
  return '';
}
function llmLooksLikeOllama(url) { try { return new URL(url).port === '11434'; } catch (err) { return false; } }

/* ============================================================
   Item 7A — add a model from Hugging Face.
   The two screens the TUI draws (hf-reference-editor.tsx then
   hf-pick-list.tsx), against the port in desktop/main/huggingface.ts.
   Every string below is quoted from those files; the parse and listing
   errors are shown VERBATIM, never turned into "invalid input" —
   huggingface-ref.ts says in as many words that the caller prints them.
   ============================================================ */

function llmHfInputValue() {
  const n = document.getElementById('llm-hf-ref');
  return n ? n.value : LLMHF.reference;
}
function llmHfFocus() {
  const n = document.getElementById('llm-hf-ref');
  if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
}
function llmHfClose() {
  if (LLMHF.busy && BR && BR.hfCancel) BR.hfCancel();
  LLMHF.open = false; LLMHF.busy = false; LLMHF.error = null; LLMHF.repo = null; LLMHF.reference = ''; LLMHF.cursor = 0;
  llmRepaint();
}
function llmHfCancel() {
  // local-models-hf-keys.ts: Escape mid-lookup drops the socket and keeps
  // what was typed. The branch stays open.
  LLMHF.reference = llmHfInputValue();
  if (BR && BR.hfCancel) BR.hfCancel();
  LLMHF.busy = false;
  llmRepaint(); llmHfFocus();
}
async function llmHfResolve(raw) {
  if (!BR || !BR.hfResolve) return;
  const value = String(raw === undefined ? LLMHF.reference : raw);
  LLMHF.reference = value; LLMHF.busy = true; LLMHF.error = null;
  llmRepaint();
  const res = await BR.hfResolve(value);
  if (!LLMHF.open) return;
  /* Review fix: the cancelled arm has to come BEFORE `busy = false`. Escape
     cancels lookup A and Enter starts B; A's late reply then cleared B's busy
     flag, so the editor lost `asking huggingface.co…`, got `[ clear ]` back
     and offered `esc back to the list` while B was still in flight. Whoever
     cancelled A already put the flag where it belongs. */
  if (res && res.cancelled) { llmRepaint(); llmHfFocus(); return; }
  LLMHF.busy = false;
  if (!res || res.ok !== true) {
    // Verbatim. huggingface-ref.ts:77-78 and huggingface-api.ts:45-58 are
    // written for this screen.
    LLMHF.error = (res && res.error) || 'the lookup failed';
    llmRepaint(); llmHfFocus(); return;
  }
  LLMHF.repo = res.repo; LLMHF.cursor = 0; LLMHF.step = 'pick'; LLMHF.error = null;
  llmRepaint();
}
async function llmHfAdd() {
  if (!BR || !BR.hfAdd || !LLMHF.repo) return;
  if (LLMP.pulling) { LLMHF.error = 'a download is already running'; llmRepaint(); return; }
  const res = await BR.hfAdd(LLMHF.repo, LLMHF.cursor);
  if (!res || res.ok !== true) { LLMHF.error = (res && res.error) || 'could not add the model'; llmRepaint(); return; }
  const def = res.def || {};
  // `atag models pull` fetches weights only, so the projector is parked
  // here and fetched by this window once the weights land.
  LLMHF.pendingMmproj = def.supportsVision && def.mmprojUrl && def.mmprojFilename
    ? {id: res.id, url: def.mmprojUrl, filename: def.mmprojFilename, name: def.name || res.id}
    : null;
  LLMHF.open = false; LLMHF.busy = false; LLMHF.error = null; LLMHF.repo = null; LLMHF.reference = ''; LLMHF.cursor = 0;
  // The same order the orchestrator takes: close the branch, then hand the
  // id to the pull the curated rows use.
  llmPull('chat', res.id);
}
/* hf-reference-editor.tsx then hf-pick-list.tsx. */
function llmHfHTML() {
  if (LLMHF.step === 'pick' && LLMHF.repo) return llmHfPickHTML();
  const busy = LLMHF.busy;
  return '<div class="llm-section llm-hf">'
    + '<div>Which model? <span class="ter">' + esc(HF_REF_TITLE_TAIL) + '</span></div>'
    + '<div class="ter">' + esc(HF_REF_EXAMPLES_LINE) + '</div>'
    + '<div style="margin-top:8px"><input id="llm-hf-ref" value="' + esc(LLMHF.reference) + '" autocomplete="off" spellcheck="false" placeholder="owner/repo"'
      + (busy ? ' disabled' : '') + '></div>'
    + (!busy && LLMHF.reference.length > 0 ? '<div><button class="skpf" data-act="llm:hf:clear">[ clear ]</button></div>' : '')
    + (busy ? '<div class="ter">asking huggingface.co…</div>' : '')
    + (LLMHF.error ? '<div class="tuierr">' + esc(LLMHF.error) + '</div>' : '')
    + (busy ? tuiHints([['esc cancel', 'llm:hf:cancel']])
            : tuiHints([['enter look it up', 'llm:hf:look'], ['ctrl+l clear', 'llm:hf:clear'], ['esc back to the list', 'llm:hf:close']]))
    + '</div>';
}
function llmHfPickHTML() {
  const repo = LLMHF.repo;
  const choices = repo.choices || [];
  const cursor = Math.min(LLMHF.cursor, Math.max(0, choices.length - 1));
  // hf-pick-list.tsx windowHfChoices, ported.
  const start = Math.max(0, Math.min(cursor - HF_PICK_WINDOW + 2, choices.length - HF_PICK_WINDOW));
  const visible = choices.slice(start, start + HF_PICK_WINDOW);
  const below = choices.length - (start + visible.length);
  const selected = choices[cursor];
  // The fit check warns in one direction and nothing acts on it: weights
  // bigger than RAM still start, because llama.cpp maps the file.
  const warning = selected ? llmHfRamWarning(selected.fileSizeGb, LLMHF.ram) : null;
  return '<div class="llm-section llm-hf"><b>' + esc(repo.repoId) + '</b>'
    + visible.map((c, i) => {
        const at = start + i;
        const active = at === cursor;
        // hfChoiceLine, verbatim: `${active ? '›  ' : '   '}${filename.padEnd(44)}${sizeLabel.padStart(9)}`
        const line = (active ? '›  ' : '   ') + String(c.filename).padEnd(44) + String(c.sizeLabel).padStart(9);
        return '<button class="tuirow' + (active ? ' on' : '') + '" data-llm-row="hf:' + esc(c.path) + '" data-act="llm:hf:row:' + at + '">' + esc(line) + '</button>';
      }).join('')
    + (below > 0 ? '<div class="ter">' + esc('   ↓ ' + below + ' more') + '</div>' : '')
    + (repo.hidden ? '<div class="ter">' + esc('   ' + repo.hidden) + '</div>' : '')
    + (repo.mmproj ? '<div class="ter">' + esc(HF_MMPROJ_LINE) + '</div>' : '')
    + (warning ? '<div class="sk-off">' + esc('   ⚠ ' + warning) + '</div>' : '')
    + (LLMHF.error ? '<div class="tuierr">' + esc('   ' + LLMHF.error) + '</div>' : '')
    + tuiHints(['j/k move', ['Enter download', 'llm:hf:add'], ['esc back', 'llm:hf:back']])
    + '</div>';
}
/* huggingface-fit.ts ramWarningFor, ported so the sentence matches the TUI's. */
function llmHfRamWarning(fileSizeGb, hostRamGb) {
  if (!(fileSizeGb > 0) || !(hostRamGb > 0)) return null;
  if (fileSizeGb <= hostRamGb) return null;
  return fileSizeGb.toFixed(1) + ' GB model, ' + hostRamGb + ' GB of RAM — it will run from disk, slowly.';
}
/* llm-panel.tsx DownloadBanner: the CLI streams lines, not a byte count, so the last line stands where the TUI draws its bar. */
function llmDownloadBannerHTML() {
  const p = LLMP.pulling;
  return '<div class="llm-section"><b>downloading — ' + esc(p.id) + '</b><div class="ter">model: ' + esc(p.id) + '</div>'
    + '<div class="ter" id="llm-pull-line">' + esc(LLMP.pullLog[LLMP.pullLog.length - 1] || 'starting…') + '</div>'
    + tuiHints([['cancel', 'llm:cancelPull']]) + '</div>';
}
/* local-llm-logs-panel.tsx: header (path or the waiting line), size · tail · last read, error, the last 30 lines coloured. */
function llmLogsHTML() {
  const l = LLMP.logs;
  const header = l && l.path ? l.path : '(waiting for the first daemon start — no log file yet)';
  const lines = l ? l.text.split('\n').filter((x) => x.length > 0) : [];
  const tail = lines.slice(-LLM_LOG_LINES);
  const color = (line) => { const lower = line.toLowerCase(); if (/\b(error|fatal|fail|abort)\b/.test(lower)) return 'tuierr'; if (/\b(warn|warning)\b/.test(lower)) return 'sk-off'; if (/\b(loading|loaded|ready|listening)\b/.test(lower)) return 'sk-on'; return ''; };
  return '<div class="ter">' + esc(header) + '</div>'
    + (l && typeof l.size === 'number' ? '<div class="ter">' + esc(llmFormatBytes(l.size)) + (l.truncated ? ' · showing tail only' : '') + (l.lastReadAt ? ' · last read ' + new Date(l.lastReadAt).toLocaleTimeString() : '') + '</div>' : '')
    + (l && l.error ? '<div class="sk-off">' + esc(l.error) + '</div>' : '')
    + '<div style="margin-top:8px">' + (tail.length === 0 ? '<div class="ter">' + (l && l.error ? '' : '(log is empty — start the daemon to see output)') + '</div>'
      : tail.map((line) => '<div class="' + color(line) + '">' + esc(line) + '</div>').join('')) + '</div>'
    + tuiHints([['Esc back', 'llm:back'], ['r refresh', 'llm:logsRefresh']]);
}
function llmFormatBytes(n) { if (n < 1024) return n + ' B'; if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'; return (n / (1024 * 1024)).toFixed(1) + ' MB'; }

/* --- writes --- */
/* A whole-file write of one `llm.*` key (0.5.4 has no llm leaf). With no
   `llm` block in the user file the default block is written around the key. */
async function llmWrite(path, value) {
  if (!BR) return {ok:false, error:'no bridge'};
  const hasBlock = !!(LIVE_CONFIG && LIVE_CONFIG.llm && Array.isArray(LIVE_CONFIG.llm.providers));
  if (hasBlock) return BR.configSetPath('llm.' + path, value);
  const block = JSON.parse(JSON.stringify(llmBlock()));
  const segs = path.split('.');
  let node = block;
  segs.slice(0, -1).forEach((sg) => { if (!node[sg] || typeof node[sg] !== 'object') node[sg] = {}; node = node[sg]; });
  node[segs[segs.length - 1]] = value;
  return BR.configSetPath('llm', block);
}
function llmFail(prefix, res) { return prefix + ': ' + ((res && res.error) || 'unknown error'); }
/* The serve process keeps its boot-time provider registry (the TUI hot-reloads its own); every route write says so. */
function llmRestartMsg(text) { LLMP.msg = {text, restart:true}; }
/* Integration seam (lane B + lane C): a route switch from the LLM tab goes
   through lane B's activateProvider / selectCloudModel — the same whole-file
   llm write, key check, cloud-route daemon stop (with memory.embeddings.enabled
   off, the TUI's stopDaemon order) and `atag serve` restart that the provider
   row, the selector and the wizard use — never a raw llmWrite of
   activeTextProvider. The serve process is restarted by main (applySwitch), so
   the message reports the switch instead of asking for a restart. */
async function llmSwitchProvider(id) {
  if (S.busy) { llmReport('Not while a turn is running — the switch restarts the agent', 'cloud'); llmRepaint(); return false; }
  LLMP.busy = true; llmRepaint();
  const res = await BR.activateProvider(id);
  LLMP.busy = false;
  if (!res || !res.ok) {
    llmReport(res && res.needsKey ? 'no API key for ' + id + ' — add one with n (the wizard) or export its variable' : llmFail('switch provider failed', res), 'cloud');
    llmRepaint(); return false;
  }
  bswReport(res);
  await refreshLiveConfig();
  const p = llmProvider(id);
  const model = p ? (p.defaultChatModel || p.model || '') : '';
  const transport = res.transport || (id === 'local-llama' ? 'grammar+llama-server' : 'native_tools');
  // providers-orchestrator.ts setActiveText: the providers_status line + the feed's runtime_info.
  llmReport('Active text: ' + id + (model ? ' · ' + model : '') + ' · ' + transport, 'cloud');
  LLMP.msg = {text:'Switched active text provider to "' + id + '". New messages use ' + transport + '.' + (res.daemonLine ? ' ' + res.daemonLine : '') + ' The agent was restarted.'};
  llmRefresh();
  return true;
}
async function llmSelectChatModel(pid, modelId) {
  if (S.busy) { llmReport('Not while a turn is running — the switch restarts the agent', 'cloud'); llmRepaint(); return; }
  LLMP.busy = true; llmRepaint();
  // providers-orchestrator.ts selectChatModel: the model, then setActiveText(providerId) — lane B's selectCloudModel is exactly that pair, plus the restart.
  const res = await BR.selectCloudModel(pid, modelId);
  LLMP.busy = false;
  if (!res || !res.ok) {
    llmReport(res && res.needsKey ? 'no API key for ' + pid + ' — add one with n (the wizard) or export its variable' : llmFail('select model failed', res), 'cloud');
    llmRepaint(); return;
  }
  bswReport(res, 'Selected chat model ' + pid + '/' + modelId + '.');
  await refreshLiveConfig();
  const transport = res.transport || 'native_tools';
  llmReport('Active text: ' + pid + ' · ' + modelId + ' · ' + transport, 'cloud');
  LLMP.msg = {text:'Selected chat model ' + pid + '/' + modelId + '.' + (res.daemonLine ? ' ' + res.daemonLine : '') + ' The agent was restarted.'};
  llmRefresh();
}
async function llmSelectEmbeddingModel(pid, modelId) {
  LLMP.busy = true; llmRepaint();
  let res = await BR.upsertProvider({id:pid, kind:'', defaultEmbeddingModel:modelId});
  if (!res || res.ok === false) { LLMP.busy = false; llmReport(llmFail('select embedding failed', res), 'cloud'); llmRepaint(); return; }
  res = await llmWrite('activeEmbeddingProvider', pid);
  LLMP.busy = false;
  if (!res || res.ok === false) { llmReport(llmFail('select embedding failed', res), 'cloud'); llmRepaint(); return; }
  await refreshLiveConfig();
  llmReport('Active embedding provider: ' + pid + ' (restart agent to apply if recall unchanged)', 'cloud');
  llmRestartMsg('Selected embedding model ' + pid + '/' + modelId + '.');
  // triggerCloudEmbeddingModel: a cloud embedding route turns the local embedding daemon off.
  if (llmEmbCfg().enabled === true) await BR.modelsUseEmbedding('--disable');
  llmRefresh();
}
async function llmActivateProviderEmbedding() {
  // llm-panel-primary-actions.ts activateProviderEmbedding: the active cloud text provider, when it has an embedding model.
  const p = llmProvider(llmActiveTextId());
  if (!p || p.kind === 'llama-server' || !p.defaultEmbeddingModel) return;
  const res = await llmWrite('activeEmbeddingProvider', p.id);
  if (!res || res.ok === false) { llmReport(llmFail('set embedding provider failed', res), 'cloud'); llmRepaint(); return; }
  await refreshLiveConfig();
  llmReport('Active embedding provider: ' + p.id + ' (restart agent to apply if recall unchanged)', 'cloud');
  llmRestartMsg('Active embedding provider: ' + p.id);
  llmRepaint();
}
/* persist-llm-provider.ts removeLlmProvider, ported: the built-in entry stays, the active ids fall back to local-llama (or the first remaining). */
async function llmRemoveProviderConfirm() {
  const c = LLMP.confirm; if (!c || c.submitting) return;
  c.submitting = true; c.error = null; llmRepaint();
  const id = c.id;
  if (id === 'local-llama') { c.submitting = false; c.error = 'cannot remove built-in provider "local-llama"'; llmRepaint(); return; }
  const cfg = await BR.config();
  const llm = cfg && cfg.ok && cfg.data && cfg.data.config && cfg.data.config.llm;
  if (!llm || !Array.isArray(llm.providers)) { c.submitting = false; c.error = 'provider "' + id + '" is not configured'; llmRepaint(); return; }
  const remaining = llm.providers.filter((p) => p && p.id !== id);
  if (remaining.length === llm.providers.length) { c.submitting = false; c.error = 'provider "' + id + '" is not configured'; llmRepaint(); return; }
  let activeTextProvider = llm.activeTextProvider, activeEmbeddingProvider = llm.activeEmbeddingProvider;
  if (activeTextProvider === id) activeTextProvider = 'local-llama';
  if (activeEmbeddingProvider === id) activeEmbeddingProvider = 'local-llama';
  if (!remaining.some((p) => p.id === activeTextProvider)) activeTextProvider = remaining[0] ? remaining[0].id : 'local-llama';
  if (!remaining.some((p) => p.id === activeEmbeddingProvider)) activeEmbeddingProvider = remaining[0] ? remaining[0].id : 'local-llama';
  const res = await BR.configSetPath('llm', Object.assign({}, llm, {activeTextProvider, activeEmbeddingProvider, providers:remaining}));
  c.submitting = false;
  if (!res || res.ok === false) { c.error = (res && res.error) || 'config write failed'; llmRepaint(); return; }
  LLMP.confirm = null;
  await refreshLiveConfig();
  llmRestartMsg('Removed provider "' + id + '" from config.');
  llmClampCursors();
  llmRefresh();
}
async function llmDaemon(which) {
  if (!BR || LLMP.daemonPhase) return;
  LLMP.daemonPhase = which === 'stop' ? 'stopping' : 'starting'; llmRepaint();
  const res = which === 'stop' ? await BR.modelsStop() : await BR.modelsStart();
  LLMP.daemonPhase = null;
  if (!res || res.ok === false) { LLMP.statusErr = llmFail('models ' + which + ' failed', res); }
  else LLMP.msg = {text:'local-llm: ' + (which === 'stop' ? 'daemon stopped' : 'daemon started') + (res.stdout && res.stdout.trim() ? ' — ' + res.stdout.trim().split('\n').pop() : '')};
  await llmRefreshStatus();
}
async function llmEmbToggle() {
  if (!BR) return;
  const enabled = llmEmbCfg().enabled === true;
  // local-models-orchestrator.ts toggleEmbeddingEnabled; `use-embedding <id>` enables + selects, `--disable` turns it off.
  const target = enabled ? '--disable' : (llmEmbCfg().modelId || 'nomic-embed-text-v1.5');
  LLMP.busy = true; llmRepaint();
  const res = await BR.modelsUseEmbedding(target);
  LLMP.busy = false;
  if (!res || res.ok === false) { LLMP.statusErr = llmFail('use-embedding failed', res); llmRepaint(); return; }
  LLMP.msg = {text:'local-llm: embeddings ' + (enabled ? 'disabled' : 'enabled')};
  await refreshLiveConfig();
  llmRefresh();
}
async function llmBackendUpdate() {
  if (!BR || LLMP.busy) return;
  LLMP.busy = true; LLMP.msg = {text:'local-llm: updating the llama.cpp backend…'}; llmRepaint();
  const res = await BR.modelsUpdate();
  LLMP.busy = false;
  if (!res || res.ok === false) { LLMP.statusErr = llmFail('models update failed', res); }
  else LLMP.msg = {text:'local-llm: backend update — ' + ((res.stdout || '').trim().split('\n').pop() || 'done')};
  llmRefresh();
}
async function llmAutoUpdateToggle() {
  if (!BR) return;
  const next = !(llmManaged().autoUpdate !== false);
  const res = await BR.configSet('localModels.managed.autoUpdate', String(next));
  if (!res || res.ok === false) { LLMP.statusErr = llmFail('autoUpdate write failed', res); llmRepaint(); return; }
  LLMP.msg = {text: next ? 'local-llm: backend auto-update on — a newer llama.cpp is fetched after start' : "local-llm: backend auto-update off — update manually with 'B'"};
  await refreshLiveConfig();
  llmRepaint();
}
/* local-models-orchestrator.ts cycleManagedDevice: auto → each GPU id → cpu → auto, persisted through `atag models use-device`. */
async function llmDeviceCycle() {
  if (!BR || LLMP.busy) return;
  LLMP.busy = true; llmRepaint();
  const dev = await BR.modelsDevices();
  const ids = dev && dev.ok ? (dev.devices || []).map((d) => d.id) : [];
  const order = ['auto'].concat(ids, ['cpu']);
  const current = (dev && dev.ok && dev.configured) || llmManaged().device || 'auto';
  const idx = order.indexOf(current);
  const next = order[(idx + 1) % order.length];
  const res = await BR.modelsUseDevice(next);
  LLMP.busy = false;
  if (!res || res.ok === false) { LLMP.statusErr = llmFail('use-device failed', res); llmRepaint(); return; }
  LLMP.msg = {text:"local-llm: device → " + next + " (press 's' to restart and apply)"};
  await refreshLiveConfig();
  llmRepaint();
}
async function llmRemoveLocalConfirm() {
  const c = LLMP.confirm; if (!c || c.submitting) return;
  c.submitting = true; c.error = null; llmRepaint();
  const res = await BR.modelsRemove(c.id);
  c.submitting = false;
  if (!res || res.ok === false) { c.error = (res && res.error) || 'remove failed'; llmRepaint(); return; }
  LLMP.confirm = null;
  LLMP.msg = {text:'local-llm: ' + c.id + ' removed'};
  llmRefresh();
}
function llmPull(kind, id) {
  if (!BR || LLMP.pulling) return;
  LLMP.pulling = {kind, id}; LLMP.pullLog = ['starting ' + id + '…']; llmRepaint();
  const p = kind === 'embedding' ? BR.modelsPullEmbedding(id) : BR.modelsPull(id);
  p.then((res) => { if (res && res.ok === false) { LLMP.pulling = null; LLMP.statusErr = res.error || 'could not start the download'; llmRepaint(); } });
}
/* llm-panel-primary-actions.ts triggerLocalChatModel / triggerLocalEmbeddingModel / triggerCloud*, ported. */
async function llmPrimary(row) {
  if (!row || !BR) return;
  if (row.kind === 'localTextModel') {
    const m = row.model;
    if (LLMP.pulling) return;
    if (!m.downloaded) { llmPull('chat', m.id); return; }
    if (!m.active) { const used = await BR.modelsUse(m.id); if (used && used.ok === false) { LLMP.statusErr = llmFail('models use failed', used); llmRepaint(); return; } }
    if (!llmLocalActive()) { if (!(await llmSwitchProvider('local-llama'))) return; }
    if (m.active && !llmDaemonUp()) { await llmDaemon('start'); return; }
    await refreshLiveConfig();
    llmRefresh();
    return;
  }
  if (row.kind === 'localEmbeddingModel') {
    const m = row.model;
    if (LLMP.pulling) return;
    if (!m.downloaded) { llmPull('embedding', m.id); if (!llmLocalEmbActive()) await llmWrite('activeEmbeddingProvider', 'local-llama'); return; }
    if (!m.active) {
      const res = await BR.modelsUseEmbedding(m.id);
      if (!res || res.ok === false) { LLMP.statusErr = llmFail('use-embedding failed', res); llmRepaint(); return; }
      if (!llmLocalEmbActive()) await llmWrite('activeEmbeddingProvider', 'local-llama');
      await refreshLiveConfig(); llmRefresh(); return;
    }
    if (!llmLocalEmbActive()) { await llmWrite('activeEmbeddingProvider', 'local-llama'); await refreshLiveConfig(); }
    if (llmEmbCfg().enabled !== true) { llmEmbToggle(); return; }
    if (!(LLMP.embDaemon && LLMP.embDaemon.running)) { await llmDaemon('start'); return; }
    llmRefresh();
    return;
  }
  if (row.kind === 'cloudProvider') {
    if (!row.available) { llmOpenWizard(row.provider); return; }
    if (!row.active) await llmSwitchProvider(row.provider.id);
    return;
  }
  if (row.kind === 'cloudChatModel') {
    if (!row.available) { llmOpenWizard(row.provider); return; }
    await llmSelectChatModel(row.providerId, row.modelId);
    return;
  }
  if (row.kind === 'cloudEmbeddingModel') {
    if (!row.available) { llmOpenWizard(row.provider); return; }
    await llmSelectEmbeddingModel(row.providerId, row.modelId);
    return;
  }
  if (row.kind === 'externalUrl') { LLMP.externalDraft = row.url; LLMP.externalInvalid = false; llmRepaint(); const n = $('#llm-url'); if (n) { n.focus(); n.select(); } }
}
/* The existing add-provider wizard (selectorHTML → wizardHTML) is the
   composer's popup: it needs SEL.open and floats above the settings window
   through the `#window:has(#settings) #overlays` rule in styles.css.
   `n` opens it at pick_kind; `c` / a missing-key row opens it configured
   for that provider (the wizard's kind row by id, then by kind, else the
   custom row). */
function llmOpenWizard(provider, baseUrl) {
  SEL.open = true; SEL.addOpen = false; SEL.err = null;
  WIZ.error = null; WIZ.busy = false; WIZ.apiKey = '';
  if (provider) {
    const row = KIND_ROWS.find((k) => k.id === provider.id) || KIND_ROWS.find((k) => k.kind === provider.kind && !k.custom) || KIND_ROWS.find((k) => k.custom);
    WIZ.row = baseUrl ? Object.assign({}, row, {baseUrl}) : row;
    WIZ.baseUrl = baseUrl || provider.baseUrl || '';
    WIZ.phase = 'configure';
  } else { WIZ.row = null; WIZ.baseUrl = ''; WIZ.phase = 'pick_kind'; }
  render();
}
function llmNormalizeUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : 'http://' + trimmed;
  try { new URL(withScheme); } catch (err) { return null; }
  return withScheme;
}
/* tui-command.ts persistLlamaUrl: probe first (the main process runs the
   /health + /props + /v1/models probes), report every verdict on the
   pane's own status line, steer an OpenAI-compatible answer to the
   provider wizard, and only a passing probe writes localModels.url +
   mode external and points the chat route at local-llama. */
async function llmExternalSave() {
  const input = document.getElementById('llm-url');
  const raw = input ? input.value : LLMP.externalDraft;
  const url = llmNormalizeUrl(raw);
  if (!url) { LLMP.externalDraft = raw || ''; LLMP.externalInvalid = true; llmRepaint(); return; }
  LLMP.externalDraft = null; LLMP.externalInvalid = false;
  llmReport('probing ' + url + '…', 'external'); llmRepaint();
  const res = await BR.llamaProbe(url);
  if (!res || !res.ok) { llmReport('local-llm /health failed at ' + url + ': ' + ((res && res.error) || 'probe failed'), 'external'); llmRepaint(); return; }
  const p = res.probe;
  if (!p.reachable) {
    llmReport(p.message, 'external');
    if (p.kind === 'openai-compat') LLMP.steerUrl = res.url;
    llmRepaint(); return;
  }
  // Review fix: one whole-file write (agent-cli setExternalLlamaUrl, the port
  // of the TUI's persistUserLocalLlmUrl) — mode external, localModels.url AND
  // llm.providers[local-llama].url together. The two leaf `config set` calls
  // this replaces never re-synced the provider url, so the runtime (which
  // takes the file's llm block verbatim) kept calling the old address.
  const w = await BR.setExternalLlamaUrl(res.url);
  if (!w || w.ok === false) { llmReport(llmFail('local-llm URL write failed', w), 'external'); llmRepaint(); return; }
  await refreshLiveConfig();
  // Integration seam: the route move goes through lane B's activateProvider (restarts `atag serve`, which also picks up the two leaf writes above).
  if (llmActiveTextId() !== 'local-llama') {
    if (!(await llmSwitchProvider('local-llama'))) return;
    llmReport('local-llm URL saved (' + p.latencyMs + 'ms)', 'external');
    LLMP.msg = {text:'local-llm URL saved: ' + res.url + ' — active text provider is local-llama; the agent was restarted.'};
    llmRefreshStatus();
    return;
  }
  llmReport('local-llm URL saved (' + p.latencyMs + 'ms)', 'external');
  // The TUI rebuilds the registered provider in-process (runtime.reloadLlmProvider); the serve process needs the restart.
  llmRestartMsg('local-llm URL saved: ' + res.url);
  llmRefreshStatus();
}
async function llmFallbackPersist(chain, appendLocal) {
  const llm = llmBlock();
  const next = Object.assign({}, llm.fallback || {}, {chain, appendLocal});
  LLMP.busy = true; llmRepaint();
  const res = await llmWrite('fallback', next);
  LLMP.busy = false;
  if (!res || res.ok === false) { llmReport(llmFail('fallback write failed', res), 'cloud'); LLMP.msg = {text:'! ' + ((res && res.error) || 'fallback write failed')}; llmRepaint(); return; }
  await refreshLiveConfig();
  llmRestartMsg('llm.fallback saved: chain [' + chain.join(', ') + '], appendLocal ' + (appendLocal ? 'on' : 'off'));
  llmClampCursors();
  llmRepaint();
}
async function llmLogsOpen() {
  LLMP.view = 'logs'; LLMP.logs = null; llmRepaint();
  await llmLogsRefresh();
  if (!LLMP.logsTimer) LLMP.logsTimer = setInterval(() => { if (!llmVisible() || LLMP.view !== 'logs') { llmStopLogs(); return; } llmLogsRefresh(); }, 1000);
}
function llmStopLogs() { if (LLMP.logsTimer) { clearInterval(LLMP.logsTimer); LLMP.logsTimer = null; } }
async function llmLogsRefresh() {
  if (!BR || LLMP.logsBusy) return;
  let dataDir = LLMP.status && LLMP.status.dataDir;
  if (!dataDir) { await llmRefreshStatus(true); dataDir = LLMP.status && LLMP.status.dataDir; }
  if (!dataDir) { LLMP.logs = {path:null, size:null, truncated:false, text:'', lastReadAt:Date.now(), error:LLMP.statusErr ? 'models status failed: ' + LLMP.statusErr : null}; llmRepaint(); return; }
  LLMP.logsBusy = true;
  const res = await BR.llamaLogTail(dataDir);
  LLMP.logsBusy = false;
  const before = JSON.stringify(LLMP.logs && [LLMP.logs.size, LLMP.logs.text.length, LLMP.logs.error]);
  LLMP.logs = res && res.ok ? res : {path:(res && res.path) || null, size:null, truncated:false, text:'', lastReadAt:Date.now(), error:(res && res.error) || 'log read failed'};
  if (before !== JSON.stringify([LLMP.logs.size, LLMP.logs.text.length, LLMP.logs.error])) llmRepaint();
}
function llmSetMode(mode) {
  if (!LLM_PANEL_MODES.includes(mode)) return;
  LLMP.mode = mode; LLMP.filterFocused = false; LLMP.fallbackPicker = null;
  llmRepaint();
  if (mode === 'cloud') llmEnsureModels();
}
function llmAct(what) {
  const [verb, ...rest] = what.split(':');
  const arg = rest.join(':');
  if (verb === 'mode') {
    if (arg === 'next' || arg === 'prev') { const d = arg === 'next' ? 1 : -1; llmSetMode(LLM_PANEL_MODES[(LLM_PANEL_MODES.indexOf(LLMP.mode) + d + 4) % 4]); }
    else llmSetMode(arg);
    return;
  }
  if (verb === 'row') { const i = +arg; if (LLMP.mode === 'fallback') { LLMP.cursor.fallback = i; llmRepaint(); return; } LLMP.cursor[LLMP.mode] = i; llmPrimary(llmRowAt(i)); return; }
  if (verb === 'select') { LLMP.cursor[LLMP.mode] = +arg; llmRepaint(); return; }
  if (verb === 'enter') { if (LLMP.mode === 'fallback') { llmFallbackEnter(); return; } llmPrimary(llmRowAt()); return; }
  if (verb === 'refresh') { llmRefresh(); return; }
  if (verb === 'filter') { llmSetMode('cloud'); LLMP.filterFocused = true; llmRepaint(); const n = $('#llm-filter'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } return; }
  if (verb === 'pricing') return; // inert: pricing is not in the CLI's model list
  if (verb === 'add') { llmSetMode('cloud'); llmOpenWizard(null); return; }
  if (verb === 'configure') { llmSetMode('cloud'); const cloud = llmCloudProviders(); const p = cloud.find((x) => x.id === llmActiveTextId()) || cloud[0]; llmOpenWizard(p || null); return; }
  if (verb === 'embedding') { llmActivateProviderEmbedding(); return; }
  if (verb === 'embToggle') { llmEmbToggle(); return; }
  if (verb === 'daemon') { llmDaemon(llmDaemonUp() ? 'stop' : 'start'); return; }
  if (verb === 'hf') {
    // llm-panel-key-bindings.ts:137-141 — `a` forces the Local pane first,
    // then opens the branch.
    if (arg === 'cancel') { llmHfCancel(); return; }
    if (arg === 'back') { LLMHF.step = 'ref'; LLMHF.error = null; llmRepaint(); llmHfFocus(); return; }
    if (arg === 'clear') { LLMHF.reference = ''; LLMHF.error = null; llmRepaint(); llmHfFocus(); return; }
    if (arg === 'close') { llmHfClose(); return; }
    if (arg === 'look') { llmHfResolve(llmHfInputValue()); return; }
    if (arg === 'add') { llmHfAdd(); return; }
    if (arg.startsWith('row:')) {
      // MouseListRow's contract in the TUI (src/tui/mouse/mouse-list-row.tsx):
      // the first click selects, a second click on the SELECTED row activates.
      // Without this the HF pick list was the one list in this pane a mouse
      // could not act on — the Local model rows above activate on the first
      // click, and the footer's `Enter download` was the only mouse route.
      const at = +arg.slice(4) || 0;
      if (at === LLMHF.cursor) { llmHfAdd(); return; }
      LLMHF.cursor = at; llmRepaint(); return;
    }
    llmSetMode('local');
    LLMHF.open = true; LLMHF.step = 'ref'; LLMHF.error = null; LLMHF.repo = null; LLMHF.cursor = 0; LLMHF.busy = false;
    llmRepaint();
    llmHfFocus();
    if (BR && BR.hostRam && !LLMHF.ram) BR.hostRam().then((n) => { LLMHF.ram = Number(n) || 0; if (LLMHF.open) llmRepaint(); });
    return;
  }
  if (verb === 'backend') { llmBackendUpdate(); return; }
  if (verb === 'autoUpdate') { llmAutoUpdateToggle(); return; }
  if (verb === 'device') { llmDeviceCycle(); return; }
  if (verb === 'logs') { llmLogsOpen(); return; }
  if (verb === 'logsRefresh') { llmLogsRefresh(); return; }
  if (verb === 'back') { llmStopLogs(); LLMP.view = 'panel'; llmRepaint(); return; }
  if (verb === 'cancelPull') { if (BR) BR.cancelPull(); LLMP.pulling = null; llmRepaint(); return; }
  if (verb === 'remove') {
    if (LLMP.mode === 'fallback') { llmFallbackRemove(); return; }
    const row = llmRowAt(); if (!row) return;
    if (row.kind === 'cloudProvider' || row.kind === 'cloudChatModel' || row.kind === 'cloudEmbeddingModel') LLMP.confirm = {kind:'removeProvider', id:row.provider.id, error:null, submitting:false};
    else if (row.kind === 'localTextModel' && row.model.downloaded) LLMP.confirm = {kind:'removeLocal', id:row.model.id, error:null, submitting:false};
    else if (row.kind === 'localEmbeddingModel' && row.model.downloaded) LLMP.confirm = {kind:'removeEmbedding', id:row.model.id, error:null, submitting:false};
    else return;
    llmRepaint(); return;
  }
  if (verb === 'confirm') { const c = LLMP.confirm; if (!c) return; if (c.kind === 'removeProvider') llmRemoveProviderConfirm(); else if (c.kind === 'removeLocal') llmRemoveLocalConfirm(); return; }
  if (verb === 'cancel') { LLMP.confirm = null; llmRepaint(); return; }
  if (verb === 'external') {
    if (arg === 'save') { llmExternalSave(); return; }
    if (arg === 'cancel') { LLMP.externalDraft = null; LLMP.externalInvalid = false; llmRepaint(); return; }
    if (arg === 'edit') { llmSetMode('external'); llmPrimary(llmExternalRows()[0]); return; }
    return;
  }
  if (verb === 'steer') {
    const url = LLMP.steerUrl; LLMP.steerUrl = null;
    if (arg === 'y' && url) {
      // openai-compat-steer.ts wizardForOpenAiCompatUrl: Ollama's port lands on its preset, anything else on the manual compat row, the probed URL prefilled.
      llmSetMode('cloud');
      const preset = llmLooksLikeOllama(url) ? KIND_ROWS.find((k) => k.id === 'ollama') : null;
      llmOpenWizard(preset ? {id:preset.id, kind:preset.kind, baseUrl:url} : {id:'', kind:'openai-compatible', baseUrl:url, custom:true}, url);
      if (!preset) WIZ.row = KIND_ROWS.find((k) => k.custom);
      render();
      return;
    }
    llmRepaint(); return;
  }
  if (verb === 'fb') {
    const sub = rest[0]; const a2 = rest.slice(1).join(':');
    const view = llmFallbackView();
    if (sub === 'select') { LLMP.cursor.fallback = +a2; llmRepaint(); return; }
    if (sub === 'move') { const row = llmFallbackRowAt(); if (row && row.kind === 'link') { const chain = llmMoveLink(view.links, row.link.providerId, +a2 < 0 ? -1 : 1); if (chain) llmFallbackPersist(chain, view.appendLocal); } return; }
    if (sub === 'add') { LLMP.fallbackPicker = {cursor:0}; llmRepaint(); return; }
    if (sub === 'pick') { LLMP.fallbackPicker = null; const chain = llmAddLink(view.links, a2); if (chain) llmFallbackPersist(chain, view.appendLocal); else llmRepaint(); return; }
    if (sub === 'pickCancel') { LLMP.fallbackPicker = null; llmRepaint(); return; }
    if (sub === 'remove') { llmFallbackRemove(); return; }
    if (sub === 'local') { llmFallbackPersist(llmDeclaredChain(view.links), !view.appendLocal); return; }
  }
}
function llmFallbackEnter() {
  if (LLMP.fallbackPicker) { const ids = llmFallbackView().addableProviderIds; const id = ids[LLMP.fallbackPicker.cursor]; if (id) llmAct('fb:pick:' + id); else { LLMP.fallbackPicker = null; llmRepaint(); } return; }
  llmAct('fb:add');
}
function llmFallbackRemove() {
  const view = llmFallbackView();
  const row = llmFallbackRowAt();
  if (row && row.kind === 'link') { const chain = llmRemoveLink(view.links, row.link.providerId); if (chain) llmFallbackPersist(chain, view.appendLocal); }
}
/* llm-panel-key-bindings.ts + fallback-key-bindings.ts + the modal keys. */
function llmKey(e, k, inText) {
  const mod = e.metaKey || e.ctrlKey || e.altKey;
  // The add-provider wizard / selector popup owns the keys while open (its inputs type; Esc closes it, not the window).
  if (SEL.open || WIZ.phase) { if (k === 'Escape') { e.preventDefault(); act('close'); return true; } return inText ? false : true; }
  if (e.target.id === 'llm-filter') {
    if (k === 'Escape') { e.preventDefault(); LLMP.filterFocused = false; e.target.blur(); llmRepaint(); return true; }
    if (k === 'Enter') { e.preventDefault(); const row = llmRowAt(); if (row && row.kind === 'cloudChatModel') { LLMP.filterFocused = false; llmPrimary(row); } return true; }
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      const s = llmCloudSection(); if (!s.filtered.length) return true;
      const first = s.sectionStart, last = s.sectionStart + s.filtered.length - 1;
      LLMP.cursor.cloud = Math.min(last, Math.max(first, LLMP.cursor.cloud + (k === 'ArrowDown' ? 1 : -1)));
      llmRepaintList(); return true;
    }
    return false;
  }
  if (e.target.id === 'llm-url') {
    if (k === 'Enter') { e.preventDefault(); llmExternalSave(); return true; }
    if (k === 'Escape') { e.preventDefault(); llmAct('external:cancel'); return true; }
    return false;
  }
  /* Item 7A — the reference editor. local-models-hf-keys.ts:39-56: Escape
     cancels the lookup while one is in flight and leaves the branch once it
     is not (the least destructive reading first); ctrl+l — not ctrl+u,
     which the editor itself binds — clears the reference and its error.
     Ordinary typing falls through so the field types. */
  if (e.target.id === 'llm-hf-ref') {
    if (k === 'Escape') { e.preventDefault(); if (LLMHF.busy) llmHfCancel(); else llmHfClose(); return true; }
    if (k === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!LLMHF.busy) llmHfResolve(e.target.value); return true; }
    if (k === 'l' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!LLMHF.busy) llmAct('hf:clear'); return true; }
    return false;
  }
  if (inText || mod) return false;
  if (LLMP.view === 'logs') {
    if (k === 'Escape') { e.preventDefault(); llmAct('back'); return true; }
    if (k === 'r') { e.preventDefault(); llmLogsRefresh(); return true; }
    return true;
  }
  if (LLMP.confirm) {
    if (k === 'y' && LLMP.confirm.kind !== 'removeEmbedding') { e.preventDefault(); llmAct('confirm'); return true; }
    if (k === 'n' || k === 'Escape') { e.preventDefault(); llmAct('cancel'); return true; }
    return true;
  }
  if (LLMP.steerUrl !== null) {
    if (k === 'y') { e.preventDefault(); llmAct('steer:y'); return true; }
    if (k === 'n' || k === 'Escape') { e.preventDefault(); llmAct('steer:n'); return true; }
    return true;
  }
  if (LLMP.externalDraft !== null) { if (k === 'Escape') { e.preventDefault(); llmAct('external:cancel'); return true; } return true; }
  /* Item 7A — the branch owns every key it does not name, on BOTH steps
     (local-models-hf-keys.ts, "Both steps swallow every key they do not
     name"): a stray `s` or `d` under an open editor would otherwise start
     a daemon or open a delete confirm while a repo name is being typed. */
  if (LLMHF.open) {
    if (LLMHF.step === 'pick') {
      const n = LLMHF.repo ? LLMHF.repo.choices.length : 0;
      // Escape goes back to the reference, not out of the branch: the
      // resolved repo survives, so the file list costs no second request.
      if (k === 'Escape') { e.preventDefault(); llmAct('hf:back'); return true; }
      if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); LLMHF.cursor = Math.min(LLMHF.cursor + 1, Math.max(0, n - 1)); llmRepaint(); return true; }
      if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); LLMHF.cursor = Math.max(LLMHF.cursor - 1, 0); llmRepaint(); return true; }
      if (k === 'Enter') { e.preventDefault(); llmHfAdd(); return true; }
      e.preventDefault(); return true;
    }
    if (k === 'Escape') { e.preventDefault(); if (LLMHF.busy) llmHfCancel(); else llmHfClose(); return true; }
    if (k === 'Enter') { e.preventDefault(); if (!LLMHF.busy) llmHfResolve(llmHfInputValue()); return true; }
    e.preventDefault(); return true;
  }
  if (LLMP.mode === 'fallback') {
    if (LLMP.fallbackPicker) {
      const n = llmFallbackView().addableProviderIds.length;
      if (k === 'Escape') { e.preventDefault(); llmAct('fb:pickCancel'); return true; }
      if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); LLMP.fallbackPicker.cursor = Math.min(LLMP.fallbackPicker.cursor + 1, Math.max(0, n - 1)); llmRepaint(); return true; }
      if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); LLMP.fallbackPicker.cursor = Math.max(LLMP.fallbackPicker.cursor - 1, 0); llmRepaint(); return true; }
      if (k === 'Enter') { e.preventDefault(); llmFallbackEnter(); return true; }
      return true;
    }
    const n = llmFallbackRows().length;
    if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); LLMP.cursor.fallback = Math.min(LLMP.cursor.fallback + 1, Math.max(0, n - 1)); llmRepaint(); return true; }
    if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); LLMP.cursor.fallback = Math.max(LLMP.cursor.fallback - 1, 0); llmRepaint(); return true; }
    if (k === '<' || k === '>') { e.preventDefault(); llmAct('fb:move:' + (k === '<' ? -1 : 1)); return true; }
    if (k === 'a' || k === 'Enter') { e.preventDefault(); llmAct('fb:add'); return true; }
    if (k === 'd') { e.preventDefault(); llmAct('fb:remove'); return true; }
    if (k === 'l') { e.preventDefault(); llmAct('fb:local'); return true; }
  }
  if (k === 'f') { e.preventDefault(); llmAct('filter'); return true; }
  if (k === 'p' && LLMP.mode === 'cloud') { e.preventDefault(); return true; } // inert facet (no pricing in the CLI list)
  const n = llmRows().length;
  if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); LLMP.cursor[LLMP.mode] = Math.min(LLMP.cursor[LLMP.mode] + 1, Math.max(0, n - 1)); llmRepaint(); return true; }
  if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); LLMP.cursor[LLMP.mode] = Math.max(LLMP.cursor[LLMP.mode] - 1, 0); llmRepaint(); return true; }
  if (k === 'Enter') { e.preventDefault(); llmAct('enter'); return true; }
  if (k === '[' || k === 'ArrowLeft') { e.preventDefault(); llmAct('mode:prev'); return true; }
  if (k === ']' || k === 'ArrowRight') { e.preventDefault(); llmAct('mode:next'); return true; }
  const map = {e:'embedding', E:'embToggle', n:'add', c:'configure', s:'daemon', B:'backend', L:'logs', r:'refresh', d:'remove', U:'autoUpdate', G:'device'};
  if (map[k]) { e.preventDefault(); llmAct(map[k]); return true; }
  if (k === 'a') { e.preventDefault(); llmAct('hf'); return true; } // Item 7A — add from Hugging Face
  return false;
}
/**
 * Item 7A — what happens after the weights land.
 *
 * `atag models pull` fetches the weights and stops, so a vision model
 * added from Hugging Face would otherwise run text-only forever with
 * nothing in `models list` or `models status` saying why. The projector
 * is fetched here, on the SAME banner: the subscriber above drops every
 * frame when `LLMP.pulling` is null, so the second phase claims the slot
 * before it starts and releases it in a `finally`.
 *
 * Auto-activation waits for the projector, and is SKIPPED when the
 * projector did not land. `models start` appends `--mmproj` only when
 * the file is already on disk (src/cli/models-handlers.ts gates on
 * isMmprojDownloaded), so starting the daemon after a failed or
 * cancelled projector would give a silently text-only daemon for a model
 * this window just labelled vision-capable — the same degradation the
 * projector step exists to prevent. The failure is stated instead, and
 * the row is left for the operator to start by hand.
 */
async function llmAfterPull(p) {
  const mm = LLMHF.pendingMmproj;
  let mmError = null;
  let attempted = false;
  if (mm && mm.id === p.id && BR && BR.hfProjector) {
    attempted = true;
    LLMHF.pendingMmproj = null;
    LLMP.pulling = {kind:'chat', id:p.id, phase:'mmproj'};
    LLMP.pullLog = [mm.name + ' (mmproj) 0%'];   // local-models-orchestrator.ts pullMmprojPhase's banner label
    llmRepaint();
    try {
      const res = await BR.hfProjector(mm.id, mm.url, mm.filename, mm.name);
      if (!res || res.ok !== true) mmError = (res && res.error) || 'the projector download failed';
    } catch (e) {
      mmError = 'the projector download failed: ' + ((e && e.message) || String(e));
    } finally {
      LLMP.pulling = null;
    }
  }
  await llmRefresh();
  /* The verdict is returned so the suite can assert the decision itself
     rather than its side effects: `skipped` is true only when a failed or
     cancelled projector held activation back. The message goes in
     LLMP.msg, not LLMP.statusErr — statusErr belongs to `models status`
     and the 5 s poll (llmApplyStatus) overwrites it within a tick. */
  if (mmError) {
    LLMP.msg = {text:'! ' + mmError
      + ' — the weights are on disk, but the model was not started: it would serve text only. Press s to start it anyway.'};
    llmRepaint();
    return {projector:'failed', activated:false, skipped:true};
  }
  const row = llmRows('local').find((r) => r.model && r.model.id === p.id);
  if (row && LLMP.mode === 'local') { llmPrimary(row); return {projector: attempted ? 'ok' : 'none', activated:true, skipped:false}; }
  return {projector: attempted ? 'ok' : 'none', activated:false, skipped:false};
}

/* The pull stream for the LLM tab's downloads, guarded by its own owner flag like the SEL/MP subscribers. */
if (BR) {
  BR.onPull((ev) => {
    if (!ev || !LLMP.pulling) return;
    if (ev.line) { LLMP.pullLog.push(ev.line); const box = document.getElementById('llm-pull-line'); if (box) box.textContent = ev.line; }
    if (ev.done) {
      const p = LLMP.pulling; LLMP.pulling = null;
      if (ev.ok) { LLMP.msg = {text:'local-llm: ' + p.id + ' installed'}; llmAfterPull(p); }
      else { LLMP.statusErr = ev.error || 'the download failed'; LLMHF.pendingMmproj = null; llmRepaint(); }
    }
  });
}

/* ---------------- Telegram tab (setup-state.ts, telegram-panel.tsx, telegram-token-prompt.tsx,
   tui-telegram-orchestrator.ts, telegram-key-bindings.ts). The channel state, bot identity and
   pairing live inside the serve process's channel — nothing on the HTTP API exposes them, so
   the tab shows config + .env facts and says where pairing happens. ---------------- */

function telegramVisible() { return !!S.settings && settingsPaneId(S.settingsPane) === 'telegram'; }
function tgCfgBlock() { const t = LIVE_CONFIG && LIVE_CONFIG.telegram; return t && typeof t === 'object' ? t : null; }
function tgEnabled() { const t = tgCfgBlock(); if (t && typeof t.enabled === 'boolean') return t.enabled; return TG.cfg && typeof TG.cfg.enabled === 'boolean' ? TG.cfg.enabled : null; }
function tgOwner() { const t = tgCfgBlock(); if (t && 'ownerUserId' in t) return t.ownerUserId === undefined ? null : t.ownerUserId; return TG.cfg && TG.cfg.ownerUserId !== undefined ? TG.cfg.ownerUserId : null; }
function tgHasToken() { if (!TG.keysKnown) return null; return TG.dotenvKeys.includes('TELEGRAM_BOT_TOKEN') || TG.envKeys.includes('TELEGRAM_BOT_TOKEN'); }
function telegramTabEntered() { tgRefresh(); }
function tgRepaint() { if (telegramVisible()) paneRepaintKeepFocus(telegramTab()); }
/* R refresh (orchestrator refreshSettings): config + the key names in the env and .env.
   Review fix: a refresh asked for while one was in flight used to be DROPPED
   (`if (TG.keysBusy) return`). tgTokenSave awaits its own tgRefresh right after
   writing the key, so a refresh already running — the tab's entry refresh, or
   the settings poll — made that await return without re-reading .env, and a
   token that had just been written showed as `missing` with no confirm card.
   Refreshes are serialized now: the second one runs after the first instead of
   being thrown away. */
function tgRefresh() {
  if (!BR) return Promise.resolve();
  TG.keysChain = (TG.keysChain || Promise.resolve()).then(tgRefreshOnce, tgRefreshOnce);
  return TG.keysChain;
}
async function tgRefreshOnce() {
  if (!BR) return;
  TG.keysBusy = true;
  const stateDir = memStateDir();
  const [cfg, env, dotenv, eff] = await Promise.all([
    BR.configGet(), BR.envPresent(['TELEGRAM_BOT_TOKEN']), stateDir ? BR.dotenvKeys(stateDir) : Promise.resolve({ok:true, keys:[]}),
    tgCfgBlock() && typeof tgCfgBlock().enabled === 'boolean' ? Promise.resolve(null) : BR.configGetKey('telegram'),
  ]);
  TG.keysBusy = false;
  if (cfg && cfg.ok && cfg.config) LIVE_CONFIG = cfg.config;
  TG.envKeys = Array.isArray(env) ? env : [];
  TG.dotenvKeys = dotenv && dotenv.ok ? dotenv.keys : [];
  if (dotenv && dotenv.ok === false) TG.lastError = 'could not read .env: ' + (dotenv.error || 'unknown error');
  if (eff && eff.ok && eff.value && typeof eff.value === 'object') TG.cfg = eff.value;
  TG.keysKnown = true;
  tgRepaint();
}
function telegramTab() {
  const hasToken = tgHasToken();
  const enabled = tgEnabled();
  const owner = tgOwner();
  let body = '';
  if (TG.mode === 'tokenPrompt') body += tgTokenPromptHTML();
  else if (hasToken === null) body += '<div class="ter">reading .env…</div>';
  else if (!hasToken) {
    // setup-state.ts not_connected (no token).
    body += '<div class="tuimodal tgcard"><b>Connect Telegram</b>'
      + '<div class="ter">Create a bot with @BotFather, copy the token, and paste it here. The token is stored only on this machine.</div>'
      + '<div style="margin-top:8px"><button class="skpf skpaccent" data-act="telegram:token">Press Enter to paste a bot token</button></div></div>';
  } else if (owner === null) {
    // setup-state.ts needs_pairing; the CTA would open the pairing window, which only the live channel can.
    body += '<div class="tuimodal tgcard"><b>One last step — confirm it\'s you</b>'
      + '<div class="ter">Open Telegram, DM your bot any message. Atomic Agent will recognise you as the owner.</div>'
      + '<div class="ter" style="margin-top:8px">' + esc(TG_PAIRING_NOTE) + '</div></div>';
  } else {
    // Token + owner: the TUI would say "✅ Telegram is connected" only with the channel `up`, which the desktop cannot see.
    body += '<div class="ter">channel state is not exposed by the agent\'s HTTP API — the Telegram tab in `atag tui` shows it live</div>';
  }
  const advanced = TG.showAdvanced || (hasToken && owner !== null);
  if (advanced && TG.mode !== 'tokenPrompt') body += tgAdvancedHTML(enabled, hasToken, owner);
  // telegram-panel.tsx keeps `· <message>` inside AdvancedControls; here it is always shown, because the desktop's message carries the restart the serve process needs.
  if (TG.message) body += '<div class="ter" style="margin-top:8px">· ' + esc(TG.message) + (TG.restart ? ' <span class="ter">(the agent loads .env and config.json at start)</span> <button class="btn btn-s" data-act="agent:restart" style="height:22px">Restart Agent Runtime</button>' : '') + '</div>';
  return '<div class="tui">' + body
    + '<div class="tuihint"><button data-act="telegram:advanced">' + (TG.showAdvanced ? 'a — hide advanced' : 'a — advanced') + '</button></div></div>';
}
/* telegram-panel.tsx AdvancedControls; `state` is the one fact the desktop cannot read. */
function tgAdvancedHTML(enabled, hasToken, owner) {
  return '<div style="margin-top:8px"><span class="ter">state </span><b class="ter" title="no channel status route in this agent\'s HTTP API — the state lives inside the serve process">unknown</b>'
    + '<span class="ter">   enabled </span><span class="' + (enabled ? 'skpaccent' : 'ter') + '">' + (enabled === null ? '—' : enabled ? 'yes' : 'no') + '</span>'
    + '<span class="ter">   token </span><span class="' + (hasToken ? 'skpaccent' : 'tuierr') + '">' + (hasToken === null ? '—' : hasToken ? 'set' : 'missing') + '</span>'
    + '<span class="ter">   owner </span><span class="' + (owner === null ? 'tuierr' : 'skpaccent') + '">' + (owner === null ? 'unset' : esc(String(owner))) + '</span></div>'
    + (TG.lastError ? '<div class="tuierr">! ' + esc(TG.lastError) + '</div>' : '')
    + '<div class="tuihint" style="margin-top:8px">' + tuiBtn('e — ' + (enabled ? 'disable' : 'enable'), 'telegram:enable', {disabled:TG.busy || enabled === null}) + '<span>·</span>' + tuiBtn('r — restart', 'telegram:restart') + '<span>·</span>' + tuiBtn('R — refresh', 'telegram:refresh') + '</div>'
    + '<div class="tuihint">' + tuiBtn('T — clear token', 'telegram:clearToken', {disabled:TG.busy || !hasToken}) + '<span>·</span>' + tuiBtn('O — clear owner', 'telegram:clearOwner', {disabled:TG.busy || owner === null}) + '<span>·</span>' + tuiBtn('t — change token', 'telegram:token') + '<span>·</span>' + tuiBtn('o — re-pair', 'telegram:pair', {disabled:true, title:TG_PAIRING_NOTE}) + '</div>'
    ;
}
/* telegram-token-prompt.tsx: a password input masks the token; the value never reaches state or the DOM as text. */
function tgTokenPromptHTML() {
  const t = TG.token;
  return '<div class="tuimodal tgcard"><b>bot token</b>'
    + '<div class="ter">Paste the token issued by @BotFather. Saved to <span class="skpaccent">.env</span> at mode 0600.</div>'
    + '<div><span class="ter">&gt; </span><input id="tg-token" type="password" autocomplete="off" spellcheck="false"' + (t.submitting ? ' disabled' : '') + '></div>'
    + (t.error ? '<div class="tuierr">! ' + esc(t.error) + '</div>' : '')
    + '<div class="ter"><button class="skpf" data-act="telegram:tokenSave"' + (t.submitting ? ' disabled' : '') + '>Enter to save</button> · <button class="skpf" data-act="telegram:tokenCancel">Esc to cancel</button> · Backspace to edit' + (t.submitting ? ' · saving…' : '') + '</div></div>';
}
function tgSetMessage(text, restart) { TG.message = text; TG.restart = !!restart; TG.lastError = null; }
/* tui-telegram-orchestrator.ts submitToken: empty fails locally, then
   channel.setToken → <stateDir>/.env TELEGRAM_BOT_TOKEN (the dotenv writer
   port), "token saved", then the connect chain's next step — with a
   channel the desktop cannot see, that is `set_enabled` when telegram is
   off (setup-flow.ts decideConnectAction). */
async function tgTokenSave(value) {
  const input = document.getElementById('tg-token');
  const raw = value !== undefined ? value : (input ? input.value : '');
  const trimmed = String(raw || '').trim();
  if (!trimmed) { TG.token.error = 'token is empty'; tgRepaint(); const n = $('#tg-token'); if (n) n.focus(); return {ok:false, error:'token is empty'}; }
  const stateDir = memStateDir();
  if (!BR || !stateDir) { TG.token.error = 'state dir unknown'; tgRepaint(); return {ok:false, error:'state dir unknown'}; }
  TG.token.submitting = true; TG.busy = true; tgRepaint();
  const res = await BR.dotenvSet(stateDir, 'TELEGRAM_BOT_TOKEN', trimmed);
  if (!res || res.ok === false) { TG.token.submitting = false; TG.busy = false; TG.token.error = (res && res.error) || 'setToken failed'; TG.lastError = 'setToken failed: ' + TG.token.error; tgRepaint(); return {ok:false, error:TG.token.error}; }
  TG.mode = 'list'; TG.token = {error:null, submitting:false};
  tgSetMessage('token saved', true);
  await tgRefresh();
  if (tgEnabled() === false) {
    const w = await BR.configSet('telegram.enabled', 'true');
    if (!w || w.ok === false) TG.lastError = 'setEnabled failed: ' + ((w && w.error) || 'unknown error');
    else tgSetMessage('telegram enabled', true);
    await tgRefresh();
  }
  TG.busy = false; tgRepaint();
  return {ok:true};
}
async function tgClearToken() {
  const stateDir = memStateDir();
  if (!BR || !stateDir || TG.busy) return;
  TG.busy = true; tgRepaint();
  const res = await BR.dotenvSet(stateDir, 'TELEGRAM_BOT_TOKEN', null);
  TG.busy = false;
  if (!res || res.ok === false) TG.lastError = 'clearToken failed: ' + ((res && res.error) || 'unknown error');
  else tgSetMessage('token cleared', true);
  await tgRefresh();
}
async function tgSetEnabled(enabled) {
  if (!BR || TG.busy) return;
  TG.busy = true; tgRepaint();
  const res = await BR.configSet('telegram.enabled', String(!!enabled));
  TG.busy = false;
  if (!res || res.ok === false) TG.lastError = 'setEnabled failed: ' + ((res && res.error) || 'unknown error');
  else tgSetMessage(enabled ? 'telegram enabled' : 'telegram disabled', true);
  await tgRefresh();
}
async function tgClearOwner() {
  if (!BR || TG.busy) return;
  TG.busy = true; tgRepaint();
  const res = await BR.configUnset('telegram.ownerUserId');
  TG.busy = false;
  if (!res || res.ok === false) TG.lastError = 'setOwnerUserId failed: ' + ((res && res.error) || 'unknown error');
  else tgSetMessage('owner cleared — telegram now ignores all DMs', true);
  await tgRefresh();
}
function telegramAct(what) {
  const [verb] = what.split(':');
  const arg = what.slice(verb.length + 1);
  if (verb === 'advanced') { TG.showAdvanced = !TG.showAdvanced; tgRepaint(); return; }
  if (verb === 'token') { TG.mode = 'tokenPrompt'; TG.token = {error:null, submitting:false}; tgRepaint(); const n = $('#tg-token'); if (n) n.focus(); return; }
  if (verb === 'tokenSave') { tgTokenSave(arg || undefined); return; }
  if (verb === 'tokenCancel') { TG.mode = 'list'; TG.token = {error:null, submitting:false}; tgRepaint(); return; }
  if (verb === 'clearToken') { tgClearToken(); return; }
  if (verb === 'enable') { const e = tgEnabled(); if (e !== null) tgSetEnabled(!e); return; }
  if (verb === 'clearOwner') { tgClearOwner(); return; }
  // `r — restart` restarts the channel in the TUI; the desktop restarts the agent runtime, which restarts the channel with it.
  if (verb === 'restart') { tgSetMessage('telegram restarted with the agent runtime', false); act('agent:restart'); return; }
  if (verb === 'refresh') { tgRefresh(); return; }
  if (verb === 'pair') return; // disabled: pairing needs the live channel
}
/* telegram-key-bindings.ts: list-mode letters; the token prompt owns its input. */
function telegramKey(e, k, inText) {
  if (e.target.id === 'tg-token') {
    if (k === 'Enter') { e.preventDefault(); tgTokenSave(); return true; }
    if (k === 'Escape') { e.preventDefault(); telegramAct('tokenCancel'); return true; }
    return false;
  }
  if (inText || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (TG.mode === 'tokenPrompt') { if (k === 'Escape') { e.preventDefault(); telegramAct('tokenCancel'); return true; } return false; }
  // Enter = the connect flow's next step: paste a token, else (no owner) the pairing that needs the TUI.
  if (k === 'Enter') { e.preventDefault(); if (tgHasToken() === false) telegramAct('token'); else if (tgOwner() === null) tgSetMessage(TG_PAIRING_NOTE, false), tgRepaint(); return true; }
  const map = {a:'advanced', e:'enable', t:'token', T:'clearToken', o:'pair', O:'clearOwner', r:'restart', R:'refresh'};
  if (map[k]) { e.preventDefault(); telegramAct(map[k]); return true; }
  return false;
}

/* ---------------- Import tab (import-panel.tsx, import-panel-state.ts, import-key-bindings.ts,
   import-orchestrator.ts). The run is `atag import <hermes|openclaw> … --dry-run|--yes` (the
   HTTP API has no import route); its report lines are parsed into the TUI's rows. ---------------- */

function importVisible() { return !!S.settings && settingsPaneId(S.settingsPane) === 'import'; }
function impFocusOrder(source) { const order = ['sourceType', 'source', 'sessions', 'cron']; if (source === 'hermes') order.push('secrets'); order.push('overwrite', 'limit', 'run'); return order; }
function impRepaint() { if (importVisible()) paneRepaintKeepFocus(importTab()); }
async function importTabEntered() {
  if (!BR || IMP.defaults) return;
  const d = await BR.importDefaults();
  if (d && d.hermes) { IMP.defaults = d; if (!IMP.form.sourceDir) IMP.form.sourceDir = d[IMP.form.source] || ''; impRepaint(); }
}
function impDefaultDir(source) { return IMP.defaults ? (IMP.defaults[source] || '') : (homeDir() ? homeDir() + (source === 'openclaw' ? '/.openclaw' : '/.hermes') : ''); }
function importTab() {
  const f = IMP.form;
  const sourceLabel = f.source === 'openclaw' ? 'OpenClaw' : 'Hermes';
  let body = '<b>Import · ' + sourceLabel + ' → atomic-agent</b>';
  if (IMP.notice) body += '<div class="tuierr" style="margin-top:8px">! ' + esc(IMP.notice) + '</div>';
  if (IMP.mode === 'configure') body += impFormHTML(f);
  else if (IMP.mode === 'running') body += '<div class="ter" style="margin-top:8px">importing… please wait</div>';
  else if ((IMP.mode === 'preview' || IMP.mode === 'done') && IMP.report) body += impReportHTML(IMP.report, IMP.mode === 'done');
  return '<div class="tui">' + body + '</div>';
}
function impLabel(label, focused) { return '<span class="ter">' + esc((focused ? '▸' : ' ') + ' ' + label.padEnd(10) + ': ') + '</span>'; }
function impFormHTML(f) {
  const fc = f.focus;
  const text = (label, field, placeholder) => '<div class="impline">' + impLabel(label, fc === field) + '<input class="impinp' + (f[field === 'source' ? 'sourceDir' : field] ? '' : ' empty') + '" data-imp-field="' + (field === 'source' ? 'sourceDir' : 'limit') + '" data-imp-focus="' + field + '" value="' + esc(f[field === 'source' ? 'sourceDir' : field]) + '" placeholder="' + esc(placeholder) + '" autocomplete="off" spellcheck="false"></div>';
  const toggle = (label, field, hint) => '<div class="impline">' + impLabel(label, fc === field) + '<button class="skpf' + (f[field] ? ' sk-on' : ' ter') + '" data-act="import:toggle:' + field + '">[' + (f[field] ? '✓' : ' ') + ']</button>' + (hint ? '<span class="ter">  ' + esc(hint) + '</span>' : '') + '</div>';
  return '<div class="tuimodal impform">'
    + '<div class="impline">' + impLabel('source-of', fc === 'sourceType') + '<button class="skpf' + (f.source === 'hermes' ? ' sk-on' : ' ter') + '" data-act="import:source:hermes">' + (f.source === 'hermes' ? '‹hermes›' : ' hermes ') + '</button><span class="ter"> / </span><button class="skpf' + (f.source === 'openclaw' ? ' sk-on' : ' ter') + '" data-act="import:source:openclaw">' + (f.source === 'openclaw' ? '‹openclaw›' : ' openclaw ') + '</button></div>'
    + text('source', 'source', f.source === 'openclaw' ? '~/.openclaw' : '~/.hermes')
    + toggle('sessions', 'sessions') + toggle('cron', 'cron')
    + (f.source === 'hermes' ? toggle('secrets', 'secrets', 'OPENROUTER_API_KEY / AIMLAPI_API_KEY') : '')
    + toggle('overwrite', 'overwrite', 'replace differing destinations')
    + text('limit', 'limit', '(no limit)')
    + '<div class="impline" style="margin-top:8px"><button class="skpf' + (fc === 'run' ? ' sk-on' : ' ter') + '" data-act="import:preview"' + (IMP.busy ? ' disabled' : '') + '>' + (fc === 'run' ? '▸' : ' ') + ' Run preview</button></div>'
    + '<div class="ter" style="margin-top:8px">↑↓ move · ←/→ switch source · space toggle · type to edit · Enter on Run = preview · Ctrl+Enter preview</div></div>';
}
/* import-panel.tsx ReportView / ReportRow / SummaryRow, over the parsed CLI report. */
function impReportHTML(report, executed) {
  const items = report.items.slice(0, IMP_REPORT_ROWS);
  const hidden = report.items.length - items.length;
  const s = report.summary;
  const color = (st) => ({migrated:'sk-on', skipped:'ter', conflict:'sk-off', error:'tuierr'}[st] || 'ter');
  return '<div style="margin-top:8px"><div class="ter">' + (executed ? 'result' : 'preview (dry-run)') + ' · ' + report.items.length + ' item' + (report.items.length === 1 ? '' : 's') + '</div>'
    + items.map((it) => {
      const arrow = it.source && it.destination ? it.source + ' → ' + it.destination : (it.source || it.destination || '');
      return '<div class="improw" data-import-row="1"><span class="' + color(it.status) + '">' + esc(it.status.padEnd(8)) + '</span><span class="ter"> [' + esc(it.kind) + '] ' + esc(arrow) + (it.reason ? ' (' + esc(it.reason) + ')' : '') + '</span></div>';
    }).join('')
    + (hidden > 0 ? '<div class="ter">  … ' + hidden + ' more</div>' : '')
    + '<div style="margin-top:8px"><span class="sk-on">migrated=' + s.migrated + '</span><span class="ter"> · skipped=' + s.skipped + '</span><span class="sk-off"> · conflict=' + s.conflict + '</span><span class="tuierr"> · error=' + s.error + '</span></div>'
    + (IMP.state === 'nothing' ? '<div class="ter">Nothing to import.</div>' : '')
    + (executed ? tuiHints([['Enter / Esc back to form', 'import:reset']]) : tuiHints([['y / Enter apply', 'import:apply', {disabled:IMP.busy}], ['e edit', 'import:reset'], ['Esc cancel', 'import:reset']]))
    + '</div>';
}
/* import-orchestrator.ts runImport: the option set from the toggles, the
   limit parsed, then one `atag import` subprocess — never while a turn is
   running (it writes sessions.sqlite / tasks.sqlite beside the serve). */
async function impRun(execute) {
  if (!BR || IMP.busy) return {ok:false, error:'busy'};
  if (S.busy) { IMP.notice = 'Not while a turn is running'; impRepaint(); return {ok:false, error:IMP.notice}; }
  const f = IMP.form;
  const limit = f.limit.trim();
  if (limit && !/^\d+$/.test(limit)) { IMP.mode = 'configure'; IMP.notice = 'limit must be a non-negative integer'; impRepaint(); return {ok:false, error:IMP.notice}; }
  const exclude = []; if (!f.sessions) exclude.push('sessions'); if (!f.cron) exclude.push('cron');
  const selected = f.source === 'hermes' ? (f.sessions || f.cron || f.secrets) : (f.sessions || f.cron);
  if (!selected) { IMP.mode = 'configure'; IMP.notice = f.source === 'hermes' ? 'nothing selected to import — enable sessions, cron or secrets' : 'nothing selected to import — enable sessions or cron'; impRepaint(); return {ok:false, error:IMP.notice}; }
  IMP.mode = 'running'; IMP.notice = null; IMP.busy = true; IMP.runs++; impRepaint();
  const res = await BR.importRun({source:f.source, dir:f.sourceDir.trim() || impDefaultDir(f.source), exclude, secrets:f.secrets, overwrite:f.overwrite, limit, execute});
  IMP.busy = false;
  if (!res || !res.ok) { IMP.mode = 'configure'; IMP.notice = (res && res.error) || 'import failed'; impRepaint(); return {ok:false, error:IMP.notice}; }
  IMP.report = res.report; IMP.state = res.state;
  if (res.state === 'non-interactive') { IMP.mode = 'configure'; IMP.notice = 'Non-interactive: re-run with --yes to apply, or --dry-run to preview only.'; impRepaint(); return {ok:false, error:IMP.notice}; }
  if (execute) {
    IMP.mode = 'done'; IMP.reportExecuted = true;
    if (res.state === 'applied') {
      const s = res.report.summary;
      toast('import done', 'migrated=' + s.migrated + ' skipped=' + s.skipped + ' conflict=' + s.conflict + ' error=' + s.error);
      if (f.cron) tasksRefresh();
      if (f.sessions) loadResources();
    }
  } else { IMP.mode = 'preview'; IMP.reportExecuted = false; }
  impRepaint();
  return {ok:true, state:res.state, report:res.report};
}
function importAct(what) {
  const [verb, ...rest] = what.split(':');
  const arg = rest.join(':');
  const f = IMP.form;
  if (verb === 'source') { if (arg !== f.source && (arg === 'hermes' || arg === 'openclaw')) { f.source = arg; f.sourceDir = impDefaultDir(arg); if (arg !== 'hermes') f.secrets = false; f.focus = 'sourceType'; } impRepaint(); return; }
  if (verb === 'toggle') { if (IMP_TOGGLE_FIELDS.includes(arg)) { f[arg] = !f[arg]; f.focus = arg; } impRepaint(); return; }
  if (verb === 'field') { const [name, ...v] = rest; if (name === 'sourceDir' || name === 'limit') f[name] = v.join(':'); impRepaint(); return; }
  if (verb === 'focus') { f.focus = arg; impRepaint(); return; }
  if (verb === 'preview') { f.focus = 'run'; impRun(false); return; }
  if (verb === 'apply') { if (IMP.mode === 'preview') impRun(true); return; }
  if (verb === 'reset') { IMP.mode = 'configure'; IMP.report = null; IMP.reportExecuted = false; IMP.notice = null; IMP.state = null; impRepaint(); return; }
}
/* import-key-bindings.ts. Text rows are real inputs here: letters type into them, ↑/↓ and Enter walk the form. */
function importKey(e, k, inText) {
  const mod = e.metaKey || e.ctrlKey;
  const f = IMP.form;
  if (IMP.mode === 'running') return true;
  if (IMP.mode === 'preview') {
    if (inText) return false;
    if (k === 'y' || k === 'Enter') { e.preventDefault(); importAct('apply'); return true; }
    if (k === 'e' || k === 'n' || k === 'Escape') { e.preventDefault(); importAct('reset'); return true; }
    return true;
  }
  if (IMP.mode === 'done') { if (k === 'Enter' || k === 'Escape') { e.preventDefault(); importAct('reset'); return true; } return !inText; }
  const order = impFocusOrder(f.source);
  const move = (d) => { const i = order.indexOf(f.focus); f.focus = order[((i < 0 ? 0 : i) + d + order.length) % order.length]; impRepaint(); const n = document.querySelector('[data-imp-focus="' + f.focus + '"]'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } else { const b = document.activeElement; if (b && b.blur) b.blur(); } };
  if (e.target.dataset && e.target.dataset.impFocus) {
    f.focus = e.target.dataset.impFocus;
    if (k === 'Escape') return false;
    if (mod && k === 'Enter') { e.preventDefault(); importAct('preview'); return true; }
    if (k === 'ArrowDown') { e.preventDefault(); move(1); return true; }
    if (k === 'ArrowUp') { e.preventDefault(); move(-1); return true; }
    if (k === 'Enter') { e.preventDefault(); move(1); return true; }
    return false;
  }
  if (inText) return false;
  if (k === 'Escape') return false;
  if (mod && k === 'Enter') { e.preventDefault(); importAct('preview'); return true; }
  if (e.altKey || mod) return false;
  if (k === 'ArrowDown') { e.preventDefault(); move(1); return true; }
  if (k === 'ArrowUp') { e.preventDefault(); move(-1); return true; }
  if (k === 'Enter') {
    e.preventDefault();
    if (f.focus === 'run') importAct('preview');
    else if (f.focus === 'sourceType') importAct('source:' + (f.source === 'hermes' ? 'openclaw' : 'hermes'));
    else if (IMP_TOGGLE_FIELDS.includes(f.focus)) importAct('toggle:' + f.focus);
    else move(1);
    return true;
  }
  if (f.focus === 'sourceType') { if (k === ' ' || k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); importAct('source:' + (f.source === 'hermes' ? 'openclaw' : 'hermes')); } return true; }
  if (IMP_TOGGLE_FIELDS.includes(f.focus)) { if (k === ' ' || k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); importAct('toggle:' + f.focus); } return true; }
  if (f.focus === 'source' || f.focus === 'limit') { const n = document.querySelector('[data-imp-focus="' + f.focus + '"]'); if (n && k.length === 1) { n.focus(); return false; } }
  return true;
}

/* Hooks for --smoke (Item 7 part C: the LLM, Telegram and Import tabs). */
if (typeof window !== 'undefined') {
  window.__llmPane = () => ({mode: LLMP.mode, rows: document.querySelectorAll('#settings [data-llm-row]').length, view: LLMP.view,
    localRows: (LLMP.local || []).length, embRows: (LLMP.emb || []).length, refreshed: LLMP.lastRefreshedAt, localErr: LLMP.localErr, statusErr: LLMP.statusErr,
    status: LLMP.status ? {mode: LLMP.status.mode, dataDir: LLMP.status.dataDir, activeModel: LLMP.status.activeModel, daemon: LLMP.status.daemon, health: LLMP.status.health} : null,
    daemonLabel: llmFormatDaemon(), statusLine: llmStatusLine(), msg: LLMP.msg ? LLMP.msg.text : '', restart: !!(LLMP.msg && LLMP.msg.restart),
    cursor: Object.assign({}, LLMP.cursor), keysKnown: llmKeysKnown(), modelsFor: LLMP.modelsFor, models: LLMP.models.length, modelsBusy: LLMP.modelsBusy, modelsErr: LLMP.modelsErr,
    confirm: LLMP.confirm ? Object.assign({}, LLMP.confirm) : null, externalDraft: LLMP.externalDraft, steerUrl: LLMP.steerUrl, picker: LLMP.fallbackPicker ? Object.assign({}, LLMP.fallbackPicker) : null,
    activeText: llmActiveTextId(), providers: llmCloudProviders().map((p) => ({id: p.id, kind: p.kind, hasKey: llmHasKey(p), active: p.id === llmActiveTextId()})),
    fallback: llmFallbackView(), section: (() => { const s = llmCloudSection(); return {provider: s.provider ? s.provider.id : null, status: s.status, models: s.models.length, filtered: s.filtered.length}; })(),
    flatRows: llmRows().map((r) => r.id)});
  window.__llmOpen = async (mode) => { window.__settingsOpen('llm'); llmSetMode(mode || 'local'); if (LLMP.inflight) await LLMP.inflight; return window.__llmPane(); };
  window.__llmAct = (what) => { llmAct(what); return window.__llmPane(); };
  window.__llmRefresh = async () => { await llmRefresh(); return window.__llmPane(); };
  window.__llmFallbackPersist = async (chain, appendLocal) => { await llmFallbackPersist(chain, appendLocal); return window.__llmPane(); };
  window.__llmProbe = (url) => (BR ? BR.llamaProbe(url) : Promise.resolve({ok:false, error:'no bridge'}));
  window.__llmExternalSave = async (url) => { llmSetMode('external'); LLMP.externalDraft = String(url); LLMP.externalInvalid = false; llmRepaint(); const n = document.getElementById('llm-url'); if (n) n.value = String(url); await llmExternalSave(); return window.__llmPane(); };
  window.__telegram = () => ({hasToken: tgHasToken(), enabled: tgEnabled(), owner: tgOwner(), mode: TG.mode, showAdvanced: TG.showAdvanced, message: TG.message || '', restart: !!TG.restart,
    lastError: TG.lastError, dotenvKeys: TG.dotenvKeys.slice(), envKeys: TG.envKeys.slice(), keysKnown: TG.keysKnown, busy: TG.busy, tokenError: TG.token.error});
  window.__telegramAct = (what) => { telegramAct(what); return window.__telegram(); };
  window.__telegramTokenSave = async (value) => { TG.mode = 'tokenPrompt'; TG.token = {error:null, submitting:false}; const r = await tgTokenSave(value); return Object.assign({}, r, {state: window.__telegram()}); };
  window.__telegramClearToken = async () => { await tgClearToken(); return window.__telegram(); };
  window.__telegramRefresh = async () => { await tgRefresh(); return window.__telegram(); };
  window.__import = () => ({mode: IMP.mode, form: Object.assign({}, IMP.form), runs: IMP.runs, notice: IMP.notice, state: IMP.state, busy: IMP.busy,
    report: IMP.report ? {items: IMP.report.items.length, summary: Object.assign({}, IMP.report.summary), first: IMP.report.items[0] || null} : null,
    painted: document.querySelectorAll('#settings [data-import-row]').length});
  window.__importRuns = () => IMP.runs;
  window.__importAct = (what) => { importAct(what); return window.__import(); };
  window.__importRun = async (execute) => { const r = await impRun(!!execute); return Object.assign({}, r, {state2: window.__import()}); };
}

/* Hooks for --smoke (item 5: file attachments). */
if (typeof window !== 'undefined') {
  /** Push a synthetic turn — user, tool cards, reply — and run the real
      collector + the real app:statPaths over it. */
  window.__pushAssistantFiles = async (text, calls) => {
    S.log.push({id:nid(), k:'user', text:'(smoke)'});
    (calls || []).forEach((c) => S.log.push({id:nid(), k:'tool', name:c.tool, args:c.args, arg:summariseArgs(c.args),
      out:c.out || '', ok:c.ok !== false, open:false, where:'local'}));
    const m = {id:nid(), k:'assistant', text:text || ''};
    S.log.push(m);
    render();
    await refreshAttachments((S.live && S.live.workingDir) || null);
    render();
    const el = document.querySelector('[data-attach="' + m.id + '"]');
    const label = el ? el.querySelector('.attach-label') : null;
    return {chips: el ? el.querySelectorAll('.filechip').length : 0,
            lines: el ? el.querySelectorAll('.attach-label').length : 0,
            label: label ? label.textContent : '',
            paths: (m.attach || []).map((f) => f.path)};
  };
  /** What the newest assistant item claims it saved. */
  window.__attach = () => {
    for (let i = S.log.length - 1; i >= 0; i--) if (S.log[i].k === 'assistant') return (S.log[i].attach || []).map((f) => f.path);
    return [];
  };
}
/* Item 6 — sidebar hooks for `electron . --smoke`. */
if (typeof window !== 'undefined') {
  window.__sidebar = () => ({
    headers: [...document.querySelectorAll('.sb-list-head > span:first-child')].map((n) => n.textContent),
    navrows: document.querySelectorAll('.navrow').length,
    skillsRow: !!document.querySelector('#sidebar [data-room="skills"]'),
    subtitles: document.querySelectorAll('#sidebar .sesrow .t2').length,
    onRows: document.querySelectorAll('#sidebar .sesrow.on').length,
    counter: (document.querySelector('[data-list="tasks"] .ct') || {}).textContent || '',
    tasksEmpty: (document.querySelector('[data-list="tasks"] .sb-empty') || {}).textContent || '',
    chats: sidebarChats().rows.map((s) => ({id:s.id, dot:chatDot(s)[0], pinned:PREFS.pinned.includes(s.id), name:s.t, status:s.status, updatedAt:s.updatedAt})),
    hiddenChats: sidebarChats().hidden,
    tasks: sidebarTasks().rows.map((t) => ({id:t.id, dot:taskDot(t)[0], status:t.status, name:t.t, seen:PREFS.seen['task:' + t.id] || 0})),
    hiddenTasks: sidebarTasks().hidden,
    running: sidebarTasks().running,
    loadMore: !!document.querySelector('[data-more="chats"]'),
    page: SIDEBAR_PAGE,
    total: SESSIONS.length,
  });
  window.__pin = (id) => { act('pin:' + id); return PREFS.pinned.slice(); };
  window.__unpin = (id) => { act('unpin:' + id); return PREFS.pinned.slice(); };
  window.__prefs = () => BR.prefsGet();
  window.__reloadPrefs = () => loadPrefs();
  window.__forgetSeen = (id) => { delete PREFS.seen[id]; savePrefs(); render(); return chatDot(SESSIONS.find((s) => s.id === id))[0]; };
  window.__forgetTaskSeen = (id) => { delete PREFS.seen['task:' + id]; savePrefs(); render(); return (sidebarTasks().rows.find((t) => t.id === id) || {}).id || ''; };
  window.__openTask = (id) => { act('task:' + id); return PREFS.seen['task:' + id] || 0; };
  // The RUNNING map is what the pulsing dot reads; these drive it directly so
  // the rule can be asserted without a second live turn.
  window.__running = (turnId, id, on) => {
    if (on) RUNNING.set(turnId, id); else RUNNING.delete(turnId);
    render();
    const el = document.querySelector('[data-ses="' + id + '"] .sdot');
    return el ? el.className : '';
  };
  window.__pendingApproval = (id, on) => {
    if (on) PENDING_APPROVALS.set(id, 'smoke'); else PENDING_APPROVALS.delete(id);
    render();
    return chatDot(SESSIONS.find((s) => s.id === id))[0];
  };
  window.__deleteSession = (id) => { act('del:' + id); return SESSIONS.length; };
  /* Review fix: renderSidebar rebuilds .sb-lists whole, so a scrolled list used
     to snap back to the top on every render — which sent the "Load more" button
     the user had just clicked off screen. */
  window.__sidebarScroll = () => {
    const el = document.querySelector('.sb-lists');
    if (!el) return {scrollable:false, kept:false, reason:'no list container'};
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return {scrollable:false, kept:true, max:0, reason:'the two lists fit without scrolling here'};
    el.scrollTop = Math.min(24, max);
    const before = el.scrollTop;
    render();
    const el2 = document.querySelector('.sb-lists');
    const after = el2 ? el2.scrollTop : null;
    if (el2) el2.scrollTop = 0;
    return {scrollable:true, kept: after === before, before, after, max};
  };
  window.__loadMore = () => { const b = document.querySelector('[data-more="chats"]'); if (b) b.click(); return sidebarChats().rows.length; };
  window.__dotStyle = (id) => {
    const el = document.querySelector('[data-ses="' + id + '"] .sdot');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {cls:el.className, animation:cs.animationName, shadow:cs.boxShadow};
  };
  /* Second review fix: switching away from an open approval must NOT forget
     it. Only the map entry is planted (no approval card is fabricated in the
     transcript); `session:new` is the real path, and the agent is still
     blocked on the gate afterwards, so the waiting chat must keep its filled
     dot even though the card has left this view. */
  window.__approvalKeep = (id) => {
    PENDING_APPROVALS.set(id, 'smoke');
    S.pending = {id:'smoke', k:'approval', approvalId:'smoke', sessionId:id};
    act('session:new');
    return {pending: !!S.pending, mapped: PENDING_APPROVALS.has(id), dot: chatDot(SESSIONS.find((s) => s.id === id))[0]};
  };
  /* ... and the turn's own terminal frame is what does forget it: once the run
     is over nothing is waiting for a verdict any more. The frame is fed
     through the real onChatEvent bookkeeping, not by touching the map. */
  window.__approvalDrop = (id) => {
    PENDING_APPROVALS.set(id, 'smoke');
    RUNNING.set('smoke-appr', id);
    onChatEvent({turnId:'smoke-appr', kind:'aborted', payload:{}});
    return {mapped: PENDING_APPROVALS.has(id), running: RUNNING.has('smoke-appr'),
            dot: chatDot(SESSIONS.find((s) => s.id === id))[0]};
  };
  /* The pin affordance as the user meets it: the button rendered on the row,
     clicked through the document delegator. Asserts the row did not also open
     (the delegator stops there) and that the title flips. */
  window.__clickPin = (id) => {
    const btn = document.querySelector('[data-ses="' + id + '"] [data-pin]');
    if (!btn) return {found:false};
    const before = S.sessionId;
    const titleBefore = btn.getAttribute('title');
    btn.click();
    const after = document.querySelector('[data-ses="' + id + '"] [data-pin]');
    return {found:true, pinned: PREFS.pinned.includes(id), opened: S.sessionId === id && before !== id,
            sessionId: S.sessionId, titleBefore, titleAfter: after ? after.getAttribute('title') : null};
  };
  /* The shape of the transcript on screen. A frame belonging to a turn the
     user navigated away from used to splice its tool card, reasoning block or
     failure line into whatever chat was open — this is what says it does not. */
  window.__transcript = () => S.log.map((m) => m.k);
  // ⌘3 / View › Skills / the palette rows still reach Skills — on this tree they
  // open Settings › Skills, and only the sidebar row is gone.
  window.__skillsReachable = () => { act('room:skills'); const h = document.querySelector('#settings .settab.on'); return h ? h.textContent.replace(/\s*\((\d+|up|down)\)$/, '').trim() : ''; };
}

/* Hooks for --smoke: the review fixes.
   item 2 (folded runs), item 5 (a strip chip is really clickable, and a strip
   whose file was trashed afterwards), item 5/backend (the third backend row and
   the read-only `custom` state an external route reads as). */
if (typeof window !== 'undefined') {
  /** The folded runs on screen, in DOM order. */
  window.__groups = () => Array.from(document.querySelectorAll('[data-group]')).map((g) => ({
    id: g.dataset.group,
    head: (g.querySelector('.nm') || {}).textContent || '',
  }));
  /** Click the strip's first chip through the real delegator and report the
      path it handed to the opener (nothing is actually opened). */
  window.__clickAttachChip = () => {
    const chip = document.querySelector('.attach .filechip');
    if (!chip) return null;
    LAST_OPEN_PATH = null; OPEN_PATH_DRYRUN = true;
    try { chip.click(); } finally { OPEN_PATH_DRYRUN = false; }
    return {file: chip.dataset.file, opened: LAST_OPEN_PATH, hasMenu: !!(BR && BR.fileMenu)};
  };
  /** Re-run the real collector over the current log (after a trash card). */
  window.__reattach = async () => {
    await refreshAttachments((S.live && S.live.workingDir) || null);
    render();
    let paths = [];
    for (let i = S.log.length - 1; i >= 0; i--) if (S.log[i].k === 'assistant') { paths = (S.log[i].attach || []).map((f) => f.path); break; }
    return {paths, chips: document.querySelectorAll('.attach .filechip').length, labels: document.querySelectorAll('.attach .attach-label').length};
  };
  /** The backend pane's rows, without opening the popup. */
  window.__backendRows = () => {
    const was = SEL.kind; SEL.kind = 'backend';
    const rows = selRows(); SEL.kind = was;
    return {backend: selBackend(),
      chip: ((document.querySelector('.modechip') || {}).textContent || '').trim(),
      modelChip: !!document.querySelector('.modelchip'),
      rows: rows.map((r) => ({id:r.id, label:r.label, detail:r.detail, active:!!r.active}))};
  };
  /** The rendered geometry of the sidebar rows: one line, dot + name (+ pin).
      The old check could only catch a reintroduced `.t2` class; this measures
      what the user actually asked for. */
  window.__rowShape = () => {
    const rows = Array.from(document.querySelectorAll('#sidebar .sesrow'));
    if (!rows.length) return null;
    const h = rows.map((n) => Math.round(n.getBoundingClientRect().height));
    const t1 = rows[0].querySelector('.t1');
    const st = t1 ? getComputedStyle(t1) : null;
    return {
      rows: rows.length, minHeight: Math.min.apply(null, h), maxHeight: Math.max.apply(null, h),
      children: Array.from(rows[0].children).map((c) => (c.className || '').split(' ')[0]),
      titleHeight: t1 ? Math.round(t1.getBoundingClientRect().height) : 0,
      titleLineHeight: st ? Math.round(parseFloat(st.lineHeight)) : 0,
      nowrap: !!st && st.whiteSpace === 'nowrap' && st.textOverflow === 'ellipsis',
    };
  };
  /** Activate one backend row exactly as a click on it would. */
  window.__backendActivate = (id) => {
    const was = SEL.kind; SEL.kind = 'backend';
    const row = selRows().find((r) => r.id === id); SEL.kind = was;
    return Promise.resolve(row ? selActivate(row) : null).then(() => ({
      settings: !!S.settings, pane: settingsPaneId(S.settingsPane), llmMode: LLMP.mode, selOpen: SEL.open,
    }));
  };
}

/* ============================================================
   Smoke hooks — coding mode (item 6)
   ============================================================ */
if (typeof window !== 'undefined') {
  /* The chip's own markup, so the smoke can assert what the operator
     actually sees rather than the state behind it — the unsupported chip
     must print 'mode —' and must not print a mode name. */
  window.__chipHTML = () => codingModeChip();
  /* Force the renderer into a mode state it cannot reach against a
     capable agent, so the unsupported presentation is testable. Patch
     back to restore; nothing here talks to the agent. */
  window.__modeOverride = (patch) => { Object.assign(MODE, patch || {}); render(); };
  /* The reconnect's re-assert path, and the overlay it must not touch.
     Opening the popover through S.overlay directly rather than through
     act() keeps this hook out of the shared dispatcher. */
  window.__modeReassert = (id) => reassertCodingMode(id);
  window.__modeOpenPopover = () => { S.overlay = 'modes'; render(); return S.overlay; };
  window.__overlayNow = () => S.overlay;
  window.__overlayClose = () => { S.overlay = null; render(); return S.overlay; };
}

/* ============================================================
   Smoke hooks — coding mode, queued re-assert (item 6 review fix)
   ============================================================ */
if (typeof window !== 'undefined') {
  /* The queued half of reassertCodingMode only runs while a turn is in
     flight, which never happens at the point the smoke reaches it — so
     the wait, the coalescing and the cancel-on-click were covered by
     nothing. This drives S.busy directly rather than starting a real
     turn: the branch under test reads exactly that flag. */
  window.__modeBusy = (on) => { S.busy = !!on; render(); return S.busy; };
  /* What is queued behind the running turn, if anything. */
  window.__modeQueue = () => (MODE_REASSERT ? { mode: MODE_REASSERT.mode } : null);
  /* The click path itself, so the cancel-a-queued-re-assert branch can be
     exercised the way an operator reaches it. */
  window.__modeSet = (id) => setCodingMode(id);
}

/* ============================================================
   Smoke hooks — coding mode, the reconnect GET's seq ticket
   ============================================================ */
if (typeof window !== 'undefined') {
  /* loadResources' connect-time GET, on its own. The race it guards
     against needs the GET issued and a click landing before its reply, so
     the smoke has to be able to fire the GET without reconnecting the
     whole window. Returns the promise so the test can await both legs. */
  window.__modeLoad = () => loadCodingMode();
  /* What the window last chose, which is what the reconnect re-asserts.
     The bug this guards is precisely a re-assert of a stale LAST_MODE
     overwriting a fresher click. */
  window.__modeLast = () => LAST_MODE;
}

/* ============================================================
   r4-ui — hooks for `electron . --smoke` (items 1, 3, 4, 5)
   ============================================================ */
if (typeof window !== 'undefined') {
  /* Item 1: the dot rides the LABEL, not the line box. The cap and x midpoints
     are computed from the live font rather than hard-coded, so a different font
     stack moves the target instead of turning a pixel into a lie. */
  function dotSeatOf(row) {
    const d = row && row.querySelector('.sdot'), t = row && row.querySelector('.t1');
    if (!d || !t) return null;
    const cs = getComputedStyle(t);
    const c = document.createElement('canvas').getContext('2d');
    c.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    const mAll = c.measureText(t.textContent || 'x'), mx = c.measureText('x'), mH = c.measureText('H');
    const tr = t.getBoundingClientRect(), lh = parseFloat(cs.lineHeight);
    const base = tr.top + (tr.height - lh) / 2
      + (lh - (mAll.fontBoundingBoxAscent + mAll.fontBoundingBoxDescent)) / 2 + mAll.fontBoundingBoxAscent;
    const dr = d.getBoundingClientRect();
    return {dotMid: dr.top + dr.height / 2, capMid: base - mH.actualBoundingBoxAscent / 2,
            xMid: base - mx.actualBoundingBoxAscent / 2};
  }
  /* Item 1: all three states measured together, on real rows inside the real
     list, whatever the agent's own sessions happen to look like. The `empty`
     row is the one that mattered: its state class used to collide with the
     empty-transcript container rule and blow the dot up to ~66px. */
  window.__dotProbe = () => {
    const host = document.querySelector('[data-list="chats"]');
    if (!host) return null;
    const probe = document.createElement('div');
    probe.innerHTML = ['empty', 'filled', 'running'].map((st) =>
      '<button class="sesrow"><span class="sdot ' + st + '"></span><span class="t1">probe</span></button>').join('');
    host.appendChild(probe);
    const dots = [...probe.querySelectorAll('.sdot')].map((el) => {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return {cls: el.className, w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100,
              border: parseFloat(cs.borderTopWidth), bg: cs.backgroundColor,
              animation: cs.animationName, shadow: cs.boxShadow};
    });
    const seat = dotSeatOf(probe.querySelector('.sesrow'));
    probe.remove();
    return {dots, seat};
  };
  /* Item 1: the empty-transcript screen still centres itself under its new
     class, and no `.empty` is left anywhere. Rendered into a detached probe so
     the check does not have to destroy the transcript to see it. */
  window.__emptyChatProbe = () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-9999px;top:0;width:600px;height:400px';
    host.innerHTML = emptyChat();
    document.body.appendChild(host);
    const el = host.querySelector('.emptychat');
    // `.empty` is also the sidebar dot's STATE class (`sdot empty`) — that is the
    // collision itself, and those are meant to be there. What must be gone is any
    // element still using it as the transcript container class.
    const out = {found: !!el, display: el ? getComputedStyle(el).display : '',
                 strays: document.querySelectorAll('.empty:not(.sdot)').length};
    host.remove();
    return out;
  };

  /* Item 3: what every transcript row is made of — its kind, whether a message
     glyph came back, whether the grid rows' first cell is empty, whether the row
     carries the end mark, and where its content starts. */
  window.__turnShape = () => [...document.querySelectorAll('#scroller .turn')].map((t) => {
    const body = t.querySelector('.prose,.card,.appr,.disc');
    const usr = t.classList.contains('usr');
    return {k: usr ? 'user'
              : t.querySelector('.card') ? 'tool'
              : t.querySelector('.appr') ? 'approval'
              : t.querySelector('.disc') ? 'reason'
              : t.querySelector('.prose') ? 'assistant' : 'other',
            // The two per-message glyphs the user asked to be rid of: `.avatar`
            // was the user's `›`, `.gutter` the assistant's mark. COUNTED, on
            // every row, so either one coming back fails this — a user row's
            // firstElementChild is the bubble now, so its emptiness says nothing.
            glyphs: t.querySelectorAll('.avatar,.gutter').length,
            // The 28px first cell of a grid row, which has to stay empty. A user
            // row left the grid and has no such cell: null, not an invented 0.
            gutter: usr ? null : (t.firstElementChild ? t.firstElementChild.innerHTML.trim().length : 0),
            end: !!t.querySelector('.endmark'),
            strip: !!t.querySelector('.attach'),
            // The mark is appended AFTER attachStrip(m), so on a reply that
            // wrote files it must still be the last thing in the column.
            endLast: !!(t.lastElementChild && t.lastElementChild.lastElementChild
                        && t.lastElementChild.lastElementChild.classList.contains('endmark')),
            left: body ? Math.round(body.getBoundingClientRect().left) : 0};
  });
  /* Item 3: the bubble's geometry against the column's CONTENT box. */
  window.__bubbleBox = () => {
    const rows = [...document.querySelectorAll('#scroller .turn.usr')];
    const b = rows.length ? rows[rows.length - 1].querySelector('.prose.usr.bubble') : null;
    const col = document.querySelector('.col720');
    if (!b || !col) return null;
    const ccs = getComputedStyle(col), br = b.getBoundingClientRect(), cr = col.getBoundingClientRect();
    const mark = document.querySelector('.endmark svg');
    return {right: Math.round(br.right), width: Math.round(br.width),
            colRight: Math.round(cr.right - parseFloat(ccs.paddingRight)),
            colWidth: Math.round(cr.width - parseFloat(ccs.paddingLeft) - parseFloat(ccs.paddingRight)),
            marginLeft: getComputedStyle(b).marginLeft, rowDisplay: getComputedStyle(b.parentElement).display,
            markW: mark ? Math.round(mark.getBoundingClientRect().width) : 0};
  };
  /* Item 3: put the window back at rest before the transcript checks. The end
     mark is deliberately withheld while a turn is streaming or an approval is
     open, and the checks that run before these leave a turn going in another
     chat — so without this the mark's absence proves nothing either way. This
     stops the leftover turn through the real abort path; it invents no state.
     A pending approval left without a running turn goes through the same call
     abort() makes (dropPendingApproval), so the sidebar's filled dot is dropped
     with it instead of being stranded by a raw assignment. */
  window.__quiesce = () => {
    if (S.busy) abort();
    if (S.pending) dropPendingApproval();
    S.toasts = [];
    render();
    return {busy: S.busy, pending: !!S.pending, items: S.log.length};
  };
  /* Item 3: a user message, pushed exactly as the composer's submit() pushes
     one — the counterpart of the existing __pushAssistant. */
  window.__pushUser = (text) => { S.log.push({id:nid(), k:'user', text: String(text)}); render(); return S.log.length; };
  /* Item 3: the end mark never lands on a turn that is still running, and the
     turns above it keep theirs. S.busy is SET AND PUT BACK here — this is a
     synthetic busy, not a live stream: reading the transcript mid-delta is a
     race the suite would lose on a slow reply. What it does prove is the guard
     itself (drop `S.busy || S.pending` from endMarkIds and `during.last` flips).
     The empty streaming item that path really pushes is covered at rest by
     __emptyTurnMark below, which needs no poked flag at all. */
  window.__marksWhileBusy = () => {
    const count = () => {
      const rows = [...document.querySelectorAll('#scroller .turn')];
      return {total: document.querySelectorAll('#scroller .endmark').length,
              last: !!(rows.length && rows[rows.length - 1].querySelector('.endmark'))};
    };
    const before = S.busy;
    S.busy = true; render();
    const during = count();
    S.busy = before; render();
    /* Review fix: the guard is `S.busy || S.pending` and only the first half
       was exercised. The approval-blocked half is poked the same way, with the
       same request shape __voicePending uses, and put back exactly. */
    const pendBefore = S.pending;
    S.pending = pendBefore || {id:'endmark-smoke', k:'approval', approvalId:'endmark-smoke'};
    render();
    const duringPending = count();
    S.pending = pendBefore; render();
    return {during, duringPending, after: count()};
  };
  /* Item 3: the other half of "never on a live turn", and the one that needs no
     poked flag at all. startLiveTurn pushes an EMPTY assistant item before the
     first delta arrives; a turn aborted, or one whose BR.chat call fails, leaves
     that item in S.log at rest. It must not collect a full stop under an empty
     prose block — that is what endMarkIds' non-empty-text test is for. The two
     rows are pushed exactly as that path pushes them and then taken back out. */
  window.__emptyTurnMark = () => {
    const before = document.querySelectorAll('#scroller .endmark').length;
    S.log.push({id:nid(), k:'user', text:'(smoke) a turn that produced nothing'});
    S.log.push({id:nid(), k:'assistant', text:''});   // startLiveTurn's `streaming`
    render();
    const rows = [...document.querySelectorAll('#scroller .turn')];
    const out = {before, after: document.querySelectorAll('#scroller .endmark').length,
                 lastHasMark: !!(rows.length && rows[rows.length - 1].querySelector('.endmark'))};
    S.log.splice(S.log.length - 2, 2);
    render();
    return out;
  };

  /* Item 4: the head row carries no control, each list header carries one plus,
     the Tasks counter sits to the LEFT of its plus, and the two pluses share a
     right edge. */
  window.__sbHeads = () => ({
    headPlus: !!document.querySelector('#sidebar .sb-head [data-act]:not(.wschip)'),
    heads: ['tasks', 'chats'].map((l) => {
      const h = document.querySelector('[data-list="' + l + '"] .sb-list-head');
      if (!h) return {list: l, act: null};
      const b = h.querySelector('button[data-act]'), c = h.querySelector('.ct');
      return {list: l, act: b ? b.dataset.act : null,
              // Review fix: "one plus per header" is the literal ask, so the
              // count is reported rather than left to the first match.
              buttons: h.querySelectorAll('button[data-act]').length,
              right: b ? Math.round(b.getBoundingClientRect().right) : 0,
              visible: !!(b && b.offsetParent),
              centre: b ? Math.round(b.getBoundingClientRect().left + b.getBoundingClientRect().width / 2) : 0,
              counter: c ? c.textContent : null,
              counterVisible: !!(c && c.offsetParent),
              labelVisible: !!(h.querySelector('span:first-child') && h.querySelector('span:first-child').offsetParent),
              counterLeftOfPlus: !!(c && b) && c.getBoundingClientRect().right <= b.getBoundingClientRect().left};
    }),
    railWidth: Math.round(document.querySelector('#sidebar').getBoundingClientRect().width),
    rail: document.querySelector('#sidebar').classList.contains('rail'),
  });
  window.__clickHead = (list) => {
    const b = document.querySelector('[data-list="' + list + '"] .sb-list-head button[data-act]');
    if (!b) return null;
    b.click();
    return {pane: S.settings ? settingsPaneId(S.settingsPane) : null, mode: TK.mode,
            logLen: S.log.length, session: S.agentSession, onRows: document.querySelectorAll('#sidebar .sesrow.on').length};
  };

  /* Item 5: one Escape through the real document listener, and what the window
     looked like afterwards. */
  window.__esc = () => {
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));
    const a = document.activeElement;
    return {pane: S.settings ? settingsPaneId(S.settingsPane) : null,
            focusRow: !!(a && a.classList && a.classList.contains('menurow')),
            focusAct: a && a.dataset ? (a.dataset.act || '') : '',
            overlay: S.overlay, sel: SEL.open, busy: S.busy, toasts: S.toasts.length,
            draft: S.draft, firstRowLabel: (document.querySelector('#settings .setmenu button.menurow .lb') || {}).textContent || ''};
  };
  window.__clearToasts = () => { S.toasts = []; renderToasts(); return S.toasts.length; };
  window.__openPalette = () => { act('palette'); return S.overlay; };
  window.__rail = () => { act('toggle:sidebar'); return window.__sbHeads(); };
  window.__menuSubRows = () => document.querySelectorAll('#settings .menurow.sub, #settings .menurow.parent').length;
  /* Item 5: the focus ring is re-applied on every render while MENUFOCUS.want
     is up, so the flag has to drop the moment focus leaves the first menu row.
     Clicking dead space is a blur to <body> and nothing else — no click handler
     runs, because #settings carries no data-close — so that is what is done
     here, followed by the full render that used to steal the focus back. */
  window.__menuFocusBlur = () => {
    const first = document.querySelector('#settings .setmenu button.menurow');
    if (!first) return null;
    const focusedBefore = document.activeElement === first;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const blurred = !document.activeElement || document.activeElement === document.body;
    render();
    const a = document.activeElement;
    return {focusedBefore, blurred,
            stolen: !!(a && a.classList && a.classList.contains('menurow')),
            active: a ? (a.tagName + (a.className ? '.' + String(a.className).split(' ').join('.') : '')) : 'none'};
  };
  /* Item 5: the palette catalogue, so the harness can prove the destinations
     that left the menu still have a row. S.q / S.scope decide whether palRows()
     filters or scopes; both are put back untouched and nothing is repainted. */
  window.__palRows = () => {
    const q = S.q, scope = S.scope;
    S.q = ''; S.scope = null;
    const out = flatPalRows().map((r) => [r.t, r.act]);
    S.q = q; S.scope = scope;
    return out;
  };
  /* Item 5: run one act through the real dispatcher and report where the window
     ended up — the check that Run, World and the LLM log kept a route after
     their menu nodes were deleted. */
  window.__route = (a) => {
    act(a);
    return {room: S.room, inspector: S.inspector, inspTab: S.inspTab,
            consoleOpen: S.consoleOpen, consoleTab: S.consoleTab,
            settings: !!S.settings, overlay: S.overlay};
  };
  /* Item 5: the routes above really open the inspector and the console, and the
     backend-switch lane runs after this one — so the panes are snapshotted and
     put back exactly, through the same acts, rather than being toggled off on
     the assumption that they started closed (the inspector starts OPEN). */
  window.__panes = () => ({room: S.room, inspector: S.inspector, inspTab: S.inspTab,
                           consoleOpen: S.consoleOpen, consoleTab: S.consoleTab});
  window.__restorePanes = (was) => {
    act('room:' + was.room);
    // `insp:<tab>` and `console:<tab>` are the only acts that set a tab, and
    // both open their pane on the way — so a pane that was CLOSED on a given
    // tab is put back by selecting the tab and then toggling the pane shut.
    // Nothing is assigned by hand: the tab a closed pane would reopen on is
    // state too, and the probe must not leave it moved.
    act('insp:' + was.inspTab);
    if (!was.inspector) act('toggle:inspector');
    act('console:' + was.consoleTab);
    if (!was.consoleOpen) act('toggle:console');
    return window.__panes();
  };
}

/* ============================================================
   Item 2: voice input — boot wiring and test hooks
   Every check below drives synthetic helper events, so the whole suite
   runs without a microphone and without the speech helper ever being
   spawned by the renderer.
   ============================================================ */
if (typeof window !== 'undefined') {
  // The mic button's press semantics live here, not in the click
  // dispatcher: mousedown starts, mouseup after VOICE_HOLD_MS stops.
  document.addEventListener('mousedown', voiceMouseDown, true);
  document.addEventListener('mouseup', voiceMouseUp, true);
  // The idle way into the language menu — the strip's own chip is only on
  // screen while a take is running, and the button's tooltip says this.
  document.addEventListener('contextmenu', (e) => {
    const b = e.target.closest && e.target.closest('[data-mic]');
    if (!b || b.disabled) return;
    e.preventDefault();
    voiceAct('voice:lang');
  });
  // A window that loses focus while the microphone is OPEN is a recording
  // the user has walked away from. `starting` is deliberately not in this
  // list: on the first run of a freshly-signed build macOS raises its own
  // microphone dialog while the getUserMedia is still pending, that dialog
  // takes key status, and cancelling here would throw away the very session
  // the user is being asked to allow — the mic button would appear to do
  // nothing until the second click. Synthetic sessions are exempt too: the
  // harness runs with the window behind other windows.
  window.addEventListener('blur', () => {
    if (!VOICE.synthetic && VOICE.state === 'recording') {
      voiceCancel('The window lost focus, so that recording was thrown away');
    }
  });
  // Leaving the chat, opening another session or starting a new one all
  // abandon the take rather than carrying it into a different draft.
  const actBeforeVoice = act;
  act = function (a) {
    if (typeof a === 'string'
        && (a === 'session:new' || a === 'clear' || a.indexOf('ses:') === 0 || a.indexOf('room:') === 0)
        && (VOICE.state === 'recording' || VOICE.state === 'starting')) voiceCancel();
    return actBeforeVoice(a);
  };

  if (BR && BR.onVoice) BR.onVoice(voiceEvent);
  voiceProbe();

  /** What the button may claim, and what it is claiming. */
  window.__voice = () => ({
    available: VOICE.available, reason: VOICE.reason, code: VOICE.code, detail: VOICE.detail,
    state: VOICE.state, locales: VOICE.locales.slice(), winner: VOICE.winner,
    final: VOICE.final, partial: VOICE.partial, menu: VOICE.menu,
    supported: VOICE.supported.length, installed: VOICE.installed.length,
    // Forward-compatible: this route is on-device, so it is always false.
    // A route that set it true would owe the strip a disclosure naming the
    // vendor, and there is no such route here to assert against.
    offMachine: VOICE.offMachine,
  });
  /** The rendered strip, exactly as the user sees it. */
  window.__voiceStrip = () => {
    const n = document.querySelector('.voicestrip');
    if (!n) return null;
    const note = n.querySelector('.vsnote');
    const chip = n.querySelector('.vschip');
    return {
      present: true, hidden: n.hasAttribute('hidden'), empty: n.innerHTML === '',
      text: (n.querySelector('.vstext') || {}).textContent || '',
      partial: (n.querySelector('.vspart') || {}).textContent || '',
      note: note ? note.textContent : '',
      chip: chip ? chip.textContent.trim() : '',
      menuRows: n.querySelectorAll('.vsmrow').length,
      menuFoot: (n.querySelector('.vsmfoot') || {}).textContent || '',
    };
  };
  /** The button and its neighbours inside `.field`. */
  window.__voiceMic = () => {
    const b = document.querySelector('.composer .field .micbtn');
    const field = document.querySelector('.composer .field');
    return {
      present: !!b, disabled: !!(b && b.disabled), title: b ? b.getAttribute('title') : '',
      order: field ? Array.prototype.map.call(field.children, (n) => n.className || n.tagName).join('|') : '',
    };
  };
  /** Put the strip into a live recording without touching the microphone. */
  window.__voiceArm = () => {
    VOICE.seq++;
    VOICE.synthetic = true; VOICE.state = 'recording';
    VOICE.final = ''; VOICE.partial = ''; VOICE.winner = null; VOICE.err = null; VOICE.level = 0;
    refreshVoice();
    return window.__voice();
  };
  /** Feed one helper event through the real handler. */
  window.__voiceEvent = (o) => { voiceEvent(o); return window.__voice(); };
  /** Stop and insert, through the real insertion path. */
  window.__voiceStop = () => Promise.resolve(voiceStop()).then(() => ({
    voice: window.__voice(), draft: S.draft, entry: (($('#entry') || {}).value) || '',
    users: S.log.filter((m) => m.k === 'user').length,
  }));
  window.__voiceCancel = () => { voiceCancel(); return window.__voice(); };
  window.__voiceAct = (a) => { voiceAct(a); return window.__voice(); };
  /** Substitute a probe answer, so every disabled reason can be rendered
      without breaking the machine it runs on. */
  window.__voiceProbeSet = (p) => {
    const d = p || {};
    if ('supported' in d) VOICE.supported = d.supported || [];
    if ('installed' in d) VOICE.installed = d.installed || [];
    if ('speech' in d) VOICE.speechLocales = d.speech || [];
    if ('dictation' in d) VOICE.dictationLocales = d.dictation || [];
    if ('offMachine' in d) VOICE.offMachine = !!d.offMachine;
    if ('locales' in d) VOICE.locales = d.locales.slice();
    if ('available' in d) {
      VOICE.available = d.available;
      VOICE.code = d.available ? '' : (d.reason || 'voice-helper-failed');
      VOICE.reason = d.available ? '' : (VOICE_REASONS[VOICE.code] || VOICE_REASONS['voice-helper-failed']);
    }
    refreshVoice();
    return window.__voice();
  };
  /** Plant (or clear, or read) a pending approval, so the harness can prove
      Escape reaches the voice branch from the state whose own Escape handler
      returns first. No approval card is fabricated in the transcript. */
  window.__voicePending = (on) => {
    if (on === undefined) return !!S.pending;
    S.pending = on ? {id:'voice-smoke', k:'approval', approvalId:'voice-smoke'} : null;
    render();
    return !!S.pending;
  };
  /** Re-ask main, after a probe override or a language install. */
  window.__voiceReprobe = () => voiceProbe().then(() => window.__voice());
  /** The literal sentences, so the harness asserts the shipped copy. */
  window.__voiceReasons = () => Object.assign({}, VOICE_REASONS, {ondevice: VOICE_ONDEVICE});
}

/* Item 2 (voice input) — review-fix hooks. Appended as their own block so
   the merge with the other lanes stays a pure append. */
if (typeof window !== 'undefined') {
  /* Put the strip into the error state without a microphone, a helper or a
     toast — voiceFail() would raise a toast that the general Escape branch
     then pops, which would confuse the very check this exists for. */
  window.__voiceSetError = (msg) => {
    VOICE.state = 'error'; VOICE.err = String(msg); VOICE.final = ''; VOICE.partial = '';
    VOICE.menu = false; VOICE.synthetic = true;
    refreshVoice();
    return window.__voice();
  };
  /* Element identity across a repaint. The recording pulse is a CSS
     animation, and a replaced element starts it again from frame one — so
     the dot and the button surviving a hundred repaints IS the animation. */
  window.__voiceMark = () => {
    const dot = document.querySelector('.voicestrip .vsdot');
    const mic = document.querySelector('.composer .field .micbtn');
    if (dot) dot.dataset.smokeMark = '1';
    if (mic) mic.dataset.smokeMark = '1';
    return { dot: !!dot, mic: !!mic };
  };
  window.__voiceMarked = () => {
    const dot = document.querySelector('.voicestrip .vsdot');
    const mic = document.querySelector('.composer .field .micbtn');
    return {
      dot: !!(dot && dot.dataset.smokeMark), mic: !!(mic && mic.dataset.smokeMark),
      dotPresent: !!dot, micPresent: !!mic,
    };
  };
  /* Click the error strip's dismiss the way the user does. */
  window.__voiceDismiss = () => {
    const b = document.querySelector('.voicestrip .vsx');
    if (b) b.click();
    return { clicked: !!b, voice: window.__voice() };
  };
}

/* Item 2 (voice input) — hooks for the second round of review fixes. Its own
   block, appended, so the merge with the other lanes stays a pure append. */
if (typeof window !== 'undefined') {
  /* Open or close the language menu without a mouse. */
  window.__voiceMenu = (open) => {
    VOICE.menu = !!open; VOICE.installErr = null;
    refreshVoice();
    return { menu: VOICE.menu, rows: document.querySelectorAll('.voicestrip .vsmrow').length };
  };
  /* Click a row of that menu the way the user does — a real click, through
     the real dispatcher, on the button the menu actually rendered. */
  window.__voiceMenuClick = (action) => {
    const b = document.querySelector('.voicestrip [data-act="' + action + '"]');
    if (b) b.click();
    return { clicked: !!b, locales: VOICE.locales.slice(), installing: VOICE.installing };
  };
  /* Watch where an uninstalled language routes without actually downloading
     an Apple model onto this Mac. Returns the ids the download call site was
     asked for; passing false puts the real bridge call back. */
  window.__voiceInstallSpy = (on) => {
    if (on === false) {
      voiceInstallBridge = window.__voiceInstallReal || voiceInstallBridge;
      const seen = window.__voiceInstallSeen || [];
      window.__voiceInstallSeen = null;
      return seen;
    }
    if (!window.__voiceInstallReal) window.__voiceInstallReal = voiceInstallBridge;
    window.__voiceInstallSeen = [];
    voiceInstallBridge = (id) => {
      window.__voiceInstallSeen.push(id);
      // Never resolves ok: the point is that the language is NOT selected
      // until a model has landed, and the spy must not pretend one did.
      return Promise.resolve({ok:false, error:'not-downloaded-in-the-harness'});
    };
    return [];
  };
}

/* Item 7A (Hugging Face) and item 7C (steer / context gauge / model
   stamp): smoke hooks. Plain JSON out; nothing here does anything the
   keyboard cannot. */
if (typeof window !== 'undefined') {
  window.__llmHf = () => ({open:LLMHF.open, step:LLMHF.step, reference:LLMHF.reference, busy:LLMHF.busy, error:LLMHF.error,
    repoId: LLMHF.repo ? LLMHF.repo.repoId : null, revision: LLMHF.repo ? LLMHF.repo.revision : null,
    choices: LLMHF.repo ? LLMHF.repo.choices.length : 0,
    first: LLMHF.repo && LLMHF.repo.choices[0] ? LLMHF.repo.choices[0].filename : null,
    filenames: LLMHF.repo ? LLMHF.repo.choices.map((c) => c.filename) : [],
    mmproj: LLMHF.repo && LLMHF.repo.mmproj ? LLMHF.repo.mmproj.path : null,
    hidden: LLMHF.repo ? LLMHF.repo.hidden : null, cursor:LLMHF.cursor, ram:LLMHF.ram,
    pendingMmproj: LLMHF.pendingMmproj ? LLMHF.pendingMmproj.id : null,
    rows: document.querySelectorAll('#settings [data-llm-row^="hf:"]').length,
    pulling: LLMP.pulling ? Object.assign({}, LLMP.pulling) : null,
    daemonPhase: LLMP.daemonPhase, confirm: LLMP.confirm ? LLMP.confirm.kind : null});
  window.__llmHfOpen = async () => { llmAct('hf'); if (BR && BR.hostRam) LLMHF.ram = Number(await BR.hostRam()) || LLMHF.ram; llmRepaint(); return window.__llmHf(); };
  window.__llmHfResolve = async (ref) => { await llmHfResolve(String(ref)); return window.__llmHf(); };
  window.__llmHfCursor = (n) => { LLMHF.cursor = Number(n) || 0; llmRepaint(); return window.__llmHf(); };
  window.__llmHfDef = (i) => (BR && BR.hfDef ? BR.hfDef(LLMHF.repo, Number(i) || 0) : Promise.resolve({ok:false, error:'no bridge'}));
  window.__llmHfAdd = async (i) => { LLMHF.cursor = Number(i) || 0; await llmHfAdd(); return window.__llmHf(); };
  // The real add, with the download it hands off to stopped immediately:
  // the suite must be able to assert the config write without fetching
  // gigabytes. `started` is the pull slot the add claimed, which is the
  // proof that the handoff to the existing `models pull` plumbing happened.
  window.__llmHfAddNoDownload = async (i) => {
    LLMHF.cursor = Number(i) || 0;
    await llmHfAdd();
    const started = LLMP.pulling ? Object.assign({}, LLMP.pulling) : null;
    llmAct('cancelPull');
    return Object.assign(window.__llmHf(), {started});
  };
  window.__llmHfClose = () => { llmHfClose(); return window.__llmHf(); };
  window.__llmHfKey = (key) => {
    // The real key path, so "the branch swallows every key it does not
    // name" is asserted against the handler and not against a copy of it.
    const e = {key, target:document.body, preventDefault(){}, metaKey:false, ctrlKey:false, altKey:false, shiftKey:false};
    const handled = llmKey(e, key, false);
    return Object.assign(window.__llmHf(), {handled: handled === true});
  };
  window.__llmHfFakeRepo = (repo) => { LLMHF.open = true; LLMHF.step = 'pick'; LLMHF.repo = repo; LLMHF.cursor = 0; LLMHF.error = null; llmRepaint(); return window.__llmHf(); };
  /* The post-pull decision on its own. The projector call is the REAL
     one, driven into its own filename guard so it refuses before any
     network or filesystem access — the same {ok:false} the error and the
     cancel arms produce. Neither may go on to activate the model:
     `models start` appends --mmproj only when the file is on disk, so
     activating here would serve a vision model text-only. */
  window.__llmAfterPullProbe = async (filename) => {
    const msgBefore = LLMP.msg;
    LLMHF.pendingMmproj = {id:'custom-smoke-probe', url:'https://huggingface.co/x/y/resolve/main/mmproj.gguf',
      filename:String(filename), name:'smoke probe'};
    try {
      const verdict = await llmAfterPull({kind:'chat', id:'custom-smoke-probe'});
      return Object.assign({}, verdict, {msg: LLMP.msg ? LLMP.msg.text : null,
        body:(document.querySelector('#settings .setbody') || {}).innerText || '', pulling: LLMP.pulling});
    } finally {
      LLMHF.pendingMmproj = null; LLMP.msg = msgBefore; llmRepaint();
    }
  };

  /* The first-run row into the same branch. It must enter the LLM tab the
     way the menu does — through act('settings:llm') → llmTabEntered — or
     escaping out of the branch lands on a Local pane with no rows and no
     poll. Everything llmTabEntered owns is cleared first, so a pass means
     the row started it and not some earlier visit. */
  window.__obHfProbe = async () => {
    S.settings = null;
    if (LLMP.timer) { clearInterval(LLMP.timer); LLMP.timer = null; }
    LLMP.lastRefreshedAt = null; LLMP.local = null;
    /* r5 item 7: the first-run row no longer jumps into Settings — the
       Hugging Face branch is two real steps inside the wizard now (the
       TUI's `local_hf_ref` / `local_hf_pick`). What this check is for is
       still live and still worth holding: the Settings route into the
       SAME branch must enter the LLM tab properly, or escaping out of it
       lands on a Local pane with no rows and no poll. So the probe drives
       that route directly, the way the menu does. */
    act('settings:llm');
    llmAct('hf');
    const entered = {pane: settingsPaneId(S.settingsPane), settings: !!S.settings,
      branch: LLMHF.open, mode: LLMP.mode, polling: LLMP.timer !== null};
    llmHfClose();
    for (let i = 0; i < 40 && LLMP.lastRefreshedAt === null; i++) await new Promise((r) => setTimeout(r, 250));
    return Object.assign(entered, {refreshed: LLMP.lastRefreshedAt !== null,
      rows: Array.isArray(LLMP.local) ? LLMP.local.length : -1,
      body: (document.querySelector('#settings .setbody') || {}).innerText || ''});
  };
  window.__obHfRowLabel = () => HF_ROW_LABEL;
  // The Cloud wizard's Ollama preset, read off the array the wizard
  // renders from — so renaming or deleting it fails this check, which the
  // Local pane's own signpost copy cannot.
  window.__preset = (id) => {
    const p = PRESETS.find((x) => x.id === String(id));
    return p ? {id:p.id, label:p.label, baseUrl:p.baseUrl, kind:p.kind, local: p.local === true} : null;
  };

  window.__steer = (text) => (BR && BR.steer && S.agentSession ? BR.steer(S.agentSession, String(text)) : Promise.resolve({ok:false, error:'no session'}));
  window.__steerOrQueue = (text) => steerOrQueue(String(text)).then(() => ({queued:S.queued.slice(), ahead:STEER.ahead, draft:S.draft}));
  window.__queued = () => S.queued.slice();
  window.__steerAhead = () => STEER.ahead;
  window.__seedQueue = (n) => { S.queued.length = 0; for (let i = 0; i < n; i++) S.queued.push('seed ' + i); STEER.ahead = 0; render(); return S.queued.length; };
  window.__clearQueue = () => { S.queued.length = 0; STEER.ahead = 0; render(); return S.queued.length; };
  window.__turnId = () => S.turnId;
  window.__chatEvent = (ev) => { onChatEvent(ev); return {busy:S.busy, turnId:S.turnId, lines:window.__systemLines()}; };
  window.__steerEntries = () => S.log.filter((m) => m.k === 'user' && m.steered).map((m) => m.text);
  // The GET leg on its own: what the route answers, and what the renderer
  // does with it (front of the queue, one system line, then the DELETE).
  window.__undelivered = (id) => (BR && BR.undeliveredSteers
    ? BR.undeliveredSteers(String(id || S.agentSession || '')) : Promise.resolve({ok:false, error:'no bridge'}));
  window.__recoverSteers = async (id) => {
    STEER.recovery = null;
    await recoverParkedSteers(String(id || S.agentSession || ''));
    return {queued:S.queued.slice(), ahead:STEER.ahead, lines:window.__systemLines().slice(-1),
      recovery: STEER.recovery ? Object.assign({}, STEER.recovery) : null};
  };
  window.__steerRecovery = () => (STEER.recovery ? Object.assign({}, STEER.recovery) : null);
  window.__sendButton = () => { const b = document.querySelector('.sendbtn'); return b ? {act:b.dataset.act || '', title:b.title || ''} : null; };

  window.__ctxSections = () => (CTX.sections || []).map((x) => x.label);
  window.__ctxStored = () => (CTX055.stored ? Object.assign({}, CTX055.stored, {sections:(CTX055.stored.sections || []).map((x) => x.label)}) : null);
  window.__ctxBound = () => ((document.querySelector('.popover .ctxbound') || {}).textContent || '');
  /* A refresh that has been overtaken must write NOTHING — including the
     0.5.5 session snapshot, which used to be assigned before the seq
     guard. Start a refresh, overtake it, and the sentinel below has to
     survive: otherwise session A's trimming verdict lands under session
     B's numbers. */
  window.__ctxStaleProbe = async () => {
    const before = CTX055.stored;
    const sentinel = {tokens:1, sections:[{label:'sentinel', tokens:1}], conversationBoundBy:null};
    const p = refreshContext();
    CTX055.stored = sentinel;
    CTX.seq++;                       // the in-flight refresh is now stale
    await p;
    const survived = CTX055.stored === sentinel;
    CTX055.stored = before;
    return {survived};
  };
  /* Every arm of the binding line against a synthetic session row. On a
     real agent `conversationBoundBy` is usually null, so the three
     sentences would otherwise never render and the live assertion would
     collapse to "" === "". Nothing is written: the snapshot is restored. */
  window.__ctxBoundProbe = (u) => {
    const before = CTX055.stored;
    CTX055.stored = u;
    let html = '';
    try { html = ctxBoundLine(); } finally { CTX055.stored = before; }
    const el = document.createElement('div'); el.innerHTML = html;
    return {html, text: el.textContent || ''};
  };
  window.__ctxRoute = () => CTX055.route;
  window.__ctxWindowLabel = () => CTX.windowLabel;
  window.__sessStamp = () => (CTX055.stamp ? Object.assign({}, CTX055.stamp) : null);
  // Drives the real noteSessionModelStamp against a synthetic session row,
  // so the three outcomes can be pinned without depending on which model
  // the sessions in this state dir happen to have run on.
  window.__sessStampProbe = (metadata) => {
    const before = S.log.length;
    noteSessionModelStamp({metadata});
    return {stamp: window.__sessStamp(), added: S.log.slice(before).map((m) => m.text),
      lines: window.__systemLines().slice(-2), provider: selActiveProviderId() || '', model: activeModel() || ''};
  };
  window.__sessStampApply = async () => { await applySessionModelStamp(); return {stamp: window.__sessStamp(), provider: selActiveProviderId() || ''}; };
  // D3: the release rule on its own. Plant a prompt-derived window, plant a
  // stale route, then run the rule — the window must be let go exactly once.
  window.__ctxReleaseProbe = () => {
    CTX.window = 999999; CTX.windowLabel = 'prompt window'; CTX055.route = 'a-stale-provider a-stale-model';
    const released = ctxReleaseWindowOnRouteChange();
    const after = {released, window: CTX.window, label: CTX.windowLabel, route: CTX055.route};
    CTX.window = 999999; CTX.windowLabel = 'prompt window';
    const again = ctxReleaseWindowOnRouteChange();
    return Object.assign(after, {releasedAgain: again, windowAgain: CTX.window});
  };
  // A turn this window is streaming, without an agent behind it: the real
  // onChatEvent path for the frames a synthetic turn can carry.
  window.__fakeTurn = () => {
    const turnId = 'smoke-turn-' + Date.now().toString(16) + '-' + Math.floor(Math.random() * 1e6).toString(16);
    const streaming = {id:nid(), k:'assistant', text:''};
    S.streamId = streaming.id; S.log.push(streaming);
    S.turnId = turnId; S.busy = true;
    RUNNING.set(turnId, S.agentSession || null);
    render();
    return turnId;
  };
}

/* ------------------------------------------------------------------
   Review-fix harness hooks — Item 7 (steer, the stored gauge).
   Three things the previous round shipped without assertions: the
   chat-switch race inside the steer round trip, the GET leg's recovery
   BODY (the live check only ever saw an empty store), and the D2 cache
   parenthetical on the basis line (its `provider` arm cannot arise on
   this state dir's route). Each probe drives the REAL function and puts
   back everything it touched.
   ------------------------------------------------------------------ */
if (typeof window !== 'undefined') {
  /* A steer whose POST resolves after the user has clicked another chat.
     `answer` is what the route would have said; the injected sender does
     the switch openSession does — new S.log, S.streamId cleared, a draft
     typed in the new chat — from inside the round trip. */
  window.__steerSwitchProbe = async (answer, stay) => {
    const entry = $('#entry');
    const keep = {sid:S.agentSession, log:S.log, streamId:S.streamId, draft:S.draft,
      queued:S.queued.slice(), ahead:STEER.ahead, value: entry ? entry.value : null};
    const logB = [{id:nid(), k:'system', text:'chat B'}];
    const logA = [{id:nid(), k:'system', text:'chat A'}];
    const typedInB = 'a draft typed in chat B';
    S.agentSession = 'probe-chat-a'; S.log = logA; S.streamId = null; S.draft = '';
    if (entry) entry.value = '';
    let out = null;
    try {
      await steerOrQueueRun('a message typed while chat A was running', () => {
        // `stay` is the control arm: no switch, so the transcript and the
        // editor must be written exactly as they always were.
        if (!stay) {
          S.agentSession = 'probe-chat-b'; S.log = logB; S.streamId = null;
          S.draft = typedInB;
          const e = $('#entry'); if (e) e.value = typedInB;
        }
        return Promise.resolve(answer);
      });
      const e2 = $('#entry');
      out = {a: logA.map((m) => m.k + ':' + (m.text || '')),
        b: logB.map((m) => m.k + ':' + (m.text || '')),
        draft: S.draft, value: e2 ? e2.value : null,
        queued: S.queued.slice(), ahead: STEER.ahead};
    } finally {
      S.agentSession = keep.sid; S.log = keep.log; S.streamId = keep.streamId; S.draft = keep.draft;
      S.queued.length = 0; S.queued.push.apply(S.queued, keep.queued); STEER.ahead = keep.ahead;
      const e3 = $('#entry'); if (e3 && keep.value !== null) e3.value = keep.value;
      render();
    }
    return out;
  };
  /* The GET leg with something actually parked: the real
     recoverParkedSteers over a fixed answer, so the unshift, the
     STEER.ahead watermark, the system line and the DELETE ack are all
     executed. The two bridge calls are the only things injected. */
  window.__steerParkProbe = async (undelivered, discarded) => {
    const id = 'probe-parked-session';
    const keep = {sid:S.agentSession, queued:S.queued.slice(), ahead:STEER.ahead,
      logLen:S.log.length, recovery:STEER.recovery};
    S.agentSession = id;
    const acks = [];
    let out = null;
    try {
      await recoverParkedSteers(id, {
        fetch: (sid) => Promise.resolve({ok:true, data:{sessionId:sid, undelivered, discarded}}),
        ack: (sid, seq, disc) => { acks.push({id:sid, seq, discarded:disc}); return Promise.resolve({ok:true}); },
      });
      out = {queued:S.queued.slice(), ahead:STEER.ahead, acks,
        added: S.log.slice(keep.logLen).map((m) => m.text || ''),
        recovery: STEER.recovery ? Object.assign({}, STEER.recovery) : null};
    } finally {
      S.agentSession = keep.sid;
      S.queued.length = 0; S.queued.push.apply(S.queued, keep.queued); STEER.ahead = keep.ahead;
      S.log.length = keep.logLen; STEER.recovery = keep.recovery;
      render();
    }
    return out;
  };
  /* D2 — the basis line's `provider` arm. Plants the three fields the
     sentence reads and restores them; also reports the live pair so the
     "the cache hit is part of the counted figure" invariant is checked
     against whatever the route really reported. */
  window.__ctxBasisProbe = (u) => {
    const keep = {source:CTX.source, modelId:CTX.modelId, cacheHitTokens:CTX.cacheHitTokens};
    const live = {source:CTX.source, tokens:CTX.tokens, cacheHitTokens:CTX.cacheHitTokens};
    let text = '';
    try {
      CTX.source = u.source; CTX.modelId = u.modelId; CTX.cacheHitTokens = u.cacheHitTokens;
      text = ctxBasisLine();
    } finally {
      CTX.source = keep.source; CTX.modelId = keep.modelId; CTX.cacheHitTokens = keep.cacheHitTokens;
    }
    return {text, live, restored: CTX.source === keep.source && CTX.cacheHitTokens === keep.cacheHitTokens};
  };
}

/* ============================================================
   r4 integration — seam (c): the session model-stamp notice meets
   r4-ui's user bubbles
   ============================================================
   r4-feat writes the "this session ran on <provider>/<model>" notice into
   the transcript, and r4-ui turned user rows into right-hand bubbles with
   the agent's mark moved to the end of a finished turn. The notice is
   neither: it is `k:'system'`, so `item()` must render it as a `.sysrow`
   with no `.prose.usr.bubble` around it and no `.endmark` in it, and it
   must not split a turn the way a real user message does (endMarkIds
   segments on `k === 'user'`). Nothing asserted that across the two
   lanes, because each was written before the other landed.

   The probe pushes the notice through the REAL noteSessionModelStamp,
   renders, measures the DOM, then splices exactly what it added back out
   and re-renders — the transcript it was handed is the transcript it
   leaves. */
if (typeof window !== 'undefined') {
  window.__stampRowShape = (metadata) => {
    /* Review fix: the mark-count half of this probe was vacuous. At this point
       in the run the transcript carries no end mark at all, so `markedAfter ===
       markedBefore` compared 0 with 0 and could never have seen the notice
       delete a mark. A finished turn is pushed first — user then a non-empty
       assistant, exactly the shape endMarkIds marks — and taken back out with
       the notice, so markedBefore is genuinely 1 and the sub-assertion bites. */
    const base = S.log.length;
    S.log.push({id:nid(), k:'user', text:'(smoke) a turn that finished'});
    S.log.push({id:nid(), k:'assistant', text:'and its reply'});
    const before = S.log.length;
    const markedBefore = endMarkIds().size;
    // noteSessionModelStamp writes CTX055.stamp as well as the transcript, and
    // the checks around this one read it — so it is snapshotted, not zeroed.
    const stampBefore = CTX055.stamp;
    try {
      noteSessionModelStamp({metadata});
      render();
      const added = S.log.slice(before);
      const col = document.querySelector('#scroller .col720');
      const rows = col ? [...col.children] : [];
      const tail = rows.slice(rows.length - added.length);
      return {
        added: added.length,
        kinds: added.map((m) => m.k),
        // What the operator actually sees for the notice: the row's class,
        // whether a bubble or an end mark got wrapped around it, and whether
        // it carries the offer button the notice is supposed to carry.
        classes: tail.map((n) => n.className),
        bubbles: tail.filter((n) => n.querySelector('.prose.usr.bubble') || n.classList.contains('usr')).length,
        endmarks: tail.filter((n) => n.querySelector('.endmark')).length,
        offers: tail.filter((n) => n.querySelector('[data-act="sessmodel:apply"]')).length,
        // A system row must not open a new turn segment, so the number of
        // end marks in the transcript cannot move because of it.
        markedAfter: endMarkIds().size, markedBefore,
        // The mark is only withheld from a running turn, so the count above
        // means nothing unless the window is at rest — reported, not assumed.
        busy: !!S.busy || !!S.pending,
      };
    } finally {
      S.log.splice(base, S.log.length - base);
      CTX055.stamp = stampBefore;
      render();
    }
  };
}

/* ============================================================
   r4 review fixes — smoke hooks for the gaps the per-ask verifiers found
   ============================================================ */
if (typeof window !== 'undefined') {
  /* escape-menu (d): the precedence the menu branch leans on but nothing
     tested — a running turn takes Escape first, and the menu does not open.
     S.busy is poked and put back (the same synthetic-busy technique the
     end-mark probe uses; a real turn mid-flight is a race the suite would
     lose), and abort()'s own system row is taken back out afterwards, so the
     transcript this hook was handed is the transcript it leaves. */
  /* voice: the segment that arrives after voiceStop gave up waiting. The real
     path sets VOICE.lateTake from the 2500 ms fallback timer, which a smoke run
     has no business sitting through — the flag it sets is planted instead, and
     the `final` after it goes through the REAL voiceEvent → voiceInsertLate →
     voiceInsert chain. */
  window.__voiceLateProbe = (text) => {
    VOICE.lateTake = VOICE.seq;
    S.toasts = [];
    // The state this models is "the take closed and the draft has not been
    // touched since", so the caret sits at the end of the draft. Pinned here
    // rather than assumed: a background render (the 5 s tasks poll) rewrites
    // the textarea's value between the stop and the late segment.
    const e = $('#entry');
    if (e) { try { e.setSelectionRange(S.draft.length, S.draft.length); } catch (err) {} }
    voiceEvent({type:'final', text:String(text)});
    return {draft:S.draft, entry:(($('#entry') || {}).value) || '', state:VOICE.state,
            lateTake:VOICE.lateTake, toasts:S.toasts.map((x) => x.t + ': ' + x.s)};
  };
  /* voice: losing the window mid-sentence. The blur handler exempts synthetic
     takes (the harness runs with the window behind others), so the flag is
     dropped for the length of one real `blur` event and put back. */
  window.__voiceBlurProbe = () => {
    const wasSynthetic = VOICE.synthetic;
    VOICE.synthetic = false;
    S.toasts = [];
    window.dispatchEvent(new Event('blur'));
    const out = {state:VOICE.state, draft:S.draft, toasts:S.toasts.map((x) => x.t + ': ' + x.s)};
    VOICE.synthetic = wasSynthetic;
    return out;
  };
  /* delta-055: the branch where the running turn was never ASKED — a chat
     whose first turn has not reported its session_id yet. The state is real
     (S.agentSession null), the transcript is a private one, and everything is
     put back. Nothing is injected: the absence of a session is the input. */
  window.__steerNoSessionProbe = async (text) => {
    const keep = {sid:S.agentSession, log:S.log, streamId:S.streamId,
      queued:S.queued.slice(), ahead:STEER.ahead, draft:S.draft};
    const log = [{id:nid(), k:'system', text:'a chat with no session yet'}];
    S.agentSession = null; S.log = log; S.streamId = null; S.draft = '';
    S.queued.length = 0; STEER.ahead = 0;
    let out = null;
    try {
      await steerOrQueueRun(String(text));
      out = {lines: log.map((m) => m.k + ':' + (m.text || '')), queued: S.queued.slice(), ahead: STEER.ahead};
    } finally {
      S.agentSession = keep.sid; S.log = keep.log; S.streamId = keep.streamId; S.draft = keep.draft;
      S.queued.length = 0; S.queued.push.apply(S.queued, keep.queued); STEER.ahead = keep.ahead;
      render();
    }
    return out;
  };
  /* delta-055: the same words steered twice in one turn. Both are accepted,
     both belong in the transcript, and both `steer_applied` frames must be
     recognised as this window's own — the old text-keyed de-dupe printed one
     bubble and swallowed the other. The frames go through the REAL
     onChatEvent, against a real streaming item and turn id. */
  window.__steerEchoProbe = async (text, times) => {
    const keep = {sid:S.agentSession, log:S.log, streamId:S.streamId, turnId:S.turnId,
      busy:S.busy, queued:S.queued.slice(), ahead:STEER.ahead, mine:STEER.mine.slice()};
    const log = [{id:nid(), k:'system', text:'echo probe'}];
    const streaming = {id:nid(), k:'assistant', text:''};
    const turnId = 'smoke-echo-' + Date.now().toString(16);
    S.agentSession = 'probe-echo-session'; S.log = log; log.push(streaming);
    S.streamId = streaming.id; S.turnId = turnId; S.busy = true;
    STEER.mine.length = 0;
    RUNNING.set(turnId, S.agentSession);
    let out = null;
    try {
      const n = Number(times) || 1;
      for (let i = 0; i < n; i++) {
        await steerOrQueueRun(String(text), () => Promise.resolve({ok:true, steered:true}));
      }
      const sent = log.filter((m) => m.k === 'user' && m.steered).length;
      for (let i = 0; i < n; i++) onChatEvent({turnId, kind:'steer_applied', text:String(text), stepIndex:i + 1});
      // ...and one from somewhere else, which must always show.
      onChatEvent({turnId, kind:'steer_applied', text:'from another client', stepIndex:99});
      out = {sent, entries: log.filter((m) => m.k === 'user' && m.steered).map((m) => m.text)};
    } finally {
      RUNNING.delete(turnId);
      S.agentSession = keep.sid; S.log = keep.log; S.streamId = keep.streamId; S.turnId = keep.turnId;
      S.busy = keep.busy;
      S.queued.length = 0; S.queued.push.apply(S.queued, keep.queued); STEER.ahead = keep.ahead;
      STEER.mine.length = 0; STEER.mine.push.apply(STEER.mine, keep.mine);
      render();
    }
    return out;
  };
  window.__escWhileBusy = () => {
    const keep = {busy: S.busy, settings: S.settings, len: S.log.length};
    S.busy = true; S.settings = 0;
    render();
    // Scroll-to-bottom is the branch ABOVE abort, and it would answer this
    // Escape instead — the probe is about the abort/menu ordering, so the
    // transcript is put where a user watching a turn has it.
    const sc = $('#scroller');
    if (sc) sc.scrollTop = sc.scrollHeight;
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));
    const out = {pane: S.settings ? settingsPaneId(S.settingsPane) : null, busy: S.busy,
                 // abort() is what the branch calls, and its system line is
                 // the only observable it leaves behind.
                 aborted: S.log.length > keep.len
                   && /turn aborted/.test(S.log[S.log.length - 1].text || '')};
    S.log.length = keep.len;
    S.busy = keep.busy; S.settings = keep.settings;
    render();
    return out;
  };
}

/* ==========================================================================
   r5 item 7 — setup wizard: smoke hooks.
   Read-only but for the two drivers, which go through the SAME key router
   the keyboard and the mouse use — a hook that could reach a transition no
   key can would be asserting something the product does not have.
   ========================================================================== */
if (typeof window !== 'undefined') {
  window.__ob = () => ({
    open: OB.open, step: OB.step, cursor: OB.cursor, outcome: OB.outcome, offer: OB.offer,
    resumeAfterCloud: OB.resumeAfterCloud, busy: OB.busy, error: OB.error,
    localModelId: OB.localModelId, skipSecondOffer: OB.skipSecondOffer,
    rows: document.querySelectorAll('#onboarding .ob-row').length,
  });
  window.__obKey = (spec) => { obPress(spec); return window.__ob(); };
  window.__obClick = (n) => {
    const rows = document.querySelectorAll('#onboarding .ob-row');
    if (rows[n]) rows[n].click();
    return window.__ob();
  };
  window.__obCopy = () => {
    const root = document.getElementById('onboarding');
    const head = root && root.querySelector('.ob-sub2');
    const body = root ? root.querySelector('.ob') || root.querySelector('#ob-intro') : null;
    return {
      subtitle: head ? head.textContent : '',
      title: OB_SUBTITLES[OB.step] || '',
      lines: body ? body.innerText.split('\n').map((l) => l.trim()).filter(Boolean) : [],
      footer: obFooter(),
      hints: root && root.querySelector('.ob-hints') ? root.querySelector('.ob-hints').innerText.replace(/\s+/g, ' ').trim() : '',
    };
  };
  window.__obSky = () => ({
    present: !!document.getElementById('ob-sky'),
    stars: OBSKY.stars.length,
    running: OBSKY.running,
    reduced: obReducedMotion(),
    frames: OBSKY.frames,
  });
  /**
   * Force the reduced-motion answer without an emulated media query, by
   * moving the ONE source every path reads (review fix: this used to set
   * `OBSKY.reduced` and then paint the tagline by hand, so the check's
   * tagline half was satisfied by the hook rather than by the product).
   * Everything after this line is the production paint and mount.
   */
  window.__obReduce = (on) => {
    OBSKY.override = (on === null || on === undefined) ? null : !!on;
    render();
    return window.__obSky();
  };
  window.__dl = () => {
    const el = document.getElementById('dlbar');
    const job = DL.job;
    return {
      visible: !!(el && !el.hidden),
      label: job ? dlJobLabel(job) : null,
      kind: job ? job.kind : null,
      percent: job ? Math.round(job.percent || 0) : null,
      transferred: job ? job.transferredBytes : null,
      total: job ? job.totalBytes : null,
      eta: dlEta(dlEtaSeconds()),
      queued: DL.queue.length,
      text: el ? el.innerText.replace(/\s+/g, ' ').trim() : '',
      phases: {runtime: DL.runtime.state, weights: DL.weights.state},
      drove: {runtime: DL.runtime.drove, weights: DL.weights.drove},
      error: DL.error,
      runtimeError: DL.runtimeError,
      measured: !!(job && job.sawProgress),
    };
  };
  /** Feed the strip one real `cli:pull` frame, as main would send it. */
  window.__dlFeed = (ev) => { dlOnPull(ev); return window.__dl(); };
  /** Seed a queue without spawning anything, to assert the queue text. */
  window.__dlSeed = (jobs) => {
    DL.dry = true;
    DL.queue = jobs.slice(1);
    DL.error = null; DL.rate = null; DL.last = null;
    dlResetPhases(jobs.some((j) => j.kind === 'runtime'));
    const head = jobs[0];
    // The same shape dlNext builds — including `sawProgress:false`, so a
    // seeded job claims no bar until a sample is fed to it.
    DL.job = Object.assign({percent: 0, transferredBytes: 0, totalBytes: 0, sawProgress: false}, head);
    render();
    return window.__dl();
  };
  window.__dlClear = () => { DL.dry = false; DL.job = null; DL.queue.length = 0; DL.error = null; DL.runtimeError = null; dlResetPhases(false); render(); return window.__dl(); };
  window.__obImport = () => ({
    agents: OB.importAgents.map((a) => ({id: a.id, dir: a.dir, enabled: a.enabled})),
    rows: obImportRows().map((r) => r.kind),
    options: OB.importOptions.map((o) => ({agent: o.agent, option: o.option, secret: o.secret, enabled: o.enabled})),
    report: OB.importReport,
  });
  /**
   * Open the flow and land it on one step, without the agent round trips.
   * `opts.stamped` names the stamps a jump into the MIDDLE of the machine
   * should be treated as having already passed — a jump straight to
   * `import_preview` never went through the screen that stamps
   * `importOfferedAt`, and without saying so the finished effect would
   * (correctly) offer the import step it thinks nobody has seen.
   */
  window.__obOpen = (step, opts) => {
    OB.open = true;
    Object.assign(OB, {offer: null, resumeAfterCloud: null, localModelId: null, outcome: null,
      skipSecondOffer: false, cursor: 0, busy: false, error: null, hfReference: '', hfRepo: null,
      importAgents: [], importOptions: [], importReport: null, introTyped: false,
      settling: false, testClose: true, pendingMmproj: null, restarted: false, managedWrite: null});
    /* r5 item 7 review fix: the stamps are NO LONGER pre-marked here. They
       used to be, which short-circuited obStampOnce for the whole driven
       pass — so the five acceptance lines about write-on-arrival had no
       check and could not get one, and `importOfferedAt` being pre-set
       routed the flow around the import step the TUI has no path around.
       This lane has its own state dir; a `tui.onboarding.*` write in it is
       exactly the write under test, and the suite restores the block. */
    for (const leaf of Object.keys(OB_STAMPED)) delete OB_STAMPED[leaf];
    OB_STAMP_LOG.length = 0;
    for (const leaf of ((opts && opts.stamped) || [])) OB_STAMPED[leaf] = true;
    OB.step = step || 'intro';
    OB_LAST_STEP = null;
    render();
    // The arrival effects a real step change runs (the catalogue read on
    // local_pick, the stamps that were just neutralised).
    obAfterStep();
    if (OB.step === 'intro') obIntroMounted();
    return window.__ob();
  };
  window.__obClose = () => { OB.open = false; OB.settling = false; obSkyStop(); render(); return window.__ob(); };
  /** Every tui.onboarding.* stamp this session decided on, in order. */
  window.__obStamps = () => OB_STAMP_LOG.map((e) => ({leaf: e.leaf, at: e.at, step: e.step, written: e.written !== false}));
  /** The cloud step's list, as the cursor and the `/` filter leave it. */
  window.__wizList = () => ({
    phase: WIZ.phase, q: WIZ.q, cur: WIZ.cur,
    rows: obWizRows().map(({k}) => k.label),
    marked: Array.from(document.querySelectorAll('#onboarding .ob-wiz .modelrow.on .nm')).map((e) => e.textContent),
    row: WIZ.row ? WIZ.row.label : null,
  });
  /** Everything the flow can seed for a check, in one call. */
  window.__obSeed = (patch) => { Object.assign(OB, patch || {}); render(); return window.__ob(); };
  /** decideSecondBackendOffer, driven as a table. */
  window.__obOffer = (inputs) => obDecideSecondBackend(inputs);
  window.__obFooterFor = (step) => { const was = OB.step; OB.step = step; const f = obFooter(); OB.step = was; return f; };
  /** The cloud step's footer tracks the WIZARD phase, not the step. */
  window.__wizPhase = (phase) => { WIZ.phase = phase; WIZ.row = phase === 'configure' ? KIND_ROWS[0] : null; render(); return WIZ.phase; };
  window.__obBuildOptions = () => obBuildImportOptions(OB.importAgents);
  /** How many import sources this machine actually has, through the real scan. */
  window.__obSources = () => obDetectAgents().then((rows) => rows.map((r) => r.id));
  /** The readiness the finished effect reads, unmodified — so a check can
   *  derive what the offer table SHOULD say on this machine rather than
   *  assume a config it does not own. */
  window.__obReadiness = () => obReadiness();
}
