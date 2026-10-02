import { BrowserWindow } from "electron";

import { providerKeyPresent } from "../agent-cli.js";

/**
 * Release-fix checks for backlog item 51 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=51`.
 *
 * 51 (ATO-161) — "Adding a cloud provider: no guard, no key check, everything red."
 * Danya added OpenRouter with the key field empty. The composer's quick "Add a
 * provider" pane saved it as it was and said "saved, but could not activate it:
 * no API key", lit AI/ML API as the picked row, left OpenRouter in the provider
 * list with no key, and every screen after it opened in red: the key field, the
 * line under it and the popover's strip said the same thing three times, and the
 * strip stayed under the model list after a good key went in.
 *
 * Now an empty field with nothing behind it (no saved key, no variable) is asked
 * for, calmly, before anything is written or anyone is called; the quick pane is
 * gone (no provider yet opens the wizard's list); a provider with no key opens
 * its own key screen, saying it once; the popover's strip does not follow the
 * wizard's screens.
 *
 * Nothing reaches a provider and the config is not written: the setup's writes,
 * the key check and main's "is there a key behind the empty field" are answered
 * by stand-ins on the window's own IPC (a webContents handler is asked before
 * ipcMain's; a probe proves it first). The window's state is put back.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const ASK = "Paste your OpenRouter API key to continue.";
const show = (s: unknown) => JSON.stringify(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function checks51(js: Js, check: Check): Promise<void> {
  await keyPresentInMain(check);
  await keyScreens(js, check);
}

/* Main's yes-or-no for an empty field: the variable the agent would read, and never the key itself. */
async function keyPresentInMain(check: Check): Promise<void> {
  const NAME = "SMOKE_T51_KEY";
  const had = process.env[NAME];
  try {
    delete process.env[NAME];
    const none = await providerKeyPresent({ kind: "smoke-t51", apiKeyEnvVar: NAME });
    process.env[NAME] = "smoke-t51-dummy-0123456789";
    const some = await providerKeyPresent({ kind: "smoke-t51", apiKeyEnvVar: NAME });
    check(
      "T51: main says whether an empty key field has a variable behind it — no with none, yes with one — and never returns the key",
      none.ok && some.ok && none.present === false && some.present === true && !JSON.stringify(some).includes("smoke-t51-dummy"),
      show({ none, some }),
    );
    // A custom URL on this machine needs no key: an empty field there is not asked for.
    delete process.env[NAME];   // the yes below must come from the local URL, not the variable
    const local = await providerKeyPresent({ kind: "openai-compatible", apiKeyEnvVar: NAME, baseUrl: "http://localhost:8000/v1" });
    check(
      "T51: an empty key on a custom server at localhost is not asked for — a server on this machine needs none",
      local.ok && local.present === true,
      show(local),
    );
  } finally {
    if (had === undefined) delete process.env[NAME]; else process.env[NAME] = had;
  }
}

