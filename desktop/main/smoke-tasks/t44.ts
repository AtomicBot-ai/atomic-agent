import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { BrowserWindow } from "electron";

import {
  dotenvSet,
  keyNamesAvailable,
  moveProviderKeysIn,
  normaliseLlmBlock,
  plainCliError,
  providerIsUsable,
  providerKeyInvalid,
  removeProviderIn,
  upsertProviderIn,
  verifyProviderKey,
  type CliResult,
  type KeyStore,
  type ProviderEntry,
  type UserConfigShape,
} from "../agent-cli.js";
import { resolveBinary } from "../agent-client.js";
import { parseDotenvAsAgent } from "../provider-keys.js";
import { DESKTOP_STATE_DIR } from "../state-dir.js";

/**
 * Release-fix checks for ATO-132 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=44`.
 *
 * 44 — the key field's hint said "Saved to .env as AIMLAPI_API_KEY (mode
 * 0600)", and the desktop wrote the key into config.json, mode 0644: a file
 * other accounts can read, and one every whole-file config write handed to
 * `atag config set` on its command line. Found while fixing backlog 32.
 *
 * Now a key typed in the window goes into <stateDir>/.env (0600) and the
 * provider entry names the variable; keys saved in config.json by earlier
 * versions move there at launch; config.json and .env are owner-only.
 *
 * Every key here is a dummy made up in this file. The agent checks run the
 * real `atag` against throwaway state directories, and every provider points
 * at a server this check runs on 127.0.0.1, which records the Authorization
 * header it is sent: nothing leaves the machine, and what the agent sends is
 * compared here, never printed. The one write into the app's own state dir
 * (the key check) is taken back out.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Seen = { method: string; path: string; auth: string | null };

const run = promisify(execFile);
const q = (v: unknown) => JSON.stringify(v);

const K = {
  one: "smoke-t44-key-one-0123456789",
  aiml: "smoke-t44-key-aiml-0123456789",
  a: "smoke-t44-key-a-0123456789",
  b: "smoke-t44-key-b-0123456789",
  env: "smoke-t44-key-env-0123456789",
  shell: "smoke-t44-key-shell-0123456789",
  bad: "smoke-t44-key-\u0441",
  fail: "smoke-t44-key-fail-0123456789",
  save: "smoke-t44-key-save-0123456789",
  rekey: "smoke-t44-key-rekey-0123456789",
  gone: "smoke-t44-key-gone-0123456789",
  check: "smoke-t44-key-check-0123456789",
} as const;
const ALL_KEYS: string[] = Object.values(K);
/** Names this check sets; the agent's environment must not carry them, so .env is what it reads. */
const NAMES = ["AIMLAPI_API_KEY", "SMOKE_T44_SHARED_KEY", "SMOKE_T44_ENV_KEY", "SMOKE_T44_CHECK_KEY", "SMOKE_T44_ROW_KEY"];

/** The server every provider in this check points at: it answers a model list or a completion, and keeps what it was sent. */
async function loopback(): Promise<{ base: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    seen.push({ method: req.method ?? "", path, auth: typeof req.headers.authorization === "string" ? req.headers.authorization : null });
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(path.endsWith("/v1/models")
        ? JSON.stringify({ data: [{ id: "smoke-t44-model" }] })
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
  const bin = resolveBinary();
  if (!bin) {
    check("T44: the agent binary is there to check against", false, "no agent binary resolved");
    return;
  }
  const lb = await loopback();
  const dirs: string[] = [];
  const fresh = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `aa-t44-${tag}-`)); dirs.push(d); return d; };
  try {
    const agent = agentIn(bin);
    await launchMove(check, agent, fresh("move"), lb);
    await launchMoveFails(check, agent, fresh("fail"), lb);
    await windowSave(check, agent, fresh("save"), lb);
    await keyCheckAndSettings(js, check, lb);
    await hintInWindow(js, check);
    await blankOnBadKeyInEnv(js, check);
  } finally {
    await lb.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
}

/* What the launch did to the app's own state directory before this ran: the
   suite's copy starts from a seed whose config.json is 0644. */
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

type Agent = {
  /** `atag …` on a throwaway state dir, with exactly this environment (plus the dir). */
  cli: (dir: string, env: NodeJS.ProcessEnv, args: string[]) => Promise<CliResult>;
  /** The key store main uses, on a throwaway state dir, read and written by the real `atag`. */
  store: (dir: string, env: NodeJS.ProcessEnv) => KeyStore;
  /** The Authorization header the agent sends for this provider, as the loopback server got it (null: none). */
  sends: (dir: string, env: NodeJS.ProcessEnv, id: string, path: string, lb: { seen: Seen[] }) => Promise<string | null>;
};

