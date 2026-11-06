import { randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createDefaultPluginFetcher, githubUrl, type PluginFetcher } from "./marketplace-fetch.js";
import {
  findMarketplaceFile,
  MarketplaceError,
  readMarketplaceFile,
  parseMarketplaceJson,
  type MarketplaceEntry,
  type MarketplaceManifest,
} from "./marketplace-manifest.js";
import {
  marketplaceCheckoutDir,
  marketplacesRoot,
  readMarketplaceLock,
  writeMarketplaceLock,
  type MarketplaceRecord,
  type MarketplaceSourceRecord,
} from "./marketplace-store.js";
import { detectPluginFormat, PLUGIN_NAME_RE } from "./plugin-manifest.js";
import { discardStagedPlugin, PluginInstallError, reviewAndCommit, stagePluginCopy, type PluginReview } from "./plugin-install.js";
import { pluginsRoot, readPluginState, type InstalledPluginRecord, type PluginSourceRecord } from "./plugin-store.js";

/**
 * Marketplace operations shared by the CLI and (later) the desktop sidecar:
 * add / list / update / remove marketplaces, and install / update plugins
 * listed in them. Every install goes fetch -> plugin folder -> stage ->
 * review -> commit; the review hook is where the security scan and the
 * runs-code consent plug in. Nothing fetched is ever executed.
 */

export interface MarketplaceDeps {
  fetcher?: PluginFetcher;
  now?: () => Date;
  /** Base for relative local paths given to `marketplace add`. */
  cwd?: string;
}

function deps(d: MarketplaceDeps = {}) {
  return { fetcher: d.fetcher ?? createDefaultPluginFetcher(), now: d.now ?? (() => new Date()), cwd: d.cwd ?? process.cwd() };
}

/**
 * Read what the user typed after `marketplace add`:
 *  - `./dir`, `/abs/dir`, `~/dir` or an existing folder or `marketplace.json` -> local
 *  - `https://.../marketplace.json` (any https URL ending in `.json`) -> url
 *  - `https://host/owner/repo(.git)`, `ssh://...`, `git@host:owner/repo` -> git
 *  - `owner/repo` -> GitHub
 */
