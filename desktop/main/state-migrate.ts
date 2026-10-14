/**
 * ATO-416 — the one-time move of a desktop install's data into the shared
 * state directory.
 *
 * Until this release the desktop kept everything in `~/.atomic-agent-desktop`
 * (state-dir.ts, r5 item 9). From now on it runs on the terminal agent's own
 * `~/.atomic-agent`, so an existing desktop user's chats, memory, tasks,
 * skills, keys and settings have to arrive there once, on the first launch of
 * the new version. The product owner's rules, all four enforced below:
 *
 *   1. It happens by itself, on the first launch, before anything reads the
 *      shared directory (state-dir-boot.ts calls it before the fresh-run
 *      latch, so a merged directory is not mistaken for a first run, and long
 *      before `atag serve` or `models start`).
 *   2. A BACKUP comes first: the shared directory's config.json, .env and a
 *      consistent copy of each of its databases go to
 *      `<shared>/backups/pre-desktop-merge-<ts>/`.
 *   3. On any conflict the TERMINAL's data wins. The desktop's only ever
 *      fills what the terminal does not have.
 *   4. The old directory is NEVER deleted. Everything that crosses is copied,
 *      except two things that are moved because they are big and the old
 *      directory has no further use for them: model weights (gigabytes) and
 *      traces. Those moves run last, after every other step has succeeded,
 *      so a failed attempt leaves the old directory's data as it was.
 *
 * WHAT CROSSES (a whitelist; anything not named here stays where it is):
 *   config.json         copied as is (nothing on the other side) or merged
 *                       field by field (see mergeConfigs)
 *   .env                names the shared .env lacks (or has empty)
 *   sessions/memory/tasks.sqlite
 *                       a consistent snapshot when the shared side has no
 *                       such database; otherwise the agent's own importer,
 *                       `atag import atomic-desktop --source <old> --json`,
 *                       which merges rows and is idempotent
 *   skills/             skill folders the shared side lacks
 *   restore/ inbox/     files the shared side lacks
 *   browser-profile/ atomic-mail/
 *                       only when the shared side has none (a browser
 *                       profile is not merged file by file)
 *   desktop-analytics.json telegram-session.json discord-session.json
 *                       when absent on the shared side
 *   traces/             moved, entries the shared side lacks
 *   models/models/*     moved, model folders the shared side lacks; a
 *                       `models/models` that is a SYMLINK (the r5 seed linked
 *                       it into ~/.atomic-agent/models/models) is skipped,
 *                       since it already points at the shared weights
 *
 * WHAT DOES NOT: agent.log*, serve.json, serve/, the llama.cpp backend and
 * Atomic Core (`models/backend`, `models/core`, a new launch installs its
 * own), pid / key / lock / log files, `-wal`/`-shm` siblings (the snapshot
 * folds them in), config.json backups and tmp files, install-channel,
 * analytics.json (the install id is the shared ~/.atomic-agent-install-id),
 * web-search-cache.json.
 *
 * ONCE, AND AT MOST THREE TIMES. `<shared>/.desktop-merged.json` records the
 * outcome. `ok:true` ends it for good. `ok:false` is retried on the next
 * launch, at most MAX_ATTEMPTS times in all; every step is idempotent, so a
 * retry after a half-done attempt finishes the job rather than doubling it.
 * Whatever happens the app keeps working: it runs on the shared directory
 * either way. A note, `MOVED-TO-.atomic-agent.txt`, is left in the old
 * directory on success.
 *
 * SYNCHRONOUS on purpose. It runs while state-dir-boot.ts is being loaded,
 * before Electron is ready and before any window or agent exists, so the
 * order is guaranteed by the module system rather than by a promise someone
 * could forget to await. The price is a launch that takes a few seconds
 * longer, once.
 *
 * Everything that touches a process (the `atag` runs, the orphan reap, the
 * pid probe, the clock) is handed in as `deps`, so the smoke can drive the
 * whole thing on throwaway directories with a stand-in agent written in JS
 * (smoke-tasks/t416.ts). Nothing here imports electron.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

import { dotenvSet, normaliseLlmBlock, providerHasKey, type KeyEnvNames, type ProviderEntry } from "./agent-cli.js";
import { parseDotenv } from "./tui-import.js";

/* Local names for the two directories, so this file merges cleanly with the
   ATO-416 change to state-dir.ts (which makes ~/.atomic-agent the default and
   exports LEGACY_DESKTOP_STATE_DIR). Same values. */
/** The desktop's directory before ATO-416 (state-dir.ts LEGACY_DESKTOP_STATE_DIR). */
export const LEGACY_DIR_DEFAULT = join(homedir(), ".atomic-agent-desktop");
/** The terminal agent's directory, shared with the desktop from ATO-416 (state-dir.ts TUI_STATE_DIR). */
export const SHARED_DIR_DEFAULT = join(homedir(), ".atomic-agent");