/** This process's environment without the names this check sets, plus `extra`: the agent then reads those from .env. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const n of NAMES) delete env[n];
  return { ...env, ...extra };
}

function agentIn(bin: string): Agent {
  const cli = async (dir: string, env: NodeJS.ProcessEnv, args: string[]): Promise<CliResult> => {
    try {
      const { stdout, stderr } = await run(bin, args, { env: { ...env, ATOMIC_AGENT_STATE_DIR: dir }, timeout: 90_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      return { ok: true, stdout, stderr };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "", error: plainCliError(e.stderr ?? "") || `atag ${args[0] ?? ""} failed` };
    }
  };
  const store = (dir: string, env: NodeJS.ProcessEnv): KeyStore => ({
    stateDir: dir,
    env,
    read: async () => {
      const r = await cli(dir, env, ["config", "get"]);
      if (!r.ok) return { ok: false, error: r.error };
      try {
        return { ok: true, config: JSON.parse(r.stdout) as UserConfigShape };
      } catch {
        return { ok: false, error: "config get did not return JSON" };
      }
    },
    write: async (cfg) => {
      normaliseLlmBlock(cfg);
      return cli(dir, env, ["config", "set", JSON.stringify(cfg)]);
    },
  });
  const sends = async (dir: string, env: NodeJS.ProcessEnv, id: string, path: string, lb: { seen: Seen[] }) => {
    const from = lb.seen.length;
    await cli(dir, env, ["models", "search", " ", "--provider", id, "--refresh", "--json"]);
    const hit = lb.seen.slice(from).find((s) => s.path === `${path}/v1/models`);
    return hit ? hit.auth : null;
  };
  return { cli, store, sends };
}

const providersIn = (cfg: UserConfigShape | undefined): ProviderEntry[] => cfg?.llm?.providers ?? [];
const fileText = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);
/** The providers as config.json holds them on disk — what the agent wrote, read without another `atag` run. */
const providersOnDisk = (dir: string): ProviderEntry[] => {
  try {
    return providersIn(JSON.parse(fileText(join(dir, "config.json")) ?? "{}") as UserConfigShape);
  } catch {
    return [];
  }
};
const holdsAnyKey = (text: string | null) => ALL_KEYS.filter((k) => !!text && text.includes(k)).length;
const modeOf = (p: string) => (existsSync(p) ? (statSync(p).mode & 0o777).toString(8) : "absent");
const ownerOnly = (p: string) => process.platform === "win32" || (existsSync(p) && (statSync(p).mode & 0o077) === 0);

/** A config written the way versions before ATO-132 wrote it: each provider holding its own key. */
async function seedLegacy(agent: Agent, dir: string, env: NodeJS.ProcessEnv, providers: ProviderEntry[]): Promise<boolean> {
  const s = agent.store(dir, env);
  const read = await s.read();
  if (!read.ok || !read.config) return false;
  read.config.llm = { activeTextProvider: "local-llama", providers };
  return (await s.write(read.config)).ok;
}

/* The launch move, on a config like the ones out there: a custom endpoint, a
   built-in kind, two entries sharing one variable (as the terminal saves two
   entries of one preset), one whose variable this app's environment sets to
   something else, and one whose key has a character keys don't have. */
