/**
 * r5 item 9 — the wizard's "bring your existing setup over?" offer.
 *
 * The user chose a fully separate desktop state directory WITH an import
 * offer, so this is the one door between `~/.atomic-agent` and
 * `~/.atomic-agent-desktop`. Two rules hold everywhere below:
 *
 *   1. THE SOURCE IS READ-ONLY. Nothing here writes, renames, moves or
 *      deletes anything under the terminal agent's directory. The sqlite
 *      files are read through `sqlite3 -readonly … ".backup"`, which is
 *      also the only consistent way to copy a database that may have an
 *      open WAL — a plain `cp` of a live sqlite file copies a torn page
 *      set and leaves the -wal behind.
 *   2. NOTHING CROSSES UNLESS IT IS TICKED. Every flag defaults false.
 *      What crosses is a COPY, not a link, so revoking a key on one side
 *      does not revoke it on the other.
 *   3. THE DESTINATION IS NOT LIVE WHILE A DATABASE IS REPLACED. The
 *      desktop's own `atag serve` holds sessions.sqlite and memory.sqlite
 *      open; that arm of the import stops it, drops the destination's stale
 *      `-wal`/`-shm`, restores, and starts it again (TuiImportHooks).
 *
 * WHAT IS NEVER COPIED, and why — enforced as a whitelist (the merge below
 * names the fields it takes; everything else is simply not read):
 *   · `localModels` in its entirety, so `managed.port` and
 *     `managed.dataDirOverride` cannot cross. Two daemons cannot share a
 *     port or a pid file, and the desktop keeps its own (state-dir.ts).
 *   · `tui.onboarding` — it would tell the desktop the wizard is done.
 *   · `telegram` — one bot token cannot serve two pollers.
 *   · `analytics`, and `version` — the fresh file is already at the
 *     current schema version; an older one would re-run migrations over
 *     already-migrated blocks.
 *   · `tasks.sqlite` — its cron jobs would then fire from two agents.
 *   · An inline `apiKey` on a provider entry. Keys travel only through the
 *     `keys` flag, into the desktop's own .env, and only if ticked.
 */

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { configGet, configSetWhole, dotenvSet, keyNamesAvailable, providerHasKey, type ProviderEntry } from "./agent-cli.js";
import { DESKTOP_STATE_DIR, TUI_STATE_DIR } from "./state-dir.js";

const run = promisify(execFile);

const SQLITE = "/usr/bin/sqlite3";
const DOTENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface TuiSetupPresence {
  ok: true;
  present: boolean;
  path: string;
  has: { providers: number; keys: string[]; skills: number; sessions: number; memory: boolean };
}

export interface TuiImportOptions {
  providers?: boolean;
  keys?: boolean;
  skills?: boolean;
  sessions?: boolean;
  memory?: boolean;
}

export interface TuiImportResult {
  ok: boolean;
  copied: { providers: number; keys: number; skills: number; sessions: number; memory: boolean };
  error?: string;
}

/**
 * r5 review fix (major) — the DESTINATION of a database import is a file the
 * desktop's OWN agent already has open.
 *
 * `sqlite3 … ".backup"` was correct about the source (read-only, WAL-aware)
 * and wrong about the target: main.ts starts `atag serve` from
 * `did-finish-load`, and the wizard that calls this runs in that same window,
 * so `<desktopStateDir>/sessions.sqlite` and `memory.sqlite` are open with a
 * live WAL while `.backup` replaces the main database file underneath. Two
 * ways that ends badly: the running connection's `-wal`/`-shm` still describe
 * the PRE-import image and the next checkpoint writes those stale frames back
 * over the restored file, and sqlite takes an exclusive lock on the
 * destination, so an unlucky moment fails the whole import with a BUSY.
 *
 * So the caller hands in the agent's own stop/start. The database arm — and
 * ONLY that arm — runs with the agent down and the destination's WAL siblings
 * deleted, and the agent is brought back in a `finally` even if the copy
 * throws. Everything else (providers, keys, skills) is safe with it running.
 */
export interface TuiImportHooks {
  stopAgent: () => Promise<unknown>;
  startAgent: () => Promise<unknown>;
}

const NOTHING = (): TuiImportResult["copied"] => ({ providers: 0, keys: 0, skills: 0, sessions: 0, memory: false });

