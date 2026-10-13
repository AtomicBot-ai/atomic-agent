import { BrowserWindow } from "electron";

import { providerModels, withCliStandIn, type CliResult } from "../agent-cli.js";

/**
 * Release-fix check (see main/release-fixes-smoke.ts). Run alone with
 * `--smoke --smoke-task=115`.
 *
 * ATO-318 (a) — Settings › Models › Cloud listed 32 AI/ML API models ("Showing
 * 1–12 of 32. Filter to find the rest.") and the filter could only search
 * those: `models search` answers `aimlapi` and `openrouter` from the snapshot
 * bundled in the agent unless asked with `--refresh`, and every list was cut
 * at 200. Settings now asks for the live list (`live`), with a limit past any
 * catalogue; when the live fetch did not come back the list is the snapshot,
 * and the pane says so and carries a Try again.
 *
 * ATO-318 (b) — scrolled down in Settings › Models, the pane jumped back to
 * the top on a 5 s poll: the repaint put the focus back on the button it was
 * on (a mode tab at the top) with a focus that scrolls. The pane's scroll, the
 * focus and a field's caret are kept now, on the in-place repaint and on the
 * whole window's rebuild alike.
 *
 * ATO-318 (c) — the Fallback chain and its picker named providers by id
 * ("dashscope"); they use the provider's name and mark as the Cloud rows do.
 *
 * The window's IPC is answered by a stand-in for the model list only; what the
 * checks stage is put back.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Failed = { err?: string };

const show = (s: unknown) => JSON.stringify(s);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ids = (n: number) => Array.from({ length: n }, (_, i) => `smoke-t115/model-${String(i).padStart(3, "0")}`);
const list = (n: number) => ids(n).map((id) => ({ provider: "aimlapi", id, kind: "chat" }));

async function safe<T>(js: Js, code: string): Promise<T & Failed> {
  try {
    return (await js<T & Failed>(code)) ?? ({ err: "the renderer answered nothing" } as T & Failed);
  } catch (e) {
    return { err: `the renderer threw: ${message(e)}` } as T & Failed;
  }
}

export async function checks115(js: Js, check: Check): Promise<void> {
  await inMain(check);
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const asked: Array<{ id: string; live: boolean }> = [];
  let answer: unknown = { ok: true, models: [] };
  const handler = (_e: unknown, p: unknown) => {
    const o = (p ?? {}) as { id?: unknown; live?: unknown };
    asked.push({ id: String(o.id ?? ""), live: o.live === true });
    return answer;
  };
  try {
    for (const x of wins) { x.webContents.ipc.removeHandler("cli:providerModels"); x.webContents.ipc.handle("cli:providerModels", handler); }
    await inWindow(js, check, asked, (a) => { answer = a; });
  } finally {
    for (const x of wins) if (!x.isDestroyed()) x.webContents.ipc.removeHandler("cli:providerModels");
  }
}

/* ---- main: the live list, the limit, and how a fallback snapshot is told ---- */
async function inMain(check: Check): Promise<void> {
  const seen: string[][] = [];
  const reply = (models: unknown[]): CliResult => ({ ok: true, stdout: JSON.stringify(models), stderr: "" });
  const live = await withCliStandIn(async (args) => {
    seen.push(args);
    return reply(args.includes("--refresh") ? list(337) : list(32));
  }, () => providerModels("aimlapi", "aimlapi", { live: true }));
  const refreshed = seen.find((a) => a.includes("--refresh"));
  check(
    "T115 (ATO-318): Settings' list for AI/ML API is the live one (--refresh, a limit past the catalogue), all 337, not the 32 of the snapshot",
    live.ok && live.models?.length === 337 && live.stale !== true && !!refreshed
      && refreshed[refreshed.indexOf("--limit") + 1] === "5000",
    show({ n: live.models?.length, stale: live.stale, seen }),
  );

  const same = await withCliStandIn(async () => reply(list(32)), () => providerModels("aimlapi", "aimlapi", { live: true }));
  const failed = await withCliStandIn(
    async (args) => (args.includes("--refresh") ? { ok: false, stdout: "", stderr: "", error: "the agent did not answer" } : reply(list(32))),
    () => providerModels("aimlapi", "aimlapi", { live: true }),
  );
  check(
    "T115 (ATO-318): a refreshed list that is the snapshot, or a refresh that failed, comes back as the snapshot marked `stale`",
    same.ok && same.stale === true && same.models?.length === 32 && failed.ok && failed.stale === true && failed.models?.length === 32,
    show({ same: { ok: same.ok, stale: same.stale }, failed: { ok: failed.ok, stale: failed.stale, error: failed.error } }),
  );

  const asked: string[][] = [];
  const plain = await withCliStandIn(async (args) => { asked.push(args); return reply(list(32)); }, () => providerModels("aimlapi", "aimlapi"));
  check(
    "T115 (ATO-318): the setup and the selector keep the quick bundled list (no --refresh, limit 200, one call, never `stale`)",
    plain.ok && plain.stale === undefined && asked.length === 1 && !asked[0]!.includes("--refresh") && asked[0]![asked[0]!.indexOf("--limit") + 1] === "200",
    show(asked),
  );
}

