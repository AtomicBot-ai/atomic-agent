import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserWindow, Menu } from "electron";

import { plainCliError } from "./agent-cli.js";
import { resolveBinary } from "./agent-client.js";

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

export const RELEASE_FIX_TASKS = ["04", "05", "06", "07", "08", "12", "15"];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function menuLabels(menu: Electron.Menu | null): string[] {
  if (!menu) return [];
  return menu.items.flatMap((i) => [i.label, ...menuLabels(i.submenu ?? null)]);
}

export async function releaseFixesSmokeTest(js: Js, check: Check, tasks: string[]): Promise<void> {
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
      const saved = {local: LLMP.local, heal: LLMP.staleHealAt, inflight: LLMP.inflight, refresh: window.llmRefresh, status: LLMP.status, err: LLMP.statusErr, down: LLMP.downSince};
      let refreshed = 0;
      try {
        LLMP.local = [{id:'qwen-3.5-9b', downloaded:false}, {id:'gemma-4-12b', downloaded:false}];
        const st = {mode:'managed', activeModel:'qwen-3.5-9b', activeDownloaded:true, daemonRunning:true, daemonPid:1, health:'ok'};
        const staleWhenListLags = llmListIsStale(st);
        const notStaleWhenNotOnDisk = !llmListIsStale(Object.assign({}, st, {activeDownloaded:false}));
        LLMP.local = [{id:'qwen-3.5-9b', downloaded:true}];
        const notStaleWhenAgreeing = !llmListIsStale(st);
        LLMP.local = [{id:'qwen-3.5-9b', downloaded:false}];
        LLMP.staleHealAt = 0; LLMP.inflight = null;
        window.llmRefresh = () => { refreshed++; return Promise.resolve(); };
        llmApplyStatus({ok:true, status:st});
        llmApplyStatus({ok:true, status:st});
        await new Promise((res) => setTimeout(res, 50));
        return {staleWhenListLags, notStaleWhenNotOnDisk, notStaleWhenAgreeing, refreshed};
      } finally {
        window.llmRefresh = saved.refresh; LLMP.local = saved.local; LLMP.staleHealAt = saved.heal; LLMP.inflight = saved.inflight;
        LLMP.status = saved.status; LLMP.statusErr = saved.err; LLMP.downSince = saved.down;
      }
    })()`);
    check(
      "T05: a status that says the active model is on disk re-reads a list that says it is not, once",
      r.staleWhenListLags === true && r.notStaleWhenNotOnDisk === true && r.notStaleWhenAgreeing === true && r.refreshed === 1,
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
  }

  if (want.has("07")) {
    // 07a — "Setup complete" while the model is still downloading.
    const a = await js<Record<string, unknown>>(`(() => {
      const saved = DL.job;
      try {
        DL.job = {kind:'model', id:'qwen-3.5-9b', label:'Qwen 3.5 9B', percent:10};
        const downloading = obClosingToast('local');
        const chip = downloadingChipHtml();
        const busy = dlBusy();
        DL.job = null;
        return {downloading, done: obClosingToast('local'), skipped: obClosingToast('skipped'), chip, busy, idle: dlBusy()};
      } finally { DL.job = saved; }
    })()`);
    check(
      "T07a: closing setup during a download says the model is downloading, not Setup complete",
      Array.isArray(a.downloading) && (a.downloading as string[])[0] === "Your model is downloading"
        && (a.done as string[])[0] === "Setup complete" && (a.skipped as string[])[0] === "Setup skipped",
      JSON.stringify([a.downloading, a.done, a.skipped]),
    );
    check(
      "T07b: while the wizard's download runs the composer says Downloading, and it is not a button",
      a.busy === true && a.idle === false && /Downloading Qwen 3\.5 9B/.test(a.chip as string) && !/data-act|<button/.test(a.chip as string),
      JSON.stringify({ busy: a.busy, idle: a.idle, chip: a.chip }),
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
      const saved = LLMP.downSince;
      try {
        LLMP.downSince = null;
        llmNoteDaemonHealth({daemonRunning:true, daemonPid:4242, health:'down'});
        const fresh = llmJustSpawned();
        LLMP.downSince.at = Date.now() - 120000;
        const old = llmJustSpawned();
        llmNoteDaemonHealth({daemonRunning:true, daemonPid:4242, health:'ok'});
        const healthyClears = LLMP.downSince === null;
        return {fresh, old, healthyClears};
      } finally { LLMP.downSince = saved; }
    })()`);
    check(
      "T07e: a just-spawned server reads Starting for its first 90 s, then Not answering",
      e.fresh === true && e.old === false && e.healthyClears === true,
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

  await wait(100);
}