export const MERGE_MARKER = ".desktop-merged.json";
export const MOVED_NOTE = "MOVED-TO-.atomic-agent.txt";
export const MAX_ATTEMPTS = 3;
const DBS = ["sessions.sqlite", "memory.sqlite", "tasks.sqlite"] as const;
const COPY_IF_ABSENT_FILES = ["desktop-analytics.json", "telegram-session.json", "discord-session.json"];
const COPY_IF_ABSENT_DIRS = ["browser-profile", "atomic-mail"];
const COPY_MISSING_TREES = ["restore", "inbox"];

/* ------------------------------------------------------------- types --- */

export interface AtagRun {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}
/** One `atag` run with ATOMIC_AGENT_STATE_DIR=<stateDir>, synchronously. */
export type RunAtag = (args: string[], opts: { stateDir: string; input?: string; timeoutMs?: number }) => AtagRun;

export interface MigrateDeps {
  runAtag: RunAtag;
  /** Ends the `atag serve` a `serve.json` names, if it is still alive (agent-client.ts reapOrphanedServe). */
  reapServe: (serveJsonPath: string) => void;
  pidAlive: (pid: number) => boolean;
  now: () => number;
}

export interface ImporterReport {
  ok?: boolean;
  sessions?: { imported?: number; skipped?: number };
  tasks?: { imported?: number; skipped?: number };
  notes?: { imported?: number; skipped?: number };
  profileFacts?: { imported?: number; skipped?: number };
  warnings?: string[];
}

export interface StateMergeRecord {
  ok: boolean;
  /** "copy": the shared side had no config.json. "merge": it had one. */
  mode: "copy" | "merge" | null;
  at: string;
  attempts: number;
  legacyDir: string;
  targetDir: string;
  backupDir: string | null;
  counts: {
    providersAdded: number;
    keysFilled: number;
    mcpServersAdded: number;
    customModelsAdded: number;
    envKeysAdded: number;
    databasesCopied: string[];
    skillsCopied: number;
    filesCopied: number;
    tracesMoved: number;
    modelsMoved: number;
  };
  imported: ImporterReport | null;
  warnings: string[];
  error?: string;
  noticeShown: boolean;
}

export type MigrateOutcome =
  | { ran: false; reason: string }
  | { ran: true; record: StateMergeRecord };

/* -------------------------------------------------------------- gate --- */

function samePath(a: string, b: string): boolean {
  const ra = resolve(a);
  const rb = resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

export function readMergeMarker(targetDir: string): StateMergeRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(targetDir, MERGE_MARKER), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as StateMergeRecord) : null;
  } catch {
    return null;
  }
}

/**
 * Whether this launch should try the merge, and if not, why. Pure apart from
 * the existence checks, so the smoke can walk its whole table.
 */
export function mergeGate(input: {
  currentDir: string;
  sharedDir: string;
  legacyDir: string;
  fromEnv: boolean;
}): { run: boolean; reason: string } {
  if (input.fromEnv) return { run: false, reason: "the state directory was named by the environment" };
  if (!samePath(input.currentDir, input.sharedDir)) return { run: false, reason: "this app does not run on the shared directory" };
  if (samePath(input.legacyDir, input.sharedDir)) return { run: false, reason: "the old and the shared directory are the same" };
  if (!existsSync(join(input.legacyDir, "config.json"))) return { run: false, reason: "no earlier desktop setup" };
  const marker = readMergeMarker(input.sharedDir);
  if (marker?.ok === true) return { run: false, reason: "already merged" };
  if (marker && marker.ok === false && (marker.attempts ?? 0) >= MAX_ATTEMPTS) {
    return { run: false, reason: `gave up after ${marker.attempts} attempts` };
  }
  return { run: true, reason: "" };
}