function readTuiConfig(): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(join(TUI_STATE_DIR, "config.json"), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * ONE parser, for both halves of the contract — r5 review fix (minor).
 *
 * `tuiSetupPresent().has.keys` and `importFromTui().copied.keys` used to be
 * produced by two different readers that disagreed in two ways: the names
 * side de-duplicated and accepted a name whose value was empty, the values
 * side did neither. So a `.env` holding the very ordinary placeholder line
 * `HF_TOKEN=` made the wizard offer three keys and the import report two,
 * and a duplicated name flipped it the other way — a difference the Wizard
 * lane, coding to this contract, could not explain to anyone.
 *
 * The rule, now stated once and applied to both:
 *   · a name must be a legal env var name (DOTENV_KEY);
 *   · a name is listed at most ONCE, and a repeat overwrites the earlier
 *     value — that is dotenv's own last-wins semantics;
 *   · an EMPTY value is not a key. It is a placeholder line, and offering
 *     to import it would promise the operator something that isn't there.
 * A Map does both: insertion order for the first sighting, last value wins.
 *
 * Takes the text so the suite can drive it over a synthetic file rather than
 * over whatever the operator's own `.env` happens to contain today.
 * Exported for that reason ONLY; the values never leave this module except
 * through `importFromTui({keys:true})`.
 */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^(?:export\s+)?([^=]+)=(.*)$/.exec(trimmed);
    if (!m) continue;
    const key = m[1]!.trim();
    if (!DOTENV_KEY.test(key)) continue;
    const value = m[2]!.trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
    // The two rules meeting: a later empty line for a name that already had
    // a value un-sets it, so the offer and the copy still agree afterwards.
    if (value.length === 0) { out.delete(key); continue; }
    out.set(key, value);
  }
  return out;
}

function tuiDotenv(): Map<string, string> {
  try {
    return parseDotenv(readFileSync(join(TUI_STATE_DIR, ".env"), "utf8"));
  } catch {
    return new Map(); // no .env — nothing to offer
  }
}

/** Env var NAMES only. A value is never returned, logged or counted. */
function tuiKeyNames(): string[] {
  return [...tuiDotenv().keys()];
}

/** name → value, read once, held only for the length of one write. */
function tuiKeyValues(): Array<[string, string]> {
  return [...tuiDotenv().entries()];
}

/**
 * r5 review fix (major) — the key names that will be resolvable in THIS
 * directory once the current import finishes. The providers arm runs before
 * the keys arm, so a key this same call is about to copy is not in the
 * desktop's .env yet; without this the route decision would read as "no key"
 * on the one path where the operator did tick the keys row. NAMES only —
 * `tuiDotenv` has already dropped every empty value, so every name added
 * here is non-empty, which is what `providerHasKey` asks of it.
 */
function namesAfterImport(keysAreComing: boolean): ReturnType<typeof keyNamesAvailable> {
  const names = keyNamesAvailable();
  if (!keysAreComing) return names;
  for (const name of tuiKeyNames()) {
    names.present.add(name);
    names.nonEmpty.add(name);
  }
  return names;
}

function dirNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Skill folders the desktop does not already have. A fresh state dir seeds
 * the whole built-in starter set on its first runtime creation
 * (src/runtime/bootstrap.ts seedStarterSkillsIfMissing), so what is left
 * over is exactly "skills you installed yourself".
 */
function importableSkills(): string[] {
  const mine = new Set(dirNames(join(DESKTOP_STATE_DIR, "skills")));
  return dirNames(join(TUI_STATE_DIR, "skills")).filter((n) => !mine.has(n));
}

