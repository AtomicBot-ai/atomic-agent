import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserWindow } from "electron";

import { downloadJobRunning, modelIdFromPath, modelsRemoveSafe, probeServer, removeBlocker, removeModelDir, type ServerFacts } from "../agent-cli.js";

/**
 * Release-fix checks for Settings › Models (Danya's items Д30–Д35 in
 * ~/desktop-release-fixes-2026-10-01.md, ATO-119's "no Remove for the model
 * in use nor for the embedding models", and ATO-125's Use). Run alone with
 * `--smoke --smoke-task=48`.
 *
 *   Д30 — Two look-alike rows at the top, "Set up: Local / Cloud / Custom
 *         server" over "Chats run on: Local models / Cloud / Fusion". Where
 *         chats run is the pane's first block now, three cards with a line
 *         each; the setup tabs come under it, in words that are not that
 *         choice's words (Local models · Cloud providers · Custom server).
 *   Д31 — Cloud with no cloud provider ran the switch, and its refusal landed
 *         in the chat behind Settings. A choice that cannot be made yet opens
 *         what it needs here: Add provider, a provider's key, the Local
 *         models list; Fusion the same.
 *   Д32 — "runs comfortably — wants 16 GB…" lines under the rows: badges now
 *         (Fits well / Tight fit / Too big / Installed), the reasons in the
 *         tooltip and in the row's description; no sentence over the list.
 *   Д33 — "Default 1500." is gone from Thinking budget; the chat template is
 *         Advanced's, in shorter words.
 *   Д34 — The Ollama signpost read as an ad: one "Add Ollama" button that
 *         opens the provider setup with Ollama's address filled in.
 *   Д35 — Advanced was a pile of look-alike buttons: Stop sits beside the
 *         model's state (on every route the server is up on), llama.cpp's
 *         update / auto-update / device are one Engine card, the LLM log is
 *         Settings › Diagnostics' (the card's Server log row and `L` open it
 *         there), the route's internals fold under Details, each value with
 *         its Copy (Д56).
 *   ATO-119 — Remove on every model on disk, the one in use and the
 *         embedding models included; never under a server that has it
 *         loaded. The window asks for the go-ahead to stop, main decides
 *         against what each server says it runs and deletes nothing it is
 *         unsure of — a server left up under a Custom server route included.
 *   ATO-125 — Settings' Use wrote the model and left the server on the old
 *         one under "In use". It is the composer's own pick now, and the
 *         "now" line names the model the server says it runs.
 *
 * The window's checks render the pane's own functions against a staged copy
 * of the config, the catalogue and what the servers say (the file is not
 * touched) and put every piece of state back. The Remove flow and Use run
 * against stand-ins on the window's own IPC (a webContents handler is asked
 * before ipcMain's; a probe proves it first) and a stand-in for the switch
 * funnel's model pick, so no server stops, no file is deleted and nothing is
 * switched. Main's half deletes only inside a throwaway directory.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const show = (v: unknown) => JSON.stringify(v);

export async function checks48(js: Js, check: Check): Promise<void> {
  await layout(js, check);
  await routeNeeds(js, check);
  await fitBadges(js, check);
  await reasoning(js, check);
  await ollama(js, check);
  await advanced(js, check);
  await nowLine(js, check);
  await diagnosticsLog(js, check);
  await removeAndUseInWindow(js, check);
  await removeInMain(check);
}

/* Д30: where chats run first, the setup tabs under it, each in its own words. */
async function layout(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(() => {
    const keep = LLMP.mode;
    try {
      LLMP.mode = 'local';
      const box = document.createElement('div'); box.className = 'llm-pane'; box.innerHTML = llmPanelHTML();
      const run = box.querySelector('.llm-runmode'), bar = box.querySelector('.llm-srcbar');
      return {
        first: box.firstElementChild ? box.firstElementChild.className : null,
        before: !!run && !!bar && !!(run.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING),
        title: run ? ((run.querySelector('.llm-sh-t') || {}).textContent || null) : null,
        cards: run ? [...run.querySelectorAll('.llm-rm')].map((b) => [((b.querySelector('.llm-rm-t') || {}).textContent || ''), ((b.querySelector('.llm-rm-d') || {}).textContent || '')]) : [],
        refresh: !!(run && run.querySelector('[data-act="llm:refresh"]')),
        tabs: [...box.querySelectorAll('.llm-bar .llmmode')].map((b) => b.textContent.trim()),
        barTitle: bar ? ((bar.querySelector('.llm-sh-t') || {}).textContent || null) : null,
        old: /Chats run on/.test(box.textContent),
      };
    } finally { LLMP.mode = keep; }
  })()`);
  const cards = (r["cards"] ?? []) as string[][];
  check(
    "T48 (Д30): where chats run is the pane's first block — three cards, each with a line — and the setup tabs come under it",
    r["first"] === "llm-section llm-runmode" && r["before"] === true && r["title"] === "Where chats run" && r["refresh"] === true
      && cards.length === 3 && cards.map((c) => c[0]).join("|") === "Local models|Cloud|Fusion" && cards.every((c) => (c[1] ?? "").length > 0),
    show({ first: r["first"], before: r["before"], title: r["title"], cards }),
  );
  check(
    "T48 (Д30): the setup tabs say what they set up — Local models · Cloud providers · Custom server — and \"Chats run on\" is gone",
    show(r["tabs"]) === show(["Local models", "Cloud providers", "Custom server"]) && r["barTitle"] === "Set up models" && r["old"] === false,
    show({ tabs: r["tabs"], barTitle: r["barTitle"], old: r["old"] }),
  );
}

/* Д31: a choice made before what it needs is there opens that, and tries no switch. */
async function routeNeeds(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    const keep = {cfg: LIVE_CONFIG, mode: LLMP.mode, msg: LLMP.msg, open: SEL.open, addOpen: SEL.addOpen, err: SEL.err, wiz: Object.assign({}, WIZ),
      swxErr: SWX.err, log: S.log.length, ids: BSW.readyIds, rl: BSW.readyLoaded, ll: BSW.localLoaded, local: SEL.local, llmLocal: LLMP.local,
      choose: window.selChooseBackend, fusion: window.selChooseFusion, activate: window.fzActivateBackend};
    const calls = [];
    const close = () => { WIZ.unfinishedId = null; act('close'); };
    const tick = () => new Promise((res) => setTimeout(res, 50));
    const providers = (extra) => ({llm: {activeTextProvider: 'local-llama', activeEmbeddingProvider: 'local-llama',
      providers: [{id: 'local-llama', kind: 'llama-server'}].concat(extra)}});
    try {
      // Only the built-in local entry: no cloud provider at all, one local model on disk.
      LIVE_CONFIG = Object.assign({}, keep.cfg || {}, providers([]), {localModels: {mode: 'managed', managed: {modelId: 'smoke-t48'}}});
      BSW.readyIds = []; BSW.readyLoaded = true; BSW.localLoaded = true; SEL.local = [{id: 'smoke-t48', downloaded: true}];
      LLMP.local = [{id: 'smoke-t48', downloaded: true}];
      SWX.err = null;
      // Whatever a click would switch is written down here and switched nowhere.
      window.selChooseBackend = (id) => { calls.push('selChooseBackend:' + id); return Promise.resolve({ok: false}); };
      window.selChooseFusion = () => { calls.push('selChooseFusion'); return Promise.resolve({ok: false}); };
      window.fzActivateBackend = (id) => { calls.push('fzActivateBackend:' + id); return Promise.resolve({ok: false}); };
      const cards = () => { const box = document.createElement('div'); box.innerHTML = llmRunModeHTML(); return box; };
      const card = (box, word) => { const b = [...box.querySelectorAll('.llm-rm')].find((x) => (x.querySelector('.llm-rm-t') || {}).textContent === word);
        return b ? {act: b.dataset.act, blocked: b.classList.contains('blocked'), line: (b.querySelector('.llm-rm-d') || {}).textContent, title: b.title} : null; };
      const first = cards();
      const out = {cloud: card(first, 'Cloud'), fusion: card(first, 'Fusion')};
      close();
      act(out.cloud ? out.cloud.act : 'runmode:cloud');
      await tick();
      out.afterCloud = {calls: calls.slice(), open: SEL.open, phase: WIZ.phase, mode: LLMP.mode, swxErr: SWX.err, logGrew: S.log.length - keep.log};
      close();
      act(out.fusion ? out.fusion.act : 'runmode:fusion');
      await tick();
      out.afterFusion = {calls: calls.slice(), open: SEL.open, phase: WIZ.phase, mode: LLMP.mode, msg: LLMP.msg ? LLMP.msg.text : null, logGrew: S.log.length - keep.log};
      // A cloud provider whose key cannot be used: Cloud opens that provider's key screen.
      close();
      LIVE_CONFIG = Object.assign({}, keep.cfg || {}, providers([{id: 'openrouter', kind: 'openrouter', defaultChatModel: 'openrouter/auto'}]),
        {localModels: {mode: 'managed', managed: {modelId: 'smoke-t48'}}});
      out.keyless = card(cards(), 'Cloud');
      act(out.keyless ? out.keyless.act : 'runmode:cloud');
      await tick();
      out.afterKeyless = {calls: calls.slice(), open: SEL.open, phase: WIZ.phase, row: WIZ.row ? WIZ.row.id : null};
      // No local model on disk: Local models goes to the list to download one, not onto a route with nothing to run.
      close();
      LIVE_CONFIG = Object.assign({}, keep.cfg || {}, {localModels: {mode: 'managed', managed: {modelId: null}},
        llm: {activeTextProvider: 'openrouter', providers: [{id: 'local-llama', kind: 'llama-server'}, {id: 'openrouter', kind: 'openrouter', defaultChatModel: 'openrouter/auto'}]}});
      BSW.readyIds = ['openrouter']; LLMP.local = [{id: 'smoke-t48', downloaded: false}]; SEL.local = [{id: 'smoke-t48', downloaded: false}];
      LLMP.mode = 'cloud';
      out.empty = card(cards(), 'Local models');
      act(out.empty ? out.empty.act : 'runmode:local');
      await tick();
      out.afterEmpty = {calls: calls.slice(), open: SEL.open, mode: LLMP.mode, msg: LLMP.msg ? LLMP.msg.text : null, logGrew: S.log.length - keep.log};
      return out;
    } finally {
      close();
      Object.assign(WIZ, keep.wiz, {unfinishedId: null}); SEL.open = keep.open; SEL.addOpen = keep.addOpen; SEL.err = keep.err;
      window.selChooseBackend = keep.choose; window.selChooseFusion = keep.fusion; window.fzActivateBackend = keep.activate;
      BSW.readyIds = keep.ids; BSW.readyLoaded = keep.rl; BSW.localLoaded = keep.ll; SEL.local = keep.local; LLMP.local = keep.llmLocal;
      LIVE_CONFIG = keep.cfg; LLMP.mode = keep.mode; LLMP.msg = keep.msg; SWX.err = keep.swxErr; render();
    }
  })()`);
  const cloud = r["cloud"] ?? {};
  const after = r["afterCloud"] ?? {};
  check(
    "T48 (Д31): with no cloud provider the Cloud card says so, and a click opens Add provider — no switch is tried, nothing lands in the chat",
    cloud.act === "llm:needs:cloud" && cloud.blocked === true && /cloud provider/i.test(String(cloud.line))
      && show(after.calls) === "[]" && after.open === true && after.phase === "pick_kind" && after.mode === "cloud"
      && after.swxErr === null && after.logGrew === 0,
    show({ cloud, after }),
  );
  const fusion = r["fusion"] ?? {};
  const fafter = r["afterFusion"] ?? {};
  check(
    "T48 (Д31): Fusion with no cloud provider to plan says what it needs and opens Add provider too, with no switch tried",
    fusion.act === "llm:needs:fusion" && fusion.blocked === true && show(fafter.calls) === "[]" && fafter.open === true
      && fafter.phase === "pick_kind" && /Fusion needs a cloud provider/.test(String(fafter.msg)) && fafter.logGrew === 0,
    show({ fusion, fafter }),
  );
  const keyless = r["keyless"] ?? {};
  const kafter = r["afterKeyless"] ?? {};
  const empty = r["empty"] ?? {};
  const eafter = r["afterEmpty"] ?? {};
  check(
    "T48 (Д31): Cloud with providers but no key it can use opens that provider's key screen; Local models with nothing on disk opens the list to download from — no switch tried",
    keyless.act === "llm:needs:cloud" && /key/i.test(String(keyless.line)) && kafter.open === true && kafter.phase === "configure" && kafter.row === "openrouter"
      && empty.act === "llm:needs:local" && /Download a model/.test(String(empty.line)) && eafter.mode === "local" && eafter.open === false
      && /needs a model on/.test(String(eafter.msg)) && show(eafter.calls) === "[]" && eafter.logGrew === 0,
    show({ keyless, kafter, empty, eafter }),
  );
}

