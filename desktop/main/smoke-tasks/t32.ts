import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserWindow } from "electron";

import * as cli from "../agent-cli.js";
import {
  configGet,
  keyNamesAvailable,
  normaliseLlmBlock,
  providerIsUsable,
  removeProvider,
  upsertProvider,
  verifyProviderKey,
  type ProviderEntry,
} from "../agent-cli.js";
import { resolveBinary } from "../agent-client.js";

/**
 * Release-fix checks for backlog item 32 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=32`.
 *
 * 32 — "AI/ML API doesn't work; OpenRouter works." The AI/ML API key saved in
 * the config had a character no key has. The agent refuses such a key on every
 * request before anything is sent (src/llm/provider/openai/ascii-header-guard.ts),
 * the turn falls over to the next provider in the chain, and what the window
 * showed was the last link's `fetch failed`: "The model isn't answering (no
 * connection)". The desktop let the key in: the key field took whatever it was
 * given, the key check turned fetch's own refusal of the header into "Could not
 * reach api.aimlapi.com — the key was not checked" and offered Save unchecked,
 * and a key saved that way read "Key saved" everywhere.
 *
 * Every key here is a dummy made up in this file; none is anyone's. Nothing
 * reaches a provider: for the run, main's fetch answers any request carrying
 * one of these dummies itself, after the same header check the real fetch
 * makes first (the Headers constructor), and passes everything else through.
 * The wizard's writes and switches are answered by stand-ins on the window's
 * own IPC (a webContents handler is asked before ipcMain's; a probe proves it
 * before anything relies on it), so the config is not written. The one write
 * that could land in main is taken back out, and the throwaway state
 * directory is removed.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Fetch = typeof globalThis.fetch;
type Call = { ch: string; id?: unknown; apiKey?: unknown; on?: unknown };

const ID = "smoke-t32";
const SENTENCE = "That key has a character keys don\u2019t have; paste it again.";
/** A Cyrillic es where a Latin c belongs: a key typed in the wrong keyboard layout. */
const CYRILLIC = "smoke-t32-key-\u0441";
/** A no-break space inside the key: Latin-1, so the real fetch would send it as it is. */
const NBSP_INSIDE = "smoke-t32-key\u00a0inside";
/** What a copy from a web page or a chat can carry around a key. */
const PASTED = "\u00a0\u200b smoke-t32-key-0123456789\u200b\u00a0\u2060";
const PASTED_CLEAN = "smoke-t32-key-0123456789";
/** What a real paste leaves in the field (the browser keeps both): trim() takes the NBSP, not the zero-width space. */
const LEFTOVER = "\u00a0smoke-t32-key-0123\u200b";
const LEFTOVER_CLEAN = "smoke-t32-key-0123";
const MODEL = "openai/gpt-5.5-2026-04-23";

const q = (v: unknown) => JSON.stringify(v);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (s: unknown) => JSON.stringify(s, (_k, v) => (typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) : v));

/** Main's fetch for the run: the dummies get the real header check and a 401 from here, never the network. */
function stubFetch(): { calls: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    if (!JSON.stringify(init?.headers ?? {}).includes("smoke-t32")) return real(input, init);
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    // What the real fetch does before it opens a connection: a header value
    // that is not a ByteString (a character above U+00FF) throws a TypeError here.
    void new Headers(init?.headers);
    return new Response(JSON.stringify({ error: { message: "smoke t32: answered in main, nothing was sent" } }),
      { status: 401, headers: { "content-type": "application/json" } });
  }) as Fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function providersOf(config: unknown): ProviderEntry[] {
  const llm = (config as { llm?: { providers?: ProviderEntry[] } } | undefined)?.llm;
  return Array.isArray(llm?.providers) ? llm!.providers! : [];
}

export async function checks32(js: Js, check: Check): Promise<void> {
  const fx = stubFetch();
  try {
    await keyCheck(check, fx.calls);
    await mainWrite(check);
    storedKey(check);
    writePath(check);
    await wizard(js, check, fx.calls);
    await storedKeyInWindow(js, check);
  } finally {
    fx.restore();
  }
}