/* ------------------------------------------------------- config merge --- */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const asObj = (v: unknown): Obj | null => (isObj(v) ? v : null);
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v.filter(isObj) as Obj[]) : []);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The key names the shared directory will resolve: the environment, then its .env (load-dotenv.ts order). */
export function keyNamesIn(stateDir: string, env: NodeJS.ProcessEnv = process.env): KeyEnvNames {
  const present = new Set<string>();
  const nonEmpty = new Set<string>();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    present.add(k);
    if (v.length > 0) nonEmpty.add(k);
  }
  try {
    for (const line of readFileSync(join(stateDir, ".env"), "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (!m || present.has(m[1]!)) continue;
      present.add(m[1]!);
      if (m[2]!.trim().replace(/^["']|["']$/g, "").length > 0) nonEmpty.add(m[1]!);
    }
  } catch {
    // no .env: the environment alone decides
  }
  return { present, nonEmpty, badChars: new Set() };
}

export interface ConfigMergeResult {
  config: Obj;
  providersAdded: number;
  keysFilled: number;
  mcpServersAdded: number;
  customModelsAdded: number;
  warnings: string[];
}

/**
 * The terminal's config with the desktop's filled in where the terminal has
 * nothing. Pure: both inputs are left as they were.
 *
 *  · llm.providers: a desktop provider whose id the terminal lacks is added
 *    WITH its inline apiKey (the desktop keeps keys inline, in a 0600 file,
 *    ATO-132). Same id: the terminal's entry stays, and only when it resolves
 *    no key at all does it take the desktop's inline key. The desktop's
 *    `local-llama` never crosses: it names the desktop's own managed port.
 *  · llm.activeTextProvider: the terminal's; filled from the desktop only
 *    when the terminal has none and the provider resolves a key.
 *  · mcp.servers (by name) and localModels.customModels (by id): union, the
 *    terminal's entry wins on a clash.
 *  · localModels, llm.runMode, tui.onboarding and every other block: the
 *    terminal's, untouched.
 *  · telegram / discord: the desktop's block only when the terminal's is not
 *    paired (no owner) and the desktop's is.
 *  · analytics.enabled: off if EITHER side turned it off.
 *
 * `names` is what the shared directory resolves once its .env merge is done.
 */
export function mergeConfigs(terminal: Obj, desktop: Obj, names: KeyEnvNames, paths?: { legacyModels: string; targetModels: string }): ConfigMergeResult {
  const out = clone(terminal);
  const warnings: string[] = [];
  let providersAdded = 0;
  let keysFilled = 0;
  let mcpServersAdded = 0;
  let customModelsAdded = 0;

  const dLlm: Obj = asObj(desktop["llm"]) ?? {};
  const dProviders = arr(dLlm["providers"]).filter((p) => typeof p["id"] === "string" && p["id"] !== "local-llama");
  if (dProviders.length > 0) {
    const tLlm: Obj = asObj(out["llm"]) ?? {};
    const tProviders = arr(tLlm["providers"]);
    const byId = new Map(tProviders.filter((p) => typeof p["id"] === "string").map((p): [string, Obj] => [p["id"] as string, p]));
    for (const p of dProviders) {
      const at = byId.get(p["id"] as string);
      if (!at) {
        const added = clone(p);
        tProviders.push(added);
        byId.set(p["id"] as string, added);
        providersAdded++;
        continue;
      }
      const key = typeof p["apiKey"] === "string" ? p["apiKey"] : "";
      if (key.length > 0 && !providerHasKey(at as unknown as ProviderEntry, names)) {
        at["apiKey"] = key;
        keysFilled++;
      }
    }
    tLlm["providers"] = tProviders;
    const tActive = typeof tLlm["activeTextProvider"] === "string" ? (tLlm["activeTextProvider"] as string) : "";
    const dActive = typeof dLlm["activeTextProvider"] === "string" ? (dLlm["activeTextProvider"] as string) : "";
    if (!tActive && dActive && dActive !== "local-llama") {
      const entry = byId.get(dActive);
      if (entry && providerHasKey(entry as unknown as ProviderEntry, names)) tLlm["activeTextProvider"] = dActive;
    }
    out["llm"] = tLlm;
  }

  const dServers = arr(asObj(desktop["mcp"])?.["servers"]);
  if (dServers.length > 0) {
    const tMcp: Obj = asObj(out["mcp"]) ?? {};
    const tServers = arr(tMcp["servers"]);
    const names2 = new Set(tServers.map((s) => s["name"]).filter((n): n is string => typeof n === "string"));
    for (const s of dServers) {
      if (typeof s["name"] !== "string" || names2.has(s["name"])) continue;
      tServers.push(clone(s));
      names2.add(s["name"]);
      mcpServersAdded++;
    }
    tMcp["servers"] = tServers;
    out["mcp"] = tMcp;
  }

  const dCustom = arr(asObj(desktop["localModels"])?.["customModels"]);
  if (dCustom.length > 0) {
    const tLocal: Obj = asObj(out["localModels"]) ?? {};
    const tCustom = arr(tLocal["customModels"]);
    const ids = new Set(tCustom.map((m) => m["id"]).filter((n): n is string => typeof n === "string"));
    for (const m of dCustom) {
      if (typeof m["id"] !== "string" || ids.has(m["id"])) continue;
      tCustom.push(rehomeLocalPath(clone(m), paths));
      ids.add(m["id"]);
      customModelsAdded++;
    }
    tLocal["customModels"] = tCustom;
    out["localModels"] = tLocal;
  }

  for (const block of ["telegram", "discord"] as const) {
    const t = asObj(out[block]);
    const d = asObj(desktop[block]);
    if (d && paired(block, d) && !(t && paired(block, t))) out[block] = clone(d);
  }

  const tAnalytics: Obj = asObj(out["analytics"]) ?? {};
  const dAnalytics: Obj = asObj(desktop["analytics"]) ?? {};
  if (tAnalytics["enabled"] === false || dAnalytics["enabled"] === false) {
    tAnalytics["enabled"] = false;
    out["analytics"] = tAnalytics;
  }

  normaliseLlmBlock(out);
  return { config: out, providersAdded, keysFilled, mcpServersAdded, customModelsAdded, warnings };
}

function paired(block: "telegram" | "discord", cfg: Obj): boolean {
  if (block === "telegram") return typeof cfg["ownerUserId"] === "number";
  return Array.isArray(cfg["ownerUserIds"]) && cfg["ownerUserIds"].length > 0;
}

/** A custom model registered from a file inside the old weights folder points at where that file is moved to. */
function rehomeLocalPath(model: Obj, paths?: { legacyModels: string; targetModels: string }): Obj {
  const p = model["localPath"];
  if (!paths || typeof p !== "string") return model;
  const from = paths.legacyModels + sep;
  if (p.startsWith(from)) model["localPath"] = join(paths.targetModels, p.slice(from.length));
  return model;
}

/* ----------------------------------------------------------- helpers --- */

function sha256Of(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function readJson(path: string): Obj | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

function writeFileAtomic(path: string, text: string, mode = 0o600): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { encoding: "utf8", mode });
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  try { chmodSync(path, mode); } catch { /* no chmod on this platform */ }
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/* node:sqlite (Electron 44's Node has it; tui-import.ts uses it the same way). */
type SqliteDb = { exec(sql: string): void; close(): void };
type NodeSqlite = { DatabaseSync: new (path: string, opts: { readOnly?: boolean; timeout?: number }) => SqliteDb };
function nodeSqlite(): NodeSqlite | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node:sqlite") as NodeSqlite;
  } catch {
    return null;
  }
}

/**
 * A consistent copy of a database that may be open elsewhere (the terminal
 * agent may be running while its own files are backed up). `VACUUM INTO` is a
 * single read transaction, so the copy is one point in time with any WAL
 * folded in, and it is synchronous, which the boot path needs (the async
 * `backup()` is not). The source is opened read-only; a busy writer is
 * waited on for five seconds. Throws when it cannot copy.
 */
export function sqliteSnapshot(src: string, dst: string): void {
  const part = `${dst}.part`;
  rmSync(part, { force: true });
  const sq = nodeSqlite();
  if (sq) {
    let lastErr: unknown = null;
    const closeQuietly = (db: SqliteDb | undefined) => { try { db?.close(); } catch { /* closed */ } };
    // Read-only first; a build that will not VACUUM INTO from a read-only
    // handle gets a normal one (VACUUM INTO only ever reads the source).
    for (const readOnly of [true, false]) {
      let db: SqliteDb | undefined;
      try {
        db = new sq.DatabaseSync(src, { readOnly, timeout: 5000 });
        db.exec(`VACUUM INTO '${part.replace(/'/g, "''")}'`);
        closeQuietly(db);
        lastErr = null;
        break;
      } catch (err) {
        closeQuietly(db);
        lastErr = err;
        rmSync(part, { force: true });
      }
    }
    if (lastErr) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    renameSync(part, dst);
    return;
  }
  // No node:sqlite: the file and its WAL, together. Only safe because the
  // old directory's agent has been stopped by now; said in the warnings.
  copyFileSync(src, dst);
  if (existsSync(`${src}-wal`)) copyFileSync(`${src}-wal`, `${dst}-wal`);
}

/** Move `name` from `fromDir` to `toDir` for each entry the destination lacks. */
function moveMissing(fromDir: string, toDir: string, warnings: string[], what: string): number {
  let moved = 0;
  const names = entries(fromDir).filter((n) => !n.startsWith("."));
  if (names.length === 0) return 0;
  mkdirSync(toDir, { recursive: true });
  for (const name of names) {
    const dst = join(toDir, name);
    if (existsSync(dst)) continue;
    try {
      renameSync(join(fromDir, name), dst);
      moved++;
    } catch (err) {
      // EXDEV (another volume) or EBUSY/EPERM (Windows: a file still open).
      // Copying gigabytes here would hold the launch for minutes, so it is
      // left where it is and said.
      warnings.push(`${what} ${name} was not moved (${(err as NodeJS.ErrnoException).code ?? String(err)}); it is still in ${fromDir}`);
    }
  }
  return moved;
}

/* ------------------------------------------------------------- the run --- */

function emptyRecord(legacyDir: string, targetDir: string, attempts: number, at: string): StateMergeRecord {
  return {
    ok: false,
    mode: null,
    at,
    attempts,
    legacyDir,
    targetDir,
    backupDir: null,
    counts: {
      providersAdded: 0, keysFilled: 0, mcpServersAdded: 0, customModelsAdded: 0, envKeysAdded: 0,
      databasesCopied: [], skillsCopied: 0, filesCopied: 0, tracesMoved: 0, modelsMoved: 0,
    },
    imported: null,
    warnings: [],
    noticeShown: false,
  };
}

/** A live process holds one of the old directory's channel locks: the bot would be polled twice. */
function liveChannelLock(legacyDir: string, deps: MigrateDeps): string | null {
  for (const name of entries(legacyDir)) {
    if (!/^(telegram|discord)(-[^/\\]+)?\.lock$/.test(name)) continue;
    let pid = NaN;
    try { pid = Number.parseInt(readFileSync(join(legacyDir, name), "utf8").trim(), 10); } catch { /* unreadable: not held */ }
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid && deps.pidAlive(pid)) return `${name} (pid ${pid})`;
  }
  return null;
}

