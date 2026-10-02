/**
 * Д45 (Settings › Skills › Skills Hub): the hub's last answer, kept on disk.
 *
 * WHERE THE TIME WENT. Every hub view was one `atag skill browse` (or
 * `atag skill search <q>`) subprocess, and nothing of it was kept: the CLI
 * boots, asks ClawHub for its catalogue (one GET, ~1.2 s warm and ~6.5 s
 * cold, measured 02.10 against clawhub.ai), then walks the three default
 * GitHub taps one after the other — a tree listing each, then every SKILL.md
 * on raw.githubusercontent.com, six at a time (73 files in 14 rounds). That is
 * the 15 s the hub sat on two spinners, again on every opening and on every
 * search.
 *
 * THE CACHE. The answer for a query is written here once it has come back
 * whole, keyed by the query and by the config that shaped it (the taps and
 * the ClawHub settings). The window shows it the moment the hub opens and
 * asks the CLI again only when it is older than HUB_CACHE_FRESH_MS, or when
 * the person presses Browse again; a newer answer then replaces it in place.
 * It lives in the desktop's own state directory, so a smoke lane with its own
 * ATOMIC_AGENT_STATE_DIR never reads another run's catalogue.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { HubSkillRow } from "./agent-cli.js";
import { DESKTOP_STATE_DIR } from "./state-dir.js";

export const HUB_CACHE_FILE = "skills-hub-cache.json";
/** Within this an answer is shown and nothing is fetched. */
export const HUB_CACHE_FRESH_MS = 15 * 60_000;
/** Past this an answer is not shown at all. */
export const HUB_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** The browse and the most recent searches; the browse is never the one dropped. */
export const HUB_CACHE_MAX_ENTRIES = 12;

/** What `atag skill browse|search` answered (agent-cli.ts skillBrowse). */
export interface HubBrowseAnswer {
  ok: boolean;
  rows?: HubSkillRow[];
  hubError?: string | null;
  error?: string;
  /** When the rows were fetched (set on an answer that came back whole). */
  savedAt?: number;
}

/** A kept answer, as the window gets it. */
export interface HubCachedAnswer {
  ok: true;
  rows: HubSkillRow[];
  hubError: string | null;
  savedAt: number;
  /** Whole and younger than HUB_CACHE_FRESH_MS: show it and fetch nothing. */
  fresh: boolean;
}

interface Entry {
  rows: HubSkillRow[];
  hubError: string | null;
  savedAt: number;
  config: string;
}

interface CacheFile {
  version: 1;
  entries: Record<string, Entry>;
}