/* Д32: the fit lines are badges, the reasons in their tooltips and the row's description. */
async function fitBadges(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(() => {
    const keep = {local: LLMP.local, emb: LLMP.emb, ram: HOST_RAM_GB, served: LLMP.served};
    try {
      HOST_RAM_GB = 18; LLMP.served = null;
      const m = (id, rec, min, downloaded) => ({id, name: 'Smoke ' + id, size: '6.2 GB', sizeGb: 6.2, recommendedRamGb: rec, minRamGb: min, downloaded,
        description: 'A smoke model', context: '32K'});
      LLMP.local = [m('smoke-fits', 16, 10, false), m('smoke-tight', 24, 14, false), m('smoke-big', 36, 24, false), m('smoke-small-installed', 8, 6, true)];
      LLMP.emb = [{id: 'smoke-emb', size: '118 MB', downloaded: true}];
      const box = document.createElement('div'); box.className = 'llm-pane'; box.innerHTML = llmLocalHTML();
      const rows = {};
      box.querySelectorAll('[data-llm-row^="local-"]').forEach((row) => {
        const by = row.getAttribute('aria-describedby');
        const why = by ? row.querySelector('#' + by) : null;
        rows[row.dataset.llmRow] = {badges: [...row.querySelectorAll('.llm-badge')].map((b) => ({key: b.dataset.badge, word: b.textContent.trim(), title: b.title,
          chip: b.classList.contains('tk-chip'), tag: b.tagName})), lines: row.querySelectorAll('.body > .d').length,
          described: why ? {text: why.textContent, hidden: why.hidden} : null};
      });
      return {rows, note: !!box.querySelector('.llm-ram'),
        old: /runs comfortably|a tight fit —|of RAM at minimum|Downloaded first|best fit for this \w+’s/.test(box.textContent),
        fitLines: box.querySelectorAll('[class*="llm-fit-"], .llm-caution').length};
    } finally { LLMP.local = keep.local; LLMP.emb = keep.emb; HOST_RAM_GB = keep.ram; LLMP.served = keep.served; }
  })()`);
  type Row = { badges: Array<{ key: string; word: string; title: string; chip: boolean; tag: string }>; lines: number; described: { text: string; hidden: boolean } | null };
  const rows = (r["rows"] ?? {}) as Record<string, Row>;
  const one = (id: string) => rows[`local-text:${id}`]?.badges ?? [];
  const only = (id: string, word: string, re: RegExp) => one(id).length === 1 && one(id)[0]!.word === word && re.test(one(id)[0]!.title);
  check(
    "T48 (Д32): each local model wears one badge — Fits well, Tight fit, Too big or Installed — and its tooltip gives the figures",
    only("smoke-fits", "Fits well", /wants 16 GB.*has 18 GB/) && only("smoke-tight", "Tight fit", /runs in 14 GB but wants 24 GB.*Expect it to be slow/)
      && only("smoke-big", "Too big", /needs at least 24 GB/) && only("smoke-small-installed", "Installed", /Installed on .*\(6\.2 GB\).*Fits well.*small model/)
      && (rows["local-embedding:smoke-emb"]?.badges ?? []).map((b) => b.word).join() === "Installed",
    show(rows),
  );
  check(
    "T48 (Д32): the badges are the shared non-clickable chip, and the fit lines and the memory sentence over the list are gone",
    Object.values(rows).every((row) => row.badges.every((b) => b.chip && b.tag === "SPAN") && row.lines <= 1)
      && r["note"] === false && r["old"] === false && r["fitLines"] === 0,
    show({ note: r["note"], old: r["old"], fitLines: r["fitLines"], lines: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.lines])) }),
  );
  check(
    "T48 (Д32): a keyboard or a screen reader gets the badges' reasons too — each row is described by them",
    Object.values(rows).every((row) => !!row.described && row.described.hidden && row.described.text === row.badges.map((b) => b.title).join(" ")),
    show(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.described]))),
  );
}

/* Д33: no "Default 1500."; the chat template is Advanced's. */
async function reasoning(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(() => {
    const div = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d; };
    const tune = div(llmTuneHTML()), adv = div(llmAdvancedHTML('local')), ext = div(llmAdvancedHTML('external'));
    const has = (d) => !!d.querySelector('[data-act^="llm:tune:template:"]');
    return {tune: tune.textContent, adv: adv.textContent, inTune: has(tune), inAdv: has(adv), inExt: has(ext)};
  })()`);
  check(
    "T48 (Д33): Thinking budget no longer spells out its default, and the chat template sits in Advanced in shorter words",
    /Thinking budget/.test(String(r["tune"])) && !/Default 1500/.test(String(r["tune"])) && r["inTune"] === false
      && r["inAdv"] === true && r["inExt"] === true && /Chat template/.test(String(r["adv"])) && !/Model’s own chat template/.test(String(r["adv"])),
    show({ inTune: r["inTune"], inAdv: r["inAdv"], inExt: r["inExt"], tune: String(r["tune"]).slice(0, 200) }),
  );
}

