/* ---------------- Anonymous usage analytics: the act-id allowlist ----------------
   Loaded BEFORE analytics.js and renderer.js, so it only declares: the
   registries it reads (SETTINGS_TABS, MENU_GROUPS, ...) are renderer.js
   consts, looked up when a function runs, never at load time.

   sanitizeAct keeps an act string's verb, and its tail only when the tail
   is one of the fixed words listed here; everything else is cut off, so no
   id, name, path or URL ever reaches window.atomic.track. Main checks the
   result again (catalog-values.ts uiActionOk). See desktop/ANALYTICS.md. */

const ANX_ACTS = (() => {
  /* A renderer.js registry, or `fallback` while it is not there (load order,
     a harness that stubs the page). */
  function reg(read, fallback) {
    try { const v = read(); return v == null ? fallback : v; } catch (e) { return fallback; }
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

  return {reg, sanitizeAct};
})();