async function launchMove(check: Check, agent: Agent, dir: string, lb: { base: string; seen: Seen[] }): Promise<void> {
  const env = childEnv({ SMOKE_T44_ENV_KEY: K.shell });
  const compat = (id: string, path: string, apiKey: string, apiKeyEnvVar?: string): ProviderEntry => ({
    id, kind: "openai-compatible", baseUrl: `${lb.base}${path}`, defaultChatModel: "smoke-t44-model", apiKey, ...(apiKeyEnvVar ? { apiKeyEnvVar } : {}),
  });
  const seeded = await seedLegacy(agent, dir, env, [
    compat("smoke-t44", "/one", K.one),
    { id: "aimlapi", kind: "aimlapi", apiKeyEnvVar: "AIMLAPI_API_KEY", apiKey: K.aiml, defaultChatModel: "x-ai/grok-4-6" },
    compat("smoke-t44-a", "/a", K.a, "SMOKE_T44_SHARED_KEY"),
    compat("smoke-t44-b", "/b", K.b, "SMOKE_T44_SHARED_KEY"),
    compat("smoke-t44-env", "/env", K.env, "SMOKE_T44_ENV_KEY"),
    compat("smoke-t44-bad", "/bad", K.bad),
  ]);
  const legacyHeld = holdsAnyKey(fileText(join(dir, "config.json")));
  const r = await moveProviderKeysIn(agent.store(dir, env));
  const cfgText = fileText(join(dir, "config.json"));
  const providers = providersOnDisk(dir);
  const dotenv = parseDotenvAsAgent(fileText(join(dir, ".env")) ?? "");
  const want: Record<string, [string, string]> = {
    "smoke-t44": ["SMOKE_T44_API_KEY", K.one],
    aimlapi: ["AIMLAPI_API_KEY", K.aiml],
    "smoke-t44-a": ["SMOKE_T44_SHARED_KEY", K.a],
    "smoke-t44-b": ["SMOKE_T44_B_API_KEY", K.b],
    "smoke-t44-env": ["SMOKE_T44_ENV_API_KEY", K.env],
    "smoke-t44-bad": ["SMOKE_T44_BAD_API_KEY", K.bad],
  };
  const placed = Object.entries(want).map(([id, [name, key]]) => {
    const e = providers.find((p) => p.id === id);
    return { id, name: e?.apiKeyEnvVar ?? null, noInline: !!e && !("apiKey" in e), inEnv: dotenv.get(name) === key && e?.apiKeyEnvVar === name };
  });
  check(
    "T44: at launch, keys saved in config.json move to .env (0600); config.json names the variables and holds no key",
    seeded && legacyHeld === 6 && r.ok && r.moved.length === 6 && r.left.length === 0
      && holdsAnyKey(cfgText) === 0 && placed.every((x) => x.noInline && x.inEnv) && ownerOnly(join(dir, ".env")),
    q({ seeded, legacyHeld, ok: r.ok, moved: r.moved, left: r.left, error: r.error, keysLeftInConfig: holdsAnyKey(cfgText), placed, envMode: modeOf(join(dir, ".env")) }),
  );
  check(
    "T44: the agent writes config.json readable by its owner only",
    ownerOnly(join(dir, "config.json")),
    `config.json ${modeOf(join(dir, "config.json"))}`,
  );

  /* What the agent sends now, for each moved key: read from .env, not the
     environment's own value. `models search` builds the same runtime config
     `atag serve` boots on, and every route reads the key from there — the
     chat route, the fallback chain's links, Fusion's orchestrator. */
  const sent = {
    one: (await agent.sends(dir, env, "smoke-t44", "/one", lb)) === `Bearer ${K.one}`,
    a: (await agent.sends(dir, env, "smoke-t44-a", "/a", lb)) === `Bearer ${K.a}`,
    b: (await agent.sends(dir, env, "smoke-t44-b", "/b", lb)) === `Bearer ${K.b}`,
    env: (await agent.sends(dir, env, "smoke-t44-env", "/env", lb)) === `Bearer ${K.env}`,
  };
  check(
    "T44: the agent sends each moved key — two providers that shared a variable each keep their own, and a variable this app's environment sets does not take over",
    Object.values(sent).every(Boolean),
    q(sent),
  );

  // Backlog 32's "Key invalid", and every other provider still counted as keyed, read from .env.
  const names = keyNamesAvailable(dir, env);
  const bad = providers.find((p) => p.id === "smoke-t44-bad");
  const usable = providers.filter((p) => p.id !== "smoke-t44-bad" && p.id !== "local-llama").map((p) => [p.id, providerIsUsable(p, names)] as const);
  check(
    "T44: a moved key with a character keys don't have still reads Key invalid; the others count as keys for the switches, Fusion and the fallback rows",
    !!bad && providerKeyInvalid(bad, names) && !providerIsUsable(bad, names) && usable.length === 5 && usable.every(([, u]) => u),
    q({ badInvalid: !!bad && providerKeyInvalid(bad, names), usable }),
  );

  // A second launch has nothing to move and changes no file.
  const envBefore = fileText(join(dir, ".env"));
  const cfgBefore = fileText(join(dir, "config.json"));
  const again = await moveProviderKeysIn(agent.store(dir, env));
  check(
    "T44: the move is idempotent — a second launch moves nothing and leaves .env and config.json as they are",
    again.ok && again.moved.length === 0 && fileText(join(dir, ".env")) === envBefore && fileText(join(dir, "config.json")) === cfgBefore,
    q({ ok: again.ok, moved: again.moved, envSame: fileText(join(dir, ".env")) === envBefore, configSame: fileText(join(dir, "config.json")) === cfgBefore }),
  );
}

