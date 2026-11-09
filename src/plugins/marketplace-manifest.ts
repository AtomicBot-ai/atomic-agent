import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";

/**
 * Plugin marketplaces in the Claude Code format: a git repo (or a folder,
 * or a bare JSON file) with `.claude-plugin/marketplace.json` listing
 * plugins and where to get each one. oh-my-pi uses the same file under
 * `.omp-plugin/`. Parsing is data only; nothing here touches the network.
 */

/** Marketplace file locations, in lookup order. */
export const MARKETPLACE_FILES = [".claude-plugin/marketplace.json", ".omp-plugin/marketplace.json"] as const;

/** Marketplace names become folder names and the `@name` in `plugin@name`. */
export const MARKETPLACE_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i;

const MAX_MARKETPLACE_BYTES = 4 * 1024 * 1024;

/** Entry fields that describe plugin parts; with `strict: false` (or no plugin.json) they define the plugin. */
export const ENTRY_COMPONENT_KEYS = ["skills", "commands", "agents", "hooks", "mcpServers", "lspServers", "outputStyles"] as const;

export class MarketplaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceError";
  }
}

/** Where a marketplace entry's plugin files come from. */
export type MarketplacePluginSource =
  /** A folder inside the marketplace itself, POSIX path relative to its root ("" = the root). */
  | { kind: "relative"; path: string }
  /** A GitHub repo, optionally a sub-folder of it. */
  | { kind: "github"; repo: string; ref?: string; sha?: string; path?: string }
  /** Any git URL (Claude `url`, `git` and `git-subdir` sources). */
  | { kind: "git"; url: string; ref?: string; sha?: string; path?: string }
  /** npm, pip, `command` and unknown sources: listed, never installed. */
  | { kind: "unsupported"; type: string; reason: string };

export interface MarketplaceEntry {
  name: string;
  description: string;
  version?: string;
  category?: string;
  homepage?: string;
  source: MarketplacePluginSource;
  /** Claude `strict`: false means the entry, not plugin.json, defines the plugin's parts. */
  strict: boolean;
  /** Component fields given on the entry (skills, mcpServers, ...), kept raw. */
  components: Record<string, unknown>;
  /** Raw author field, copied into a synthesised plugin.json. */
  author?: unknown;
}

export interface MarketplaceManifest {
  name: string;
  description: string;
  owner?: string;
  plugins: MarketplaceEntry[];
  /** Entries we could not read, in plain words. */
  problems: string[];
}

/** First marketplace file found under `root`, as a path relative to it. */
export function findMarketplaceFile(root: string): string | null {
  for (const rel of MARKETPLACE_FILES) {
    try { if (statSync(join(root, rel)).isFile()) return rel; } catch { /* next */ }
  }
  return null;
}

export function readMarketplaceFile(file: string): MarketplaceManifest {
  let size: number;
  try { size = statSync(file).size; } catch { throw new MarketplaceError(`marketplace file not found: ${file}`); }
  if (size > MAX_MARKETPLACE_BYTES) throw new MarketplaceError(`marketplace file is larger than 4 MiB: ${file}`);
  return parseMarketplaceJson(readFileSync(file, "utf8"));
}