/* The key check in main: a key that cannot travel in a header is refused by
   the check itself, with the sentence — never "Could not reach …", which is
   what fetch's own TypeError became, and never sent for a provider to reject. */
async function keyCheck(check: Check, calls: string[]): Promise<void> {
  const n0 = calls.length;
  const v = await verifyProviderKey({ id: ID, kind: "aimlapi", apiKey: CYRILLIC }, MODEL);
  check(
    "T32: the key check refuses a key with a character keys don't have in its own words — not \"Could not reach … not checked\", nothing sent",
    v.ok === false && v.checked === true && v.error === SENTENCE && calls.length === n0,
    show({ v, sent: calls.length - n0 }),
  );
  const n1 = calls.length;
  const w = await verifyProviderKey({ id: ID, kind: "aimlapi", apiKey: NBSP_INSIDE }, MODEL);
  check(
    "T32: a no-break space inside the key is refused the same way, not sent for the provider to turn down",
    w.ok === false && w.checked === true && w.error === SENTENCE && calls.length === n1,
    show({ w, sent: calls.length - n1 }),
  );
}

/* main's write: whichever window path hands it such a key, it is not saved. */
async function mainWrite(check: Check): Promise<void> {
  try {
    const res = await upsertProvider({ id: ID, kind: "openai-compatible", baseUrl: "https://smoke-t32.invalid", apiKey: CYRILLIC });
    const after = await configGet();
    const saved = providersOf(after.config).some((p) => p.id === ID);
    check(
      "T32: main refuses to save a key with such a character, whichever window path sends it",
      res.ok === false && res.error === SENTENCE && !saved,
      show({ ok: res.ok, error: res.error, saved }),
    );
  } finally {
    const now = await configGet();
    if (providersOf(now.config).some((p) => p.id === ID)) await removeProvider(ID);
  }
}

/* A key already saved with such a character is not a usable key: the
   provider list, the switches and the composer read this. */
function storedKey(check: Check): void {
  const invalid = (cli as unknown as Record<string, unknown>)["providerKeyInvalid"];
  const stored: ProviderEntry = { id: ID, kind: "aimlapi", apiKey: CYRILLIC, defaultChatModel: MODEL };
  check(
    "T32: a key already saved with such a character does not count as a usable key, and says why",
    providerIsUsable(stored) === false && typeof invalid === "function" && (invalid as (e: ProviderEntry) => boolean)(stored) === true,
    show({ usable: providerIsUsable(stored), providerKeyInvalid: typeof invalid }),
  );
  const VAR = "SMOKE_T32_API_KEY";
  const had = Object.prototype.hasOwnProperty.call(process.env, VAR) ? process.env[VAR] : undefined;
  try {
    const viaEnv: ProviderEntry = { id: ID, kind: "openai-compatible", baseUrl: "https://smoke-t32.invalid", apiKeyEnvVar: VAR, defaultChatModel: "m" };
    process.env[VAR] = "smoke-t32-key\u200b";
    const bad = providerIsUsable(viaEnv, keyNamesAvailable());
    process.env[VAR] = "smoke-t32-key";
    const good = providerIsUsable(viaEnv, keyNamesAvailable());
    check(
      "T32: the same for a key read from the environment or .env, and a plain key there still counts",
      bad === false && good === true,
      show({ bad, good }),
    );
  } finally {
    if (had === undefined) delete process.env[VAR];
    else process.env[VAR] = had;
  }
}

/* Item 2's question, answered on the path itself: does the desktop's config
   write add or drop characters? The same read-modify-write upsertProvider
   makes (`config get`, then `config set '<whole file>'`), against a throwaway
   state directory. What goes in comes back — the plain key and the bad one —
   so the agent's config layer stores a key as it is given, and the refusal
   has to happen before it. */