/* Д34: no Ollama signpost; one button opens the provider setup on Ollama, its address filled in. */
async function ollama(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(() => {
    const keep = {cfg: LIVE_CONFIG, mode: LLMP.mode, open: SEL.open, addOpen: SEL.addOpen, err: SEL.err, wiz: Object.assign({}, WIZ)};
    const close = () => { WIZ.unfinishedId = null; act('close'); };
    const local = (extra) => Object.assign({}, keep.cfg || {}, {llm: {activeTextProvider: 'local-llama', providers: [{id: 'local-llama', kind: 'llama-server'}].concat(extra)}});
    try {
      LIVE_CONFIG = local([]);
      const box = document.createElement('div'); box.innerHTML = llmLocalHTML();
      const btn = box.querySelector('[data-act="llm:ollama"]');
      const out = {signpost: /Using Ollama\?/.test(box.textContent) || !!box.querySelector('.llm-ollama'), button: btn ? btn.textContent.trim() : null};
      close();
      act('llm:ollama');
      out.wizard = {open: SEL.open, phase: WIZ.phase, row: WIZ.row ? WIZ.row.id : null, baseUrl: WIZ.baseUrl};
      out.mode = LLMP.mode;
      LIVE_CONFIG = local([{id: 'ollama', kind: 'openai-compatible', baseUrl: 'http://localhost:11434'}]);
      const again = document.createElement('div'); again.innerHTML = llmLocalHTML();
      out.afterAdded = !!again.querySelector('[data-act="llm:ollama"]');
      return out;
    } finally {
      close();
      Object.assign(WIZ, keep.wiz, {unfinishedId: null}); SEL.open = keep.open; SEL.addOpen = keep.addOpen; SEL.err = keep.err;
      LIVE_CONFIG = keep.cfg; LLMP.mode = keep.mode; render();
    }
  })()`);
  const wiz = r["wizard"] ?? {};
  check(
    "T48 (Д34): no Ollama signpost under the lists; Add Ollama opens the provider setup on Ollama with its address filled in, and goes once Ollama is added",
    r["signpost"] === false && r["button"] === "Add Ollama" && wiz.open === true && wiz.phase === "configure" && wiz.row === "ollama"
      && wiz.baseUrl === "http://localhost:11434" && r["mode"] === "cloud" && r["afterAdded"] === false,
    show(r),
  );
}

/* Д35: Stop beside the model's state, the Engine card, no log screen here, the route under Details with Copy. */
async function advanced(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(() => {
    const keep = {cfg: LIVE_CONFIG, status: LLMP.status, phase: LLMP.daemonPhase, served: LLMP.served, mode: LLMP.mode, copy: window.copyText};
    try {
      const lm = (keep.cfg && keep.cfg.localModels) || {};
      LIVE_CONFIG = Object.assign({}, keep.cfg || {}, {llm: {activeTextProvider: 'local-llama', providers: [{id: 'local-llama', kind: 'llama-server'}]},
        localModels: Object.assign({}, lm, {mode: 'managed', managed: Object.assign({}, lm.managed || {}, {modelId: 'smoke-t48'})})});
      const running = {mode: 'managed', activeModel: 'smoke-t48', activeDownloaded: true, daemonRunning: true, daemonPid: 4848, health: 'ok',
        daemonUrl: 'http://127.0.0.1:19091', backendTag: 'b9999'};
      LLMP.status = running; LLMP.daemonPhase = null;
      LLMP.served = {chat: {answered: true, ids: ['smoke-t48']}, embedding: {answered: false, ids: []}};
      const div = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d; };
      const now = div(llmNowHTML()), adv = div(llmAdvancedHTML('local'));
      const stop = now.querySelector('[data-act="llm:daemon"]');
      LLMP.status = Object.assign({}, running, {daemonRunning: false, daemonPid: null, health: 'down'});
      LLMP.served = {chat: {answered: false, ids: []}, embedding: {answered: false, ids: []}};
      const start = div(llmNowHTML()).querySelector('[data-act="llm:daemon"]');
      LLMP.status = running;
      LLMP.served = {chat: {answered: true, ids: ['smoke-t48']}, embedding: {answered: false, ids: []}};
      const out = {stop: stop ? stop.textContent.trim() : null, start: start ? start.textContent.trim() : null,
        engine: [...adv.querySelectorAll('.llm-engine .llm-tune-t')].map((t) => t.textContent),
        engineActs: [...adv.querySelectorAll('.llm-engine [data-act]')].map((b) => b.dataset.act),
        daemonInAdv: !!adv.querySelector('[data-act="llm:daemon"]'), logsInAdv: !!adv.querySelector('[data-act="llm:logs"]'),
        routeInDetails: !!adv.querySelector('details.llm-details .llm-route'),
        routeOutside: [...adv.querySelectorAll('.llm-route')].filter((x) => !x.closest('details.llm-details')).length,
        copies: [...adv.querySelectorAll('.llm-route .llm-kv')].map((kv) => ((kv.querySelector('.llm-copybtn') || {}).dataset || {}).act || null)};
      // Each Copy takes the value as drawn.
      const copied = [];
      window.copyText = (text) => { copied.push(text); return Promise.resolve(true); };
      try { llmAct('copy:0'); llmAct('copy:3'); } finally { window.copyText = keep.copy; }
      out.copied = copied;
      out.facts = llmRouteFacts().map((f) => f.value);
      LLMP.mode = 'local';
      out.logsInPane = !!div(llmPanelHTML()).querySelector('[data-act="llm:logs"]');
      // The fault notice's way to the log.
      LLMP.status = Object.assign({}, running, {fault: 'smoke t48: out of memory'});
      out.faultAct = ((div(tpLlmFaultHTML()).querySelector('.llm-fault [data-act]') || {dataset: {}}).dataset || {}).act || null;
      LLMP.status = running;
      return out;
    } finally {
      LIVE_CONFIG = keep.cfg; LLMP.status = keep.status; LLMP.daemonPhase = keep.phase; LLMP.served = keep.served; LLMP.mode = keep.mode;
    }
  })()`);
  check(
    "T48 (Д35): the local model server's Stop (and Start) sits beside the model's state, not among Advanced's buttons",
    r["stop"] === "Stop" && r["start"] === "Start" && r["daemonInAdv"] === false,
    show({ stop: r["stop"], start: r["start"], daemonInAdv: r["daemonInAdv"] }),
  );
  check(
    "T48 (Д35): llama.cpp's update, auto-update and device are one Engine card (with the way to the server log); the route's internals fold under Details",
    show(r["engine"]) === show(["llama.cpp", "Engine choice", "Update automatically", "Device", "Server log"])
      && show(r["engineActs"]) === show(["llm:backend", "llm:engine", "llm:autoUpdate", "llm:device", "diag:llmlogs"])
      && r["routeInDetails"] === true && r["routeOutside"] === 0 && r["logsInAdv"] === false && r["logsInPane"] === false && r["faultAct"] === "diag:llmlogs",
    show({ engine: r["engine"], engineActs: r["engineActs"], routeInDetails: r["routeInDetails"], routeOutside: r["routeOutside"], logsInAdv: r["logsInAdv"], logsInPane: r["logsInPane"], faultAct: r["faultAct"] }),
  );
  const facts = (r["facts"] ?? []) as string[];
  check(
    "T48 (Д56): each value under Details has its Copy, and it copies the value as drawn",
    show(r["copies"]) === show(["llm:copy:0", "llm:copy:1", "llm:copy:2", "llm:copy:3"])
      && show(r["copied"]) === show([facts[0], facts[3]]) && facts[0] === "local-llama / smoke-t48" && /^running pid 4848/.test(String(facts[3])),
    show({ copies: r["copies"], copied: r["copied"], facts }),
  );
}