/* All or nothing: config.json cannot be written, so nothing moves. */
async function launchMoveFails(check: Check, agent: Agent, dir: string, lb: { base: string }): Promise<void> {
  const env = childEnv();
  const seeded = await seedLegacy(agent, dir, env, [
    { id: "smoke-t44-fail", kind: "openai-compatible", baseUrl: `${lb.base}/fail`, defaultChatModel: "smoke-t44-model", apiKey: K.fail },
  ]);
  writeFileSync(join(dir, ".env"), "SMOKE_T44_OTHER=1\n");
  const real = agent.store(dir, env);
  const refusing: KeyStore = { ...real, write: async () => ({ ok: false, stdout: "", stderr: "", error: `config set failed: ${K.fail} was refused (smoke t44)` }) };
  const r = await moveProviderKeysIn(refusing);
  const now = providersOnDisk(dir).find((p) => p.id === "smoke-t44-fail");
  check(
    "T44: when config.json cannot be written nothing moves: .env and config.json stay exactly as they were, and the warning names no key",
    seeded && !r.ok && r.moved.length === 0 && r.left.includes("smoke-t44-fail")
      && fileText(join(dir, ".env")) === "SMOKE_T44_OTHER=1\n" && now?.apiKey === K.fail
      && !ALL_KEYS.some((k) => String(r.error ?? "").includes(k)) && /left as it was/.test(String(r.error ?? "")),
    q({ seeded, ok: r.ok, moved: r.moved, left: r.left, envSame: fileText(join(dir, ".env")) === "SMOKE_T44_OTHER=1\n", stillInline: now?.apiKey === K.fail, errorHasKey: ALL_KEYS.some((k) => String(r.error ?? "").includes(k)) }),
  );
}

/* The window's save path (every key field ends in upsertProvider), on a throwaway state dir. */
async function windowSave(check: Check, agent: Agent, dir: string, lb: { base: string; seen: Seen[] }): Promise<void> {
  const env = childEnv();
  const store = agent.store(dir, env);
  await store.read(); // a default config.json, as a first launch writes
  const entry = (apiKey?: string, apiKeyEnvVar?: string): ProviderEntry => ({
    id: "smoke-t44-save", kind: "openai-compatible", baseUrl: `${lb.base}/save`, defaultChatModel: "smoke-t44-model",
    ...(apiKey ? { apiKey } : {}), ...(apiKeyEnvVar ? { apiKeyEnvVar } : {}),
  });
  const first = await upsertProviderIn(store, entry(K.save));
  const cfgText = fileText(join(dir, "config.json"));
  const saved = providersOnDisk(dir).find((p) => p.id === "smoke-t44-save");
  const dotenv = parseDotenvAsAgent(fileText(join(dir, ".env")) ?? "");
  const sentFirst = (await agent.sends(dir, env, "smoke-t44-save", "/save", lb)) === `Bearer ${K.save}`;
  check(
    "T44: a key typed in the window goes into .env (0600) under the provider's variable; config.json names it, holds no key, and the agent sends it",
    first.ok && holdsAnyKey(cfgText) === 0 && saved?.apiKeyEnvVar === "SMOKE_T44_SAVE_API_KEY" && !!saved && !("apiKey" in saved)
      && dotenv.get("SMOKE_T44_SAVE_API_KEY") === K.save && ownerOnly(join(dir, ".env")) && sentFirst,
    q({ ok: first.ok, error: first.error, keysInConfig: holdsAnyKey(cfgText), name: saved?.apiKeyEnvVar ?? null, envMode: modeOf(join(dir, ".env")), sent: sentFirst }),
  );

  const rekey = await upsertProviderIn(store, entry(K.rekey, "SMOKE_T44_SAVE_API_KEY"));
  const sentRekey = (await agent.sends(dir, env, "smoke-t44-save", "/save", lb)) === `Bearer ${K.rekey}`;
  // A blank field, with a row variable that is not the provider's own: the provider keeps its own.
  const blank = await upsertProviderIn(store, entry(undefined, "SMOKE_T44_ROW_KEY"));
  const kept = providersOnDisk(dir).find((p) => p.id === "smoke-t44-save");
  const envAfter = fileText(join(dir, ".env")) ?? "";
  check(
    "T44: re-keying replaces the key the agent sends; a blank key field keeps the provider's own variable",
    rekey.ok && sentRekey && !envAfter.includes(K.save) && blank.ok && kept?.apiKeyEnvVar === "SMOKE_T44_SAVE_API_KEY",
    q({ rekey: rekey.ok, sent: sentRekey, oldKeyGone: !envAfter.includes(K.save), blank: blank.ok, name: kept?.apiKeyEnvVar ?? null }),
  );

  // A provider the setup created and then took back (its key was turned down): no trace of the key.
  const gone = await upsertProviderIn(store, { id: "smoke-t44-gone", kind: "openai-compatible", baseUrl: `${lb.base}/gone`, defaultChatModel: "smoke-t44-model", apiKey: K.gone });
  const wrote = (fileText(join(dir, ".env")) ?? "").includes(K.gone);
  const removed = await removeProviderIn(store, "smoke-t44-gone");
  const left = providersOnDisk(dir).some((p) => p.id === "smoke-t44-gone");
  check(
    "T44: a key turned down for a provider the setup created leaves no trace in .env or config.json",
    gone.ok && wrote && removed.ok && !left && !(fileText(join(dir, ".env")) ?? "").includes(K.gone)
      && (fileText(join(dir, ".env")) ?? "").includes("SMOKE_T44_SAVE_API_KEY="),
    q({ saved: gone.ok, wrote, removed: removed.ok, entryLeft: left, keyLeft: (fileText(join(dir, ".env")) ?? "").includes(K.gone) }),
  );
}