function atagJson(deps: MigrateDeps, args: string[], stateDir: string, what: string): Obj {
  const r = deps.runAtag(args, { stateDir });
  if (r.status !== 0) throw new Error(`${what} failed: ${(r.error || r.stderr || `exit ${r.status}`).trim().slice(0, 300)}`);
  try {
    const v = JSON.parse(r.stdout) as unknown;
    if (isObj(v)) return v;
  } catch { /* fall through */ }
  throw new Error(`${what} did not return JSON`);
}

/** The last line of stdout that parses as a JSON object (the importer may print progress first). */
function lastJsonObject(stdout: string): Obj | null {
  const whole = stdout.trim();
  try { const v = JSON.parse(whole) as unknown; if (isObj(v)) return v; } catch { /* lines below */ }
  for (const line of whole.split(/\r?\n/).reverse()) {
    try { const v = JSON.parse(line) as unknown; if (isObj(v)) return v; } catch { /* next */ }
  }
  return null;
}

/**
 * Try the merge once. Never throws: a failure is the record's `ok:false`.
 * The caller has already checked mergeGate.
 */
export function migrateDesktopState(legacyDir: string, targetDir: string, deps: MigrateDeps): MigrateOutcome {
  const previous = readMergeMarker(targetDir);
  const startedAt = deps.now();
  const stamp = new Date(startedAt).toISOString();
  const record = emptyRecord(legacyDir, targetDir, (previous?.ok === false ? previous.attempts ?? 0 : 0) + 1, stamp);
  const w = record.warnings;

  // 1. Nothing may still be running out of the old directory.
  try { deps.reapServe(join(legacyDir, "serve.json")); } catch { /* nothing to reap */ }
  const stop = deps.runAtag(["models", "stop"], { stateDir: legacyDir, timeoutMs: 30_000 });
  if (stop.status !== 0) w.push(`models stop in the old directory said: ${(stop.error || stop.stderr || `exit ${stop.status}`).trim().slice(0, 200)}`);
  const held = liveChannelLock(legacyDir, deps);
  if (held) return { ran: false, reason: `a running process still holds ${held} in the old directory; trying again next launch` };

  const scratch = join(targetDir, `.desktop-merge-tmp-${startedAt}`);
  try {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const targetHadConfig = existsSync(join(targetDir, "config.json"));
    record.mode = targetHadConfig ? "merge" : "copy";

    // 2. Backup of what the shared directory already holds.
    const toBackUp = [
      ...["config.json", ".env"].filter((f) => existsSync(join(targetDir, f))),
      ...DBS.filter((f) => existsSync(join(targetDir, f))),
    ];
    if (toBackUp.length > 0) {
      const backupDir = join(targetDir, "backups", `pre-desktop-merge-${stamp.replace(/[:.]/g, "-")}`);
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      for (const f of toBackUp) {
        if ((DBS as readonly string[]).includes(f)) sqliteSnapshot(join(targetDir, f), join(backupDir, f));
        else { copyFileSync(join(targetDir, f), join(backupDir, f)); try { chmodSync(join(backupDir, f), 0o600); } catch { /* no chmod */ } }
      }
      record.backupDir = backupDir;
    }

    // 3. .env: the names the shared side lacks or holds empty. Before the
    //    config merge, so "does the terminal's provider resolve a key" sees them.
    let legacyEnv = new Map<string, string>();
    try { legacyEnv = parseDotenv(readFileSync(join(legacyDir, ".env"), "utf8")); } catch { /* no .env */ }
    let targetEnv = new Map<string, string>();
    try { targetEnv = parseDotenv(readFileSync(join(targetDir, ".env"), "utf8")); } catch { /* no .env */ }
    for (const [name, value] of legacyEnv) {
      if (targetEnv.has(name)) continue;
      const res = dotenvSet(targetDir, name, value);
      if (!res.ok) throw new Error(`could not write ${name} to the shared .env: ${res.error ?? "unknown error"}`);
      record.counts.envKeysAdded++;
    }

    // Where the weights live on each side (a dataDirOverride moves them).
    const legacyCfgRaw = readJson(join(legacyDir, "config.json"));
    if (!legacyCfgRaw) throw new Error(`could not read ${join(legacyDir, "config.json")}`);
    const dataDirOf = (cfg: Obj | null, stateDir: string): string => {
      const o = asObj(asObj(cfg?.["localModels"])?.["managed"])?.["dataDirOverride"];
      return typeof o === "string" && isAbsolute(o) ? o : join(stateDir, "models");
    };
    const legacyModels = join(dataDirOf(legacyCfgRaw, legacyDir), "models");

    // 4. config.json. A copy when the shared side has none: written LAST
    //    (step 7), so an attempt that fails before it retries as a copy.
    let copyConfig: Obj | null = null;
    if (!targetHadConfig) {
      copyConfig = clone(legacyCfgRaw);
      const copyTargetModels = join(targetDir, "models", "models");
      const lm = asObj(copyConfig["localModels"]);
      if (lm && Array.isArray(lm["customModels"])) {
        lm["customModels"] = arr(lm["customModels"]).map((m) => rehomeLocalPath(m, { legacyModels, targetModels: copyTargetModels }));
      }
    } else {
      mergeConfigInto(legacyDir, targetDir, scratch, legacyModels, deps, record);
    }

    // 5. Databases: a snapshot where the shared side has none, the agent's
    //    importer where both sides have one.
    const both: string[] = [];
    for (const db of DBS) {
      const src = join(legacyDir, db);
      if (!existsSync(src)) continue;
      const dst = join(targetDir, db);
      if (existsSync(dst)) { both.push(db); continue; }
      sqliteSnapshot(src, dst);
      record.counts.databasesCopied.push(db);
    }
    if (!nodeSqlite() && record.counts.databasesCopied.length > 0) w.push("node:sqlite was not available; the databases were copied as files");
    if (both.length > 0) {
      const r = deps.runAtag(["import", "atomic-desktop", "--source", legacyDir, "--json"], { stateDir: targetDir, timeoutMs: 300_000 });
      const report = lastJsonObject(r.stdout) as unknown as ImporterReport | null;
      if (r.status !== 0 || !report || report.ok === false) {
        throw new Error(`the chats and memory import failed: ${(r.error || r.stderr || (report ? JSON.stringify(report).slice(0, 200) : `exit ${r.status}`)).trim().slice(0, 300)}`);
      }
      record.imported = report;
      for (const msg of Array.isArray(report.warnings) ? report.warnings : []) w.push(`import: ${String(msg)}`);
    }

    // 6. Skills and the small things, copied where the shared side lacks them.
    const mySkills = new Set(entries(join(targetDir, "skills")));
    for (const name of entries(join(legacyDir, "skills"))) {
      if (name.startsWith(".") || mySkills.has(name) || !isDir(join(legacyDir, "skills", name))) continue;
      cpSync(join(legacyDir, "skills", name), join(targetDir, "skills", name), { recursive: true, force: false, errorOnExist: false });
      record.counts.skillsCopied++;
    }
    for (const f of COPY_IF_ABSENT_FILES) {
      if (!existsSync(join(legacyDir, f)) || existsSync(join(targetDir, f))) continue;
      copyFileSync(join(legacyDir, f), join(targetDir, f));
      record.counts.filesCopied++;
    }
    for (const d of COPY_IF_ABSENT_DIRS) {
      if (!isDir(join(legacyDir, d)) || existsSync(join(targetDir, d))) continue;
      cpSync(join(legacyDir, d), join(targetDir, d), { recursive: true, force: false, errorOnExist: false });
      record.counts.filesCopied++;
    }
    for (const d of COPY_MISSING_TREES) {
      if (!isDir(join(legacyDir, d))) continue;
      // force:false keeps every file the shared side already has.
      cpSync(join(legacyDir, d), join(targetDir, d), { recursive: true, force: false, errorOnExist: false });
      record.counts.filesCopied++;
    }

    // 7. The copied config, now that everything it describes is in place.
    if (copyConfig) writeFileAtomic(join(targetDir, "config.json"), `${JSON.stringify(copyConfig, null, 2)}\n`);

    // 8. The two moves, last: traces, then the weights.
    record.counts.tracesMoved = moveMissing(join(legacyDir, "traces"), join(targetDir, "traces"), w, "trace");
    const targetCfg = readJson(join(targetDir, "config.json"));
    const targetModels = join(dataDirOf(targetCfg, targetDir), "models");
    if (isSymlink(legacyModels)) {
      // The r5 seed linked the old weights folder to the shared one: nothing to move.
    } else if (!isInside(legacyModels, legacyDir)) {
      // A folder the operator chose (dataDirOverride) is theirs, not the old directory's: left alone.
      w.push(`the desktop's models are in ${legacyModels}, a folder of your own; they were left there`);
    } else if (isDir(legacyModels) && !sameRealPath(legacyModels, targetModels)) {
      record.counts.modelsMoved = moveMissing(legacyModels, targetModels, w, "model");
    }

    record.ok = true;
  } catch (err) {
    record.ok = false;
    record.error = err instanceof Error ? err.message : String(err);
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* our own tmp; a later launch tidies nothing else */ }
  }

  writeMarker(targetDir, record);
  if (record.ok) leaveNote(legacyDir, targetDir, stamp);
  appendLog(targetDir, stateMergeLogLine(record));
  return { ran: true, record };
}

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent) + sep;
  return process.platform === "win32" ? c.toLowerCase().startsWith(p.toLowerCase()) : c.startsWith(p);
}