async function keyScreens(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const seen: Array<{ ch: string; id?: unknown; baseUrl?: unknown }> = [];
  const answer = { present: false, verify: { ok: true, checked: true, status: 200 } as Record<string, unknown> };
  const stand: Record<string, (_e: unknown, payload: unknown) => unknown> = {
    "cli:providerKeyPresent": (_e, p) => {
      seen.push({ ch: "present", baseUrl: (p as { baseUrl?: unknown } | null)?.baseUrl });
      return { ok: true, present: answer.present, smokeT51: true };
    },
    "cli:upsertProvider": (_e, entry) => { seen.push({ ch: "upsert", id: (entry as { id?: unknown } | null)?.id }); return { ok: true, stdout: "", stderr: "" }; },
    "cli:providerModels": () => { seen.push({ ch: "models" }); return { ok: true, models: [{ provider: "openrouter", id: "openrouter/auto", kind: "chat" }] }; },
    "cli:verifyProviderKey": () => { seen.push({ ch: "verify" }); return answer.verify; },
    "cli:removeProvider": (_e, id) => { seen.push({ ch: "remove", id }); return { ok: true, stdout: "", stderr: "" }; },
    "app:unverifiedSet": () => ({ ok: true }),
    /* The setup re-reads the config after a failed check; answered "could not read", the staged copy stands. */
    "cli:configGet": () => ({ ok: false, error: "smoke t51: the staged config stands" }),
    "cli:providersReady": () => ({ ok: false, error: "smoke t51: the staged key list stands" }),
    "cli:selectCloudModel": () => { seen.push({ ch: "select" }); return { ok: false, error: "smoke t51: nothing is switched" }; },
    "cli:activateProvider": () => { seen.push({ ch: "activate" }); return { ok: false, error: "smoke t51: nothing is switched" }; },
  };
  let staged = false;
  try {
    for (const w of wins) for (const [ch, fn] of Object.entries(stand)) w.webContents.ipc.handle(ch, fn);
    const probe = await js<{ smokeT51?: boolean } | null>("BR.providerKeyPresent({kind: 'openrouter'})").catch((e: unknown) => String(e));
    if (typeof probe !== "object" || probe?.smokeT51 !== true) {
      check("T51: stand-ins on the window's IPC answer the setup first", false, `${show(probe)}; the setup was not driven`);
      return;
    }
    seen.length = 0;
    staged = await js<boolean>(`(() => {
      window.__t51Keep = {wiz: Object.assign({}, WIZ), open: SEL.open, err: SEL.err, kind: SEL.kind, addOpen: SEL.addOpen,
        presetCur: SEL.presetCur, cfg: LIVE_CONFIG, ids: BSW.readyIds, loaded: BSW.readyLoaded, want: SWX.want};
      window.__t51Settle = async () => { for (let i = 0; i < 100 && (WIZ.stepping || WIZ.phase === 'verifying'); i++) await new Promise((r) => setTimeout(r, 50)); };
      window.__t51View = () => {
        const pop = document.querySelector('#overlays .selpop');
        return {phase: WIZ.phase, row: WIZ.row && WIZ.row.id, error: WIZ.error, soft: wizErrSoft(), selErr: SEL.err,
          redField: !!(pop && pop.querySelector('.tk-inpwrap.is-error, .tk-inpwrap.is-warn')),
          redLine: !!(pop && pop.querySelector('.ob-err')), strip: !!(pop && pop.querySelector('.selerr')),
          ask: pop && pop.querySelector('.wiz-ask') ? pop.querySelector('.wiz-ask').textContent : null};
      };
      window.__t51Stage = (providers) => {
        const cfg = JSON.parse(JSON.stringify(window.__t51Keep.cfg || {}));
        cfg.llm = cfg.llm || {};
        cfg.llm.providers = providers;
        LIVE_CONFIG = cfg; SWX.want = null; BSW.readyIds = []; BSW.readyLoaded = true;
      };
      WIZ.unfinishedId = null; act('close');
      window.__t51Stage([]);
      SEL.open = true; SEL.err = null; SEL.kind = 'provider';
      Object.assign(WIZ, {row: KIND_ROWS.find((k) => k.id === 'openrouter'), phase: 'configure', apiKey: '', baseUrl: '', error: null, softError: null,
        errorDetail: null, uncheckedFor: null, acceptUnchecked: false, modelChosen: false, forId: null, unfinishedId: null});
      render();
      return !!document.querySelector('#overlays .selpop #wiz-key');
    })()`);

    // 1. Next with the field empty and nothing behind it: asked for, calmly; nothing saved, nobody called.
    const empty = await js<Record<string, unknown>>(`(async () => { act('wiz:next'); await window.__t51Settle(); return window.__t51View(); })()`);
    check(
      "T51: Next with an empty key and no variable behind it asks for the key — one calm line, the field unlit, nothing red",
      staged && empty["phase"] === "configure" && empty["error"] === ASK && empty["soft"] === true && empty["ask"] === ASK
        && !empty["redField"] && !empty["redLine"] && !empty["strip"],
      show(empty),
    );
    check(
      "T51: …and nothing is saved, listed or checked for it",
      seen.some((c) => c.ch === "present") && !seen.some((c) => ["upsert", "models", "verify", "remove", "activate", "select"].includes(c.ch)),
      show(seen),
    );

    // 2. Typing clears the line; a strip the popover holds is not drawn over the wizard's screens.
    const typed = await js<Record<string, unknown>>(`(() => {
      SEL.err = 'smoke t51: a strip left from the pane before'; render();
      const k = document.querySelector('#overlays .selpop #wiz-key');
      k.focus(); k.value = 's'; k.dispatchEvent(new Event('input', {bubbles: true}));
      return window.__t51View();
    })()`);
    check(
      "T51: the first keystroke clears the request, and the popover's red strip is not drawn under the key field",
      typed["error"] === null && !typed["strip"] && typed["ask"] === null,
      show(typed),
    );
    await js<unknown>("(() => { SEL.err = null; render(); })()");

    // 3. The variable is there, but main's check finds no key after all: still a request, not "didn't accept this key".
    seen.length = 0;
    answer.present = true;
    answer.verify = { ok: false, checked: true, error: "no API key — type one above, or set OPENROUTER_API_KEY" };
    const viaCheck = await js<Record<string, unknown>>(`(async () => {
      Object.assign(WIZ, {apiKey: '', error: null, softError: null, phase: 'configure'}); render();
      const k = document.querySelector('#overlays .selpop #wiz-key'); if (k) k.value = '';
      act('wiz:next'); await window.__t51Settle(); return window.__t51View();
    })()`);
    check(
      "T51: an empty field the key check finds no key for is asked for — not \"didn't accept this key\" — and the entry it wrote is taken back",
      viaCheck["phase"] === "configure" && viaCheck["error"] === ASK && viaCheck["soft"] === true && !viaCheck["redLine"]
        && seen.some((c) => c.ch === "verify") && seen.some((c) => c.ch === "remove" && c.id === "openrouter"),
      show({ viaCheck, calls: seen }),
    );

    // 4. A provider in the list with no key: its key screen asks once, not three times in red.
    answer.present = false;
    const opened = await js<Record<string, unknown>>(`(() => {
      WIZ.phase = null; window.__t51Stage([{id: 'openrouter', kind: 'openrouter', apiKeyEnvVar: 'OPENROUTER_API_KEY'}]);
      SEL.err = null; bswOpenKey('openrouter'); return window.__t51View();
    })()`);
    check(
      "T51: choosing a provider that has no key opens its key screen asking for one — no red field, no red line, no red strip",
      opened["phase"] === "configure" && opened["row"] === "openrouter" && opened["error"] === ASK && opened["soft"] === true
        && opened["selErr"] === null && !opened["redField"] && !opened["redLine"] && !opened["strip"],
      show(opened),
    );

    // 5. A Groq entry with no key opens Groq's screen, not the first OpenAI-compatible preset's (Anthropic).
    const groq = await js<Record<string, unknown>>(`(() => {
      WIZ.phase = null; window.__t51Stage([{id: 'groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai', apiKeyEnvVar: 'GROQ_API_KEY'}]);
      SEL.err = null; bswOpenKey('groq'); return window.__t51View();
    })()`);
    check(
      "T51: a Groq entry with no key opens Groq's key screen — not Anthropic's — asking for a Groq key",
      groq["phase"] === "configure" && groq["row"] === "groq" && groq["error"] === "Paste your Groq API key to continue." && groq["soft"] === true,
      show(groq),
    );

    // 6. A custom URL is handed to main with the empty-field question, so a server on this machine is let through there.
    seen.length = 0;
    answer.present = true;
    answer.verify = { ok: true, checked: true, status: 200 };
    const custom = await js<Record<string, unknown>>(`(async () => {
      WIZ.phase = null; window.__t51Stage([]);
      Object.assign(WIZ, {row: KIND_ROWS.find((k) => k.custom), phase: 'configure', apiKey: '', baseUrl: 'http://localhost:8000/v1', error: null,
        softError: null, forId: null, unfinishedId: null, modelChosen: false}); render();
      act('wiz:next'); await window.__t51Settle(); return window.__t51View();
    })()`);
    check(
      "T51: an empty key on a custom URL asks main with that URL, and goes on to the model step when main says nothing is missing",
      seen.some((c) => c.ch === "present" && c.baseUrl === "http://localhost:8000/v1") && custom["phase"] === "pick_model",
      show({ custom, calls: seen }),
    );

    // 7. A failure is still red: a key the provider turned down.
    seen.length = 0;
    answer.verify = { ok: false, checked: true, status: 401, error: "the provider rejected this key: User not found" };
    const bad = await js<Record<string, unknown>>(`(async () => {
      window.__t51Stage([]);
      Object.assign(WIZ, {row: KIND_ROWS.find((k) => k.id === 'openrouter'), phase: 'configure', apiKey: 'smoke-t51-bad-key-0123', error: null,
        softError: null, forId: null, unfinishedId: null, modelChosen: false}); render();
      act('wiz:next'); await window.__t51Settle(); return window.__t51View();
    })()`);
    check(
      "T51: a key the provider turned down is still said in red, as before",
      bad["phase"] === "configure" && bad["soft"] === false && /didn’t accept this key/.test(String(bad["error"] ?? ""))
        && !!bad["redField"] && !!bad["redLine"],
      show(bad),
    );
  } finally {
    if (staged) {
      await js<unknown>(`(() => { const k = window.__t51Keep || {};
        WIZ.unfinishedId = null; act('close');
        Object.assign(WIZ, k.wiz || {}, {unfinishedId: null, stepping: false});
        LIVE_CONFIG = k.cfg; BSW.readyIds = k.ids || []; BSW.readyLoaded = !!k.loaded; SWX.want = k.want;
        SEL.open = !!k.open; SEL.err = k.err || null; if (k.kind) SEL.kind = k.kind; SEL.addOpen = !!k.addOpen; SEL.presetCur = k.presetCur || 0;
        ['__t51Keep', '__t51Settle', '__t51View', '__t51Stage'].forEach((n) => { delete window[n]; });
        render(); })()`).catch(() => undefined);
    }
    for (const w of wins) if (!w.isDestroyed()) for (const ch of Object.keys(stand)) w.webContents.ipc.removeHandler(ch);
  }
  await wait(50);
}
