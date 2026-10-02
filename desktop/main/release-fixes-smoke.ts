import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserWindow, Menu } from "electron";

import { plainCliError } from "./agent-cli.js";
import { resolveBinary } from "./agent-client.js";
import { checks03 } from "./smoke-tasks/t03.js";
import { checks09 } from "./smoke-tasks/t09.js";
import { checks10 } from "./smoke-tasks/t10.js";
import { checks11 } from "./smoke-tasks/t11.js";
import { checks13 } from "./smoke-tasks/t13.js";
import { checks18 } from "./smoke-tasks/t18.js";
import { checks18b } from "./smoke-tasks/t18b.js";
import { checks18c } from "./smoke-tasks/t18c.js";
import { checks18d } from "./smoke-tasks/t18d.js";
import { checks18e } from "./smoke-tasks/t18e.js";
import { checks18f } from "./smoke-tasks/t18f.js";
import { checks22 } from "./smoke-tasks/t22.js";
import { checks24 } from "./smoke-tasks/t24.js";
import { checks25 } from "./smoke-tasks/t25.js";
import { checks26 } from "./smoke-tasks/t26.js";
import { checks27 } from "./smoke-tasks/t27.js";
import { checks28 } from "./smoke-tasks/t28.js";
import { checks32 } from "./smoke-tasks/t32.js";
import { checks30 } from "./smoke-tasks/t30.js";
import { checks34 } from "./smoke-tasks/t34.js";
import { checks36 } from "./smoke-tasks/t36.js";
import { checks47 } from "./smoke-tasks/t47.js";

/**
 * The 0.6.7 release fixes, in the smoke.
 *
 * One block per backlog item, each proving the fix where it lives: the
 * native menu from main, the CLI against a throwaway state directory, the
 * renderer's own functions and state through `executeJavaScript`. Every
 * block puts back what it touched. `--smoke --smoke-task=06` runs one block;
 * a plain `--smoke` runs them all.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

/** What the projector download's `models status` read answers: only the data dir is read. */
export type ProjectorStatusAnswer = { ok: boolean; status?: { dataDir: string | null }; error?: string };
/**
 * Backlog 18 (the deferred cases): main's stand-ins for what its download
 * handlers wait on, handed in by main.ts, which owns the slots. Nothing is
 * spawned or fetched through them.
 */
export type SmokeDownloads = {
  /** A stand-in held in main's runtime or projector slot, with no child behind it. Returns its release. */
  hold: (kind: "runtime" | "projector", id: string) => () => void;
  /** The projector download's `models status` read, stood in. Returns the undo. */
  projectorStatus: (read: () => Promise<ProjectorStatusAnswer>) => () => void;
  /** Every download handler refuses before it spawns or fetches anything, whatever it is asked. Returns the undo. */
  offline: () => () => void;
  /** What quitting does to the downloads before the agent stops (main's before-quit), run now. Returns the undo for what a check can carry on without. */
  quit: () => () => void;
  /** The download main runs, as its refusals name it, or null. */
  running: () => { kind: string; id: string } | null;
  /** Backlog 35: the route `atag serve` booted on, stood in as the config it read (null: no agent up). Returns the undo. */
  bootedOn: (cfg: unknown) => () => void;
};