export function parseMarketplaceInput(input: string, cwd = process.cwd()): MarketplaceSourceRecord {
  const raw = input.trim();
  if (!raw) throw new MarketplaceError("give a marketplace: owner/repo, a git URL, a folder or a URL to marketplace.json");
  if (/^https?:\/\//i.test(raw)) {
    if (/^http:\/\//i.test(raw)) throw new MarketplaceError("plain http is not allowed; use https");
    return /\.json(?:[?#].*)?$/i.test(raw) ? { kind: "url", url: raw } : { kind: "git", url: raw };
  }
  if (/^ssh:\/\//i.test(raw) || /^[\w.-]+@[\w.-]+:/.test(raw)) return { kind: "git", url: raw };
  const looksLikePath = raw.startsWith(".") || raw.startsWith("/") || raw.startsWith("~") || /^[a-z]:[\\/]/i.test(raw) || raw.includes("\\");
  if (looksLikePath) return { kind: "local", path: expandPath(raw, cwd) };
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
    // `owner/repo` unless it names a folder that exists right here.
    const asPath = resolve(cwd, raw);
    if (existsSync(asPath) && statSync(asPath).isDirectory() && findMarketplaceFile(asPath)) return { kind: "local", path: asPath };
    return { kind: "github", repo: raw.replace(/\.git$/, "") };
  }
  const asPath = resolve(cwd, raw);
  if (existsSync(asPath)) return { kind: "local", path: asPath };
  throw new MarketplaceError(`not a marketplace source: ${input}`);
}

function expandPath(p: string, cwd: string): string {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** A marketplace as read right now: its lock record and parsed file, or why it cannot be read. */
export interface LoadedMarketplace {
  record: MarketplaceRecord;
  /** Folder relative plugin sources resolve against; null for a bare-JSON marketplace. */
  root: string | null;
  manifest: MarketplaceManifest | null;
  error?: string;
}

function marketplaceRoot(stateDir: string, record: MarketplaceRecord): string | null {
  if (record.source.kind === "local") {
    const p = record.source.path;
    if (statSafe(p)?.isDirectory()) return p;
    // A file path: `<root>/.claude-plugin/marketplace.json`, or a JSON file next to the plugins.
    return /^\.(claude|omp)-plugin$/.test(basename(dirname(p))) ? dirname(dirname(p)) : dirname(p);
  }
  if (record.source.kind === "url") return null;
  return marketplaceCheckoutDir(stateDir, record.name);
}

function marketplaceFilePath(stateDir: string, record: MarketplaceRecord): string {
  if (record.source.kind === "local") {
    const st = statSafe(record.source.path);
    return st?.isFile() ? record.source.path : join(record.source.path, record.manifestPath);
  }
  return join(marketplaceCheckoutDir(stateDir, record.name), record.manifestPath);
}

export function loadMarketplace(stateDir: string, name: string): LoadedMarketplace {
  const record = readMarketplaceLock(stateDir).marketplaces[name];
  if (!record) throw new MarketplaceError(`no marketplace named ${name}; see \`atomic-agent plugin marketplace list\``);
  return loadRecord(stateDir, record);
}

function loadRecord(stateDir: string, record: MarketplaceRecord): LoadedMarketplace {
  const root = marketplaceRoot(stateDir, record);
  try {
    return { record, root, manifest: readMarketplaceFile(marketplaceFilePath(stateDir, record)) };
  } catch (err) {
    return { record, root, manifest: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function listMarketplaces(stateDir: string): LoadedMarketplace[] {
  return Object.values(readMarketplaceLock(stateDir).marketplaces)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(r => loadRecord(stateDir, r));
}

interface Fetched {
  /** Folder with the marketplace file (temp checkout or the local folder). */
  root: string;
  manifestPath: string;
  manifest: MarketplaceManifest;
  sha?: string;
  /** True when `root` is a temp folder this call created. */
  temp: boolean;
}

async function fetchMarketplace(stateDir: string, source: MarketplaceSourceRecord, ref: string | undefined, fetcher: PluginFetcher): Promise<Fetched> {
  if (source.kind === "local") {
    const st = statSafe(source.path);
    if (!st) throw new MarketplaceError(`folder not found: ${source.path}`);
    if (st.isFile()) {
      return { root: dirname(source.path), manifestPath: basename(source.path), manifest: readMarketplaceFile(source.path), temp: false };
    }
    const rel = findMarketplaceFile(source.path);
    if (!rel) throw new MarketplaceError(`${source.path} has no .claude-plugin/marketplace.json`);
    return { root: source.path, manifestPath: rel, manifest: readMarketplaceFile(join(source.path, rel)), temp: false };
  }
  const tmp = join(marketplacesRoot(stateDir), `.tmp-${randomBytes(4).toString("hex")}`);
  mkdirSync(tmp, { recursive: true });
  try {
    if (source.kind === "url") {
      const text = await fetcher.fetchText(source.url);
      const manifest = parseMarketplaceJson(text);
      const manifestPath = ".claude-plugin/marketplace.json";
      mkdirSync(join(tmp, ".claude-plugin"), { recursive: true });
      writeFileSync(join(tmp, manifestPath), text);
      return { root: tmp, manifestPath, manifest, temp: true };
    }
    const url = source.kind === "github" ? githubUrl(source.repo) : source.url;
    const { sha } = await fetcher.gitCheckout(url, tmp, ref ? { ref } : {});
    const rel = findMarketplaceFile(tmp);
    if (!rel) throw new MarketplaceError(`${url} has no .claude-plugin/marketplace.json`);
    return { root: tmp, manifestPath: rel, manifest: readMarketplaceFile(join(tmp, rel)), sha, temp: true };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

/** Swap a fetched temp checkout into `plugins/marketplaces/<name>`, keeping the old one until the new one is in. */
function placeCheckout(stateDir: string, name: string, fetched: Fetched): void {
  if (!fetched.temp) return;
  const target = marketplaceCheckoutDir(stateDir, name);
  const backup = existsSync(target) ? `${target}.old-${randomBytes(3).toString("hex")}` : null;
  if (backup) renameSync(target, backup);
  try {
    renameSync(fetched.root, target);
  } catch (err) {
    if (backup) renameSync(backup, target);
    throw err;
  }
  if (backup) rmSync(backup, { recursive: true, force: true });
}

export interface AddMarketplaceResult {
  record: MarketplaceRecord;
  manifest: MarketplaceManifest;
}

/** `marketplace add`: fetch, read the marketplace's own name, pin the commit, record it. */
export async function addMarketplace(stateDir: string, input: string, options: { ref?: string } & MarketplaceDeps = {}): Promise<AddMarketplaceResult> {
  const d = deps(options);
  const source = parseMarketplaceInput(input, d.cwd);
  if (options.ref && (source.kind === "local" || source.kind === "url")) throw new MarketplaceError("--ref only applies to git marketplaces");
  const fetched = await fetchMarketplace(stateDir, source, options.ref, d.fetcher);
  const name = fetched.manifest.name;
  const lock = readMarketplaceLock(stateDir);
  if (lock.marketplaces[name]) {
    if (fetched.temp) rmSync(fetched.root, { recursive: true, force: true });
    throw new MarketplaceError(`a marketplace named ${name} is already added; use \`plugin marketplace update ${name}\` or remove it first`);
  }
  placeCheckout(stateDir, name, fetched);
  const now = d.now().toISOString();
  const record: MarketplaceRecord = {
    name,
    source,
    ...(options.ref ? { ref: options.ref } : {}),
    ...(fetched.sha ? { sha: fetched.sha } : {}),
    manifestPath: fetched.manifestPath,
    addedAt: now,
    fetchedAt: now,
  };
  lock.marketplaces[name] = record;
  writeMarketplaceLock(stateDir, lock);
  return { record, manifest: fetched.manifest };
}

export interface UpdateMarketplaceResult {
  name: string;
  previousSha?: string;
  sha?: string;
  changed: boolean;
  error?: string;
}

/** `marketplace update [name]`: refetch one or all marketplaces. A failed one keeps its old copy. */
export async function updateMarketplaces(stateDir: string, name: string | undefined, options: MarketplaceDeps = {}): Promise<UpdateMarketplaceResult[]> {
  const d = deps(options);
  const lock = readMarketplaceLock(stateDir);
  const names = name ? [name] : Object.keys(lock.marketplaces).sort();
  if (name && !lock.marketplaces[name]) throw new MarketplaceError(`no marketplace named ${name}`);
  const results: UpdateMarketplaceResult[] = [];
  for (const n of names) {
    const record = lock.marketplaces[n]!;
    try {
      const fetched = await fetchMarketplace(stateDir, record.source, record.ref, d.fetcher);
      if (fetched.manifest.name !== record.name) {
        if (fetched.temp) rmSync(fetched.root, { recursive: true, force: true });
        throw new MarketplaceError(`the marketplace now calls itself ${fetched.manifest.name}; remove and add it again`);
      }
      placeCheckout(stateDir, n, fetched);
      const changed = record.source.kind === "local" || record.source.kind === "url" || fetched.sha !== record.sha;
      lock.marketplaces[n] = {
        ...record,
        manifestPath: fetched.manifestPath,
        ...(fetched.sha ? { sha: fetched.sha } : {}),
        fetchedAt: d.now().toISOString(),
      };
      results.push({ name: n, previousSha: record.sha, sha: fetched.sha, changed });
    } catch (err) {
      results.push({ name: n, previousSha: record.sha, changed: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  writeMarketplaceLock(stateDir, lock);
  return results;
}

export interface RemoveMarketplaceResult {
  removed: boolean;
  /** Installed plugins that came from it. They stay installed but can no longer be updated from it. */
  plugins: string[];
}

export function removeMarketplace(stateDir: string, name: string): RemoveMarketplaceResult {
  const lock = readMarketplaceLock(stateDir);
  const record = lock.marketplaces[name];
  if (!record) return { removed: false, plugins: [] };
  delete lock.marketplaces[name];
  writeMarketplaceLock(stateDir, lock);
  if (record.source.kind !== "local") rmSync(marketplaceCheckoutDir(stateDir, name), { recursive: true, force: true });
  const plugins = Object.values(readPluginState(stateDir).plugins)
    .filter(p => p.source.kind === "marketplace" && p.source.marketplace === name)
    .map(p => p.name)
    .sort();
  return { removed: true, plugins };
}

/** `name@marketplace` or a bare `name`. */
export function parsePluginSpec(spec: string): { plugin: string; marketplace?: string } {
  const at = spec.lastIndexOf("@");
  if (at > 0) return { plugin: spec.slice(0, at), marketplace: spec.slice(at + 1) };
  return { plugin: spec };
}

/** True when the argument to `plugin install` names a marketplace plugin rather than a folder. */
export function looksLikePluginSpec(arg: string, cwd = process.cwd()): boolean {
  if (existsSync(resolve(cwd, arg))) return false;
  const { plugin, marketplace } = parsePluginSpec(arg);
  return /^[\w.-]+$/.test(plugin) && (marketplace === undefined || /^[\w.-]+$/.test(marketplace));
}

export interface ResolvedMarketplacePlugin {
  marketplace: LoadedMarketplace & { manifest: MarketplaceManifest };
  entry: MarketplaceEntry;
}

/** Find a plugin entry; a bare name must match exactly one marketplace. */
export function resolveMarketplacePlugin(stateDir: string, spec: string): ResolvedMarketplacePlugin {
  const { plugin, marketplace } = parsePluginSpec(spec);
  const candidates = marketplace ? [loadMarketplace(stateDir, marketplace)] : listMarketplaces(stateDir);
  if (candidates.length === 0) throw new MarketplaceError("no marketplaces added yet; add one with `atomic-agent plugin marketplace add <owner/repo>`");
  const hits: ResolvedMarketplacePlugin[] = [];
  for (const m of candidates) {
    if (!m.manifest) {
      if (marketplace) throw new MarketplaceError(`marketplace ${m.record.name} cannot be read: ${m.error}`);
      continue;
    }
    const entry = m.manifest.plugins.find(p => p.name === plugin);
    if (entry) hits.push({ marketplace: m as ResolvedMarketplacePlugin["marketplace"], entry });
  }
  if (hits.length === 0) throw new MarketplaceError(marketplace ? `${plugin} is not listed in marketplace ${marketplace}` : `no added marketplace lists a plugin named ${plugin}`);
  if (hits.length > 1) {
    throw new MarketplaceError(`${plugin} is listed in several marketplaces; pick one: ${hits.map(h => `${plugin}@${h.marketplace.record.name}`).join(", ")}`);
  }
  return hits[0]!;
}

interface Materialised {
  /** Plugin folder ready to stage. */
  dir: string;
  source: Extract<PluginSourceRecord, { kind: "marketplace" }>;
  notes: string[];
  cleanup: () => void;
}

function marketplaceUrl(record: MarketplaceRecord): string | undefined {
  switch (record.source.kind) {
    case "github": return githubUrl(record.source.repo);
    case "git": return record.source.url;
    case "url": return record.source.url;
    case "local": return undefined;
  }
}

/** Get one entry's files into a private work folder, with the entry's own fields applied. */
export async function materialiseEntry(stateDir: string, resolved: ResolvedMarketplacePlugin, fetcher: PluginFetcher): Promise<Materialised> {
  const { marketplace, entry } = resolved;
  // `cache/<rand>/<entry name>`: the last segment is the folder name a manifest-less plugin is named after.
  const holder = join(pluginsRoot(stateDir), "cache", randomBytes(4).toString("hex"));
  const work = join(holder, entry.name);
  const cleanup = () => rmSync(holder, { recursive: true, force: true });
  const base = { kind: "marketplace" as const, marketplace: marketplace.record.name, entry: entry.name };
  try {
    let dir: string;
    let source: Materialised["source"];
    switch (entry.source.kind) {
      case "unsupported":
        throw new MarketplaceError(`cannot install ${entry.name}: ${entry.source.reason}`);
      case "relative": {
        if (!marketplace.root) throw new MarketplaceError(`${entry.name} lives next to the marketplace file, but this marketplace was added from a bare URL; add its git repository instead`);
        const src = insideDir(marketplace.root, entry.source.path);
        copyTree(src, work);
        dir = work;
        const url = marketplaceUrl(marketplace.record);
        source = { ...base, ...(url ? { url } : {}), ...(marketplace.record.ref ? { ref: marketplace.record.ref } : {}), ...(marketplace.record.sha ? { sha: marketplace.record.sha } : {}) };
        break;
      }
      case "github":
      case "git": {
        const url = entry.source.kind === "github" ? githubUrl(entry.source.repo) : entry.source.url;
        const { sha } = await fetcher.gitCheckout(url, work, { ...(entry.source.ref ? { ref: entry.source.ref } : {}), ...(entry.source.sha ? { sha: entry.source.sha } : {}) });
        dir = entry.source.path ? insideDir(work, entry.source.path) : work;
        source = { ...base, url, ...(entry.source.ref ? { ref: entry.source.ref } : {}), sha };
        break;
      }
      default:
        throw new MarketplaceError(`cannot install ${entry.name}: unknown source`);
    }
    const notes = applyEntryManifest(dir, entry);
    return { dir, source, notes, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Resolve `rel` under `root` and refuse anything that leaves it, symlinks included. */
function insideDir(root: string, rel: string): string {
  const abs = resolve(root, rel);
  const realRoot = realpathSync(root);
  let real: string;
  try { real = realpathSync(abs); } catch { throw new MarketplaceError(`plugin folder not found in the marketplace: ${rel || "."}`); }
  const r = relative(realRoot, real);
  if (r.startsWith("..") || isAbsolute(r)) throw new MarketplaceError(`plugin path leaves the marketplace: ${rel}`);
  if (!statSync(real).isDirectory()) throw new MarketplaceError(`plugin path is not a folder: ${rel}`);
  return real;
}

/** Copy a folder without .git and without symlinks (staging drops them again; this keeps the work copy clean too). */
function copyTree(src: string, dest: string): void {
  cpSync(src, dest, {
    recursive: true,
    dereference: false,
    filter: (from) => {
      if (from !== src && basename(from) === ".git") return false;
      return !lstatSync(from).isSymbolicLink();
    },
  });
}

/**
 * Marketplace entries can describe the plugin themselves (Claude `strict:
 * false`, or a folder with no plugin.json). Then we write the plugin.json
 * the entry implies into the work copy, so the loader reads one manifest.
 * A plugin with its own manifest and `strict` left on is used as shipped.
 * Returns notes for the user.
 */
export function applyEntryManifest(dir: string, entry: MarketplaceEntry): string[] {
  const notes: string[] = [];
  const detected = detectPluginFormat(dir);
  const hasComponents = Object.keys(entry.components).length > 0;
  if (detected?.manifestPath && (entry.strict || !hasComponents)) {
    if (entry.strict && hasComponents) notes.push("The marketplace entry also lists parts; the plugin's own plugin.json was used.");
    return notes;
  }
  let base: Record<string, unknown> = {};
  if (detected?.format === "claude" && detected.manifestPath) {
    try { base = JSON.parse(readFileSync(detected.manifestPath, "utf8")) as Record<string, unknown>; } catch { base = {}; }
  }
  if (!PLUGIN_NAME_RE.test(entry.name)) throw new PluginInstallError(`marketplace entry name must be kebab-case: ${entry.name}`);
  const manifest: Record<string, unknown> = {
    ...base,
    name: typeof base.name === "string" ? base.name : entry.name,
    ...(base.version === undefined && entry.version ? { version: entry.version } : {}),
    ...(base.description === undefined && entry.description ? { description: entry.description } : {}),
    ...(base.author === undefined && entry.author !== undefined ? { author: entry.author } : {}),
    ...entry.components,
  };
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  notes.push(entry.strict ? "plugin.json was written from the marketplace entry (the plugin ships none)." : "Parts were taken from the marketplace entry (strict: false).");
  return notes;
}

export interface MarketplaceInstallOptions extends MarketplaceDeps {
  force?: boolean;
  /** Runs on the staged copy before commit; PR-level security review plugs in here. */
  review?: PluginReview;
}

export interface MarketplaceInstallResult {
  record: InstalledPluginRecord;
  entry: MarketplaceEntry;
  marketplace: string;
  notes: string[];
}

/** `plugin install <name>[@marketplace]`. */
export async function installMarketplacePlugin(stateDir: string, spec: string, options: MarketplaceInstallOptions = {}): Promise<MarketplaceInstallResult> {
  const d = deps(options);
  const resolved = resolveMarketplacePlugin(stateDir, spec);
  const existing = readPluginState(stateDir).plugins[resolved.entry.name];
  if (existing && !options.force) {
    throw new PluginInstallError(`plugin ${resolved.entry.name} is already installed; use \`plugin update ${resolved.entry.name}\` or --force`);
  }
  const result = await installResolved(stateDir, resolved, d.fetcher, { mode: "install", force: options.force, review: options.review });
  return result!;
}

async function installResolved(
  stateDir: string,
  resolved: ResolvedMarketplacePlugin,
  fetcher: PluginFetcher,
  opts: { mode: "install" | "update"; force?: boolean; review?: PluginReview; skipWhenSha?: string },
): Promise<MarketplaceInstallResult | null> {
  const m = await materialiseEntry(stateDir, resolved, fetcher);
  try {
    // Same commit as installed: nothing to do (an update without --force).
    if (opts.skipWhenSha && m.source.sha === opts.skipWhenSha) return null;
    const staged = stagePluginCopy(stateDir, m.dir);
    const notes = [...m.notes];
    if (staged.bundle.name !== resolved.entry.name) notes.push(`The plugin calls itself ${staged.bundle.name}; the marketplace lists it as ${resolved.entry.name}.`);
    const record = await reviewAndCommit(stateDir, staged, { mode: opts.mode, source: m.source, force: opts.force, review: opts.review });
    return { record, entry: resolved.entry, marketplace: resolved.marketplace.record.name, notes: [...notes, ...staged.bundle.notes] };
  } finally {
    m.cleanup();
  }
}

export interface PluginUpdateOptions extends MarketplaceDeps {
  /** Refetch the plugin's marketplace first (default true). */
  refreshMarketplace?: boolean;
  /** Reinstall even when the version and commit did not change. */
  force?: boolean;
  review?: PluginReview;
}

export type PluginUpdateResult =
  | { status: "updated"; record: InstalledPluginRecord; previous: InstalledPluginRecord; notes: string[] }
  | { status: "up-to-date"; record: InstalledPluginRecord };

/** `plugin update <name>`: reinstall from where it came from (marketplace or local folder). */
export async function updatePlugin(stateDir: string, name: string, options: PluginUpdateOptions = {}): Promise<PluginUpdateResult> {
  const d = deps(options);
  const previous = readPluginState(stateDir).plugins[name];
  if (!previous) throw new PluginInstallError(`plugin not installed: ${name}`);
  const src = previous.source;
  if (src.kind === "local") {
    if (!existsSync(src.path)) throw new PluginInstallError(`${name} was installed from ${src.path}, which no longer exists`);
    const staged = stagePluginCopy(stateDir, src.path);
    if (staged.bundle.name !== name) {
      discardStagedPlugin(staged);
      throw new PluginInstallError(`${src.path} now holds plugin ${staged.bundle.name}, not ${name}`);
    }
    const record = await reviewAndCommit(stateDir, staged, { mode: "update", source: src, review: options.review });
    return { status: "updated", record, previous, notes: staged.bundle.notes };
  }
  if (src.kind !== "marketplace") throw new PluginInstallError(`${name} was installed from ${src.kind}; updating that kind of source is not supported yet`);
  if (options.refreshMarketplace !== false) {
    const [res] = await updateMarketplaces(stateDir, src.marketplace, d);
    if (res?.error) throw new MarketplaceError(`could not refresh marketplace ${src.marketplace}: ${res.error}`);
  }
  const resolved = resolveMarketplacePlugin(stateDir, `${src.entry}@${src.marketplace}`);
  if (!options.force && isSamePin(previous, resolved)) return { status: "up-to-date", record: previous };
  const previousSha = previous.source.kind === "marketplace" ? previous.source.sha : undefined;
  const result = await installResolved(stateDir, resolved, d.fetcher, {
    mode: "update",
    review: options.review,
    ...(!options.force && previousSha ? { skipWhenSha: previousSha } : {}),
  });
  if (!result) return { status: "up-to-date", record: previous };
  return { status: "updated", record: result.record, previous, notes: result.notes };
}

/** Cheap check before fetching: a pinned entry commit equal to the installed one means nothing to do. */
function isSamePin(previous: InstalledPluginRecord, resolved: ResolvedMarketplacePlugin): boolean {
  if (previous.source.kind !== "marketplace") return false;
  const s = resolved.entry.source;
  if ((s.kind === "git" || s.kind === "github") && s.sha && previous.source.sha) {
    return previous.source.sha.toLowerCase().startsWith(s.sha.toLowerCase());
  }
  if (s.kind === "relative" && resolved.marketplace.record.sha && previous.source.sha) {
    return previous.source.sha === resolved.marketplace.record.sha;
  }
  return false;
}

function statSafe(p: string) {
  try { return statSync(p); } catch { return null; }
}