/* ATO-125, B3, R5: the "now" line names what the server says it runs, and offers Stop wherever the server is up. */
async function nowLine(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(() => {
    const keep = {cfg: LIVE_CONFIG, status: LLMP.status, phase: LLMP.daemonPhase, served: LLMP.served, local: LLMP.local, ram: HOST_RAM_GB};
    const div = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d; };
    const read = () => { const d = div(llmNowHTML()); const b = d.querySelector('[data-act^="llm:"]');
      return {text: d.textContent.replace(/\s+/g, ' ').trim(), bold: ((d.querySelector('b') || {}).textContent || null), act: b ? b.dataset.act : null, label: b ? b.textContent.trim() : null}; };
    const base = (patch) => Object.assign({}, keep.cfg || {}, {llm: {activeTextProvider: 'local-llama', providers: [{id: 'local-llama', kind: 'llama-server'},
      {id: 'openrouter', kind: 'openrouter', defaultChatModel: 'openrouter/auto'}]}, localModels: {mode: 'managed', managed: {modelId: 'smoke-t48'}}}, patch || {});
    const up = (ids) => ({chat: {answered: true, ids}, embedding: {answered: false, ids: []}});
    const down = {chat: {answered: false, ids: []}, embedding: {answered: false, ids: []}};
    try {
      LLMP.daemonPhase = null; HOST_RAM_GB = 18;
      const m = (id, active) => ({id, name: 'Smoke ' + id, size: '6.2 GB', sizeGb: 6.2, recommendedRamGb: 8, minRamGb: 6, downloaded: true, active, description: 'smoke', context: '32K'});
      LLMP.local = [m('smoke-t48', true), m('smoke-t48-other', false)];
      const out = {};
      // The server runs another model than the one picked.
      LIVE_CONFIG = base();
      LLMP.status = {mode: 'managed', activeModel: 'smoke-t48', activeDownloaded: true, daemonRunning: true, daemonPid: 4848, health: 'ok', daemonUrl: 'http://127.0.0.1:19091'};
      LLMP.served = up(['smoke-t48-other']);
      out.stale = read();
      out.staleRows = llmLocalRows().map((x) => x.model.id + ':' + x.primaryAction);
      // A Cloud route with the server still up.
      LIVE_CONFIG = base({llm: Object.assign({}, base().llm, {activeTextProvider: 'openrouter'})});
      LLMP.status = {mode: 'managed', activeModel: 'smoke-t48', activeDownloaded: true, daemonRunning: true, daemonPid: 4848, health: 'ok', daemonUrl: 'http://127.0.0.1:19091'};
      LLMP.served = up(['smoke-t48']);
      out.cloudUp = read();
      LLMP.status = {mode: 'managed', activeModel: 'smoke-t48', activeDownloaded: true, daemonRunning: false, daemonPid: null, health: 'down'};
      LLMP.served = down;
      out.cloudDown = read();
      // A Custom server route, the managed server left up behind it (models status says nothing of it there).
      LIVE_CONFIG = base({localModels: {mode: 'external', url: 'http://10.0.0.5:8080', managed: {modelId: 'smoke-t48'}}});
      LLMP.status = {mode: 'external', url: 'http://10.0.0.5:8080', daemonRunning: false};
      LLMP.served = up(['smoke-t48']);
      out.customUp = read();
      const cards = div(llmRunModeHTML());
      out.customCard = ((cards.querySelector('.llm-rm.on .llm-rm-d') || {}).textContent || null);
      // Fusion whose local seat is a Custom server: no managed server state, no Start.
      LIVE_CONFIG = base({llm: Object.assign({}, base().llm, {activeTextProvider: 'openrouter',
        runMode: {mode: 'fusion', fusion: {orchestratorProvider: 'openrouter', workerProvider: 'local-llama'}}}),
        localModels: {mode: 'external', url: 'http://10.0.0.5:8080', managed: {modelId: 'smoke-t48'}}});
      LLMP.served = down;
      out.fusionCustom = read();
      return out;
    } finally {
      LIVE_CONFIG = keep.cfg; LLMP.status = keep.status; LLMP.daemonPhase = keep.phase; LLMP.served = keep.served; LLMP.local = keep.local; HOST_RAM_GB = keep.ram;
    }
  })()`);
  const stale = r["stale"] ?? {};
  check(
    "T48 (ATO-125): the \"now\" line names the model the server says it runs, says which one is picked and offers the restart onto it; that row is not \"In use\"",
    /smoke-t48-other/i.test(String(stale.bold)) && /is picked/.test(String(stale.text)) && stale.act === "llm:usePicked"
      && show([...((r["staleRows"] ?? []) as string[])].filter((row) => row.startsWith("smoke-t48")).sort())
        === show(["smoke-t48-other:use", "smoke-t48:use"]),
    show({ stale, rows: r["staleRows"] }),
  );
  const cloudUp = r["cloudUp"] ?? {}, cloudDown = r["cloudDown"] ?? {}, customUp = r["customUp"] ?? {}, fusionCustom = r["fusionCustom"] ?? {};
  check(
    "T48 (Д35): a model server up under a Cloud or a Custom server route shows, with its Stop; none when it is down",
    cloudUp.act === "llm:daemon" && cloudUp.label === "Stop" && /still up/.test(String(cloudUp.text)) && cloudDown.act === null
      && customUp.act === "llm:daemon" && customUp.label === "Stop" && /custom server/.test(String(customUp.text))
      && r["customCard"] === "On your custom server",
    show({ cloudUp, cloudDown, customUp, customCard: r["customCard"] }),
  );
  check(
    "T48 (Fusion): local workers on a Custom server read as such, with no managed server state and no Start that could not work",
    /local workers on a custom server/.test(String(fusionCustom.text)) && fusionCustom.act === null && !/Stopped|Ready|Running/.test(String(fusionCustom.text)),
    show(fusionCustom),
  );
}

/* Д35/Д58: Models' way to the LLM log opens it in Settings › Diagnostics, for real. */
async function diagnosticsLog(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    const keep = {settings: S.settings, pane: S.settingsPane, view: LLMP.view, confirm: LLMP.confirm, open: SEL.open, wizPhase: WIZ.phase, hf: LLMHF.open,
      draft: LLMP.externalDraft, steer: LLMP.steerUrl, mode: LLMP.mode, logOpen: typeof DIAG !== 'undefined' ? DIAG.logOpen : null};
    try {
      // The L key, in Models with nothing open over it.
      S.settings = 1; S.settingsPane = 'llm';
      LLMP.view = 'panel'; LLMP.confirm = null; SEL.open = false; WIZ.phase = null; LLMHF.open = false; LLMP.externalDraft = null; LLMP.steerUrl = null; LLMP.mode = 'local';
      if (typeof DIAG !== 'undefined') DIAG.logOpen = false;
      render();
      const handled = llmKey({key: 'L', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, target: {id: ''}, preventDefault() {}}, 'L', false);
      await new Promise((res) => setTimeout(res, 150));
      return {handled, pane: S.settingsPane, settings: !!S.settings, logOpen: typeof DIAG !== 'undefined' ? !!DIAG.logOpen : null,
        log: !!document.querySelector('#settings .set-diaglog')};
    } finally {
      if (typeof DIAG !== 'undefined') { DIAG.logOpen = !!keep.logOpen; if (!keep.logOpen && typeof diagLogStop === 'function') diagLogStop(); }
      LLMP.view = keep.view; LLMP.confirm = keep.confirm; SEL.open = keep.open; WIZ.phase = keep.wizPhase; LLMHF.open = keep.hf;
      LLMP.externalDraft = keep.draft; LLMP.steerUrl = keep.steer; LLMP.mode = keep.mode;
      S.settings = keep.settings; S.settingsPane = keep.pane; render();
    }
  })()`);
  check(
    "T48 (Д35): Models' `L` opens the model server's log in Settings › Diagnostics (the same diag:llmlogs as Engine's Server log and the fault notice)",
    r["handled"] === true && r["settings"] === true && r["pane"] === "diagnostics" && r["logOpen"] === true && r["log"] === true,
    show(r),
  );
}