export const RELEASE_FIX_TASKS = ["03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "30", "32", "34", "36", "47"];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* A task file that throws (a renderer error inside `js`) or never settles
   used to hang the whole run instead of failing it. Either is one FAIL here,
   and the run goes on to the next item. */
async function guarded(id: string, check: Check, run: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("did not finish within 180 s")), 180_000); }),
    ]);
  } catch (err) {
    check(`T${id}: its checks ran to the end`, false, err instanceof Error ? err.message : String(err));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function menuLabels(menu: Electron.Menu | null): string[] {
  if (!menu) return [];
  return menu.items.flatMap((i) => [i.label, ...menuLabels(i.submenu ?? null)]);
}

export async function releaseFixesSmokeTest(js: Js, check: Check, tasks: string[], downloads: SmokeDownloads): Promise<void> {
  const want = new Set(tasks.map((t) => t.padStart(2, "0")));

  if (want.has("12")) {
    // 12 — "Run Setup Again…" was a debug item in the app menu.
    const labels = menuLabels(Menu.getApplicationMenu());
    check(
      "T12: the app menu has no Run Setup Again…",
      labels.includes("Settings…") && !labels.some((l) => /run setup again/i.test(l)),
      `${labels.length} items; ${JSON.stringify(labels.filter((l) => /setup|settings/i.test(l)))}`,
    );
    check(
      "T12: setup still opens from /onboarding",
      await js<boolean>("typeof openOnboarding === 'function' && typeof window.__obMenuOpen === 'function'"),
    );
  }

  if (want.has("06")) {
    // 06 — the embedding catalogue writes "33 MB"; the button said "Download 33 GB".
    const words = await js<Record<string, string>>(`({
      mb: modelSizeWord({size:'33 MB'}),
      btnMb: llmEffectLabel({primaryAction:'download', kind:'localEmbeddingModel', model:{id:'bge-m3', size:'635 MB'}}),
      gbField: modelSizeWord({sizeGb:6.2}),
      gbString: modelSizeWord({size:'6.2 GB'}),
      withProjector: modelSizeWord({sizeGb:5.9, mmprojSizeGb:0.3}),
      btnGb: llmEffectLabel({primaryAction:'download', model:{id:'qwen-3.5-9b', sizeGb:6.2}}),
      mbAsGb: String(obDownloadGb({size:'512 MB'}).toFixed(2)),
    })`);
    check(
      "T06: a size in MB stays in MB on the row and the button",
      words.mb === "33 MB" && words.btnMb === "Download 635 MB" && words.mbAsGb === "0.50",
      JSON.stringify(words),
    );
    check(
      "T06: sizes in GB read as before",
      words.gbField === "6.2 GB" && words.gbString === "6.2 GB" && words.withProjector === "6.2 GB" && words.btnGb === "Download 6.2 GB",
      JSON.stringify(words),
    );
    // The live catalogue, when the agent answers: no embedding button may say GB for a size in MB.
    const live = await js<{ ok: boolean; bad: string[]; n: number; error?: string }>(`(async () => {
      const res = await window.atomic.modelsListEmbeddings();
      if (!res || !res.ok) return {ok:false, bad:[], n:0, error: res && res.error};
      const bad = (res.models || []).filter((m) => /MB$/i.test(m.size)).map((m) =>
        llmEffectLabel({primaryAction:'download', kind:'localEmbeddingModel', model:m})).filter((l) => /GB$/.test(l));
      return {ok:true, bad, n:(res.models || []).length};
    })()`);
    check(
      "T06: no embedding model in the live catalogue offers a download in GB for a size in MB",
      live.ok && live.n > 0 && live.bad.length === 0,
      live.ok ? `${live.n} models; wrong: ${JSON.stringify(live.bad)}` : `catalogue not read: ${live.error}`,
    );
  }

  if (want.has("04")) {
    // 04 — `models status` on a managed install whose server never started threw ENOENT on the log.
    const bin = resolveBinary();
    const dir = mkdtempSync(join(tmpdir(), "aa-t04-"));
    try {
      const env = { ...process.env, ATOMIC_AGENT_STATE_DIR: dir };
      const set = bin ? spawnSync(bin, ["config", "set", "localModels.mode", "managed"], { env, encoding: "utf8", timeout: 60_000 }) : null;
      const st = bin ? spawnSync(bin, ["models", "status"], { env, encoding: "utf8", timeout: 60_000 }) : null;
      const out = st ? `${st.stdout}${st.stderr}` : "";
      check(
        "T04: models status on a server that never started exits 0 with no ENOENT",
        !!st && set?.status === 0 && st.status === 0 && /mode:\s+managed/.test(st.stdout) && /health:/.test(st.stdout) && !/ENOENT|llama-server\.log/.test(out),
        bin ? `exit ${st?.status}; ${JSON.stringify(out.slice(-240))}` : "no agent binary resolved",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const raw = "Error: ENOENT: no such file or directory, stat '/x/models/llama-server.log'\n"
      + "    at statSync (node:fs:1710:25)\n    at readLogTail (file:///A/dist/local-llm/log-tail.js:3:15)\n"
      + "    at runLocalModelsStatus (file:///A/dist/cli/models-handlers.js:281:39)\n"
      + "    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)\n\nNode.js v25.9.0\n";
    const plain = plainCliError(raw);
    const kept = plainCliError("pick a model first: atomic-agent models pull <id>\nat least one provider must be set\n");
    check(
      "T04: a CLI failure reaches the window without its stack frames",
      plain === "Error: ENOENT: no such file or directory, stat '/x/models/llama-server.log'"
        && kept === "pick a model first: atomic-agent models pull <id>\nat least one provider must be set",
      JSON.stringify({ plain, kept }),
    );
    const banner = await js<string>("(window.__settingsOpen && window.__settingsOpen('llm'), new Promise((r) => setTimeout(() => r(typeof llmStatusLine === 'function' ? llmStatusLine() : ''), 4000)))");
    check("T04: the Models pane shows no stack trace", !/ENOENT|\bat (statSync|readLogTail)/.test(banner), JSON.stringify(banner.slice(0, 200)));
    await js<void>("window.__settingsClose()");
  }

  if (want.has("05")) {
    // 05 — a model pulled outside the Models tab kept its Download button under a header that said Ready.
    const r = await js<Record<string, unknown>>(`(async () => {
      if (LLMP.inflight) { try { await LLMP.inflight; } catch (e) { /* its own report */ } }
      const saved = {local: LLMP.local, heal: LLMP.staleHealAt, refresh: window.llmRefresh, status: LLMP.status, err: LLMP.statusErr, down: LLMP.downSince};
      let refreshed = 0;
      try {
        LLMP.local = [{id:'qwen-3.5-9b', downloaded:false, active:true}, {id:'gemma-4-12b', downloaded:false}];
        const st = {mode:'managed', activeModel:'qwen-3.5-9b', activeDownloaded:true, daemonRunning:true, daemonPid:1, health:'ok'};
        const staleWhenListLags = llmListIsStale(st);
        const notStaleWhenNotOnDisk = !llmListIsStale(Object.assign({}, st, {activeDownloaded:false}));
        LLMP.local = [{id:'qwen-3.5-9b', downloaded:true, active:true}];
        const notStaleWhenAgreeing = !llmListIsStale(st);
        LLMP.local = [{id:'qwen-3.5-9b', downloaded:true, active:false}];
        const staleWhenNotMarkedActive = llmListIsStale(st);
        LLMP.local = [{id:'qwen-3.5-9b', downloaded:false}];
        LLMP.staleHealAt = 0; LLMP.inflight = null;
        window.llmRefresh = () => { refreshed++; return Promise.resolve(); };
        llmApplyStatus({ok:true, status:st});
        llmApplyStatus({ok:true, status:st});
        await new Promise((res) => setTimeout(res, 50));
        return {staleWhenListLags, notStaleWhenNotOnDisk, notStaleWhenAgreeing, staleWhenNotMarkedActive, refreshed};
      } finally {
        window.llmRefresh = saved.refresh; LLMP.local = saved.local; LLMP.staleHealAt = saved.heal;
        LLMP.status = saved.status; LLMP.statusErr = saved.err; LLMP.downSince = saved.down;
      }
    })()`);
    check(
      "T05: a list that disagrees with the status about the active model (not on disk, or not chosen) is re-read, once",
      r.staleWhenListLags === true && r.notStaleWhenNotOnDisk === true && r.notStaleWhenAgreeing === true
        && r.staleWhenNotMarkedActive === true && r.refreshed === 1,
      JSON.stringify(r),
    );
    // A finished pull through the real IPC channel the downloads use. Every
    // other pull subscriber ignores it: none of them owns a running job.
    const saved = await js<number | null>("(() => { const s = LLMP.lastRefreshedAt; LLMP.lastRefreshedAt = 123; return s; })()");
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("cli:pull", { done: true, ok: true, id: "smoke-t05" });
    await wait(300);
    const after = await js<number | null>("LLMP.lastRefreshedAt");
    await js<void>(`if (LLMP.lastRefreshedAt === null && !LLMP.inflight) LLMP.lastRefreshedAt = ${saved === null ? "null" : saved};`);
    const pull = { after };
    check("T05: any finished pull marks the Local list for a re-read", pull.after === null, JSON.stringify(pull));
  }

  if (want.has("08")) {
    // 08 — changing the mode on an empty chat took the start screen away.
    const r = await js<Record<string, unknown>>(`(async () => {
      const before = MODE.current || 'default';
      const target = before === 'plan' ? 'auto' : 'plan';
      await window.__newSession();
      await new Promise((res) => setTimeout(res, 300));
      const emptyBefore = !!document.querySelector('.emptychat');
      const toastsBefore = S.toasts.length;
      await window.__setCodingMode(target);
      await new Promise((res) => setTimeout(res, 150));
      const out = {target, emptyBefore, logAfter: S.log.length, emptyAfter: !!document.querySelector('.emptychat'),
        toast: (S.toasts.slice(toastsBefore).map((t) => t.t).pop()) || null, mode: MODE.current};
      // Inside a conversation the line is still recorded.
      S.log.push({id:nid(), k:'user', text:'smoke t08'});
      await window.__setCodingMode(before);
      await new Promise((res) => setTimeout(res, 150));
      out.lineInChat = S.log.length === 2 && S.log[1].k === 'system';
      out.restored = MODE.current;
      await window.__newSession();
      return out;
    })()`);
    check(
      "T08: a mode change on an empty chat keeps the start screen and says so in a toast",
      r.emptyBefore === true && r.logAfter === 0 && r.emptyAfter === true && typeof r.toast === "string" && /^Mode changed to /.test(r.toast as string) && r.mode === r.target,
      JSON.stringify(r),
    );
    check("T08: inside a conversation the change is still a transcript line", r.lineInChat === true, JSON.stringify(r));
    const f = await js<Record<string, unknown>>(`(async () => {
      await window.__newSession();
      const toastsBefore = S.toasts.length;
      await setCodingMode('plan', async () => ({ok:false, error:'smoke t08 refusal'}));
      await new Promise((res) => setTimeout(res, 150));
      const out = {log: S.log.length, empty: !!document.querySelector('.emptychat'), toast: (S.toasts.slice(toastsBefore).map((t) => t.t + ' / ' + t.s).pop()) || null};
      SWX.err = null; render();
      return out;
    })()`);
    check(
      "T08: a refused mode change on an empty chat is a toast too, and the start screen stays",
      f.log === 0 && f.empty === true && typeof f.toast === "string" && /did not change/.test(f.toast as string) && /smoke t08 refusal/.test(f.toast as string),
      JSON.stringify(f),
    );
  }

  if (want.has("07")) {
    // 07a/07b — "Setup complete" and "Set up a model" while the model is still downloading.
    // The wizard queues {kind:'runtime', id:'llama.cpp'} then {kind:'weights', id:<model>}.
    const a = await js<Record<string, unknown>>(`(async () => {
      const saved = {job: DL.job, queue: DL.queue.slice()};
      try {
        DL.job = {kind:'runtime', id:'llama.cpp', percent:40}; DL.queue = [{kind:'weights', id:'qwen-3.5-4b'}];
        const downloading = obClosingToast('local');
        const busy = dlBusy();
        const name = dlModelName();
        const setupSlot = downloadingChipHtml();
        render(); await new Promise((r) => setTimeout(r, 100));
        const pc = document.querySelector('#composer .cfoot .pullchip');
        const onScreen = pc ? {text: pc.textContent.trim(), cls: pc.className, tag: pc.tagName, act: pc.getAttribute('data-act') || pc.getAttribute('data-sel-open')} : null;
        const route = selBackend();
        DL.job = null; DL.queue = [];
        render(); await new Promise((r) => setTimeout(r, 100));
        const gone = !document.querySelector('#composer .cfoot .pullchip');
        return {downloading, done: obClosingToast('local'), skipped: obClosingToast('skipped'), busy, idle: dlBusy(), name, setupSlot, onScreen, route, gone};
      } finally { DL.job = saved.job; DL.queue = saved.queue; render(); }
    })()`);
    check(
      "T07a: closing setup during a download says the model is downloading, not Setup complete",
      Array.isArray(a.downloading) && (a.downloading as string[])[0] === "Your model is downloading"
        && (a.done as string[])[0] === "Setup complete" && (a.skipped as string[])[0] === "Setup skipped",
      JSON.stringify([a.downloading, a.done, a.skipped]),
    );
    const shown = a.onScreen as { text: string; cls: string; tag: string; act: string | null } | null;
    check(
      "T07b: while the wizard's download runs, the composer shows Downloading <the model> in place of a control",
      a.busy === true && a.idle === false && /qwen.?3\.5.?4b/i.test(String(a.name))
        && !!shown && /^Downloading /.test(shown.text) && /qwen.?3\.5.?4b/i.test(shown.text) && shown.tag === "SPAN" && !shown.act
        && /Downloading/.test(String(a.setupSlot)) && a.gone === true,
      JSON.stringify({ route: a.route, name: a.name, onScreen: a.onScreen, gone: a.gone }),
    );
    // 07c — the 45 s watchdog's line outlived a switch that landed.
    const c = await js<Record<string, unknown>>(`(async () => {
      if (S.busy || SWX.pending) return {skipped:'busy'};
      const label = 'starting smoke-t07…';
      const res = await swxRun(label, null, async () => { SWX.err = swxSlowLine(label); return {ok:true}; });
      const cleared = SWX.err === null;
      const res2 = await swxRun(label, null, async () => ({ok:false, error:'boom'}));
      const failKept = /boom/.test(SWX.err || '');
      SWX.err = null; render();
      return {ok: res && res.ok, cleared, failKept, ok2: res2 && res2.ok};
    })()`);
    check(
      "T07c: a switch that lands clears the watchdog's has-not-finished line; a failure still shows",
      c.cleared === true && c.failKept === true,
      JSON.stringify(c),
    );
    // 07d — the context gauge read as a spinner that never stopped.
    const d = await js<Record<string, unknown>>(`(() => {
      const saved = {tokens: CTX.tokens, window: CTX.window, source: CTX.source};
      try {
        CTX.tokens = 15000; CTX.window = 100000; CTX.source = 'built';
        const html = contextChip();
        const host = document.createElement('div'); host.className = 'cfoot'; host.innerHTML = html; document.body.appendChild(host);
        const fg = host.querySelector('.ctxring .fg'), bg = host.querySelector('.ctxring .bg');
        const out = {pie: !!fg && fg.getAttribute('r') === '3.75', fgWidth: fg ? getComputedStyle(fg).strokeWidth : null,
          bgFill: bg ? getComputedStyle(bg).fill : null, anim: fg ? getComputedStyle(fg).animationName : null};
        host.remove();
        return out;
      } finally { Object.assign(CTX, saved); }
    })()`);
    check(
      "T07d: the context gauge is a filled pie on a disc, not an arc",
      d.pie === true && d.fgWidth === "7.5px" && d.bgFill !== "none" && (d.anim === "none" || d.anim === null),
      JSON.stringify(d),
    );
    // 07e — "Not answering" for the half minute a fresh server needs to open its port.
    const e = await js<Record<string, unknown>>(`(() => {
      const saved = LLMP.downSince, savedPid = LLMP.healthyPid;
      try {
        LLMP.downSince = null; LLMP.healthyPid = null;
        llmNoteDaemonHealth({daemonRunning:true, daemonPid:4242, health:'down'});
        const fresh = llmJustSpawned();
        LLMP.downSince.at = Date.now() - 120000;
        const old = llmJustSpawned();
        llmNoteDaemonHealth({daemonRunning:true, daemonPid:4242, health:'ok'});
        const healthyClears = LLMP.downSince === null;
        llmNoteDaemonHealth({daemonRunning:true, daemonPid:4242, health:'down'});
        const hungAfterOk = llmJustSpawned();
        return {fresh, old, healthyClears, hungAfterOk};
      } finally { LLMP.downSince = saved; LLMP.healthyPid = savedPid; }
    })()`);
    check(
      "T07e: a just-spawned server reads Starting for its first 90 s, then Not answering; one that answered before gets no grace",
      e.fresh === true && e.old === false && e.healthyClears === true && e.hungAfterOk === false,
      JSON.stringify(e),
    );
  }

  if (want.has("15")) {
    // 15 — picking a model in a provider's long list threw the list back to the top.
    const r = await js<Record<string, unknown>>(`(async () => {
      const saved = {phase: WIZ.phase, row: WIZ.row, models: WIZ.models, pick: WIZ.modelPick, label: WIZ.savedLabel, def: WIZ.defaultModel, filter: WIZ.modelFilter};
      const tick = (ms) => new Promise((res) => setTimeout(res, ms));
      try {
        window.__selOpen('provider');
        WIZ.row = KIND_ROWS[0]; WIZ.savedLabel = 'OpenRouter'; WIZ.defaultModel = 'vendor/model-0'; WIZ.modelFilter = '';
        WIZ.models = Array.from({length: 60}, (_, i) => ({id: 'vendor/model-' + i, name: 'Model ' + i}));
        WIZ.modelPick = null; WIZ.phase = 'pick_model'; render();
        await tick(250);
        const box = document.querySelector('#overlays .selbody');
        if (!box) return {err: 'no list on screen'};
        box.scrollTop = 900; await tick(60);
        const before = box.scrollTop;
        const b = box.getBoundingClientRect();
        const target = Array.from(box.querySelectorAll('[data-wizmodel]')).find((el) => {
          const q = el.getBoundingClientRect(); return q.top > b.top + 20 && q.bottom < b.bottom - 20; });
        if (!target) return {err: 'no row in view', before};
        const id = target.dataset.wizmodel;
        target.click();
        await tick(250);
        const list = document.querySelector('#overlays .selbody');
        const row = list && list.querySelector('[data-wizmodel="' + id + '"]');
        const out = {before, after: list ? list.scrollTop : null, picked: !!row && row.classList.contains('on'), id};
        WIZ.modelFilter = 'model-1'; render(); await tick(120);
        const searched = document.querySelector('#overlays .selbody');
        out.afterSearch = searched ? searched.scrollTop : null;
        return out;
      } finally {
        Object.assign(WIZ, {phase: saved.phase, row: saved.row, models: saved.models, modelPick: saved.pick,
          savedLabel: saved.label, defaultModel: saved.def, modelFilter: saved.filter});
        window.__selClose(); render();
      }
    })()`);
    check(
      "T15: picking a model keeps the list where it was scrolled",
      typeof r.before === "number" && (r.before as number) > 100 && r.after === r.before && r.picked === true,
      JSON.stringify(r),
    );
    check("T15: a new search still starts the list at the top", r.afterSearch === 0, JSON.stringify(r));
  }

  if (want.has("16")) {
    // 16 — downloaded models first in Settings › Models and in the composer's picker.
    const r = await js<Record<string, unknown>>(`(() => {
      const saved = {local: LLMP.local, emb: LLMP.emb};
      try {
        LLMP.local = [
          {id:'big-remote', size:'6.2 GB', sizeGb:6.2, recommendedRamGb:8, minRamGb:6, downloaded:false},
          {id:'small-on-disk', size:'3.4 GB', sizeGb:3.4, recommendedRamGb:8, minRamGb:6, downloaded:true},
          {id:'mid-remote', size:'5.2 GB', sizeGb:5.2, recommendedRamGb:8, minRamGb:6, downloaded:false},
        ];
        LLMP.emb = [{id:'e-remote', size:'33 MB', downloaded:false}, {id:'e-on-disk', size:'118 MB', downloaded:true}];
        const rows = llmLocalRows();
        const text = rows.filter((x) => x.kind === 'localTextModel').map((x) => x.model.id);
        const emb = rows.filter((x) => x.kind === 'localEmbeddingModel').map((x) => x.model.id);
        const helper = onDiskFirst([{id:'a'}, {id:'b', downloaded:true}, {id:'c'}, {id:'d', downloaded:true}]).map((m) => m.id).join(',');
        return {text, emb, helper};
      } finally { LLMP.local = saved.local; LLMP.emb = saved.emb; }
    })()`);
    check(
      "T16: models on this Mac come first, the rest keep their fit order",
      JSON.stringify(r.text) === JSON.stringify(["small-on-disk", "big-remote", "mid-remote"])
        && JSON.stringify(r.emb) === JSON.stringify(["e-on-disk", "e-remote"]) && r.helper === "b,d,a,c",
      JSON.stringify(r),
    );
  }

  if (want.has("17")) {
    // 17 — the three route cards on the first step wore indigo, blue and grey icons.
    const r = await js<Record<string, unknown>>(`(() => {
      const html = obChooseHTML();
      const box = document.createElement('div'); box.innerHTML = html;
      const icons = Array.from(box.querySelectorAll('.ob-routes .tk-ico')).map((i) => i.className);
      return {icons, indigo: /tk-ico--indigo/.test(html)};
    })()`);
    const icons = r.icons as string[];
    check(
      "T17: the three route cards wear one icon tone",
      icons.length === 3 && new Set(icons).size === 1 && /tk-ico--blue/.test(icons[0] ?? "") && r.indigo === false,
      JSON.stringify(r),
    );
  }

  // The remaining items keep their checks in their own files (main/smoke-tasks/),
  // so they can be built in parallel without touching this one. 13 also covers 14.
  if (want.has("03")) await guarded("03", check, () => checks03(js, check));
  if (want.has("09")) await guarded("09", check, () => checks09(js, check));
  if (want.has("10")) await guarded("10", check, () => checks10(js, check));
  if (want.has("11")) await guarded("11", check, () => checks11(js, check));
  if (want.has("13") || want.has("14")) await guarded("13", check, () => checks13(js, check));
  if (want.has("18")) {
    /* The card's checks wait on timers and on the window's own layout. With
       several smokes side by side another window covers this one, and an
       occluded page's chained timers end up a minute apart: a run overran its
       180 s that way. As the screenshot lane does, throttling is off while
       they run, and put back as it was. */
    const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
    const throttled = wins.map((x) => x.webContents.getBackgroundThrottling());
    wins.forEach((x) => x.webContents.setBackgroundThrottling(false));
    /* The card's corner is the window's with the inspector closed; with it
       open the card stands to its left (t18b checks that). The full suite
       reaches this block with whatever the inspector was left at, so it is
       closed here — not through its toggle, which would persist — and put
       back after. */
    await js<unknown>("(() => { window.__t18Insp = S.inspector; S.inspector = false; render(); })()");
    try {
      await guarded("18", check, () => checks18(js, check));
      // R1's resume of a vision model's projector (smoke-tasks/t18c.ts).
      await guarded("18", check, () => checks18c(js, check));
      // Its review follow-ups, in their own file (smoke-tasks/t18b.ts).
      await guarded("18", check, () => checks18b(js, check));
      // Its second review: a reopened window, an early landing, the resume cap, a late Cancel (smoke-tasks/t18d.ts).
      await guarded("18", check, () => checks18d(js, check));
      // The rare cases deferred from it, a vision model's projector among the other downloads (smoke-tasks/t18e.ts).
      await guarded("18", check, () => checks18e(js, check, downloads));
      // Settings' llama.cpp update against the model starts, and at quit (smoke-tasks/t18f.ts).
      await guarded("18", check, () => checks18f(js, check, downloads));
    } finally {
      await js<unknown>("(() => { S.inspector = !!window.__t18Insp; delete window.__t18Insp; render(); })()");
      wins.forEach((x, i) => { if (!x.isDestroyed()) x.webContents.setBackgroundThrottling(throttled[i]!); });
    }
  }
  // 22 — a chat still loading when New chat was pressed came back over the new one.
  if (want.has("22")) await guarded("22", check, () => checks22(js, check));
  // 27 — a new chat was not on the sidebar until its first reply landed.
  // Item 29's desktop checks live in t27.ts with item 27's, so either id runs them.
  if (want.has("27") || want.has("29")) await guarded("27", check, () => checks27(js, check));
  // 28 — a switch from a new chat restarted the agent under the turn still running in the chat it left.
  if (want.has("28")) await guarded("28", check, () => checks28(js, check));
  // 32 — a key with a character keys don't have got in, and a saved one failed every turn as "no connection".
  if (want.has("32")) await guarded("32", check, () => checks32(js, check));
  // 30 and 31 share one file: the quit and the model server killed by hand.
  if (want.has("30") || want.has("31")) await guarded("30", check, () => checks30(js, check));
  // 34 — backlog 18's second review: a switch's restart under a running turn, and a start spawned after the quit.
  if (want.has("34")) await guarded("34", check, () => checks34(js, check, downloads));

  if (want.has("23")) {
    // 23 — "This Mac" named the local route on every platform, Windows and Linux included.
    // It is "Local models" now (Nadya, 02.10), and the analytics row no longer says messages never leave the machine.
    const r = await js<Record<string, unknown>>(`(() => {
      const text = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.textContent || ''; };
      try {
        const runMode = text(llmRunModeHTML()), local = text(llmLocalHTML()), general = text(generalPane());
        return {word: backendWord('local'), row: selRowName({type:'provider', id:'local-llama'}),
          runMode: /Local models/.test(runMode), runModeOld: /This Mac/.test(runMode),
          localTitle: /Local models/.test(local), localOld: /Models on this Mac/.test(local),
          analytics: /never sent with analytics/.test(general), analyticsOld: /never leave/.test(general)};
      } catch (err) { return {error: String(err && err.message || err)}; }
    })()`);
    check(
      "T23: the local route is called Local models wherever it is named",
      r.word === "Local models" && r.row === "Local models" && r.runMode === true && r.runModeOld === false
        && r.localTitle === true && r.localOld === false,
      JSON.stringify(r),
    );
    check(
      "T23: the analytics row says what analytics never send, not that nothing leaves the machine",
      r.analytics === true && r.analyticsOld === false,
      JSON.stringify(r),
    );
  }

  if (want.has("19")) {
    // 19 — "What never leaves this Mac" read as a privacy promise the app does not make.
    const r = await js<Record<string, unknown>>(`(() => {
      const html = privacyPane();
      return {sent: /Sent with analytics/.test(html), never: /Never sent with analytics/.test(html),
        cloud: /With a cloud model, your messages go to that provider\\./.test(html), old: /never leaves this Mac/i.test(html)};
    })()`);
    check(
      "T19: Privacy says what analytics send and never send, and that a cloud model gets the messages",
      r.sent === true && r.never === true && r.cloud === true && r.old === false,
      JSON.stringify(r),
    );
  }

  if (want.has("20")) {
    // 20 — Add MCP server: other products named, sideways scroll, two technical lines.
    const r = await js<Record<string, unknown>>(`(async () => {
      const tick = (ms) => new Promise((res) => setTimeout(res, ms));
      const savedSubmit = window.mcpAddSubmit; let submitted = 0;
      try {
        window.__settingsOpen('mcp'); await tick(200);
        MCP.addModal = {json:'', error:null, submitting:false}; render(); await tick(100);
        const box = document.getElementById('mcp-json');
        const modal = document.querySelector('.sd-modal');
        const text = modal ? modal.textContent : '';
        const out = {open: !!box, plain: /usually in the server.s README/.test(text),
          others: /Claude Desktop|Cursor|auto-promoted|Shift\\/Alt/.test(text),
          lines: box ? (box.getAttribute('placeholder') || '').split('\\n').length : 0,
          wrap: box ? getComputedStyle(box).whiteSpace : null, sideways: box ? getComputedStyle(box).overflowX : null};
        window.mcpAddSubmit = () => { submitted++; };
        box.focus();
        box.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}));
        await tick(50);
        out.enterSubmits = submitted; out.stillOpen = !!MCP.addModal;
        box.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', metaKey:true, bubbles:true, cancelable:true}));
        await tick(50);
        out.cmdEnterSubmits = submitted;
        return out;
      } finally {
        window.mcpAddSubmit = savedSubmit; MCP.addModal = null; window.__settingsClose(); render();
      }
    })()`);
    check(
      "T20: Add MCP server speaks plainly, wraps the JSON and shows the example on lines",
      r.open === true && r.plain === true && r.others === false && (r.lines as number) >= 5 && r.wrap === "pre-wrap" && r.sideways === "hidden",
      JSON.stringify(r),
    );
    check(
      "T20: Enter starts a new line in the box; Add or Cmd+Enter adds the server",
      r.enterSubmits === 0 && r.stillOpen === true && r.cmdEnterSubmits === 1,
      JSON.stringify(r),
    );
  }

  if (want.has("21")) {
    // 21 — Gemma wore a star nobody knew; the Hugging Face row had a grey hint beside it.
    const r = await js<Record<string, unknown>>(`(async () => {
      const box = document.createElement('div'); box.innerHTML = obLocalPickHTML();
      const hf = box.querySelector('.ob-hfrow');
      const img = new Image();
      const loaded = await new Promise((res) => {
        img.onload = () => res(true); img.onerror = () => res(false); setTimeout(() => res(false), 3000);
        img.src = 'logos/google.svg';
      });
      return {gemma: modelMark('gemma-4-12b-it'), gguf: modelMark('unsloth/gemma-3-4b-it-GGUF'), gemini: modelMark('gemini-2.5-pro'),
        loaded, hf: !!hf, label: hf ? hf.querySelector('.t').textContent : null, hint: hf ? !!hf.querySelector('.d') : null,
        oldHint: /owner\\/repo id or a huggingface/.test(box.innerHTML)};
    })()`);
    check(
      "T21: Gemma models wear Google's mark, and the mark loads",
      /logos\/google\.svg/.test(String(r.gemma)) && /logos\/google\.svg/.test(String(r.gguf))
        && /gemini-color\.svg/.test(String(r.gemini)) && r.loaded === true,
      JSON.stringify(r),
    );
    check(
      "T21: Add a model from Hugging Face stands alone, no grey hint beside it",
      r.hf === true && r.label === "Add a model from Hugging Face…" && r.hint === false && r.oldHint === false,
      JSON.stringify(r),
    );
    // Same spot in the recording: the marks were small, and a white disc glared in the dark theme.
    const b = await js<Record<string, unknown>>(`(() => {
      const probe = document.createElement('span'); probe.className = 'logo';
      probe.innerHTML = '<img src="logos/google.svg" alt="">'; document.body.appendChild(probe);
      const root = document.documentElement, had = root.getAttribute('data-theme');
      try {
        root.setAttribute('data-theme', 'light'); const light = getComputedStyle(probe).backgroundColor;
        root.setAttribute('data-theme', 'dark'); const dark = getComputedStyle(probe).backgroundColor;
        const share = parseFloat(getComputedStyle(probe.querySelector('img')).width) / parseFloat(getComputedStyle(probe).width);
        return {light, dark, share: Math.round(share * 100) / 100};
      } finally {
        if (had == null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', had);
        probe.remove();
      }
    })()`);
    check(
      "T21: a mark sits on white in the light theme, light grey in the dark one, and fills three quarters of it",
      b.light === "rgb(255, 255, 255)" && b.dark === "rgb(211, 215, 219)" && b.share === 0.74,
      JSON.stringify(b),
    );
  }

  // 24 — a message sent while a chat was still opening went to the chat that was left.
  if (want.has("24")) await guarded("24", check, () => checks24(js, check));

  // 25 — after a chat switch, Stop, Escape and y/n acted on the turn and the approval of another chat.
  if (want.has("25")) await guarded("25", check, () => checks25(js, check));

  // 26 — a message queued in one chat ran in whatever chat was on screen when its turn ended.
  if (want.has("26")) await guarded("26", check, () => checks26(js, check));

  // 36 — the Settings nav could cut its last rows off on a window too short for them; and the
  // settings window sat under the system's window controls on a small window.
  if (want.has("36")) await guarded("36", check, () => checks36(js, check));

  // 47 — Danya's Settings items (Д25–Д28): Done, one status line, toasts inside Settings, no On / Off words.
  if (want.has("47")) await guarded("47", check, () => checks47(js, check));

  await wait(100);
}
