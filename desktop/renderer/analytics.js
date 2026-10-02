/* ---------------- Anonymous usage analytics: the renderer's half ----------------
   Loaded BEFORE renderer.js, so it only declares: the registries it reads
   (SETTINGS_TABS, SLASH, CATS, MENU_GROUPS …) are renderer.js consts, looked
   up when a function runs, never at load time.

   Everything here ends in window.atomic.track(event, props), which main
   re-validates against its own allowlist and drops while analytics is off.
   This side never sends anything a person typed or named: no ids, no chat
   titles, no paths, no URLs, no server or skill names, no slash arguments,
   no message text. An act string keeps its verb, and its tail only when the
   tail is one of a fixed set of words this file lists; everything else is
   cut off. Nothing here may throw into the code that calls it. */

const ANX = (() => {
  const bridge = () => (typeof window !== 'undefined' && window.atomic) || null;

  function track(event, props) {
    try {
      const b = bridge();
      if (b && typeof b.track === 'function') b.track(event, props || {});
    } catch (e) { /* analytics never breaks the app */ }
  }

  /* A renderer.js registry, or `fallback` while it is not there (load order,
     a harness that stubs the page). */
  function reg(read, fallback) {
    try { const v = read(); return v == null ? fallback : v; } catch (e) { return fallback; }
  }

  /* ---------- how an action was started ----------
     A caller that knows (the menu bridge, a chord, the palette, a slash
     command, the plan bar) sets the marker just before it acts; a click sets
     it in the capture phase, before the page's own handler runs. The marker
     lives for the current task only, so it cannot leak onto a later act. */
  let viaPending = null;
  let viaTimer = null;
  function via(v) {
    viaPending = v;
    clearTimeout(viaTimer);
    viaTimer = setTimeout(() => { viaPending = null; viaTimer = null; }, 0);
  }
  function viaNow() { return viaPending; }
  if (typeof document !== 'undefined') {
    document.addEventListener('click', () => { if (!viaPending) via('click'); }, true);
  }

  /* ---------- the act-id sanitizer ----------
     A tree of allowed words. `true` = a leaf: the word is kept and whatever
     follows it is dropped. An object = the next segment is kept only if it
     is a key there. A verb missing from the tree is reported as `other`. */
  const L = true;
  const set = (words) => { const o = {}; (words || []).forEach((w) => { if (typeof w === 'string' && w) o[w] = L; }); return o; };
  const UPDOWN = {up:L, down:L};

  function tree() {
    const panes = reg(() => SETTINGS_TABS.map((t) => t[0]), []);
    const sections = reg(() => SETTINGS_SECTIONS.map((s) => s[0]), []);
    const menuIds = reg(() => {
      const ids = [];
      MENU_GROUPS.forEach(([, nodes]) => nodes.forEach((n) => { ids.push(n.id); (n.sub || []).forEach((c) => ids.push(c.id)); }));
      return ids;
    }, []);
    const taskFilters = reg(() => TK_FILTER_ORDER, []);
    const memChannels = reg(() => MEM_CHANNEL_ORDER, []);
    const memFilters = reg(() => MEM_NOTES_FILTERS, []);
    const skillFilters = reg(() => SKP_FILTERS, []);
    const mcpTabs = reg(() => MCP_TAB_ORDER, []);
    const llmModes = reg(() => LLM_PANEL_MODES, []);
    const impSources = reg(() => IMP_SOURCES, []);
    const impFields = reg(() => IMP_TOGGLE_FIELDS, []);
    const readScopes = reg(() => READ_SCOPES.map((r) => r[0]), []);
    return {
      // chat, sessions and the window
      close:L, palette:{slash:L, theme:L}, shortcuts:L, context:L, modes:L, send:L, stop:L, retry:L,
      clear:L, dump:L, report:L, 'help.report':L, tools:L, restart:L, quit:L, about:L, update:L,
      workspace:{choose:L}, analytics:L, steer:L, onboarding:{choose:L}, voice:{add:L, dismiss:L, lang:L, pick:L, reset:L, settings:L},
      session:{new:L, switch:L, id:L}, ses:L, pin:L, unpin:L, unread:L, del:L, delask:L,
      more:{chats:L, tasks:L}, task:L, toastx:L, 'turn':{continue:L}, sessmodel:{apply:L},
      copy:{reply:L, session:L}, agent:{restart:L, update:L}, jump:{appr:L}, diag:{llmlogs:L},
      dl:{cancel:L}, dlc:{cloud:L, dismiss:L, fold:L, keep:L, retry:L, switch:L, unfold:L},
      appr:{y:L, n:L, esc:L, s:L, a:L}, selector:{model:L}, cards:{expand:L, collapse:L},
      room:{chat:L, tasks:L, skills:L}, insp:{steps:L, reasoning:L, world:L}, console:{agent:L, llm:L},
      toggle:{sidebar:L, inspector:L, console:L},
      theme:{light:L, dark:L, system:L},
      runmode:{local:L, cloud:L, fusion:L, swap:L, status:L,
        workers:{1:L, 2:L, 3:L, 4:L, 5:L, 6:L, 7:L, 8:L}},
      settings:Object.assign(set(panes), set(sections), {open:L, close:L, connections:L, channels:L, appearance:L}),
      menu:set(menuIds),
      scope:L, taskfilter:set(taskFilters), skillstab:L, memtab:L,
      // composer selector and the add-provider wizard
      sel:{add:L, browseLocal:L, closeAdd:L, savePreset:L, cancelPull:L},
      wiz:{back:L, next:L, cancel:L, model:L, useDefault:L, saveUnchecked:L},
      // Settings › Privacy and General
      privacy:{analytics:L, refresh:L, readscope:set(readScopes)}, notify:{toggle:L}, names:{toggle:L},
      // the Manage panes' own verbs (renderer.js mcpAct / skillsAct / memoryAct / tasksAct / llmAct / telegramAct / importAct)
      mcp:{add:L, addSubmit:L, addCancel:L, auto:L, back:L, detail:L, refresh:L, remove:L,
        removeCancel:L, removeConfirm:L, restart:L, toggle:L, enable:L, disable:L,
        dtab:Object.assign(set(mcpTabs), {cycle:L})},
      skills:{auto:L, back:L, card:L, cardScroll:UPDOWN, detail:L, filter:set(skillFilters), hub:L,
        hubPage:UPDOWN, hubSearch:L, install:L, installAck:L, installCancel:L, page:UPDOWN,
        rebrowse:L, refresh:L, remove:L, removeCancel:L, removeConfirm:L, search:L, toggle:L, tools:L},
      memory:{auto:L, back:L, ch:set(memChannels), cycle:L, expand:L, filter:set(memFilters), jump:L,
        neighbor:L, open:L, page:UPDOWN, refresh:L},
      tasks:{auto:L, back:L, cancel:L, cancelConfirm:L, cancelKeep:L, clearSearch:L, detail:L,
        filter:set(taskFilters), kind:{cron:L, interval:L, at:L}, new:L, open:L, page:UPDOWN,
        refresh:L, run:L, search:L, submit:L},
      llm:{mode:Object.assign(set(llmModes), {next:L, prev:L}), add:L, autoUpdate:L, back:L, backend:L,
        cancel:L, cancelPull:L, configure:L, confirm:L, daemon:L, device:L, edit:L, embToggle:L,
        embedding:L, enter:L, external:{cancel:L, save:L, edit:L}, filter:L, logs:L, logsRefresh:L,
        pricing:L, refresh:L, remove:L, removeAt:L, row:L, select:L, steer:{y:L, n:L}, tune:L,
        fb:{add:L, local:L, move:L, pick:L, pickCancel:L, remove:L, select:L},
        hf:{add:L, back:L, cancel:L, clear:L, close:L, look:L, row:L}},
      telegram:{advanced:L, clearOwner:L, clearToken:L, enable:L, disable:L, pair:L, refresh:L,
        restart:L, start:L, stop:L, token:L, tokenCancel:L, tokenSave:L},
      import:{apply:L, field:L, focus:L, preview:L, reset:L, source:Object.assign(set(impSources), {tui:L}),
        toggle:set(impFields)},
    };
  }

  /* Built once the registries exist (they are renderer.js consts). */
  let TREE = null;
  function treeOnce() {
    if (TREE) return TREE;
    const t = tree();
    if (reg(() => SETTINGS_TABS.length > 0 && MENU_GROUPS.length > 0, false)) TREE = t;
    return t;
  }

  /* `pin:hermes:2026…` → `pin`; `settings:privacy` → `settings:privacy`;
     `mcp:toggle:<server>` → `mcp:toggle`; an unknown verb → `other`. */
  function sanitizeAct(a) {
    if (typeof a !== 'string' || !a) return 'other';
    const segs = a.split(':');
    let node = treeOnce();
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      if (!node || node === L || typeof node !== 'object') break;
      const s = segs[i];
      if (!Object.prototype.hasOwnProperty.call(node, s)) break;
      out.push(s);
      node = node[s];
    }
    if (!out.length) return 'other';
    return out.join(':').slice(0, 64);
  }

  /* The verbs that also mean something to the session list or the turn. */
  const SESSION_VERB = {ses:'open', pin:'pin', unpin:'unpin', unread:'mark_unread', del:'delete'};
  function sessionAction(a, clean) {
    if (a === 'session:new') return 'new';
    if (a === 'session:switch') return 'switch';
    if (a === 'clear') return 'clear';
    if (clean === 'more:chats') return 'load_more';
    const k = a.indexOf(':') < 0 ? null : a.slice(0, a.indexOf(':'));
    return k && SESSION_VERB[k] ? SESSION_VERB[k] : null;
  }
  const MESSAGE_VERB = {stop:'stop', 'copy:reply':'copy_reply'};

  /* The outermost wrapper of act (installed at the very end of renderer.js).
     Only the outermost call of a nested chain is counted: `tools` running
     `settings:skills` is one action, not two. */
  let depth = 0;
  function aroundAct(a, inner) {
    if (depth === 0 && typeof a === 'string' && a && a !== 'na') {
      try {
        const v = viaPending || 'other';
        const clean = sanitizeAct(a);
        track('ui_action', {action: clean, via: v});
        const sa = sessionAction(a, clean);
        if (sa) track('session_action', {action: sa});
        if (MESSAGE_VERB[a]) track('message_action', {action: MESSAGE_VERB[a]});
      } catch (e) { /* never in the way of the act */ }
    }
    depth++;
    try { return inner(a); } finally { depth--; }
  }

  /* ---------- slash commands ---------- */
  function slashUsed(name) {
    const n = String(name || '').toLowerCase();
    const known = reg(() => {
      const names = [];
      SLASH.forEach((r) => { names.push(r[0]); (r[3] || []).forEach((al) => names.push(al)); });
      return names;
    }, []);
    track('slash_command_used', {command: known.includes(n) ? n : 'unknown'});
  }

  /* ---------- message actions ---------- */
  function messageAction(action) { track('message_action', {action}); }

  /* ---------- approvals ---------- */
  const apprShownAt = new WeakMap();
  function apprShown(req) { try { if (req && typeof req === 'object') apprShownAt.set(req, Date.now()); } catch (e) { /* ignore */ } }
  /* key: y / n / esc / s / a from the card, or 'prose' for a typed refusal. */
  function apprAnswered(req, key) {
    if (!req || typeof req !== 'object') return;
    const choice = key === 'prose' ? 'deny_with_text'
      : key === 'esc' ? 'abort'
      : (key === 'y' || key === 's' || key === 'a') ? 'allow_once' : 'deny';
    const at = apprShownAt.get(req);
    const cats = reg(() => CATS.map((c) => c[0]), []);
    const lvl = Number(req.lvl);
    track('approval_answered', {
      choice,
      category: cats.includes(req.cat) ? req.cat : 'other',
      level: Number.isInteger(lvl) ? lvl : null,
      input: key === 'prose' ? 'key' : viaPending === 'click' ? 'click' : 'key',
      ms_to_answer: typeof at === 'number' ? Math.max(0, Date.now() - at) : null,
    });
  }

  /* ---------- coding mode and the plan hand-off ---------- */
  const MODE_IDS = ['default', 'plan', 'auto', 'bypass'];
  /* Read at the top of setCodingMode, while the caller's marker is live. */
  function modeVia() {
    const v = viaPending;
    if (v === 'plan_bar' || v === 'palette' || v === 'shortcut') return v;
    if (v === 'click' || v === 'menu') return 'menu';
    return 'other';
  }
  function modeChanged(from, to, v) {
    if (!to || from === to) return;
    track('coding_mode_changed', {
      from: MODE_IDS.includes(from) ? from : 'other',
      to: MODE_IDS.includes(to) ? to : 'other',
      via: v || 'other',
    });
  }
  function planHandoff(choice) { track('plan_handoff', {choice}); }

  /* ---------- Settings panes: time on each ----------
     Called on every render with the pane on screen (null when Settings is
     closed); a change emits the pane being left with the time spent on it. */
  const PANE_NAME = {llm:'models'};
  let paneNow = null;
  let paneSince = 0;
  function paneTick(pane) {
    const p = pane ? (PANE_NAME[pane] || pane) : null;
    if (p === paneNow) return;
    const now = Date.now();
    if (paneNow) track('settings_pane_viewed', {pane: paneNow, ms_on_pane: Math.max(0, now - paneSince)});
    paneNow = p;
    paneSince = now;
  }

  /* ---------- onboarding ---------- */
  let obSince = 0;
  const OB_OUTCOMES = ['local', 'cloud', 'custom', 'skipped'];
  function obStep(step, prev, outcome) {
    const now = Date.now();
    const props = {step: step || 'other', prev_step: prev || null,
      ms_on_prev_step: prev && obSince ? Math.max(0, now - obSince) : null};
    if (step === 'finished') props.outcome = OB_OUTCOMES.includes(outcome) ? outcome : 'skipped';
    obSince = now;
    track('onboarding_step', props);
  }
  function obSkipped(atStep) { track('onboarding_skipped', {at_step: atStep || 'other'}); }

  function ramBucket(gb) {
    const n = Number(gb) || 0;
    if (!n) return null;
    return n < 12 ? 8 : n < 24 ? 16 : n < 48 ? 32 : 64;
  }
  /* model: the catalogue row (or null); fit: fitFor's verdict for it. A row
     that is not in the curated catalogue (a Hugging Face add) is `custom`:
     its id carries a repo and file name. */
  function modelPicked(model, fit, ramGb, sizeGb) {
    const curated = !!(model && fit && fit.known && typeof model.id === 'string' && /^[a-zA-Z0-9_.:-]{1,64}$/.test(model.id));
    const gb = Number(sizeGb);
    track('model_picked', {
      model_id: curated ? model.id : 'custom',
      size_gb: Number.isFinite(gb) && gb > 0 ? Math.round(gb * 10) / 10 : null,
      fit: fit && ['comfortable', 'tight', 'over'].includes(fit.v) ? fit.v : null,
      host_ram_gb: ramBucket(ramGb),
    });
  }
  function endpointTested(kind, reachable) { track('custom_endpoint_tested', {kind, reachable: !!reachable}); }

  /* ---------- the add-provider wizard ---------- */
  function presetId(row) {
    if (!row) return 'other';
    if (row.custom) return 'custom';
    return typeof row.id === 'string' && /^[a-z0-9_.-]{1,40}$/.test(row.id) ? row.id : 'other';
  }
  function providerStarted(row) { track('provider_setup_started', {provider_preset: presetId(row)}); }
  /* step: where the wizard ran (first-run setup or the app); reason: the fixed list. */
  function providerFailed(reason, inOnboarding) {
    track('provider_setup_failed', {step: inOnboarding ? 'onboarding' : 'settings', reason});
  }

  /* ---------- MCP servers ---------- */
  function mcpAdded(ok) { track('mcp_server_added', {result: ok ? 'ok' : 'error'}); }
  function mcpAction(op) {
    const action = op === 'enable' || op === 'disable' ? 'toggle' : op;
    if (action === 'toggle' || action === 'restart' || action === 'remove') track('mcp_server_action', {action});
  }

  /* ---------- renderer errors → main (which scrubs before Sentry) ---------- */
  let errSent = 0;
  const errSeen = new Set();
  function reportError(kind, err, fallbackMessage) {
    try {
      const b = bridge();
      if (!b || typeof b.reportError !== 'function') return;
      if (errSent >= 25) return;
      const e = err && typeof err === 'object' ? err : null;
      const payload = {
        kind,
        name: String((e && e.name) || (kind === 'unhandledrejection' ? 'UnhandledRejection' : 'Error')).slice(0, 64),
        message: String((e && e.message) || fallbackMessage || (err != null && !e ? err : '')).slice(0, 500),
        stack: String((e && e.stack) || '').slice(0, 8000),
      };
      const key = payload.name + '|' + payload.message + '|' + payload.stack.slice(0, 300);
      if (errSeen.has(key)) return;
      errSeen.add(key);
      errSent++;
      b.reportError(payload);
    } catch (x) { /* nothing to do */ }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('error', (ev) => {
      // A failed <img>/<script> load is an Event with no error: not a JS error.
      if (!ev || typeof ev.message !== 'string') return;
      reportError('error', ev.error, ev.message);
    });
    window.addEventListener('unhandledrejection', (ev) => {
      reportError('unhandledrejection', ev ? ev.reason : null, '');
    });
  }

  return {
    track, via, viaNow, sanitizeAct, aroundAct, slashUsed, messageAction,
    apprShown, apprAnswered, modeVia, modeChanged, planHandoff, paneTick,
    obStep, obSkipped, modelPicked, endpointTested, providerStarted, providerFailed,
    mcpAdded, mcpAction,
  };
})();