/* ATO-119 and ATO-125, the window's half: a Remove on every model on disk, what each one asks to stop, and Use as the composer's pick. */
async function removeAndUseInWindow(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  const calls: string[] = [];
  let staleAsked = 0;
  let failEmbedding = false;
  let busyTurns = 0;
  const ok = { ok: true, stdout: "", stderr: "" };
  const stopWord = (opts: unknown) => (opts && typeof opts === "object" && (opts as { stop?: unknown }).stop === true ? ":stop" : "");
  const stand: Record<string, (_e: unknown, payload: unknown, opts?: unknown) => unknown> = {
    "cli:modelsStop": () => { calls.push("stop"); return ok; },
    "cli:modelsStart": () => { calls.push("start"); return ok; },
    "cli:modelsUse": (_e, id) => { calls.push(`use:${String(id)}`); return ok; },
    "cli:modelsUseEmbedding": (_e, id) => { calls.push(`useEmbedding:${String(id)}`); return ok; },
    "cli:modelsRemove": (_e, id, opts) => {
      if (id === "smoke-t48-probe") return { ok: false, smokeT48: true };
      calls.push(`remove:${String(id)}${stopWord(opts)}`);
      // A server still on this model though the window thinks it is not: main refuses, once, unless it may stop it.
      if (id === "smoke-t48-stale" && staleAsked++ === 0 && !stopWord(opts)) return { ok: false, running: true, stdout: "", stderr: "", error: "a local model server is running this model — stop it first" };
      return ok;
    },
    "cli:modelsRemoveEmbedding": (_e, id, opts) => {
      calls.push(`removeEmbedding:${String(id)}${stopWord(opts)}`);
      return failEmbedding ? { ok: false, stdout: "", stderr: "", error: "smoke t48: the folder could not be deleted" } : ok;
    },
    "cli:modelsStatus": () => ({ ok: false, error: "smoke t48: not read" }),
    "cli:modelsServed": () => ({ ok: true, chat: { answered: false, ids: [] }, embedding: { answered: false, ids: [] } }),
    "agent:health": () => ({ ok: true, data: { busyTurns } }),
  };
  let staged = false;
  try {
    for (const w of wins) for (const [ch, fn] of Object.entries(stand)) w.webContents.ipc.handle(ch, fn);
    const probe = await js<{ smokeT48?: boolean } | null>("BR.modelsRemove('smoke-t48-probe')").catch((e: unknown) => String(e));
    if (typeof probe !== "object" || probe?.smokeT48 !== true) {
      check("T48 (ATO-119): stand-ins on the window's IPC answer the removal's calls first", false, `${show(probe)}; the removal was not driven`);
      return;
    }
    staged = await js<boolean>(String.raw`(() => {
      window.__t48Keep = {cfg: LIVE_CONFIG, local: LLMP.local, emb: LLMP.emb, embDaemon: LLMP.embDaemon, status: LLMP.status, phase: LLMP.daemonPhase,
        confirm: LLMP.confirm, msg: LLMP.msg, err: LLMP.statusErr, mode: LLMP.mode, cursor: Object.assign({}, LLMP.cursor), ram: HOST_RAM_GB,
        down: LLMP.downSince, busy: S.busy, served: LLMP.served, refresh: window.llmRefresh, live: window.refreshLiveConfig, snap: window.bswSnapshot,
        pick: SWXBR.selectLocalModel};
      window.__t48Snaps = 0;
      window.__t48Stage = () => {
        window.llmRefresh = () => Promise.resolve();
        window.refreshLiveConfig = () => Promise.resolve();
        window.bswSnapshot = () => { window.__t48Snaps++; return Promise.resolve(); };
        const lm = (window.__t48Keep.cfg && window.__t48Keep.cfg.localModels) || {};
        LIVE_CONFIG = Object.assign({}, window.__t48Keep.cfg || {}, {
          llm: {activeTextProvider: 'local-llama', activeEmbeddingProvider: 'local-llama', providers: [{id: 'local-llama', kind: 'llama-server'}]},
          localModels: Object.assign({}, lm, {mode: 'managed', managed: Object.assign({}, lm.managed || {}, {modelId: 'smoke-t48'}),
            embeddings: Object.assign({}, lm.embeddings || {}, {enabled: true, modelId: 'smoke-t48-emb'})})});
        HOST_RAM_GB = 18;
        const m = (id, active) => ({id, name: 'Smoke ' + id, size: '6.2 GB', sizeGb: 6.2, recommendedRamGb: 8, minRamGb: 6, downloaded: true, active,
          description: 'A smoke model', context: '32K'});
        LLMP.local = [m('smoke-t48', true), m('smoke-t48-other', false), m('smoke-t48-stale', false)];
        LLMP.emb = [{id: 'smoke-t48-emb', size: '118 MB', downloaded: true, active: true}];
        LLMP.embDaemon = {running: true, pid: 4849, port: 19092, health: 'ok'};
        LLMP.status = {mode: 'managed', activeModel: 'smoke-t48', activeDownloaded: true, daemonRunning: true, daemonPid: 4848, health: 'ok', daemonUrl: 'http://127.0.0.1:19091'};
        LLMP.served = null;
        LLMP.daemonPhase = null; LLMP.confirm = null; LLMP.msg = null; LLMP.mode = 'local'; LLMP.downSince = null; S.busy = false;
      };
      window.__t48Open = (rowId) => {
        llmAct('removeAt:' + llmRows('local').findIndex((x) => x.id === rowId));
        return window.__t48Modal();
      };
      window.__t48Modal = () => {
        const d = document.createElement('div'); d.innerHTML = llmModalHTML();
        const cancel = d.querySelector('[data-act="llm:cancel"]');
        return {kind: LLMP.confirm ? LLMP.confirm.kind : null, text: d.textContent.replace(/\s+/g, ' ').trim(),
          yes: ((d.querySelector('[data-act="llm:confirm"]') || {}).textContent || null), cancelDisabled: !!(cancel && cancel.disabled)};
      };
      window.__t48Confirm = async () => {
        await llmRemoveLocalConfirm();
        return {confirm: LLMP.confirm ? {error: LLMP.confirm.error, mustStop: !!LLMP.confirm.mustStop, submitting: !!LLMP.confirm.submitting} : null,
          msg: LLMP.msg ? LLMP.msg.text : null, snaps: window.__t48Snaps};
      };
      return true;
    })()`);
    await js<unknown>("window.__t48Stage()");
    const rows = await js<Record<string, any>>(String.raw`(() => {
      const box = document.createElement('div'); box.className = 'llm-pane'; box.innerHTML = llmLocalHTML();
      const row = (id) => box.querySelector('[data-llm-row="' + id + '"]');
      const read = (r) => r ? {effect: ((r.querySelector('.llm-effect') || {}).textContent || null), remove: ((r.querySelector('.llm-rowact') || {}).textContent || null)} : null;
      return {inUse: read(row('local-text:smoke-t48')), emb: read(row('local-embedding:smoke-t48-emb'))};
    })()`);
    check(
      "T48 (ATO-119): the model in use and the embedding models have a Remove like every other model on disk",
      rows["inUse"]?.effect === "In use" && rows["inUse"]?.remove === "Remove" && rows["emb"]?.remove === "Remove",
      show(rows),
    );

    // 1 — the chat model in use: one call, with main's go-ahead to stop the server before it deletes.
    calls.length = 0;
    const inUse = await js<Record<string, any>>("window.__t48Open('local-text:smoke-t48')");
    const inUseDone = await js<Record<string, any>>("window.__t48Confirm()");
    const inUseCalls = calls.slice();
    // 2 — a model no server has loaded: deleted, nothing stopped.
    await js<unknown>("window.__t48Stage()");
    calls.length = 0;
    const other = await js<Record<string, any>>("window.__t48Open('local-text:smoke-t48-other')");
    const otherDone = await js<Record<string, any>>("window.__t48Confirm()");
    const otherCalls = calls.slice();
    check(
      "T48 (ATO-119): removing the model in use says the server (and memory search's) stops first and gives main the go-ahead to stop it; any other model is just deleted; the composer's list is re-read after",
      inUse["kind"] === "removeLocal" && inUse["yes"] === "Stop and delete" && /stops the local model server first, and the memory-search server with it/.test(String(inUse["text"]))
        && show(inUseCalls) === show(["remove:smoke-t48:stop"]) && inUseDone["confirm"] === null && /^Deleted /.test(String(inUseDone["msg"])) && inUseDone["snaps"] >= 1
        && other["yes"] === "Delete" && show(otherCalls) === show(["remove:smoke-t48-other"]) && otherDone["confirm"] === null,
      show({ inUse, inUseCalls, inUseDone, other, otherCalls }),
    );

    // 3 — the embedding model memory search uses: embeddings off, then main stops that server alone and deletes; the chat server is not touched.
    await js<unknown>("window.__t48Stage()");
    calls.length = 0;
    const emb = await js<Record<string, any>>("window.__t48Open('local-embedding:smoke-t48-emb')");
    const embDone = await js<Record<string, any>>("window.__t48Confirm()");
    const embCalls = calls.slice();
    // 3b — the same, refused: local embeddings go back on.
    await js<unknown>("window.__t48Stage()");
    calls.length = 0;
    failEmbedding = true;
    await js<unknown>("window.__t48Open('local-embedding:smoke-t48-emb')");
    const embFailed = await js<Record<string, any>>("window.__t48Confirm()");
    failEmbedding = false;
    const embFailedCalls = calls.slice();
    check(
      "T48 (ATO-119): an embedding model in use is turned off, then deleted with the go-ahead to stop its server alone — no chat-server stop or restart — and turned back on when the delete fails",
      emb["kind"] === "removeEmbedding" && emb["yes"] === "Turn off and delete" && /chat model is left running/.test(String(emb["text"]))
        && show(embCalls) === show(["useEmbedding:--disable", "removeEmbedding:smoke-t48-emb:stop"]) && embDone["confirm"] === null
        && show(embFailedCalls) === show(["useEmbedding:--disable", "removeEmbedding:smoke-t48-emb:stop", "useEmbedding:smoke-t48-emb"])
        && /Local embeddings are on again/.test(String(embFailed["confirm"]?.error)),
      show({ emb, embCalls, embDone, embFailed, embFailedCalls }),
    );

    // 4 — a turn running, in this window or anywhere the agent answers (Telegram, a task): nothing is stopped or deleted.
    await js<unknown>("window.__t48Stage()");
    calls.length = 0;
    await js<unknown>("window.__t48Open('local-text:smoke-t48')");
    const heldHere = await js<Record<string, any>>("(async () => { S.busy = true; try { return await window.__t48Confirm(); } finally { S.busy = false; } })()");
    busyTurns = 1;
    const heldElsewhere = await js<Record<string, any>>("window.__t48Confirm()");
    const stopElsewhere = await js<Record<string, any>>("(async () => { LLMP.confirm = null; await llmDaemon('stop'); return {msg: LLMP.msg ? LLMP.msg.text : null}; })()");
    busyTurns = 0;
    const heldCalls = calls.slice();
    check(
      "T48 (ATO-119): with a turn running — this window's or one the agent answers elsewhere — neither Stop and delete nor Stop stops the server",
      show(heldCalls) === "[]" && /Not while a turn is running/.test(String(heldHere["confirm"]?.error))
        && /answering elsewhere/.test(String(heldElsewhere["confirm"]?.error)) && /answering elsewhere/.test(String(stopElsewhere["msg"])),
      show({ heldHere, heldElsewhere, stopElsewhere, heldCalls }),
    );

    // 5 — main refuses: a server has the model loaded after all. The confirm becomes Stop and delete, and that works.
    await js<unknown>("window.__t48Stage()");
    calls.length = 0;
    staleAsked = 0;
    await js<unknown>("window.__t48Open('local-text:smoke-t48-stale')");
    const refused = await js<Record<string, any>>("window.__t48Confirm()");
    const again = await js<Record<string, any>>("window.__t48Modal()");
    const retried = await js<Record<string, any>>("window.__t48Confirm()");
    const staleCalls = calls.slice();
    check(
      "T48 (ATO-119): when main finds a server still has the model loaded it deletes nothing, and the confirm becomes Stop and delete",
      refused["confirm"]?.mustStop === true && /stop it first/.test(String(refused["confirm"]?.error)) && again["yes"] === "Stop and delete"
        && show(staleCalls) === show(["remove:smoke-t48-stale", "remove:smoke-t48-stale:stop"]) && retried["confirm"] === null,
      show({ refused, again, retried, staleCalls }),
    );

    // 6 — a confirm that is working is not let go of: Cancel is disabled and n / Esc / Cancel wait.
    await js<unknown>("window.__t48Stage()");
    const busy = await js<Record<string, any>>(String.raw`(() => {
      window.__t48Open('local-text:smoke-t48-other');
      LLMP.confirm.submitting = true;
      const modal = window.__t48Modal();
      llmAct('cancel');
      const kept = !!LLMP.confirm;
      LLMP.confirm.submitting = false;
      llmAct('cancel');
      return {cancelDisabled: modal.cancelDisabled, kept, after: LLMP.confirm};
    })()`);
    check(
      "T48 (ATO-119): Cancel, n and Esc wait while a removal works, and work again once it has finished",
      busy["cancelDisabled"] === true && busy["kept"] === true && busy["after"] === null,
      show(busy),
    );

    // 7 — ATO-125: Use is the composer's own pick, not a config write that leaves the server on the old model.
    await js<unknown>("window.__t48Stage()");
    calls.length = 0;
    const use = await js<Record<string, any>>(String.raw`(async () => {
      const picks = [];
      SWXBR.selectLocalModel = (id) => { picks.push(id); return Promise.resolve({ok: true, providerId: 'local-llama', modelId: id, daemon: 'restarted', restart: false}); };
      try {
        LLMP.served = {chat: {answered: true, ids: ['smoke-t48']}, embedding: {answered: false, ids: []}};
        const row = llmLocalRows().find((x) => x.model.id === 'smoke-t48-other');
        await llmPrimary(row);
        const first = {picks: picks.slice(), msg: LLMP.msg ? LLMP.msg.text : null, action: row.primaryAction};
        // The server still on another model than the one picked: stopped, then the pick starts it on the picked one.
        LLMP.served = {chat: {answered: true, ids: ['smoke-t48-other']}, embedding: {answered: false, ids: []}};
        picks.length = 0;
        llmAct('usePicked');
        for (let i = 0; i < 40 && !picks.length; i++) await new Promise((res) => setTimeout(res, 25));
        return {first, restart: {picks: picks.slice()}};
      } finally { SWXBR.selectLocalModel = window.__t48Keep.pick; }
    })()`);
    const useCalls = calls.slice();
    const first = use["first"] ?? {};
    check(
      "T48 (ATO-125): Settings' Use is the composer's pick (the switch that restarts the server on the model), never a bare `models use`; a server still on another model is stopped and started on the one picked",
      first.action === "use" && show(first.picks) === show(["smoke-t48-other"]) && /answers chats now/.test(String(first.msg))
        && show(use["restart"]?.picks) === show(["smoke-t48"]) && show(useCalls) === show(["stop"]) && !useCalls.some((c) => c.startsWith("use:")),
      show({ use, useCalls }),
    );
  } finally {
    if (staged) {
      await js<unknown>(String.raw`(() => { const k = window.__t48Keep || {};
        window.llmRefresh = k.refresh; window.refreshLiveConfig = k.live; window.bswSnapshot = k.snap; if (k.pick) SWXBR.selectLocalModel = k.pick;
        LIVE_CONFIG = k.cfg; LLMP.local = k.local; LLMP.emb = k.emb; LLMP.embDaemon = k.embDaemon; LLMP.status = k.status; LLMP.daemonPhase = k.phase || null;
        LLMP.confirm = k.confirm || null; LLMP.msg = k.msg || null; LLMP.statusErr = k.err || null; LLMP.mode = k.mode || 'local'; LLMP.served = k.served || null;
        if (k.cursor) Object.assign(LLMP.cursor, k.cursor); HOST_RAM_GB = k.ram || 0; LLMP.downSince = k.down || null; S.busy = !!k.busy;
        ['__t48Keep', '__t48Stage', '__t48Open', '__t48Modal', '__t48Confirm', '__t48Snaps'].forEach((n) => { delete window[n]; });
        render(); })()`).catch(() => undefined);
    }
    for (const w of wins) if (!w.isDestroyed()) for (const ch of Object.keys(stand)) w.webContents.ipc.removeHandler(ch);
  }
}