function sameRealPath(a: string, b: string): boolean {
  try {
    return samePath(realpathSync(a), realpathSync(b));
  } catch {
    return samePath(a, b);
  }
}

/**
 * Step 4 when both sides have a config. Each side is read through the agent
 * (`config get`), so both arrive at the bundled agent's schema version: the
 * terminal's in place (that is what any run of this agent there does), the
 * desktop's from a scratch copy, so the old directory is not rewritten.
 * Written back with `config set -` (stdin: it carries keys), only if the
 * terminal's file did not change in between; one re-read and re-merge if it
 * did.
 */
function mergeConfigInto(legacyDir: string, targetDir: string, scratch: string, legacyModels: string, deps: MigrateDeps, record: StateMergeRecord): void {
  const w = record.warnings;
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  copyFileSync(join(legacyDir, "config.json"), join(scratch, "config.json"));
  let desktop: Obj;
  try {
    desktop = atagJson(deps, ["config", "get"], scratch, "reading the desktop settings");
  } catch (err) {
    desktop = readJson(join(legacyDir, "config.json")) ?? {};
    w.push(`${err instanceof Error ? err.message : String(err)}; read the file as it is`);
  }
  const bundledVersion = typeof desktop["version"] === "number" ? (desktop["version"] as number) : null;

  for (let turn = 0; turn < 2; turn++) {
    const terminal = atagJson(deps, ["config", "get"], targetDir, "reading the terminal settings");
    const shaBefore = sha256Of(join(targetDir, "config.json"));
    const tVersion = typeof terminal["version"] === "number" ? (terminal["version"] as number) : null;
    if (bundledVersion !== null && tVersion !== null && tVersion > bundledVersion) {
      w.push(`the terminal's settings are from a newer version (v${tVersion}) than this app's agent (v${bundledVersion}); the desktop's settings were not merged`);
      return;
    }
    const targetModels = join(targetDir, "models", "models");
    const merged = mergeConfigs(terminal, desktop, keyNamesIn(targetDir), { legacyModels, targetModels });
    w.push(...merged.warnings);
    const nothing = merged.providersAdded + merged.keysFilled + merged.mcpServersAdded + merged.customModelsAdded === 0
      && JSON.stringify(merged.config) === JSON.stringify(normalised(terminal));
    if (nothing) return;
    if (sha256Of(join(targetDir, "config.json")) !== shaBefore) continue;   // the terminal wrote it meanwhile: again
    const r = deps.runAtag(["config", "set", "-"], { stateDir: targetDir, input: JSON.stringify(merged.config) });
    if (r.status !== 0) {
      const said = (r.error || r.stderr || `exit ${r.status}`).trim();
      if (/newer than this build/i.test(said)) {
        w.push(`the terminal's settings are from a newer version than this app's agent; the desktop's settings were not merged`);
        return;
      }
      throw new Error(`writing the merged settings failed: ${said.slice(0, 300)}`);
    }
    record.counts.providersAdded = merged.providersAdded;
    record.counts.keysFilled = merged.keysFilled;
    record.counts.mcpServersAdded = merged.mcpServersAdded;
    record.counts.customModelsAdded = merged.customModelsAdded;
    return;
  }
  w.push("the terminal agent kept changing its settings while they were being merged; the desktop's settings were not merged");
}