/** One key per query as the hub reads it: case and spacing do not make a new search. */
export function hubCacheKey(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * What in the config shapes a hub answer: `skills.taps` and
 * `skills.clawhub`, hashed. An answer kept under other taps is not shown.
 */
export function hubConfigKey(stateDir: string): string {
  let shape: unknown = null;
  try {
    const cfg = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as { skills?: { taps?: unknown; clawhub?: unknown } } | null;
    const skills = cfg && typeof cfg === "object" ? cfg.skills : undefined;
    shape = skills && typeof skills === "object" ? { taps: skills.taps ?? null, clawhub: skills.clawhub ?? null } : null;
  } catch {
    shape = null; // no config yet, or one being rewritten: the defaults
  }
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

function isRow(v: unknown): v is HubSkillRow {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.identifier === "string" && r.identifier.length > 0
    && (r.source === "clawhub" || r.source === "github")
    && (r.downloads === null || (typeof r.downloads === "number" && Number.isFinite(r.downloads)))
    && typeof r.description === "string";
}

function isEntry(v: unknown): v is Entry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return Array.isArray(e.rows) && e.rows.every(isRow)
    && (e.hubError === null || typeof e.hubError === "string")
    && typeof e.savedAt === "number" && Number.isFinite(e.savedAt)
    && typeof e.config === "string";
}

export class SkillsHubCache {
  private data: CacheFile | null = null;
  private readonly inflight = new Map<string, Promise<HubBrowseAnswer>>();

  constructor(readonly file: string, private readonly now: () => number = Date.now) {}

  /** The kept answer for `query` under `config`, or null when there is none worth showing. */
  peek(query: string, config: string): HubCachedAnswer | null {
    const entry = this.load().entries[hubCacheKey(query)];
    if (!entry || entry.config !== config) return null;
    const age = this.now() - entry.savedAt;
    if (age > HUB_CACHE_MAX_AGE_MS) return null;
    // A cut answer is shown but always asked for again; a clock moved back
    // (a negative age) is never trusted as fresh either.
    const fresh = entry.hubError === null && age >= 0 && age < HUB_CACHE_FRESH_MS;
    return { ok: true, rows: entry.rows, hubError: entry.hubError, savedAt: entry.savedAt, fresh };
  }

  /**
   * Run the browse for `query`, once at a time per query (a second ask joins
   * the first), and keep what it answered. The answer goes back with the
   * time it was fetched.
   *
   * Nothing found while a source failed is a failure, not an empty
   * catalogue: offline, `atag skill browse` prints `(no skills found)` and
   * exits 1 with a WARN per source (src/cli/skill.ts printHubEntries), which
   * agent-cli.ts reads as rows [] plus `hubError`. Handed on as it was, the
   * window took it for the hub's answer and emptied a list it was showing.
   */
  refresh(query: string, config: string, run: () => Promise<HubBrowseAnswer>): Promise<HubBrowseAnswer> {
    const key = hubCacheKey(query);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = (async (): Promise<HubBrowseAnswer> => {
      const res = await run();
      if (!res || !res.ok || !Array.isArray(res.rows)) return res;
      if (res.rows.length === 0 && res.hubError) return { ok: false, error: res.hubError };
      const savedAt = this.now();
      this.keep(key, { rows: res.rows, hubError: res.hubError ?? null, savedAt, config });
      return { ...res, savedAt };
    })().finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }

  /** Read the file again at the next ask (the smoke puts the app's file back under it). */
  reload(): void {
    this.data = null;
  }

  /**
   * A whole answer replaces what was kept. One with a source missing (a tap
   * rate-limited, ClawHub down: `hubError` set) is kept only where nothing
   * whole is, so it never pushes out a full list for a cut one.
   */
  private keep(key: string, entry: Entry): void {
    const data = this.load();
    const old = data.entries[key];
    const oldWhole = !!old && old.config === entry.config && old.hubError === null && this.now() - old.savedAt <= HUB_CACHE_MAX_AGE_MS;
    if (entry.hubError !== null && oldWhole) return;
    data.entries[key] = entry;
    const now = this.now();
    for (const [k, e] of Object.entries(data.entries)) if (now - e.savedAt > HUB_CACHE_MAX_AGE_MS) delete data.entries[k];
    const searches = Object.keys(data.entries).filter((k) => k !== "")
      .sort((a, b) => data.entries[b]!.savedAt - data.entries[a]!.savedAt);
    const room = HUB_CACHE_MAX_ENTRIES - ("" in data.entries ? 1 : 0);
    for (const k of searches.slice(Math.max(0, room))) delete data.entries[k];
    this.save();
  }

  private load(): CacheFile {
    if (this.data) return this.data;
    const data: CacheFile = { version: 1, entries: {} };
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { version?: unknown; entries?: unknown };
      if (raw && raw.version === 1 && raw.entries && typeof raw.entries === "object") {
        for (const [k, e] of Object.entries(raw.entries as Record<string, unknown>)) if (isEntry(e)) data.entries[k] = e;
      }
    } catch {
      // Missing or unreadable: start empty. The next whole answer rewrites it.
    }
    this.data = data;
    return data;
  }

  /* Written beside itself and renamed over, so a crash mid-write leaves the old file. */
  private save(): void {
    if (!this.data) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
    } catch {
      // A cache that cannot be written only costs the next opening its wait.
    }
  }
}

/** The one the app uses: in the desktop's state directory. */
export const hubCache = new SkillsHubCache(join(DESKTOP_STATE_DIR, HUB_CACHE_FILE));