export async function sqliteRowCount(file: string, table: string): Promise<number> {
  if (!existsSync(file) || !existsSync(SQLITE)) return 0;
  try {
    const { stdout } = await run(SQLITE, ["-readonly", file, `select count(*) from ${table}`], { timeout: 10_000 });
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * The consistent, read-only copy: `.backup` walks the pages through
 * sqlite's own reader, so an open WAL on the source is honoured and the
 * source's mtime and its -wal/-shm files are left untouched.
 */
async function sqliteBackup(src: string, dst: string): Promise<boolean> {
  if (!existsSync(src) || !existsSync(SQLITE)) return false;
  try {
    await run(SQLITE, ["-readonly", src, `.backup '${dst.replace(/'/g, "''")}'`], { timeout: 120_000 });
    return existsSync(dst) && statSync(dst).size > 0;
  } catch {
    return false;
  }
}

/**
 * The `-wal` and `-shm` of a database that is about to be REPLACED. They
 * describe the old image; left in place, the next connection replays them
 * over the freshly restored file and the import silently undoes itself.
 * Only ever called against a path inside the desktop's own state dir, with
 * the agent stopped.
 */
function dropWalSiblings(dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try { rmSync(dbPath + suffix, { force: true }); } catch { /* nothing to drop */ }
  }
}

/**
 * Cross-lane contract: reports whether the terminal agent's setup exists
 * and what it holds. Never throws when it is absent — `present: false`.
 */
export async function tuiSetupPresent(): Promise<TuiSetupPresence> {
  const path = TUI_STATE_DIR;
  // If the desktop has been pointed AT the terminal agent's directory (a
  // lane run with ATOMIC_AGENT_STATE_DIR=~/.atomic-agent would do it),
  // there is nothing to import from — it is the same tree.
  const sameTree = DESKTOP_STATE_DIR === TUI_STATE_DIR;
  const present = !sameTree && existsSync(join(path, "config.json"));
  if (!present) return { ok: true, present: false, path, has: { providers: 0, keys: [], skills: 0, sessions: 0, memory: false } };
  const cfg = readTuiConfig();
  const llm = (cfg?.["llm"] ?? {}) as { providers?: unknown[] };
  const memoryFile = join(path, "memory.sqlite");
  return {
    ok: true,
    present: true,
    path,
    has: {
      // r5 review fix — count what the import will actually COPY. The merge
      // below skips the source's `local-llama` entry on purpose (its managed
      // port is the terminal agent's), so counting the raw array made the
      // preview screen — the last honest word before the write — promise one
      // provider more than the result reported.
      providers: Array.isArray(llm.providers) ? llm.providers.filter((p) => (p as { id?: unknown })?.["id"] !== "local-llama").length : 0,
      keys: tuiKeyNames(),
      skills: importableSkills().length,
      sessions: await sqliteRowCount(join(path, "sessions.sqlite"), "sessions"),
      memory: existsSync(memoryFile) && statSync(memoryFile).size > 0,
    },
  };
}

/**
 * Cross-lane contract: copies only what is ticked. Every flag defaults
 * FALSE, so `importFromTui({})` copies nothing and says so.
 */
export async function importFromTui(opts: TuiImportOptions, hooks?: TuiImportHooks): Promise<TuiImportResult> {
  const copied = NOTHING();
  if (DESKTOP_STATE_DIR === TUI_STATE_DIR) {
    return { ok: false, copied, error: "this app is already running on the terminal agent's directory — there is nothing to import" };
  }
  if (!existsSync(join(TUI_STATE_DIR, "config.json"))) {
    return { ok: false, copied, error: "no terminal-agent setup at " + TUI_STATE_DIR };
  }
  const want = {
    providers: opts?.providers === true,
    keys: opts?.keys === true,
    skills: opts?.skills === true,
    sessions: opts?.sessions === true,
    memory: opts?.memory === true,
  };

  try {
    if (want.providers) {
      const src = readTuiConfig();
      if (!src) return { ok: false, copied, error: "could not read " + join(TUI_STATE_DIR, "config.json") };
      const mine = await configGet();
      if (!mine.ok || !mine.config || typeof mine.config !== "object") {
        return { ok: false, copied, error: mine.error ?? "could not read this app's own config" };
      }
      const target = mine.config as Record<string, unknown>;
      const srcLlm = (src["llm"] ?? {}) as Record<string, unknown>;
      const dstLlm = ((target["llm"] as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      // The whitelist. `localModels` is deliberately absent: the managed
      // port and the dataDirOverride must stay the desktop's own.
      const providers = Array.isArray(srcLlm["providers"]) ? (srcLlm["providers"] as Array<Record<string, unknown>>) : [];
      const stripped = providers.map((p) => {
        const clean: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(p)) if (k !== "apiKey") clean[k] = v;
        return clean;
      });
      const byId = new Map<string, Record<string, unknown>>();
      for (const p of (Array.isArray(dstLlm["providers"]) ? (dstLlm["providers"] as Array<Record<string, unknown>>) : [])) {
        if (typeof p["id"] === "string") byId.set(p["id"], p);
      }
      for (const p of stripped) {
        if (typeof p["id"] !== "string") continue;
        // The desktop's own local-llama entry names the desktop's managed
        // port; the terminal agent's names its own. Keep ours.
        if (p["id"] === "local-llama") continue;
        const at = byId.get(p["id"] as string);
        byId.set(p["id"] as string, at ? { ...at, ...p } : p);
        copied.providers++;
      }
      dstLlm["providers"] = [...byId.values()];
      /* r5 review fix (major) — the import must not RE-ROUTE the desktop.
         This used to be an unconditional `dstLlm.activeTextProvider =
         srcLlm.activeTextProvider`, which was wrong twice over:

         (1) It overrode the choice the operator had just made. The import
             step is the LAST wizard screen (obSettle), after the backend
             choice and the second-backend offer, so an operator who picked
             "Local models" and waited out a multi-GB download was silently
             re-routed to the terminal agent's cloud provider by a tick-list
             row whose copy never says it changes where the agent runs.
         (2) Nothing checked the provider resolves a key HERE. Keys live in
             each directory's own .env and the `keys` row is secret, so it
             is OFF in the wizard's defaults — ticking "Atomic Agent in the
             terminal" landed a keyless active provider, exactly the state
             backend-switch.ts activateProvider refuses to create
             (`needsKey: true`, "no API key").

         So the route is only ever FILLED IN, never replaced, and only when
         it will actually work: the destination has no route of its own, and
         the provider resolves a key once this import finishes (the `keys`
         arm runs below, so names this run is about to write count). */
      const srcActive = typeof srcLlm["activeTextProvider"] === "string" ? (srcLlm["activeTextProvider"] as string) : "";
      const dstActive = typeof dstLlm["activeTextProvider"] === "string" ? (dstLlm["activeTextProvider"] as string) : "";
      if (srcActive && srcActive !== "local-llama" && dstActive.length === 0) {
        const entry = byId.get(srcActive) as unknown as ProviderEntry | undefined;
        if (entry && providerHasKey(entry, namesAfterImport(want.keys === true))) {
          dstLlm["activeTextProvider"] = srcActive;
        }
      }
      if (typeof srcLlm["toolTransport"] === "string") dstLlm["toolTransport"] = srcLlm["toolTransport"];
      if (srcLlm["fallback"] && typeof srcLlm["fallback"] === "object") dstLlm["fallback"] = srcLlm["fallback"];
      target["llm"] = dstLlm;
      const srcMcp = (src["mcp"] ?? {}) as Record<string, unknown>;
      if (srcMcp["servers"] && typeof srcMcp["servers"] === "object") {
        const dstMcp = ((target["mcp"] as Record<string, unknown>) ?? {}) as Record<string, unknown>;
        dstMcp["servers"] = srcMcp["servers"];
        target["mcp"] = dstMcp;
      }
      const write = await configSetWhole(target);
      if (!write.ok) return { ok: false, copied, error: write.error ?? "could not write this app's config" };
    }

    if (want.keys) {
      for (const [name, value] of tuiKeyValues()) {
        const res = dotenvSet(DESKTOP_STATE_DIR, name, value);
        if (!res.ok) return { ok: false, copied, error: res.error ?? "could not write " + name };
        copied.keys++;
      }
    }

    if (want.skills) {
      const dst = join(DESKTOP_STATE_DIR, "skills");
      mkdirSync(dst, { recursive: true });
      for (const name of importableSkills()) {
        cpSync(join(TUI_STATE_DIR, "skills", name), join(dst, name), { recursive: true });
        copied.skills++;
      }
    }

    if (want.sessions || want.memory) {
      // See TuiImportHooks: the destination databases belong to a running
      // agent. Down for the copy, back up afterwards, whatever happens.
      if (hooks) await hooks.stopAgent();
      try {
        if (want.sessions) {
          const dst = join(DESKTOP_STATE_DIR, "sessions.sqlite");
          dropWalSiblings(dst);
          if (await sqliteBackup(join(TUI_STATE_DIR, "sessions.sqlite"), dst)) {
            copied.sessions = await sqliteRowCount(dst, "sessions");
          }
        }
        if (want.memory) {
          const dst = join(DESKTOP_STATE_DIR, "memory.sqlite");
          dropWalSiblings(dst);
          copied.memory = await sqliteBackup(join(TUI_STATE_DIR, "memory.sqlite"), dst);
        }
      } finally {
        if (hooks) await hooks.startAgent();
      }
    }

    return { ok: true, copied };
  } catch (err) {
    return { ok: false, copied, error: err instanceof Error ? err.message : String(err) };
  }
}