function writePath(check: Check): void {
  const bin = resolveBinary();
  const dir = mkdtempSync(join(tmpdir(), "aa-t32-"));
  try {
    const env = { ...process.env, ATOMIC_AGENT_STATE_DIR: dir };
    const read = () => {
      const r = bin ? spawnSync(bin, ["config", "get"], { env, encoding: "utf8", timeout: 60_000 }) : null;
      try { return r && r.status === 0 ? JSON.parse(r.stdout) as Record<string, unknown> : null; } catch { return null; }
    };
    const roundTrip = (key: string): { status: number | null; back: unknown } => {
      const cfg = read();
      if (!cfg) return { status: null, back: undefined };
      cfg["llm"] = { activeTextProvider: "local-llama", providers: [{ id: ID, kind: "aimlapi", apiKey: key, defaultChatModel: MODEL }] };
      normaliseLlmBlock(cfg);
      const set = spawnSync(bin!, ["config", "set", JSON.stringify(cfg)], { env, encoding: "utf8", timeout: 60_000 });
      const back = providersOf(read()).find((p) => p.id === ID)?.apiKey;
      return { status: set.status, back };
    };
    const plain = roundTrip(PASTED_CLEAN);
    const odd = roundTrip(CYRILLIC);
    check(
      "T32: the config write stores a key exactly as it is given — nothing added, nothing taken away, a bad character included",
      !!bin && plain.status === 0 && plain.back === PASTED_CLEAN && odd.status === 0 && odd.back === CYRILLIC,
      show({ bin: !!bin, plain, odd }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* The key field, in the provider setup the composer and Settings › Models open
   (the first-run setup draws the same field from the same state). */
async function wizard(js: Js, check: Check, calls: string[]): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const seen: Call[] = [];
  const stand: Record<string, (_e: unknown, payload: unknown) => unknown> = {
    "cli:upsertProvider": (_e, entry) => {
      const e = (entry ?? {}) as { id?: unknown; apiKey?: unknown };
      seen.push({ ch: "upsert", id: e.id, apiKey: e.apiKey });
      return { ok: true, stdout: "", stderr: "" };
    },
    "cli:providerModels": () => ({ ok: true, smokeT32: true, models: [{ provider: "aimlapi", id: MODEL, kind: "chat" }] }),
    "cli:removeProvider": (_e, id) => { seen.push({ ch: "remove", id }); return { ok: true, stdout: "", stderr: "" }; },
    "app:unverifiedSet": (_e, p) => { seen.push({ ch: "unverified", on: (p as { on?: unknown } | null)?.on }); return { ok: true }; },
    "cli:selectCloudModel": () => { seen.push({ ch: "select" }); return { ok: false, error: "smoke t32: nothing is switched" }; },
    "cli:activateProvider": () => { seen.push({ ch: "activate" }); return { ok: false, error: "smoke t32: nothing is switched" }; },
  };
  let staged = false;
  try {
    for (const w of wins) for (const [ch, fn] of Object.entries(stand)) w.webContents.ipc.handle(ch, fn);
    const probe = await js<{ smokeT32?: boolean } | null>("BR.providerModels('smoke-t32-probe', 'aimlapi')").catch((e: unknown) => String(e));
    if (typeof probe !== "object" || probe?.smokeT32 !== true) {
      check("T32: stand-ins on the window's IPC answer the setup's writes first", false, `${q(probe)}; the setup was not driven`);
      return;
    }
    staged = await js<boolean>(`(() => {
      window.__t32Keep = {wiz: Object.assign({}, WIZ), open: SEL.open, err: SEL.err, kind: SEL.kind, addOpen: SEL.addOpen};
      window.__t32Open = () => {
        WIZ.unfinishedId = null; act('close');
        SEL.open = true; SEL.err = null;
        Object.assign(WIZ, {row: KIND_ROWS.find((k) => k.id === 'aimlapi'), phase: 'configure', apiKey: '', baseUrl: '', error: null,
          errorDetail: null, uncheckedFor: null, acceptUnchecked: false, modelChosen: false, forId: null, unfinishedId: null});
        render();
        return document.querySelector('#overlays .selpop #wiz-key');
      };
      window.__t32Paste = (el, text) => {
        const dt = new DataTransfer(); dt.setData('text/plain', text);
        let ev = null;
        try { ev = new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}); } catch (e) { ev = null; }
        if (!ev || !ev.clipboardData) { ev = new Event('paste', {bubbles: true, cancelable: true}); Object.defineProperty(ev, 'clipboardData', {value: dt}); }
        el.focus(); el.dispatchEvent(ev);
      };
      window.__t32Settle = async () => { for (let i = 0; i < 100 && (WIZ.stepping || WIZ.phase === 'verifying'); i++) await new Promise((r) => setTimeout(r, 50)); };
      window.__t32View = () => { const k = document.querySelector('#overlays .selpop #wiz-key');
        return {field: k ? k.value : null, apiKey: WIZ.apiKey, phase: WIZ.phase, error: WIZ.error, unchecked: !!WIZ.uncheckedFor,
          saveUnchecked: !!document.querySelector('[data-act="wiz:saveUnchecked"]')}; };
      return true; })()`);

    // A paste: the no-break spaces, the zero-width space and the word joiner go; the key stays.
    const pasted = await js<Record<string, unknown>>(`(() => { const k = window.__t32Open(); if (!k) return {field: null};
      window.__t32Paste(k, ${q(PASTED)}); return window.__t32View(); })()`);
    check(
      "T32: a pasted key loses the no-break and zero-width characters around it — the field holds the key alone",
      pasted["field"] === PASTED_CLEAN && pasted["apiKey"] === PASTED_CLEAN && !pasted["error"],
      show(pasted),
    );

    // A paste with a character keys don't have: refused on the spot, the field as it was.
    const refused = await js<Record<string, unknown>>(`(() => { const k = window.__t32Open(); if (!k) return {field: null};
      window.__t32Paste(k, ${q(CYRILLIC)}); return window.__t32View(); })()`);
    check(
      "T32: a pasted key with a character keys don't have is refused at the paste, with the sentence — the field stays empty, no Save unchecked",
      refused["field"] === "" && refused["error"] === SENTENCE && refused["unchecked"] === false && refused["saveUnchecked"] === false,
      show(refused),
    );

    // Typed in the wrong layout, then Next: refused before anything is saved or asked.
    seen.length = 0;
    const n0 = calls.length;
    const typed = await js<Record<string, unknown>>(`(async () => { const k = window.__t32Open(); if (!k) return {field: null};
      k.focus(); k.value = ${q(CYRILLIC)}; k.dispatchEvent(new Event('input', {bubbles: true}));
      act('wiz:next'); await window.__t32Settle(); return window.__t32View(); })()`);
    check(
      "T32: Next with such a key typed is refused with the sentence before anything is saved or sent — no \"Could not reach\", no Save unchecked",
      typed["phase"] === "configure" && typed["error"] === SENTENCE && typed["unchecked"] === false && typed["saveUnchecked"] === false
        && !seen.some((c) => c.ch === "upsert") && calls.length === n0,
      show({ typed, calls: seen, sent: calls.length - n0 }),
    );

    // Save unchecked, pressed with such a key in the field: refused the same way.
    seen.length = 0;
    const unchecked = await js<Record<string, unknown>>(`(async () => { const k = window.__t32Open(); if (!k) return {field: null};
      WIZ.uncheckedFor = {id: 'aimlapi', model: ${q(MODEL)}, label: 'AI/ML API'};
      WIZ.error = 'Could not reach api.aimlapi.com — the key was not checked.'; render();
      const k2 = document.querySelector('#overlays .selpop #wiz-key'); k2.value = ${q(CYRILLIC)}; WIZ.apiKey = ${q(CYRILLIC)};
      const offered = !!document.querySelector('[data-act="wiz:saveUnchecked"]');
      act('wiz:saveUnchecked'); await window.__t32Settle(); return Object.assign({offered}, window.__t32View()); })()`);
    check(
      "T32: Save unchecked cannot save such a key either — refused with the sentence, nothing saved, nothing marked unverified",
      unchecked["offered"] === true && unchecked["phase"] === "configure" && unchecked["error"] === SENTENCE
        && !seen.some((c) => c.ch === "upsert" || c.ch === "unverified"),
      show({ unchecked, calls: seen }),
    );

    // What a real paste leaves in the field around the key is gone before it is saved.
    seen.length = 0;
    const leftover = await js<Record<string, unknown>>(`(async () => { const k = window.__t32Open(); if (!k) return {field: null};
      k.focus(); k.value = ${q(LEFTOVER)}; k.dispatchEvent(new Event('input', {bubbles: true}));
      act('wiz:next'); await window.__t32Settle(); return window.__t32View(); })()`);
    const up = seen.find((c) => c.ch === "upsert");
    check(
      "T32: a key with a no-break space and a zero-width space around it is saved as the key alone",
      !!up && up.apiKey === LEFTOVER_CLEAN,
      show({ saved: up ? up.apiKey : null, view: leftover }),
    );

    // A key the check finds bad (one read from .env, the field left blank): the sentence, in red, no Save unchecked.
    seen.length = 0;
    for (const w of wins) w.webContents.ipc.handle("cli:verifyProviderKey", () => ({ ok: false, checked: true, keyChars: true, error: SENTENCE }));
    let fromEnv: Record<string, unknown> = {};
    try {
      fromEnv = await js<Record<string, unknown>>(`(async () => { const k = window.__t32Open(); if (!k) return {field: null};
        act('wiz:next'); await window.__t32Settle(); return window.__t32View(); })()`);
    } finally {
      for (const w of wins) if (!w.isDestroyed()) w.webContents.ipc.removeHandler("cli:verifyProviderKey");
    }
    check(
      "T32: when the key check finds such a character (a key read from .env), the setup says the sentence — not \"didn't accept this key\" — with no Save unchecked",
      fromEnv["phase"] === "configure" && fromEnv["error"] === SENTENCE && fromEnv["unchecked"] === false && fromEnv["saveUnchecked"] === false,
      show(fromEnv),
    );

    // The key screen of a provider whose saved key is bad, Next with the field
    // left blank: blank keeps that key, so the screen asks for a new one and
    // saves nothing. The provider is staged in the window's copy of the config.
    seen.length = 0;
    // A blank field reads the key from .env: the check is stood in too, so a
    // key this run's state happens to hold is never sent anywhere.
    for (const w of wins) w.webContents.ipc.handle("cli:verifyProviderKey", () => { seen.push({ ch: "verify" }); return { ok: false, checked: true, error: "smoke t32: not asked" }; });
    let blank: Record<string, unknown> = {};
    try {
      blank = await js<Record<string, unknown>>(`(async () => {
        const keep = LIVE_CONFIG;
        try {
          const cfg = JSON.parse(JSON.stringify(LIVE_CONFIG || {}));
          cfg.llm = cfg.llm || {};
          cfg.llm.providers = (cfg.llm.providers || []).filter((x) => x.id !== 'aimlapi')
            .concat([{id: 'aimlapi', kind: 'aimlapi', baseUrl: 'https://api.aimlapi.com', apiKey: ${q(CYRILLIC)}, defaultChatModel: ${q(MODEL)}}]);
          LIVE_CONFIG = cfg;
          const k = window.__t32Open(); if (!k) return {field: null};
          act('wiz:next'); await window.__t32Settle(); return window.__t32View();
        } finally { LIVE_CONFIG = keep; }
      })()`);
    } finally {
      for (const w of wins) if (!w.isDestroyed()) w.webContents.ipc.removeHandler("cli:verifyProviderKey");
    }
    check(
      "T32: Next with the field blank on a provider whose saved key is bad asks for the key again and saves nothing",
      blank["phase"] === "configure" && /^The key saved for AI\/ML API has a character keys don’t have/.test(String(blank["error"] ?? ""))
        && blank["saveUnchecked"] === false && !seen.some((c) => c.ch === "upsert" || c.ch === "verify"),
      show({ blank, calls: seen }),
    );
  } finally {
    /* The setup is closed with nothing left to drop, before the stand-ins come
       off: a removal it still owed would otherwise reach the real config. */
    if (staged) {
      await js<unknown>(`(() => { const k = window.__t32Keep || {};
        WIZ.unfinishedId = null; act('close');
        Object.assign(WIZ, k.wiz || {}, {unfinishedId: null, stepping: false});
        SEL.open = !!k.open; SEL.err = k.err || null; if (k.kind) SEL.kind = k.kind; SEL.addOpen = !!k.addOpen;
        ['__t32Keep', '__t32Open', '__t32Paste', '__t32Settle', '__t32View'].forEach((n) => { delete window[n]; });
        render(); })()`).catch(() => undefined);
    }
    for (const w of wins) if (!w.isDestroyed()) for (const ch of Object.keys(stand)) w.webContents.ipc.removeHandler(ch);
  }
  await wait(50);
}

/* A key that is already saved with such a character, in the window: Settings ›
   Models says so next to the provider, the composer's provider list says so and
   opens the key screen with the reason, and a turn on that provider names the
   key instead of "no connection". The provider is staged in the window's copy of
   the config only; the file is not touched. */
async function storedKeyInWindow(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, unknown>>(`(() => {
    const p = {id: ${q(ID)}, kind: 'aimlapi', apiKey: ${q(CYRILLIC)}, defaultChatModel: ${q(MODEL)}};
    const keep = {cfg: LIVE_CONFIG, ids: BSW.readyIds, loaded: BSW.readyLoaded, kind: SEL.kind, err: SEL.err, wiz: Object.assign({}, WIZ), want: SWX.want};
    const text = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.textContent || ''; };
    try {
      const row = llmProviderRow(p);
      const settings = {available: row.available, action: row.primaryAction, text: text(llmRowHTML(row, 0, -1))};
      const cfg = JSON.parse(JSON.stringify(LIVE_CONFIG || {}));
      cfg.llm = cfg.llm || {};
      cfg.llm.providers = (cfg.llm.providers || []).filter((x) => x.id !== p.id).concat([p]);
      LIVE_CONFIG = cfg; SWX.want = null;
      BSW.readyIds = (keep.ids || []).filter((x) => x !== p.id); BSW.readyLoaded = true;
      SEL.kind = 'provider';
      const listed = (selRows().find((x) => x.id === p.id) || {}).detail || null;
      bswOpenKey(p.id);
      const keyScreen = {err: SEL.err, wizErr: WIZ.error, phase: WIZ.phase};
      cfg.llm.activeTextProvider = p.id;
      const waitLine = tpWaitNotice({reason: 'fetch failed', maxWaitMs: 300000});
      const failLine = text(turnFailureLine({kind: 'error', category: 'transport', error: 'fetch failed'}));
      return {settings, listed, keyScreen, waitLine, failLine};
    } finally {
      LIVE_CONFIG = keep.cfg; BSW.readyIds = keep.ids; BSW.readyLoaded = keep.loaded; SEL.kind = keep.kind; SEL.err = keep.err;
      Object.assign(WIZ, keep.wiz); SWX.want = keep.want; render();
    }
  })()`);
  const settings = (r["settings"] ?? {}) as { available?: unknown; action?: unknown; text?: unknown };
  const stext = String(settings.text ?? "");
  check(
    "T32: Settings › Models marks a saved key with such a character as invalid next to its provider, and Enter opens the key screen",
    settings.available === false && settings.action === "configure" && /Key invalid/.test(stext)
      && /character keys don\u2019t have/.test(stext) && !/Key saved/.test(stext),
    show(settings),
  );
  const keyScreen = (r["keyScreen"] ?? {}) as { err?: unknown; wizErr?: unknown; phase?: unknown };
  check(
    "T32: the composer's provider list says the saved key is invalid, and choosing it opens the key screen saying why",
    /invalid/i.test(String(r["listed"] ?? "")) && keyScreen.phase === "configure"
      && /saved for .*character keys don\u2019t have/.test(String(keyScreen.wizErr ?? "")),
    show({ listed: r["listed"], keyScreen }),
  );
  check(
    "T32: a turn on that provider names its saved key — not \"no connection\"",
    /saved for .*character keys don\u2019t have/.test(String(r["waitLine"] ?? "")) && !/no connection/.test(String(r["waitLine"] ?? ""))
      && /saved for .*character keys don\u2019t have/.test(String(r["failLine"] ?? "")),
    show({ waitLine: r["waitLine"], failLine: r["failLine"] }),
  );
}