/* ---- the window ---- */
async function inWindow(js: Js, check: Check, asked: Array<{ id: string; live: boolean }>, set: (a: unknown) => void): Promise<void> {
  const staged = await safe<{ ok: boolean }>(js, `(async () => {
    window.__t115Keep = {cfg: LIVE_CONFIG, settings: S.settings, pane: S.settingsPane, mode: LLMP.mode, models: LLMP.models, modelsFor: LLMP.modelsFor,
      busy: LLMP.modelsBusy, err: LLMP.modelsErr, stale: LLMP.modelsStale, filter: LLMP.filter, cursor: LLMP.cursor.cloud, picker: LLMP.fallbackPicker};
    window.__settingsOpen('llm');
    if (LLMP.inflight) await LLMP.inflight;
    const keep = window.__t115Keep.cfg || {};
    LIVE_CONFIG = Object.assign({}, keep, {llm: {activeTextProvider: 'aimlapi', providers: [
      {id: 'local-llama', kind: 'llama-server', url: 'http://127.0.0.1:19091'},
      {id: 'aimlapi', kind: 'aimlapi', defaultChatModel: 'smoke-t115/model-000'},
      {id: 'dashscope', kind: 'qwen-openai-compatible', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'}]}});
    // Tall enough to scroll whatever the window's height.
    const st = document.createElement('style'); st.id = 't115-tall';
    st.textContent = '#settings .setbody > *:last-child{margin-bottom:2400px}';
    document.head.appendChild(st);
    window.__t115Load = async () => {
      if (LLMP.modelsRetry) { clearTimeout(LLMP.modelsRetry); LLMP.modelsRetry = null; }
      LLMP.modelsFor = null; LLMP.models = []; LLMP.modelsErr = null; LLMP.filter = '';
      llmSetMode('cloud');
      await llmEnsureModels();
      for (let i = 0; i < 100 && LLMP.modelsBusy; i++) await new Promise((r) => setTimeout(r, 50));
    };
    window.__t115List = () => {
      const box = document.getElementById('llm-cloud-models');
      return {rows: box ? [...box.querySelectorAll('.llm-id')].map((n) => n.textContent) : [],
        counter: ((box && box.querySelector('.llm-counter:not(.llm-stale)')) || {}).textContent || '',
        stale: ((box && box.querySelector('.llm-stale')) || {}).textContent || '',
        retry: !!(box && box.querySelector('.llm-stale [data-act="llm:modelsRetry"]'))};
    };
    return {ok: true};
  })()`);
  if (!staged.ok) { check("T115 (ATO-318): Settings › Models was staged", false, show(staged)); return; }
  try {
    /* (a) the whole live list, filtered across all of it */
    set({ ok: true, models: list(300) });
    asked.length = 0;
    const loaded = await safe<{ before: { rows: string[]; counter: string }; after: { rows: string[]; counter: string } }>(js, `(async () => {
      await window.__t115Load();
      const before = window.__t115List();
      const n = document.getElementById('llm-filter');
      n.value = 'model-250'; n.dispatchEvent(new Event('input', {bubbles: true}));
      return {before, after: window.__t115List()};
    })()`);
    check(
      "T115 (ATO-318): Settings asks for the live list and the filter finds a model past the first page (300 listed, model-250 found)",
      asked.some((a) => a.id === "aimlapi" && a.live) && /of 300\b/.test(loaded.before?.counter ?? "")
        && (loaded.after?.rows ?? []).includes("smoke-t115/model-250") && !/of 300/.test(loaded.after?.counter ?? "x"),
      show({ asked, loaded }),
    );

    /* (a) the built-in list says so, and Try again asks for the live one */
    set({ ok: true, models: list(32), stale: true });
    const stale = await safe<{ stale: string; retry: boolean }>(js, `(async () => { await window.__t115Load(); return window.__t115List(); })()`);
    set({ ok: true, models: list(300) });
    const retried = await safe<{ stale: string; counter: string }>(js, `(async () => {
      llmAct('modelsRetry');
      for (let i = 0; i < 100 && LLMP.modelsBusy; i++) await new Promise((r) => setTimeout(r, 50));
      return window.__t115List();
    })()`);
    check(
      "T115 (ATO-318): a built-in list says the live list from AI/ML API did not load, with Try again; Try again brings the live list",
      /live list from AI\/ML API did not load/.test(stale.stale ?? "") && stale.retry === true
        && !retried.stale && /of 300\b/.test(retried.counter ?? ""),
      show({ stale, retried }),
    );

    /* (b) a repaint keeps the scroll, the focus and the caret */
    const kept = await safe<Record<string, unknown>>(js, `(async () => {
      const box = () => document.querySelector('#settings .setbody');
      const out = {};
      const tab = box().querySelector('[data-act="llm:mode:cloud"]') || box().querySelector('[data-act]');
      tab.focus({preventScroll: true}); box().scrollTop = 400;
      const at = box().scrollTop;
      llmRepaint();
      out.button = {at, after: box().scrollTop, act: (document.activeElement && document.activeElement.dataset) ? document.activeElement.dataset.act : null, want: tab.dataset.act};
      const n = document.getElementById('llm-filter');
      n.focus({preventScroll: true}); n.value = 'model-1'; LLMP.filter = 'model-1'; n.setSelectionRange(3, 3); box().scrollTop = 400;
      const at2 = box().scrollTop;
      llmRepaint();
      const a = document.activeElement;
      out.field = {at: at2, after: box().scrollTop, id: a && a.id, caret: a && a.selectionStart};
      render();
      const b = document.activeElement;
      out.rebuilt = {at: at2, after: box().scrollTop, id: b && b.id, caret: b && b.selectionStart};
      return out;
    })()`);
    const b = kept["button"] as { at: number; after: number; act: string; want: string } | undefined;
    const f = kept["field"] as { at: number; after: number; id: string; caret: number } | undefined;
    const r = kept["rebuilt"] as { at: number; after: number; id: string; caret: number } | undefined;
    check(
      "T115 (ATO-318): a Settings repaint with a button focused keeps the pane where it was scrolled (it jumped to the top)",
      !!b && b.at > 0 && Math.abs(b.after - b.at) <= 1 && b.act === b.want,
      show(kept),
    );
    check(
      "T115 (ATO-318): the model filter keeps the focus, its caret and the pane's scroll through a repaint and a whole render",
      !!f && !!r && f.at > 0 && Math.abs(f.after - f.at) <= 1 && f.id === "llm-filter" && f.caret === 3
        && Math.abs(r.after - r.at) <= 1 && r.id === "llm-filter" && r.caret === 3,
      show(kept),
    );

    /* (c) provider names on the Fallback picker and chain */
    const names = await safe<{ row: string; picker: string }>(js, `(() => {
      const row = llmRowHTML(llmProviderRow(llmProvider('dashscope')), 0, -1);
      LLMP.fallbackPicker = {cursor: 0};
      const picker = llmFallbackHTML();
      LLMP.fallbackPicker = null;
      return {row, picker};
    })()`);
    check(
      "T115 (ATO-318): a DashScope provider reads DashScope with the Qwen mark on the Cloud row and in the Fallback picker, never only its id",
      /llm-name">DashScope</.test(names.row ?? "") && /qwen-color\.svg/.test(names.row ?? "")
        && /llm-name">DashScope</.test(names.picker ?? "") && /qwen-color\.svg/.test(names.picker ?? ""),
      show(names),
    );
  } finally {
    await safe(js, `(() => {
      const k = window.__t115Keep; if (!k) return {ok: true};
      if (LLMP.modelsRetry) { clearTimeout(LLMP.modelsRetry); LLMP.modelsRetry = null; }
      const st = document.getElementById('t115-tall'); if (st) st.remove();
      LIVE_CONFIG = k.cfg; LLMP.mode = k.mode; LLMP.models = k.models; LLMP.modelsFor = k.modelsFor; LLMP.modelsBusy = k.busy;
      LLMP.modelsErr = k.err; LLMP.modelsStale = k.stale; LLMP.filter = k.filter; LLMP.cursor.cloud = k.cursor; LLMP.fallbackPicker = k.picker;
      S.settings = k.settings; S.settingsPane = k.pane;
      const a = document.activeElement; if (a && a.blur) a.blur();
      render();
      delete window.__t115Keep; delete window.__t115Load; delete window.__t115List;
      return {ok: true};
    })()`);
  }
}
