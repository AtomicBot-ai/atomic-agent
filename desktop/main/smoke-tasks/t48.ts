import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserWindow } from "electron";

import { modelIdFromPath, modelsRemoveSafe, removeBlocker, removeModelDir, servedModelId, type ServerFacts } from "../agent-cli.js";

/**
 * Release-fix checks for Settings › Models (Danya's items Д30–Д35 in
 * ~/desktop-release-fixes-2026-10-01.md, and ATO-119's "no Remove for the
 * model in use nor for the embedding models"). Run alone with
 * `--smoke --smoke-task=48`.
 *
 *   Д30 — Two look-alike rows at the top, "Set up: Local / Cloud / Custom
 *         server" over "Chats run on: Local models / Cloud / Fusion". Where
 *         chats run is the pane's first block now, three cards with a line
 *         each; the setup tabs come under it, in words that are not that
 *         choice's words (Local models · Cloud providers · Custom server).
 *   Д31 — Cloud with no cloud provider ran the switch, and its refusal landed
 *         in the chat behind Settings. It opens Add provider instead, and
 *         says on the card what it needs; Fusion the same.
 *   Д32 — "runs comfortably — wants 16 GB…" lines under the rows: badges now
 *         (Fits well / Tight fit / Too big / Installed), the reasons in the
 *         tooltip; no sentence over the list about this machine's memory.
 *   Д33 — "Default 1500." is gone from Thinking budget; the chat template is
 *         Advanced's, in shorter words.
 *   Д34 — The Ollama signpost read as an ad: one "Add Ollama" button that
 *         opens the provider setup with Ollama's address filled in.
 *   Д35 — Advanced was a pile of look-alike buttons: Stop sits beside the
 *         model's state, llama.cpp's update / auto-update / device are one
 *         Engine card, the LLM log is Settings › Diagnostics' (the card's
 *         Server log row and `L` open it there), the route's internals fold
 *         under Details, each value with its Copy (Д56).
 *   ATO-119 — Remove on every model on disk, the one in use and the
 *         embedding models included; never under a server that has it
 *         loaded (the window stops it first, main checks again).
 *
 * The window's checks render the pane's own functions against a staged copy
 * of the config and the catalogue (the file is not touched) and put every
 * piece of state back. The Remove flow runs against stand-ins on the
 * window's own IPC (a webContents handler is asked before ipcMain's; a probe
 * proves it first), so no server stops and no file is deleted. Main's half
 * deletes only inside a throwaway directory.
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
  await removeInWindow(js, check);
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

/* Д31: Cloud (and Fusion) chosen before what it needs is there opens that, and tries no switch. */
async function routeNeeds(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(async () => {
    const keep = {cfg: LIVE_CONFIG, mode: LLMP.mode, msg: LLMP.msg, open: SEL.open, addOpen: SEL.addOpen, err: SEL.err, wiz: Object.assign({}, WIZ),
      swxErr: SWX.err, log: S.log.length, ids: BSW.readyIds, rl: BSW.readyLoaded, ll: BSW.localLoaded, local: SEL.local,
      choose: window.selChooseBackend, fusion: window.selChooseFusion, activate: window.fzActivateBackend};
    const calls = [];
    const close = () => { WIZ.unfinishedId = null; act('close'); };
    try {
      // Only the built-in local entry: no cloud provider at all, one local model on disk.
      LIVE_CONFIG = Object.assign({}, LIVE_CONFIG || {}, {llm: {activeTextProvider: 'local-llama', activeEmbeddingProvider: 'local-llama',
        providers: [{id: 'local-llama', kind: 'llama-server'}]}});
      BSW.readyIds = []; BSW.readyLoaded = true; BSW.localLoaded = true; SEL.local = [{id: 'smoke-t48', downloaded: true}];
      SWX.err = null;
      // Whatever a click would switch is written down here and switched nowhere.
      window.selChooseBackend = (id) => { calls.push('selChooseBackend:' + id); return Promise.resolve({ok: false}); };
      window.selChooseFusion = () => { calls.push('selChooseFusion'); return Promise.resolve({ok: false}); };
      window.fzActivateBackend = (id) => { calls.push('fzActivateBackend:' + id); return Promise.resolve({ok: false}); };
      const box = document.createElement('div'); box.innerHTML = llmRunModeHTML();
      const card = (word) => { const b = [...box.querySelectorAll('.llm-rm')].find((x) => (x.querySelector('.llm-rm-t') || {}).textContent === word);
        return b ? {act: b.dataset.act, blocked: b.classList.contains('blocked'), line: (b.querySelector('.llm-rm-d') || {}).textContent, title: b.title} : null; };
      const out = {cloud: card('Cloud'), fusion: card('Fusion')};
      close();
      act(out.cloud ? out.cloud.act : 'runmode:cloud');
      await new Promise((res) => setTimeout(res, 50));
      out.afterCloud = {calls: calls.slice(), open: SEL.open, phase: WIZ.phase, mode: LLMP.mode, swxErr: SWX.err, logGrew: S.log.length - keep.log};
      close();
      act(out.fusion ? out.fusion.act : 'runmode:fusion');
      await new Promise((res) => setTimeout(res, 50));
      out.afterFusion = {calls: calls.slice(), open: SEL.open, phase: WIZ.phase, mode: LLMP.mode, msg: LLMP.msg ? LLMP.msg.text : null, logGrew: S.log.length - keep.log};
      return out;
    } finally {
      close();
      Object.assign(WIZ, keep.wiz, {unfinishedId: null}); SEL.open = keep.open; SEL.addOpen = keep.addOpen; SEL.err = keep.err;
      window.selChooseBackend = keep.choose; window.selChooseFusion = keep.fusion; window.fzActivateBackend = keep.activate;
      BSW.readyIds = keep.ids; BSW.readyLoaded = keep.rl; BSW.localLoaded = keep.ll; SEL.local = keep.local;
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
}

/* Д32: the fit lines are badges, the reasons in their tooltips. */
async function fitBadges(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(() => {
    const keep = {local: LLMP.local, emb: LLMP.emb, ram: HOST_RAM_GB};
    try {
      HOST_RAM_GB = 18;
      const m = (id, rec, min, downloaded) => ({id, name: 'Smoke ' + id, size: '6.2 GB', sizeGb: 6.2, recommendedRamGb: rec, minRamGb: min, downloaded,
        description: 'A smoke model', context: '32K'});
      LLMP.local = [m('smoke-fits', 16, 10, false), m('smoke-tight', 24, 14, false), m('smoke-big', 36, 24, false), m('smoke-small-installed', 8, 6, true)];
      LLMP.emb = [{id: 'smoke-emb', size: '118 MB', downloaded: true}];
      const box = document.createElement('div'); box.className = 'llm-pane'; box.innerHTML = llmLocalHTML();
      const rows = {};
      box.querySelectorAll('[data-llm-row^="local-"]').forEach((row) => {
        rows[row.dataset.llmRow] = {badges: [...row.querySelectorAll('.llm-badge')].map((b) => ({key: b.dataset.badge, word: b.textContent.trim(), title: b.title,
          chip: b.classList.contains('tk-chip'), tag: b.tagName})), lines: row.querySelectorAll('.body > .d').length};
      });
      return {rows, note: !!box.querySelector('.llm-ram'),
        old: /runs comfortably|a tight fit —|of RAM at minimum|Downloaded first|best fit for this \w+’s/.test(box.textContent),
        fitLines: box.querySelectorAll('[class*="llm-fit-"], .llm-caution').length};
    } finally { LLMP.local = keep.local; LLMP.emb = keep.emb; HOST_RAM_GB = keep.ram; }
  })()`);
  const rows = (r["rows"] ?? {}) as Record<string, { badges: Array<{ key: string; word: string; title: string; chip: boolean; tag: string }>; lines: number }>;
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

/* Д35: Stop beside the model's state, the Engine card, no LLM logs here, the route under Details, `L` to Diagnostics. */
async function advanced(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, any>>(String.raw`(() => {
    const keep = {cfg: LIVE_CONFIG, status: LLMP.status, phase: LLMP.daemonPhase, act: window.act, view: LLMP.view, confirm: LLMP.confirm, open: SEL.open,
      wizPhase: WIZ.phase, hf: LLMHF.open, draft: LLMP.externalDraft, steer: LLMP.steerUrl, mode: LLMP.mode};
    const acts = [];
    try {
      const lm = (keep.cfg && keep.cfg.localModels) || {};
      LIVE_CONFIG = Object.assign({}, keep.cfg || {}, {llm: {activeTextProvider: 'local-llama', providers: [{id: 'local-llama', kind: 'llama-server'}]},
        localModels: Object.assign({}, lm, {mode: 'managed', managed: Object.assign({}, lm.managed || {}, {modelId: 'smoke-t48'})})});
      LLMP.status = {mode: 'managed', activeModel: 'smoke-t48', activeDownloaded: true, daemonRunning: true, daemonPid: 4848, health: 'ok',
        daemonUrl: 'http://127.0.0.1:19091', backendTag: 'b9999'};
      LLMP.daemonPhase = null;
      const div = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d; };
      const now = div(llmNowHTML()), adv = div(llmAdvancedHTML('local'));
      const stop = now.querySelector('[data-act="llm:daemon"]');
      const running = LLMP.status;
      LLMP.status = Object.assign({}, running, {daemonRunning: false, daemonPid: null, health: 'down'});
      const start = div(llmNowHTML()).querySelector('[data-act="llm:daemon"]');
      LLMP.status = running;
      const out = {stop: stop ? stop.textContent.trim() : null, start: start ? start.textContent.trim() : null,
        engine: [...adv.querySelectorAll('.llm-engine .llm-tune-t')].map((t) => t.textContent),
        engineActs: [...adv.querySelectorAll('.llm-engine [data-act]')].map((b) => b.dataset.act),
        daemonInAdv: !!adv.querySelector('[data-act="llm:daemon"]'), logsInAdv: !!adv.querySelector('[data-act="llm:logs"]'),
        routeInDetails: !!adv.querySelector('details.llm-details .llm-route'),
        routeOutside: [...adv.querySelectorAll('.llm-route')].filter((x) => !x.closest('details.llm-details')).length,
        copies: [...adv.querySelectorAll('.llm-route .llm-kv')].map((kv) => ((kv.querySelector('.llm-copybtn') || {}).dataset || {}).act || null)};
      // Each Copy takes the value as drawn.
      const copied = [];
      const keepCopy = window.copyText;
      window.copyText = (text) => { copied.push(text); return Promise.resolve(true); };
      try { llmAct('copy:0'); llmAct('copy:3'); } finally { window.copyText = keepCopy; }
      out.copied = copied;
      out.facts = llmRouteFacts().map((f) => f.value);
      LLMP.mode = 'local';
      out.logsInPane = !!div(llmPanelHTML()).querySelector('[data-act="llm:logs"]');
      // The L key, in the pane with nothing open over it.
      LLMP.view = 'panel'; LLMP.confirm = null; SEL.open = false; WIZ.phase = null; LLMHF.open = false; LLMP.externalDraft = null; LLMP.steerUrl = null;
      window.act = (a) => { acts.push(a); };
      out.handled = llmKey({key: 'L', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, target: {id: ''}, preventDefault() {}}, 'L', false);
      out.acts = acts.slice();
      return out;
    } finally {
      window.act = keep.act;
      LIVE_CONFIG = keep.cfg; LLMP.status = keep.status; LLMP.daemonPhase = keep.phase; LLMP.view = keep.view; LLMP.confirm = keep.confirm;
      SEL.open = keep.open; WIZ.phase = keep.wizPhase; LLMHF.open = keep.hf; LLMP.externalDraft = keep.draft; LLMP.steerUrl = keep.steer; LLMP.mode = keep.mode;
    }
  })()`);
  check(
    "T48 (Д35): the local model server's Stop (and Start) sits beside the model's state, not among Advanced's buttons",
    r["stop"] === "Stop" && r["start"] === "Start" && r["daemonInAdv"] === false,
    show({ stop: r["stop"], start: r["start"], daemonInAdv: r["daemonInAdv"] }),
  );
  check(
    "T48 (Д35): llama.cpp's update, auto-update and device are one Engine card (with the way to the server log); the route's internals fold under Details",
    show(r["engine"]) === show(["llama.cpp", "Update automatically", "Device", "Server log"])
      && show(r["engineActs"]) === show(["llm:backend", "llm:autoUpdate", "llm:device", "diag:llmlogs"])
      && r["routeInDetails"] === true && r["routeOutside"] === 0,
    show({ engine: r["engine"], engineActs: r["engineActs"], routeInDetails: r["routeInDetails"], routeOutside: r["routeOutside"] }),
  );
  check(
    "T48 (Д35): Models has no LLM log screen of its own any more; its Server log and `L` key open the log in Settings › Diagnostics",
    r["logsInAdv"] === false && r["logsInPane"] === false && r["handled"] === true && show(r["acts"]) === show(["diag:llmlogs"]),
    show({ logsInAdv: r["logsInAdv"], logsInPane: r["logsInPane"], handled: r["handled"], acts: r["acts"] }),
  );
  const facts = (r["facts"] ?? []) as string[];
  check(
    "T48 (Д56): each value under Details has its Copy, and it copies the value as drawn",
    show(r["copies"]) === show(["llm:copy:0", "llm:copy:1", "llm:copy:2", "llm:copy:3"])
      && show(r["copied"]) === show([facts[0], facts[3]]) && facts[0] === "local-llama / smoke-t48" && /^running pid 4848/.test(String(facts[3])),
    show({ copies: r["copies"], copied: r["copied"], facts }),
  );
}

/* ATO-119, the window's half: a Remove on every model on disk, and what each one stops first. */
async function removeInWindow(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  const calls: string[] = [];
  let staleAsked = 0;
  const ok = { ok: true, stdout: "", stderr: "" };
  const stand: Record<string, (_e: unknown, payload: unknown) => unknown> = {
    "cli:modelsStop": () => { calls.push("stop"); return ok; },
    "cli:modelsStart": () => { calls.push("start"); return ok; },
    "cli:modelsUseEmbedding": (_e, id) => { calls.push(`useEmbedding:${String(id)}`); return ok; },
    "cli:modelsRemove": (_e, id) => {
      if (id === "smoke-t48-probe") return { ok: false, smokeT48: true };
      calls.push(`remove:${String(id)}`);
      // A server still on this model though the window thinks it is not: main refuses, once.
      if (id === "smoke-t48-stale" && staleAsked++ === 0) return { ok: false, running: true, stdout: "", stderr: "", error: "the local model server is running this model — stop it first" };
      return ok;
    },
    "cli:modelsRemoveEmbedding": (_e, id) => { calls.push(`removeEmbedding:${String(id)}`); return ok; },
    "cli:modelsStatus": () => ({ ok: false, error: "smoke t48: not read" }),
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
        down: LLMP.downSince, busy: S.busy, refresh: window.llmRefresh, live: window.refreshLiveConfig};
      window.__t48Stage = () => {
        window.llmRefresh = () => Promise.resolve();
        window.refreshLiveConfig = () => Promise.resolve();
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
        LLMP.daemonPhase = null; LLMP.confirm = null; LLMP.msg = null; LLMP.mode = 'local'; LLMP.downSince = null; S.busy = false;
      };
      window.__t48Open = (rowId) => {
        llmAct('removeAt:' + llmRows('local').findIndex((x) => x.id === rowId));
        const d = document.createElement('div'); d.innerHTML = llmModalHTML();
        return {kind: LLMP.confirm ? LLMP.confirm.kind : null, text: d.textContent.replace(/\s+/g, ' ').trim(),
          yes: ((d.querySelector('[data-act="llm:confirm"]') || {}).textContent || null)};
      };
      window.__t48Confirm = async () => {
        await llmRemoveLocalConfirm();
        return {confirm: LLMP.confirm ? {error: LLMP.confirm.error, mustStop: !!LLMP.confirm.mustStop, submitting: !!LLMP.confirm.submitting} : null,
          msg: LLMP.msg ? LLMP.msg.text : null};
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

    // 1 — the chat model in use: stop the server, then delete.
    calls.length = 0;
    const inUse = await js<Record<string, any>>("window.__t48Open('local-text:smoke-t48')");
    const inUseDone = await js<Record<string, any>>("window.__t48Confirm()");
    const inUseCalls = calls.slice();
    // 2 — a model no server has loaded: delete, nothing stopped.
    await js<unknown>("window.__t48Stage()");
    calls.length = 0;
    const other = await js<Record<string, any>>("window.__t48Open('local-text:smoke-t48-other')");
    const otherDone = await js<Record<string, any>>("window.__t48Confirm()");
    const otherCalls = calls.slice();
    check(
      "T48 (ATO-119): removing the model in use says the server stops first, then stops it before it deletes; any other model is just deleted",
      inUse["kind"] === "removeLocal" && inUse["yes"] === "Stop and delete" && /stops the local model server first/.test(String(inUse["text"]))
        && show(inUseCalls) === show(["stop", "remove:smoke-t48"]) && inUseDone["confirm"] === null && /^Deleted /.test(String(inUseDone["msg"]))
        && other["yes"] === "Delete" && show(otherCalls) === show(["remove:smoke-t48-other"]) && otherDone["confirm"] === null,
      show({ inUse, inUseCalls, inUseDone, other, otherCalls }),
    );

    // 3 — the embedding model memory search uses: embeddings off, stop, delete, the chat server back.
    await js<unknown>("window.__t48Stage()");
    calls.length = 0;
    const emb = await js<Record<string, any>>("window.__t48Open('local-embedding:smoke-t48-emb')");
    const embDone = await js<Record<string, any>>("window.__t48Confirm()");
    const embCalls = calls.slice();
    check(
      "T48 (ATO-119): an embedding model in use is turned off and its server stopped before it is deleted, and the chat server comes back",
      emb["kind"] === "removeEmbedding" && emb["yes"] === "Turn off and delete"
        && show(embCalls) === show(["useEmbedding:--disable", "stop", "removeEmbedding:smoke-t48-emb", "start"]) && embDone["confirm"] === null,
      show({ emb, embCalls, embDone }),
    );

    // 4 — a turn running: stopping the server would end it, so nothing happens.
    await js<unknown>("window.__t48Stage()");
    calls.length = 0;
    await js<unknown>("window.__t48Open('local-text:smoke-t48')");
    const held = await js<Record<string, any>>("(async () => { S.busy = true; try { return await window.__t48Confirm(); } finally { S.busy = false; } })()");
    const heldCalls = calls.slice();
    check(
      "T48 (ATO-119): with a turn running, the model in use is not stopped or deleted — the confirm says why",
      show(heldCalls) === "[]" && /Not while a turn is running/.test(String(held["confirm"]?.error)),
      show({ held, heldCalls }),
    );

    // 5 — main refuses: a server has it loaded after all. The confirm turns into Stop and delete, and that works.
    await js<unknown>("window.__t48Stage()");
    calls.length = 0;
    staleAsked = 0;
    await js<unknown>("window.__t48Open('local-text:smoke-t48-stale')");
    const refused = await js<Record<string, any>>("window.__t48Confirm()");
    const again = await js<Record<string, any>>(String.raw`(() => { const d = document.createElement('div'); d.innerHTML = llmModalHTML();
      return {yes: ((d.querySelector('[data-act="llm:confirm"]') || {}).textContent || null)}; })()`);
    const retried = await js<Record<string, any>>("window.__t48Confirm()");
    const staleCalls = calls.slice();
    check(
      "T48 (ATO-119): when main finds a server still has the model loaded it deletes nothing, and the confirm becomes Stop and delete",
      refused["confirm"]?.mustStop === true && /stop it first/.test(String(refused["confirm"]?.error)) && again["yes"] === "Stop and delete"
        && show(staleCalls) === show(["remove:smoke-t48-stale", "stop", "remove:smoke-t48-stale"]) && retried["confirm"] === null,
      show({ refused, again, retried, staleCalls }),
    );
  } finally {
    if (staged) {
      await js<unknown>(String.raw`(() => { const k = window.__t48Keep || {};
        window.llmRefresh = k.refresh; window.refreshLiveConfig = k.live;
        LIVE_CONFIG = k.cfg; LLMP.local = k.local; LLMP.emb = k.emb; LLMP.embDaemon = k.embDaemon; LLMP.status = k.status; LLMP.daemonPhase = k.phase || null;
        LLMP.confirm = k.confirm || null; LLMP.msg = k.msg || null; LLMP.statusErr = k.err || null; LLMP.mode = k.mode || 'local';
        if (k.cursor) Object.assign(LLMP.cursor, k.cursor); HOST_RAM_GB = k.ram || 0; LLMP.downSince = k.down || null; S.busy = !!k.busy;
        ['__t48Keep', '__t48Stage', '__t48Open', '__t48Confirm'].forEach((n) => { delete window[n]; });
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
  const idle: ServerFacts = { running: false, activeId: null, served: undefined };
  const b = {
    served: removeBlocker("a", { running: true, activeId: "b", served: "a" }, idle),
    servesOther: removeBlocker("a", { running: true, activeId: "a", served: "b" }, idle),
    unaskedActive: removeBlocker("a", { running: true, activeId: "a", served: undefined }, idle),
    unaskedOther: removeBlocker("a", { running: true, activeId: "b", served: undefined }, idle),
    stopped: removeBlocker("a", { running: false, activeId: "a", served: "a" }, idle),
    embedding: removeBlocker("e", idle, { running: true, activeId: "e", served: "e" }),
  };
  check(
    "T48 (ATO-119): a model a running server has loaded is never deleted — by what its /props says, else by the model its config gives it",
    !!b.served && b.servesOther === null && !!b.unaskedActive && b.unaskedOther === null && b.stopped === null && !!b.embedding,
    show(b),
  );
  const dataDir = mkdtempSync(join(tmpdir(), "aa-t48-"));
  const server = createServer((req, res) => {
    if (req.url === "/props") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model_path: join(dataDir, "models", "smoke-t48", "smoke.gguf"), default_generation_settings: { n_ctx: 4096 } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const served = {
      props: await servedModelId(`http://127.0.0.1:${port}`, dataDir),
      noProps: await servedModelId(`http://127.0.0.1:${port}/nothing-here`, dataDir),
      nobody: await servedModelId("http://127.0.0.1:1", dataDir, 1000),
    };
    check(
      "T48 (ATO-119): what a running llama-server has loaded is read off its own /props; a server that cannot say is not taken for one that says no",
      served.props === "smoke-t48" && served.noProps === undefined && served.nobody === undefined,
      show(served),
    );
    mkdirSync(join(dataDir, "models", "smoke-t48-emb"), { recursive: true });
    writeFileSync(join(dataDir, "models", "smoke-t48-emb", "e.gguf"), "smoke");
    mkdirSync(join(dataDir, "models", "smoke-t48-keep"), { recursive: true });
    writeFileSync(join(dataDir, "models", "smoke-t48-keep", "k.gguf"), "smoke");
    const gone = await removeModelDir(dataDir, "smoke-t48-emb");
    const up = await removeModelDir(dataDir, "..");
    const rel = await removeModelDir("relative-dir", "smoke-t48-keep");
    check(
      "T48 (ATO-119): an embedding model's removal deletes its folder and nothing else; no parent folder, no relative data dir",
      gone.ok && !existsSync(join(dataDir, "models", "smoke-t48-emb")) && existsSync(join(dataDir, "models", "smoke-t48-keep", "k.gguf"))
        && !up.ok && !rel.ok && existsSync(join(dataDir, "models")),
      show({ gone, up, rel }),
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
