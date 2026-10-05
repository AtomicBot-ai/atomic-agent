/* ---------------- Anonymous usage analytics: the renderer's half ----------------
   Loaded after analytics-acts.js (the act-id allowlist, ANX_ACTS) and
   BEFORE renderer.js, so it only declares: the registries it reads (SLASH,
   CATS …) are renderer.js consts, looked up when a function runs, never at
   load time. What is sent, and what never is: desktop/ANALYTICS.md.

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

  const reg = ANX_ACTS.reg;
  const sanitizeAct = ANX_ACTS.sanitizeAct;

  /* ---------- how an action was started ----------
     A caller that knows (the menu bridge, a chord, the palette, a slash
     command, the plan bar) sets the marker just before it acts; a click sets
     it in the capture phase, before the page's own handler runs. The marker
     lives for the current task only, so it cannot leak onto a later act. */
  let viaPending = null;
  let viaTimer = null;
  function via(v) {
    // A keyboard answer is a shortcut as far as the catalogue's `via` goes.
    viaPending = v === 'key' ? 'shortcut' : v;
    clearTimeout(viaTimer);
    viaTimer = setTimeout(() => { viaPending = null; viaTimer = null; }, 0);
  }
  function viaNow() { return viaPending; }
  if (typeof document !== 'undefined') {
    document.addEventListener('click', () => { if (!viaPending) via('click'); }, true);
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
      input: key === 'prose' ? 'key' : viaPending === 'click' ? 'click' : 'key',   // the shortcut marker is a key
      ms_to_answer: typeof at === 'number' ? Math.max(0, Date.now() - at) : null,
    });
  }

  /* ATO-203: a card that closed with no answer (`how`: stopped, expired,
     replaced, not_waiting). Once per card: a replay that opens it again and a
     second close are the same card going away. */
  const apprClosedSeen = new WeakSet();
  function apprClosed(req, how) {
    if (!req || typeof req !== 'object' || apprClosedSeen.has(req)) return;
    try { apprClosedSeen.add(req); } catch (e) { return; }
    const at = apprShownAt.get(req);
    const cats = reg(() => CATS.map((c) => c[0]), []);
    const lvl = Number(req.lvl);
    track('approval_closed', {
      how,
      category: cats.includes(req.cat) ? req.cat : 'other',
      level: Number.isInteger(lvl) ? lvl : null,
      ms_open: typeof at === 'number' ? Math.max(0, Date.now() - at) : null,
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

  /* host_ram_gb: <=12 -> "8", <=24 -> "16", <=48 -> "32", else "64"; null when
     unknown. The catalogue (catalog-values.ts RAM_BUCKETS) takes the strings. */
  function ramBucket(gb) {
    const n = Number(gb) || 0;
    if (!(n > 0)) return null;
    return n <= 12 ? '8' : n <= 24 ? '16' : n <= 48 ? '32' : '64';
  }
  /* model: the catalogue row (or null); fit: fitFor's verdict for it. The
     row's real id is sent: main keeps it only when it is a curated catalogue
     id and turns anything else (a Hugging Face add) into `custom`. */
  function modelPicked(model, fit, ramGb, sizeGb) {
    const gb = Number(sizeGb);
    track('model_picked', {
      model_id: model && typeof model.id === 'string' ? model.id : 'custom',
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
      // Only a real Error has a name worth keeping; anything else thrown or rejected is `NonError`.
      const e = err instanceof Error ? err : null;
      const payload = {
        kind,
        name: e ? String(e.name || 'Error').slice(0, 64) : 'NonError',
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
    apprShown, apprAnswered, apprClosed, modeVia, modeChanged, planHandoff, paneTick,
    obStep, obSkipped, modelPicked, ramBucket, endpointTested, providerStarted, providerFailed,
    mcpAdded, mcpAction,
  };
})();