/* The key check reads a key kept in the app's .env (a blank key field checks
   the saved key), and Settings › Models reads the .env names again after a
   save. One variable goes into the app's own state dir and comes out again. */
async function keyCheckAndSettings(js: Js, check: Check, lb: { base: string; seen: Seen[] }): Promise<void> {
  const NAME = "SMOKE_T44_CHECK_KEY";
  const had = parseDotenvAsAgent(fileText(join(DESKTOP_STATE_DIR, ".env")) ?? "").has(NAME);
  if (had || process.env[NAME] !== undefined) {
    check("T44: the key check reads a key kept in .env", false, `${NAME} is already set here; not touched`);
    return;
  }
  const put = dotenvSet(DESKTOP_STATE_DIR, NAME, K.check);
  try {
    const from = lb.seen.length;
    const v = await verifyProviderKey(
      { id: "smoke-t44-check", kind: "openai-compatible", baseUrl: `${lb.base}/check`, apiKeyEnvVar: NAME },
      "smoke-t44-model",
    );
    const hit = lb.seen.slice(from).find((s) => s.path === "/check/v1/chat/completions");
    check(
      "T44: the key check reads a key kept in .env — a blank key field checks the saved key",
      put.ok && v.ok === true && v.checked === true && hit?.auth === `Bearer ${K.check}`,
      q({ put: put.ok, ok: v.ok, checked: v.checked, asked: !!hit, sentSaved: hit?.auth === `Bearer ${K.check}` }),
    );

    const names = await js<{ dir: string | null; before: unknown; after: string[] | null }>(`(async () => {
      const keep = LLMP.dotenvKeys;
      try {
        LLMP.dotenvKeys = [];
        await refreshLiveConfig();
        for (let i = 0; i < 40 && !(LLMP.dotenvKeys || []).includes(${q(NAME)}); i++) await new Promise((r) => setTimeout(r, 50));
        return {dir: memStateDir(), before: keep === null ? null : 'list', after: LLMP.dotenvKeys ? LLMP.dotenvKeys.slice() : null};
      } finally { LLMP.dotenvKeys = keep; }
    })()`);
    check(
      "T44: after a save, Settings › Models reads the .env names again, so a key just saved there reads Key saved",
      !!names.dir && Array.isArray(names.after) && names.after.includes(NAME),
      q({ stateDir: !!names.dir, found: Array.isArray(names.after) && names.after.includes(NAME) }),
    );
  } finally {
    dotenvSet(DESKTOP_STATE_DIR, NAME, null);
  }
}