export function parseMarketplaceJson(text: string): MarketplaceManifest {
  if (text.length > MAX_MARKETPLACE_BYTES) throw new MarketplaceError("marketplace file is larger than 4 MiB");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (err) {
    throw new MarketplaceError(`marketplace.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseMarketplaceObject(raw);
}

export function parseMarketplaceObject(raw: unknown): MarketplaceManifest {
  if (!isObject(raw)) throw new MarketplaceError("marketplace.json must be a JSON object");
  const name = str(raw.name);
  if (!name) throw new MarketplaceError("marketplace.json needs a `name`");
  if (!MARKETPLACE_NAME_RE.test(name)) throw new MarketplaceError(`marketplace name must be letters, digits, '.', '_' or '-', got ${JSON.stringify(name)}`);
  if (!Array.isArray(raw.plugins)) throw new MarketplaceError("marketplace.json needs a `plugins` list");
  const metadata = isObject(raw.metadata) ? raw.metadata : {};
  // Claude: `metadata.pluginRoot` is prepended to bare relative sources.
  const pluginRoot = str(metadata.pluginRoot) ?? str(raw.pluginRoot);
  const owner = isObject(raw.owner) ? str(raw.owner.name) : str(raw.owner);
  const problems: string[] = [];
  const plugins: MarketplaceEntry[] = [];
  const seen = new Set<string>();
  raw.plugins.forEach((item, i) => {
    try {
      const entry = parseEntry(item, pluginRoot);
      if (seen.has(entry.name)) { problems.push(`plugin ${entry.name} is listed twice; the first entry is used`); return; }
      seen.add(entry.name);
      plugins.push(entry);
    } catch (err) {
      problems.push(`entry ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return { name, description: str(raw.description) ?? str(metadata.description) ?? "", owner, plugins, problems };
}

function parseEntry(raw: unknown, pluginRoot: string | undefined): MarketplaceEntry {
  if (!isObject(raw)) throw new MarketplaceError("not an object");
  const name = str(raw.name);
  if (!name) throw new MarketplaceError("missing `name`");
  const components: Record<string, unknown> = {};
  for (const key of ENTRY_COMPONENT_KEYS) if (raw[key] !== undefined) components[key] = raw[key];
  return {
    name,
    description: str(raw.description) ?? "",
    version: str(raw.version),
    category: str(raw.category),
    homepage: str(raw.homepage),
    source: parseEntrySource(raw.source, pluginRoot),
    strict: raw.strict !== false,
    components,
    author: raw.author,
  };
}

/** Read one entry's `source`. Exported for tests. */
export function parseEntrySource(raw: unknown, pluginRoot?: string): MarketplacePluginSource {
  if (typeof raw === "string") {
    const base = pluginRoot && !raw.startsWith("./") && !raw.startsWith("../") ? posix.join(pluginRoot, raw) : raw;
    return { kind: "relative", path: safeRelative(base) };
  }
  if (!isObject(raw)) throw new MarketplaceError("missing `source`");
  const type = str(raw.source) ?? "";
  const ref = str(raw.ref);
  const sha = str(raw.sha);
  if (sha && !/^[0-9a-f]{7,64}$/i.test(sha)) throw new MarketplaceError(`\`sha\` is not a commit id: ${sha}`);
  const path = raw.path === undefined ? undefined : safeRelative(String(raw.path));
  const opt = { ...(ref ? { ref } : {}), ...(sha ? { sha } : {}), ...(path ? { path } : {}) };
  switch (type) {
    case "github": {
      const repo = str(raw.repo);
      if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new MarketplaceError("github source needs `repo` as owner/name");
      return { kind: "github", repo, ...opt };
    }
    case "url":
    case "git":
    case "git-subdir": {
      const url = str(raw.url);
      if (!url) throw new MarketplaceError(`${type} source needs a \`url\``);
      if (type === "git-subdir" && !path) throw new MarketplaceError("git-subdir source needs a `path`");
      return { kind: "git", url: checkGitUrl(url), ...opt };
    }
    case "npm":
    case "pip":
      return { kind: "unsupported", type, reason: `${type} packages are not supported; only git and folder sources are` };
    case "command":
      return { kind: "unsupported", type, reason: "this plugin is produced by running a command on your computer, which installs never do" };
    default:
      return { kind: "unsupported", type: type || "unknown", reason: `unknown source type ${JSON.stringify(type)}` };
  }
}

/**
 * Git URLs we pass to `git`: https, ssh and scp-style `git@host:path`.
 * Plain http, `file:`, `ext::` and anything starting with `-` are refused
 * so a marketplace entry cannot reach local files or smuggle git options.
 */
export function checkGitUrl(url: string): string {
  const u = url.trim();
  if (u.startsWith("-")) throw new MarketplaceError(`not a git URL: ${url}`);
  if (/^https:\/\/[^\s]+$/i.test(u) || /^ssh:\/\/[^\s]+$/i.test(u) || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(u)) return u;
  throw new MarketplaceError(`only https and ssh git URLs are allowed, got ${url}`);
}

/** A POSIX path that stays inside its root: no absolute paths, no `..` segments. */
export function safeRelative(p: string): string {
  const cleaned = p.trim().replace(/\\/g, "/");
  if (isAbsolute(cleaned) || /^[a-z]:/i.test(cleaned)) throw new MarketplaceError(`path must be relative: ${p}`);
  const norm = posix.normalize(cleaned);
  if (norm === ".." || norm.startsWith("../")) throw new MarketplaceError(`path leaves the marketplace: ${p}`);
  return norm === "." || norm === "./" ? "" : norm.replace(/^\.\//, "").replace(/\/$/, "");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