/* ATO-119, main's half: what a server has loaded, the rule that keeps its files, and the one directory an embedding removal deletes. */
async function removeInMain(check: Check): Promise<void> {
  const fake = join(tmpdir(), "aa-t48-data");
  const ids = {
    inside: modelIdFromPath(join(fake, "models", "qwen-3.5-9b", "Qwen3.5-9B-Q4_K_M.gguf"), fake),
    outside: modelIdFromPath(join(tmpdir(), "elsewhere", "x.gguf"), fake),
    loose: modelIdFromPath(join(fake, "models", "x.gguf"), fake),
  };
  check(
    "T48 (ATO-119): a server's model file names a catalogue id only from under <data dir>/models/<id>/",
    ids.inside === "qwen-3.5-9b" && ids.outside === null && ids.loose === null,
    show(ids),
  );
  const up = (activeId: string | null, served: string[] | null): ServerFacts => ({ running: true, activeId, served });
  const b = {
    // A Custom server route with the managed server left up: it answers on its port, on the model the file still names.
    leftOver: removeBlocker("a", [up("a", ["a"])]),
    unknownActive: removeBlocker("a", [up("a", null)]),
    unknownOther: removeBlocker("b", [up("a", null)]),
    servesOther: removeBlocker("a", [up("a", ["b"])]),
    servesThis: removeBlocker("b", [up("a", ["b"])]),
    stopped: removeBlocker("a", [{ running: false, activeId: "a", served: ["a"] }]),
    embedding: removeBlocker("e", [{ running: false, activeId: null, served: null }, up("e", ["e"])]),
  };
  check(
    "T48 (ATO-119): a model a running server has loaded is never deleted — by what it says it runs, else by the model its config gives it",
    !!b.leftOver && !!b.unknownActive && b.unknownOther === null && b.servesOther === null && !!b.servesThis && b.stopped === null && !!b.embedding,
    show(b),
  );
  const dataDir = mkdtempSync(join(tmpdir(), "aa-t48-"));
  const real = join(dataDir, "real");
  const link = join(dataDir, "link");
  mkdirSync(join(real, "models", "smoke-t48"), { recursive: true });
  writeFileSync(join(real, "models", "smoke-t48", "smoke.gguf"), "smoke");
  let linked = true;
  try { symlinkSync(real, link, "dir"); } catch { linked = false; }
  const server = createServer((req, res) => {
    const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/alias/props") return json({ model_alias: "smoke-t48-alias", default_generation_settings: { n_ctx: 4096 } });
    if (req.url === "/path/props") return json({ model_path: join(real, "models", "smoke-t48", "smoke.gguf") });
    if (req.url === "/odd/props") return json({ model_path: "/somewhere/else/x.gguf" });
    if (req.url === "/key/props") { res.writeHead(401); res.end(); return; }
    res.writeHead(404);
    res.end();
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const asked = {
      alias: await probeServer(`${base}/alias`, dataDir),
      // The server was started on the real folder, the data dir is spelled through a link to it.
      path: await probeServer(`${base}/path`, linked ? link : real),
      odd: await probeServer(`${base}/odd`, real),
      key: await probeServer(`${base}/key`, real),
      nobody: await probeServer("http://127.0.0.1:1", real, 1000),
    };
    check(
      "T48 (ATO-119): what a server runs is read off its /props — the alias it was started with, or its GGUF path through the file system's own spelling — and any answer at all means a server is there",
      show(asked.alias) === show({ answered: true, ids: ["smoke-t48-alias"] }) && show(asked.path) === show({ answered: true, ids: ["smoke-t48"] })
        && show(asked.odd) === show({ answered: true, ids: [] }) && show(asked.key) === show({ answered: true, ids: [] })
        && show(asked.nobody) === show({ answered: false, ids: [] }),
      show({ linked, asked }),
    );
    mkdirSync(join(dataDir, "models", "smoke-t48-emb"), { recursive: true });
    writeFileSync(join(dataDir, "models", "smoke-t48-emb", "e.gguf"), "smoke");
    mkdirSync(join(dataDir, "models", "smoke-t48-keep"), { recursive: true });
    writeFileSync(join(dataDir, "models", "smoke-t48-keep", "k.gguf"), "smoke");
    const gone = await removeModelDir(dataDir, "smoke-t48-emb");
    const parent = await removeModelDir(dataDir, "..");
    const rel = await removeModelDir("relative-dir", "smoke-t48-keep");
    check(
      "T48 (ATO-119): an embedding model's removal deletes its folder and nothing else; no parent folder, no relative data dir",
      gone.ok && !existsSync(join(dataDir, "models", "smoke-t48-emb")) && existsSync(join(dataDir, "models", "smoke-t48-keep", "k.gguf"))
        && !parent.ok && !rel.ok && existsSync(join(dataDir, "models")),
      show({ gone, parent, rel }),
    );
    // A background download the agent's own worker drives (the TUI's `models pull --background`).
    mkdirSync(join(dataDir, "downloads"), { recursive: true });
    const job = (status: string, pid: number) => writeFileSync(join(dataDir, "downloads", "chat-smoke-t48.json"), JSON.stringify({ status, pid }));
    job("running", process.pid);
    const live = downloadJobRunning(dataDir, "chat", "smoke-t48");
    job("done", process.pid);
    const done = downloadJobRunning(dataDir, "chat", "smoke-t48");
    job("running", 4_194_301);
    const dead = downloadJobRunning(dataDir, "chat", "smoke-t48");
    check(
      "T48 (ATO-119): a model the agent's background worker is still downloading counts as coming down",
      live === true && done === false && dead === false && downloadJobRunning(dataDir, "embedding", "smoke-t48") === false,
      show({ live, done, dead }),
    );
  } finally {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
  const notEmb = await modelsRemoveSafe("embedding", "smoke-t48-not-an-embedding-model");
  const dots = await modelsRemoveSafe("embedding", "..");
  check(
    "T48 (ATO-119): main deletes an embedding model only by an id the catalogue lists, never by a path",
    !notEmb.ok && /not an embedding model/.test(notEmb.error ?? "") && !dots.ok && /not a model id/.test(dots.error ?? ""),
    show({ notEmb: notEmb.error, dots: dots.error }),
  );
}
