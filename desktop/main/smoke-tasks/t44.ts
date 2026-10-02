import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserWindow } from "electron";

import {
  checkProviderKey,
  configGet,
  dotenvSet,
  providerModels,
  removeProvider,
  removeStaleTmpFiles,
  upsertProvider,
  type ProviderEntry,
  type UserConfigShape,
} from "../agent-cli.js";
import { resolveBinary } from "../agent-client.js";
import { DESKTOP_STATE_DIR } from "../state-dir.js";

/**
 * Release-fix checks for ATO-132 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=44`.
 *
 * 44 — the key field said "Saved to .env as AIMLAPI_API_KEY (mode 0600)",
 * and the key went into config.json, mode 0644, handed to `atag config set`
 * on its command line by every whole-file write. The key stays in
 * config.json (in .env it would reach every MCP server and shell job the
 * agent starts); what is done and said around it is made true:
 *   - the agent writes config.json 0600, and the launch tightens config.json
 *     and .env and removes the tmp files a write that died half way left;
 *   - every whole-file write reaches the agent on stdin (`config set -`);
 *   - with no key typed, the key check sends the saved key only to that
 *     provider's own endpoint;
 *   - the key screen says where the key is kept.
 *
 * Every key here is a dummy made up in this file. The save path runs the
 * real `atag` on a throwaway state dir, through a shim that writes down each
 * command line it is given; every provider points at a server this check
 * runs on 127.0.0.1, which records where it was asked and with what key —
 * compared here, never printed. The one write into the app's own state dir
 * (a .env name for the Settings check) is taken back out.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Seen = { path: string; auth: string | null };

const q = (v: unknown) => JSON.stringify(v);
const sh = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const K = {
  typed: "smoke-t44-key-typed-0123456789",
  rekey: "smoke-t44-key-rekey-0123456789",
  gone: "smoke-t44-key-gone-0123456789",
  check: "smoke-t44-key-check-0123456789",
} as const;
const ALL_KEYS: string[] = Object.values(K);
const MODEL = "smoke-t44-model";

/** The server every provider here points at: a model list or a completion, and a record of what it was sent. */
async function loopback(): Promise<{ base: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    seen.push({ path, auth: typeof req.headers.authorization === "string" ? req.headers.authorization : null });
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(path.endsWith("/v1/models")
        ? JSON.stringify({ data: [{ id: MODEL }] })
        : JSON.stringify({ id: "smoke-t44", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

export async function checks44(js: Js, check: Check): Promise<void> {
  launchModes(check);
  leftovers(check);
  const bin = resolveBinary();
  if (!bin) {
    check("T44: the agent binary is there to check against", false, "no agent binary resolved");
    return;
  }
  const lb = await loopback();
  try {
    await savePath(js, check, bin, lb);
    await settingsKeyNames(js, check);
    await hintInWindow(js, check);
    await blankOnBadKeyElsewhere(js, check);
  } finally {
    await lb.close();
  }
}

/* What the launch did to the app's own state dir before this ran: the suite's
   copy starts from a seed whose config.json is 0644. */
function launchModes(check: Check): void {
  const modes = ["config.json", ".env"]
    .map((n) => ({ n, p: join(DESKTOP_STATE_DIR, n) }))
    .filter(({ p }) => existsSync(p))
    .map(({ n, p }) => ({ n, mode: statSync(p).mode & 0o777 }));
  check(
    "T44: at launch the app's config.json and .env are readable by this user only",
    process.platform === "win32" || (modes.some((m) => m.n === "config.json") && modes.every((m) => (m.mode & 0o077) === 0)),
    modes.map((m) => `${m.n} ${m.mode.toString(8)}`).join(", "),
  );
}

/* The launch's sweep (the same function main runs at launch), on a throwaway
   dir: the tmp file of a write that died is gone, one on its way stays. */
function leftovers(check: Check): void {
  const dir = mkdtempSync(join(tmpdir(), "aa-t44-tmp-"));
  try {
    const now = Date.now();
    const put = (name: string, ageMs: number) => {
      writeFileSync(join(dir, name), "{\"llm\":{\"providers\":[{\"apiKey\":\"smoke-t44-key-leftover\"}]}}", { mode: 0o644 });
      const t = (now - ageMs) / 1000;
      utimesSync(join(dir, name), t, t);
    };
    // 999999 is past any pid macOS hands out: that process is gone.
    put("config.json.tmp-999999", 1_000);
    put(".env.tmp-999999", 1_000);
    put(`config.json.tmp-${process.pid}`, 1_000);
    put("config.json.bak", 1_000);
    mkdirSync(join(dir, "nested"));
    const removed = removeStaleTmpFiles(dir, now).sort();
    const left = ["config.json.tmp-999999", ".env.tmp-999999", `config.json.tmp-${process.pid}`, "config.json.bak"].filter((n) => existsSync(join(dir, n)));
    check(
      "T44: at launch the tmp files a dead config or .env write left are removed — never one still being written",
      q(removed) === q([".env.tmp-999999", "config.json.tmp-999999"]) && q(left) === q([`config.json.tmp-${process.pid}`, "config.json.bak"]),
      q({ removed, left }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* The window's save path, the real `atag` on a throwaway state dir behind a
   shim that writes each command line down. Every config read and write the
   app makes during this block goes to that dir; the app's own config is
   re-read afterwards. */
async function savePath(js: Js, check: Check, bin: string, lb: { base: string; seen: Seen[] }): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "aa-t44-save-"));
  const state = join(dir, "state");
  const log = join(dir, "argv.log");
  const shim = join(dir, "atag-shim.sh");
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(shim, [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${sh(log)}`,
    `ATOMIC_AGENT_STATE_DIR=${sh(state)} exec ${sh(bin)} "$@"`,
    "",
  ].join("\n"));
  chmodSync(shim, 0o755);
  const cfgPath = join(state, "config.json");
  const fileText = () => (existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : "");
  const onDisk = (id: string): ProviderEntry | undefined => {
    try {
      return ((JSON.parse(fileText()) as UserConfigShape).llm?.providers ?? []).find((p) => p.id === id);
    } catch {
      return undefined;
    }
  };
  const argv = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const keysOnArgv = () => ALL_KEYS.filter((k) => argv().includes(k)).length;
  const sent = async (id: string, path: string) => {
    const from = lb.seen.length;
    await providerModels(id, "openai-compatible");
    const hit = lb.seen.slice(from).find((s) => s.path === `${path}/v1/models`);
    return hit ? hit.auth : null;
  };
  const entry = (id: string, path: string, apiKey?: string, apiKeyEnvVar?: string): ProviderEntry => ({
    id, kind: "openai-compatible", baseUrl: `${lb.base}${path}`, defaultChatModel: MODEL,
    ...(apiKey ? { apiKey } : {}), ...(apiKeyEnvVar ? { apiKeyEnvVar } : {}),
  });
  const keepBin = process.env.ATOMIC_AGENT_BIN;
  try {
    process.env.ATOMIC_AGENT_BIN = shim;
    await configGet(); // a default config.json, as a first launch writes

    // A key typed in the window: saved inline, the file owner-only, never on a command line, and sent.
    const first = await upsertProvider(entry("smoke-t44", "/one", K.typed, "SMOKE_T44_OWN_KEY"));
    const savedFirst = onDisk("smoke-t44");
    const sentFirst = (await sent("smoke-t44", "/one")) === `Bearer ${K.typed}`;
    const mode = existsSync(cfgPath) ? statSync(cfgPath).mode & 0o777 : -1;
    check(
      "T44: a key typed in the window is saved in config.json as before, the file readable by this user only, and the agent sends it",
      first.ok && savedFirst?.apiKey === K.typed && (process.platform === "win32" || (mode & 0o077) === 0) && sentFirst,
      q({ ok: first.ok, error: first.error, inline: savedFirst?.apiKey === K.typed, mode: mode.toString(8), sent: sentFirst }),
    );
    check(
      "T44: the config write reaches the agent on stdin — no key on any `atag` command line",
      keysOnArgv() === 0 && /^config set -$/m.test(argv()),
      q({ keysOnArgv: keysOnArgv(), lines: argv().split("\n").filter(Boolean).map((l) => l.slice(0, 40)) }),
    );

    // Re-keying replaces it; a blank field (its row naming another variable) keeps the key and the variable the entry reads.
    const rekey = await upsertProvider(entry("smoke-t44", "/one", K.rekey, "SMOKE_T44_OWN_KEY"));
    const blank = await upsertProvider(entry("smoke-t44", "/one", undefined, "SMOKE_T44_ROW_KEY"));
    const kept = onDisk("smoke-t44");
    const sentRekey = (await sent("smoke-t44", "/one")) === `Bearer ${K.rekey}`;
    check(
      "T44: re-keying replaces the key the agent sends; a blank key field keeps the saved key and the variable the entry reads",
      rekey.ok && blank.ok && kept?.apiKey === K.rekey && kept?.apiKeyEnvVar === "SMOKE_T44_OWN_KEY"
        && !fileText().includes(K.typed) && sentRekey && keysOnArgv() === 0,
      q({ rekey: rekey.ok, blank: blank.ok, kept: kept?.apiKey === K.rekey, variable: kept?.apiKeyEnvVar ?? null, oldGone: !fileText().includes(K.typed), sent: sentRekey, keysOnArgv: keysOnArgv() }),
    );

    // A provider the setup created and took back (its key was turned down): no trace of the key.
    const gone = await upsertProvider(entry("smoke-t44-gone", "/gone", K.gone));
    const wrote = fileText().includes(K.gone);
    const removed = await removeProvider("smoke-t44-gone");
    check(
      "T44: a key turned down for a provider the setup created leaves no trace in config.json",
      gone.ok && wrote && removed.ok && !onDisk("smoke-t44-gone") && !fileText().includes(K.gone),
      q({ saved: gone.ok, wrote, removed: removed.ok, keyLeft: fileText().includes(K.gone) }),
    );

    // The key check (N9): with no key typed, the saved key goes to the saved endpoint only.
    const from = lb.seen.length;
    const saved = await checkProviderKey(entry("smoke-t44", "/elsewhere", undefined, "HOME"), MODEL);
    const notSaved = await checkProviderKey(entry("smoke-t44-none", "/elsewhere", undefined, "HOME"), MODEL);
    const typed = await checkProviderKey(entry("smoke-t44-new", "/typed", K.check), MODEL);
    const asked = lb.seen.slice(from).map((s) => ({ path: s.path, key: s.auth === `Bearer ${K.rekey}` ? "saved" : s.auth === `Bearer ${K.check}` ? "typed" : s.auth ? "other" : "none" }));
    check(
      "T44: with no key typed, the key check sends the saved key to that provider's own endpoint only; a typed key goes where it was typed for",
      saved.ok === true && notSaved.ok === false && typed.ok === true
        && q(asked) === q([{ path: "/one/v1/chat/completions", key: "saved" }, { path: "/typed/v1/chat/completions", key: "typed" }]),
      q({ saved: saved.ok, notSaved: notSaved.ok, typed: typed.ok, asked }),
    );
  } finally {
    if (keepBin === undefined) delete process.env.ATOMIC_AGENT_BIN; else process.env.ATOMIC_AGENT_BIN = keepBin;
    rmSync(dir, { recursive: true, force: true });
    // Whatever the window read while the shim stood in, it reads the app's own config again.
    await js<void>("refreshLiveConfig()").catch(() => undefined);
  }
}

/* Settings › Models reads the .env names again whenever the live config is
   re-read, so its Key saved follows a save made on any screen. One name goes
   into the app's own .env and comes out again. */
async function settingsKeyNames(js: Js, check: Check): Promise<void> {
  const NAME = "SMOKE_T44_CHECK_KEY";
  if (process.env[NAME] !== undefined || (existsSync(join(DESKTOP_STATE_DIR, ".env")) && readFileSync(join(DESKTOP_STATE_DIR, ".env"), "utf8").includes(`${NAME}=`))) {
    check("T44: Settings › Models reads the .env names again after a save", false, `${NAME} is already set here; not touched`);
    return;
  }
  const put = dotenvSet(DESKTOP_STATE_DIR, NAME, K.check);
  try {
    const names = await js<{ dir: boolean; after: string[] | null }>(`(async () => {
      const keep = LLMP.dotenvKeys;
      try {
        LLMP.dotenvKeys = [];
        await refreshLiveConfig();
        for (let i = 0; i < 40 && !(LLMP.dotenvKeys || []).includes(${q(NAME)}); i++) await new Promise((r) => setTimeout(r, 50));
        return {dir: !!memStateDir(), after: LLMP.dotenvKeys ? LLMP.dotenvKeys.slice() : null};
      } finally { LLMP.dotenvKeys = keep; }
    })()`);
    check(
      "T44: Settings › Models reads the .env names again after a save made on any screen",
      put.ok && names.dir && Array.isArray(names.after) && names.after.includes(NAME),
      q({ put: put.ok, stateDir: names.dir, found: Array.isArray(names.after) && names.after.includes(NAME) }),
    );
  } finally {
    dotenvSet(DESKTOP_STATE_DIR, NAME, null);
  }
}

/* What the key screen says, and backlog 32's Key invalid for a key held outside the entry. */
async function hintInWindow(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, unknown>>(`(() => {
    const keep = {cfg: LIVE_CONFIG, wiz: Object.assign({}, WIZ), inv: BSW.invalidKeyIds};
    const dom = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d; };
    try {
      Object.assign(WIZ, {row: KIND_ROWS.find((k) => k.id === 'gemini'), phase: 'configure', forId: null, apiKey: '', baseUrl: '', error: null, errorDetail: null, uncheckedFor: null});
      const help = dom(obWizardHTML()).querySelector('.ob-help[title]');
      BSW.invalidKeyIds = ['smoke-t44-bad'];
      const p = {id: 'smoke-t44-bad', kind: 'openai-compatible', baseUrl: 'https://smoke-t44.invalid', apiKeyEnvVar: 'SMOKE_T44_BAD_API_KEY', defaultChatModel: 'm'};
      const row = llmProviderRow(p);
      return {tip: help ? help.getAttribute('title') : null, line: help ? help.textContent : null, win: IS_WIN, machine: THIS_MACHINE,
        invalid: {badKey: row.badKey, available: row.available, text: dom(llmRowHTML(row, 0, -1)).textContent || ''}};
    } finally {
      LIVE_CONFIG = keep.cfg; Object.assign(WIZ, keep.wiz); BSW.invalidKeyIds = keep.inv; render();
    }
  })()`);
  const want = r["win"] === true
    ? "Saved in Atomic Agent\u2019s settings file in your user folder."
    : `Saved in Atomic Agent\u2019s settings file on ${String(r["machine"])}, readable only by your user account.`;
  check(
    "T44: the key screen says where the key is kept, as it happens: the app's settings file, readable only by this user",
    r["tip"] === want && !/\.env|0600/.test(String(r["tip"] ?? "")),
    q({ tip: r["tip"], line: r["line"] }),
  );
  const invalid = (r["invalid"] ?? {}) as { badKey?: unknown; available?: unknown; text?: unknown };
  check(
    "T44: Settings › Models marks a key held outside the entry (.env, the environment) with a character keys don't have as Key invalid (backlog 32)",
    invalid.badKey === true && invalid.available === false && /Key invalid/.test(String(invalid.text ?? "")),
    q(invalid),
  );
}

/* Backlog 32's key screen, for a provider whose saved key is held outside its
   entry and has a character keys don't have: Next with the field blank keeps
   that key, so the screen asks for a new one and saves nothing. The window's
   writes and switches are answered by stand-ins on its own IPC, as in t32 (a
   webContents handler is asked before ipcMain's; a probe proves it first), so
   nothing reaches the config even if the check fails. */
async function blankOnBadKeyElsewhere(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const seen: string[] = [];
  const stand: Record<string, (_e: unknown, payload: unknown) => unknown> = {
    "cli:upsertProvider": () => { seen.push("upsert"); return { ok: true, stdout: "", stderr: "" }; },
    "cli:providerModels": () => ({ ok: true, smokeT44: true, models: [{ provider: "aimlapi", id: MODEL, kind: "chat" }] }),
    "cli:verifyProviderKey": () => { seen.push("verify"); return { ok: false, checked: true, error: "smoke t44: not asked" }; },
    "cli:removeProvider": () => { seen.push("remove"); return { ok: true, stdout: "", stderr: "" }; },
    "app:unverifiedSet": () => { seen.push("unverified"); return { ok: true }; },
    "cli:selectCloudModel": () => { seen.push("select"); return { ok: false, error: "smoke t44: nothing is switched" }; },
    "cli:activateProvider": () => { seen.push("activate"); return { ok: false, error: "smoke t44: nothing is switched" }; },
  };
  try {
    for (const w of wins) for (const [ch, fn] of Object.entries(stand)) w.webContents.ipc.handle(ch, fn);
    const probe = await js<{ smokeT44?: boolean } | null>("BR.providerModels('smoke-t44-probe', 'aimlapi')").catch((e: unknown) => String(e));
    if (typeof probe !== "object" || probe?.smokeT44 !== true) {
      check("T44: stand-ins on the window's IPC answer the setup's writes first", false, `${q(probe)}; the setup was not driven`);
      return;
    }
    const r = await js<Record<string, unknown>>(`(async () => {
      const keep = {cfg: LIVE_CONFIG, inv: BSW.invalidKeyIds, wiz: Object.assign({}, WIZ), open: SEL.open, err: SEL.err};
      try {
        const cfg = JSON.parse(JSON.stringify(LIVE_CONFIG || {}));
        cfg.llm = cfg.llm || {};
        cfg.llm.providers = (cfg.llm.providers || []).filter((x) => x.id !== 'aimlapi')
          .concat([{id: 'aimlapi', kind: 'aimlapi', baseUrl: 'https://api.aimlapi.com', apiKeyEnvVar: 'AIMLAPI_API_KEY', defaultChatModel: ${q(MODEL)}}]);
        LIVE_CONFIG = cfg;
        BSW.invalidKeyIds = ['aimlapi'];
        WIZ.unfinishedId = null; act('close');
        SEL.open = true; SEL.err = null;
        Object.assign(WIZ, {row: KIND_ROWS.find((k) => k.id === 'aimlapi'), phase: 'configure', apiKey: '', baseUrl: '', error: null,
          errorDetail: null, uncheckedFor: null, acceptUnchecked: false, modelChosen: false, forId: 'aimlapi', unfinishedId: null});
        render();
        act('wiz:next');
        for (let i = 0; i < 100 && (WIZ.stepping || WIZ.phase === 'verifying'); i++) await new Promise((res) => setTimeout(res, 50));
        return {phase: WIZ.phase, error: WIZ.error};
      } finally {
        WIZ.unfinishedId = null; act('close');
        LIVE_CONFIG = keep.cfg; BSW.invalidKeyIds = keep.inv;
        Object.assign(WIZ, keep.wiz, {unfinishedId: null, stepping: false});
        SEL.open = !!keep.open; SEL.err = keep.err || null; render();
      }
    })()`);
    check(
      "T44: Next with the key field blank, on a provider whose key held outside the entry has a character keys don't have, asks for the key again and saves nothing (backlog 32)",
      r["phase"] === "configure" && /^The key saved for AI\/ML API has a character keys don\u2019t have/.test(String(r["error"] ?? "")) && seen.length === 0,
      q({ phase: r["phase"], error: r["error"], calls: seen }),
    );
  } finally {
    for (const w of wins) if (!w.isDestroyed()) for (const ch of Object.keys(stand)) w.webContents.ipc.removeHandler(ch);
    await wait(50);
  }
}