/* What the key screen says, and the Key invalid mark for a key that lives in .env. */
async function hintInWindow(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, unknown>>(`(() => {
    const keep = {cfg: LIVE_CONFIG, wiz: Object.assign({}, WIZ), inv: BSW.invalidKeyIds};
    const dom = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d; };
    const tipOf = (h) => { const el = dom(h).querySelector('.ob-help[title]'); return el ? el.getAttribute('title') : null; };
    const labelOf = (h) => { const el = dom(h).querySelector('label[for="wiz-key"]'); return el ? el.textContent : null; };
    try {
      const row = KIND_ROWS.find((k) => k.id === 'gemini');
      const cfg = JSON.parse(JSON.stringify(LIVE_CONFIG || {}));
      cfg.llm = cfg.llm || {};
      const others = (cfg.llm.providers || []).filter((p) => p.id !== 'gemini');
      cfg.llm.providers = others;
      LIVE_CONFIG = cfg;
      Object.assign(WIZ, {row, phase: 'configure', forId: null, apiKey: '', baseUrl: '', error: null, errorDetail: null, uncheckedFor: null});
      const fresh = {tip: tipOf(obWizardHTML()), label: labelOf(wizardHTML())};
      cfg.llm.providers = others.concat([{id: 'gemini', kind: 'gemini', apiKeyEnvVar: 'GEMINI_API_KEY_2', defaultChatModel: 'gemini-2.5-flash'}]);
      WIZ.forId = 'gemini';
      const own = {tip: tipOf(obWizardHTML()), label: labelOf(wizardHTML())};
      BSW.invalidKeyIds = ['smoke-t44-bad'];
      const p = {id: 'smoke-t44-bad', kind: 'openai-compatible', baseUrl: 'https://smoke-t44.invalid', apiKeyEnvVar: 'SMOKE_T44_BAD_API_KEY', defaultChatModel: 'm'};
      const row2 = llmProviderRow(p);
      const invalid = {badKey: row2.badKey, available: row2.available, text: dom(llmRowHTML(row2, 0, -1)).textContent || ''};
      return {fresh, own, invalid, win: IS_WIN};
    } finally {
      LIVE_CONFIG = keep.cfg; Object.assign(WIZ, keep.wiz); BSW.invalidKeyIds = keep.inv; render();
    }
  })()`);
  const mode = r["win"] === true ? "." : " (mode 0600).";
  const fresh = (r["fresh"] ?? {}) as { tip?: unknown; label?: unknown };
  const own = (r["own"] ?? {}) as { tip?: unknown; label?: unknown };
  check(
    "T44: the key screen says where the key goes, as it now happens: .env, under the provider's own variable",
    fresh.tip === `Saved to .env as GEMINI_API_KEY${mode}` && /blank reads GEMINI_API_KEY$/.test(String(fresh.label ?? ""))
      && own.tip === `Saved to .env as GEMINI_API_KEY_2${mode}` && /blank reads GEMINI_API_KEY_2$/.test(String(own.label ?? "")),
    q({ fresh, own }),
  );
  const invalid = (r["invalid"] ?? {}) as { badKey?: unknown; available?: unknown; text?: unknown };
  check(
    "T44: Settings › Models marks a key kept in .env with a character keys don't have as Key invalid (backlog 32)",
    invalid.badKey === true && invalid.available === false && /Key invalid/.test(String(invalid.text ?? "")),
    q(invalid),
  );
}

/* Backlog 32's key screen, for a provider whose saved key now lives in .env:
   Next with the field blank keeps that key, so the screen asks for a new one
   and saves nothing. The window's writes and switches are answered by
   stand-ins on its own IPC, as in t32 (a webContents handler is asked before
   ipcMain's; a probe proves it first), so nothing reaches the config even if
   the check fails. */
async function blankOnBadKeyInEnv(js: Js, check: Check): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const seen: string[] = [];
  const stand: Record<string, (_e: unknown, payload: unknown) => unknown> = {
    "cli:upsertProvider": () => { seen.push("upsert"); return { ok: true, stdout: "", stderr: "" }; },
    "cli:providerModels": () => ({ ok: true, smokeT44: true, models: [{ provider: "aimlapi", id: "smoke-t44-model", kind: "chat" }] }),
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
          .concat([{id: 'aimlapi', kind: 'aimlapi', baseUrl: 'https://api.aimlapi.com', apiKeyEnvVar: 'AIMLAPI_API_KEY', defaultChatModel: 'smoke-t44-model'}]);
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
      "T44: Next with the key field blank, on a provider whose key in .env has a character keys don't have, asks for the key again and saves nothing (backlog 32)",
      r["phase"] === "configure" && /^The key saved for AI\/ML API has a character keys don\u2019t have/.test(String(r["error"] ?? "")) && seen.length === 0,
      q({ phase: r["phase"], error: r["error"], calls: seen }),
    );
  } finally {
    for (const w of wins) if (!w.isDestroyed()) for (const ch of Object.keys(stand)) w.webContents.ipc.removeHandler(ch);
  }
}