function normalised(cfg: Obj): Obj {
  const c = clone(cfg);
  normaliseLlmBlock(c);
  return c;
}

function writeMarker(targetDir: string, record: StateMergeRecord): void {
  try {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(targetDir, MERGE_MARKER), `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // A marker that cannot be written means one more attempt next launch,
    // and every step is idempotent.
  }
}

function leaveNote(legacyDir: string, targetDir: string, stamp: string): void {
  try {
    writeFileSync(
      join(legacyDir, MOVED_NOTE),
      [
        "Atomic Agent desktop no longer uses this folder.",
        "",
        `On ${stamp} its chats, memory, tasks, skills and settings were merged into ${targetDir},`,
        "the folder the terminal agent uses too. Model files and traces were moved there;",
        "everything else here was copied and left as it was.",
        "",
        "Nothing reads this folder any more. Keep it as a backup, or delete it yourself when you are sure.",
        "",
      ].join("\n"),
      "utf8",
    );
  } catch {
    // only a courtesy
  }
}

/** One line for agent.log and Diagnostics: what crossed, in numbers. */
export function stateMergeLogLine(r: StateMergeRecord): string {
  if (!r.ok) {
    return `[desktop] state: merging ${r.legacyDir} into ${r.targetDir} did not finish (attempt ${r.attempts} of ${MAX_ATTEMPTS}): ${r.error ?? "unknown error"}`;
  }
  const c = r.counts;
  const imp = r.imported;
  const parts = [
    `mode ${r.mode}`,
    `${c.providersAdded} providers`,
    `${c.mcpServersAdded} MCP servers`,
    `${c.envKeysAdded} keys`,
    `${c.skillsCopied} skills`,
    `${c.modelsMoved} models moved`,
    `${c.tracesMoved} traces moved`,
    c.databasesCopied.length ? `copied ${c.databasesCopied.join(", ")}` : "",
    imp ? `imported ${imp.sessions?.imported ?? 0} chats, ${imp.tasks?.imported ?? 0} tasks, ${imp.notes?.imported ?? 0} notes, ${imp.profileFacts?.imported ?? 0} profile facts` : "",
  ].filter(Boolean);
  return `[desktop] state: merged ${r.legacyDir} into ${r.targetDir} (${parts.join("; ")})`
    + (r.backupDir ? `; backup in ${r.backupDir}` : "")
    + (r.warnings.length ? `; ${r.warnings.length} warning(s): ${r.warnings.join(" | ")}` : "");
}

function appendLog(targetDir: string, line: string): void {
  try {
    appendFileSync(join(targetDir, "agent.log"), `${new Date().toISOString()} WARN ${line}\n`);
  } catch {
    // logging must never be the reason a launch breaks
  }
}

/* ------------------------------------------------------------ notice --- */

function tilde(p: string): string {
  if (process.platform === "win32") return p;
  const home = homedir();
  return p === home ? "~" : p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p;
}

export interface StateMergeNotice {
  title: string;
  text: string;
  /** The Diagnostics line, at WARN. */
  log: string;
}

/** What the window says once after a merge. Pure. */
export function stateMergeNoticeFor(r: StateMergeRecord): StateMergeNotice {
  const backup = r.mode === "merge" && r.backupDir ? r.backupDir : r.legacyDir;
  return {
    title: "Your desktop data moved",
    text: `Your desktop chats, memory and settings now live with the terminal agent in ${tilde(r.targetDir)}. `
      + `A backup of the earlier files is in ${tilde(backup)}.`,
    log: stateMergeLogLine(r),
  };
}

/**
 * The notice, the first time a window asks after a successful merge; null
 * every time after (the marker records that it was shown).
 */
export function takeStateMergeNotice(targetDir: string): StateMergeNotice | null {
  const r = readMergeMarker(targetDir);
  if (!r || r.ok !== true || r.noticeShown) return null;
  writeMarker(targetDir, { ...r, noticeShown: true });
  return stateMergeNoticeFor(r);
}

/* ------------------------------------------------------ the real deps --- */

/**
 * The boot call (state-dir-boot.ts). Wires the real agent, reap and pid
 * probe, checks the gate, runs. Never throws.
 */
export function runDesktopStateMigrationAtBoot(
  currentDir: string,
  fromEnv: boolean,
  real: { resolveBinary: () => string | null; reapServe: (path: string) => void },
  dirs: { legacyDir?: string; sharedDir?: string } = {},
): MigrateOutcome {
  try {
    const legacyDir = dirs.legacyDir ?? LEGACY_DIR_DEFAULT;
    const sharedDir = dirs.sharedDir ?? SHARED_DIR_DEFAULT;
    const gate = mergeGate({ currentDir, sharedDir, legacyDir, fromEnv });
    if (!gate.run) return { ran: false, reason: gate.reason };
    const outcome = migrateDesktopState(legacyDir, currentDir, {
      runAtag: (args, opts) => {
        const bin = real.resolveBinary();
        if (!bin) return { status: null, stdout: "", stderr: "", error: "no atomic-agent binary found" };
        const r = spawnSync(bin, args, {
          env: { ...process.env, ATOMIC_AGENT_STATE_DIR: opts.stateDir },
          encoding: "utf8",
          timeout: opts.timeoutMs ?? 60_000,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          ...(opts.input !== undefined ? { input: opts.input } : {}),
        });
        return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error.message } : {}) };
      },
      reapServe: real.reapServe,
      pidAlive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (err) {
          return (err as NodeJS.ErrnoException).code === "EPERM";
        }
      },
      now: () => Date.now(),
    });
    if (outcome.ran) console.error(stateMergeLogLine(outcome.record));
    else console.error(`[desktop] state: merge of ${legacyDir} postponed: ${outcome.reason}`);
    return outcome;
  } catch (err) {
    return { ran: false, reason: `the merge could not start: ${err instanceof Error ? err.message : String(err)}` };
  }
}
