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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { configGet, configSetWhole, dotenvSet } from "./agent-cli.js";
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

const NOTHING = (): TuiImportResult["copied"] => ({ providers: 0, keys: 0, skills: 0, sessions: 0, memory: false });

function readTuiConfig(): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(join(TUI_STATE_DIR, "config.json"), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Env var NAMES only. A value is never returned, logged or counted. */
function tuiKeyNames(): string[] {
  const names: string[] = [];
  try {
    const text = readFileSync(join(TUI_STATE_DIR, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).replace(/^export\s+/, "").trim();
      if (DOTENV_KEY.test(key) && !names.includes(key)) names.push(key);
    }
  } catch {
    // no .env — nothing to offer
  }
  return names;
}

/** name → value, read once, held only for the length of one write. */
function tuiKeyValues(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  try {
    const text = readFileSync(join(TUI_STATE_DIR, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (!m) continue;
      const value = m[2]!.trim().replace(/^(['"])(.*)\1$/, "$2");
      if (value.length === 0) continue;
      out.push([m[1]!, value]);
    }
  } catch {
    // no .env
  }
  return out;
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

async function sqliteRowCount(file: string, table: string): Promise<number> {
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
      providers: Array.isArray(llm.providers) ? llm.providers.length : 0,
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
export async function importFromTui(opts: TuiImportOptions): Promise<TuiImportResult> {
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
      if (typeof srcLlm["activeTextProvider"] === "string" && srcLlm["activeTextProvider"] !== "local-llama") {
        dstLlm["activeTextProvider"] = srcLlm["activeTextProvider"];
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

    if (want.sessions) {
      const dst = join(DESKTOP_STATE_DIR, "sessions.sqlite");
      if (await sqliteBackup(join(TUI_STATE_DIR, "sessions.sqlite"), dst)) {
        copied.sessions = await sqliteRowCount(dst, "sessions");
      }
    }

    if (want.memory) {
      copied.memory = await sqliteBackup(join(TUI_STATE_DIR, "memory.sqlite"), join(DESKTOP_STATE_DIR, "memory.sqlite"));
    }

    return { ok: true, copied };
  } catch (err) {
    return { ok: false, copied, error: err instanceof Error ? err.message : String(err) };
  }
}
