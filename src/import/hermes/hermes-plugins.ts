import {
  copyFileSync,
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseMcpServers } from "../../config/config-schema.js";
import { ConfigValidationError } from "../../config/config-validation-error.js";
import type { McpServerConfig } from "../../mcp/mcp-types.js";

/**
 * Hermes Python plugins -> local stdio MCP servers (ATO-953).
 *
 * A Hermes plugin is `~/.hermes/plugins/<name>/` with a `plugin.yaml` and an
 * `__init__.py` exposing `register(ctx)` (one category level is allowed:
 * `plugins/<category>/<name>/`, keyed `category/name`, as Hermes does). We
 * never import plugin code from Node: each trusted plugin becomes one MCP
 * server entry that runs the bundled Python shim
 * (`assets/hermes-plugin-bridge/hermes_mcp_shim.py`), which loads the plugin
 * and serves its `ctx.register_tool` / `ctx.register_command` registrations.
 *
 * Plugins are arbitrary local code, so nothing here is automatic: the caller
 * passes the explicit per-plugin trust list (`--trust-plugin <key>`).
 */

export const HERMES_SHIM_FILENAME = "hermes_mcp_shim.py";
const SHIM_ASSET_DIR = join("assets", "hermes-plugin-bridge");
/** Folder under the state dir that holds the installed shim copy. */
export const HERMES_SHIM_STATE_SUBDIR = "hermes-plugin-bridge";
const SERVER_NAME_PREFIX = "hermes-";
const MAX_SERVER_NAME = 32;

export interface HermesPlugin {
  /** Registry key Hermes uses: `name` (flat) or `category/name`. */
  key: string;
  /** `name:` from plugin.yaml, or the folder name when absent. */
  manifestName: string;
  /** `description:` from plugin.yaml, when present. */
  description: string | null;
  /** Absolute plugin directory (holds plugin.yaml + __init__.py). */
  dir: string;
  /**
   * Env names the plugin's tools list in `requires_env=[...]`, read from its
   * Python sources (best effort, no code runs). The shim exports exactly
   * these from `<HERMES_HOME>/.env` when they are not already set.
   */
  requiredEnv: string[];
}

export function hermesPluginsDir(sourceDir: string): string {
  return join(sourceDir, "plugins");
}

function manifestFile(dir: string): string | null {
  for (const name of ["plugin.yaml", "plugin.yml"]) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Top-level scalar from a small YAML manifest; no YAML dependency. */
function readScalar(text: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m");
  const match = re.exec(text);
  if (!match?.[1]) return null;
  const value = match[1].replace(/^(['"])(.*)\1$/, "$2").trim();
  return value.length > 0 && value !== "|" && value !== ">" ? value : null;
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

const REQUIRES_ENV_RE = /requires_env\s*=\s*[[(]([^\])]*)[\])]/g;
const QUOTED_NAME_RE = /["']([A-Za-z_][A-Za-z0-9_]*)["']/g;
const MAX_SCANNED_PY_FILES = 50;

/**
 * Collect `requires_env=[...]` names from a plugin's `.py` files (the plugin
 * dir and one level of subpackages). Static text scan, so a list built at
 * runtime is missed; the shim still hides such tools and says why on stderr.
 */
export function scanRequiredEnv(dir: string): string[] {
  const files: string[] = [];
  const collect = (base: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_SCANNED_PY_FILES) return;
      if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
      const path = join(base, entry.name);
      if (entry.isFile() && entry.name.endsWith(".py")) files.push(path);
      else if (entry.isDirectory() && depth > 0) collect(path, depth - 1);
    }
  };
  collect(dir, 1);
  const names = new Set<string>();
  for (const file of files.sort()) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const list of text.matchAll(REQUIRES_ENV_RE)) {
      for (const name of (list[1] ?? "").matchAll(QUOTED_NAME_RE)) {
        if (name[1]) names.add(name[1]);
      }
    }
  }
  return [...names].sort();
}

function readPlugin(dir: string, key: string): HermesPlugin | null {
  const manifest = manifestFile(dir);
  if (!manifest || !existsSync(join(dir, "__init__.py"))) return null;
  const text = readFileSync(manifest, "utf8");
  return {
    key,
    manifestName: readScalar(text, "name") ?? key.split("/").pop() ?? key,
    description: readScalar(text, "description"),
    dir,
    requiredEnv: scanRequiredEnv(dir),
  };
}

/**
 * List native Python plugins under `<sourceDir>/plugins`. Portable
 * (`plugin.json`-only) and manifest-only packages carry no `__init__.py`
 * and are left out: there is nothing for the shim to import.
 */
export function discoverHermesPlugins(sourceDir: string): HermesPlugin[] {
  const root = hermesPluginsDir(sourceDir);
  const out: HermesPlugin[] = [];
  for (const name of listDirs(root)) {
    const dir = join(root, name);
    if (manifestFile(dir)) {
      const plugin = readPlugin(dir, name);
      if (plugin) out.push(plugin);
      continue;
    }
    // One category level, like Hermes' `<root>/<cat>/<name>/plugin.yaml`.
    for (const child of listDirs(dir)) {
      const plugin = readPlugin(join(dir, child), `${name}/${child}`);
      if (plugin) out.push(plugin);
    }
  }
  return out;
}

export interface TrustResolution {
  /** Keys of the plugins the user trusted (unambiguously). */
  trustedKeys: Set<string>;
  /** Trusted names that match two or more plugins by manifest name. */
  ambiguous: { name: string; keys: string[] }[];
  /** Trusted names that match no plugin at all. */
  unmatched: string[];
}

/**
 * Resolve `--trust-plugin` names to plugins. The plugin key (its folder
 * path under plugins/) is authoritative. The manifest `name:` is chosen by
 * the plugin author, so it is only a fallback: used when no key equals the
 * name and exactly one plugin declares it. Otherwise the name is reported
 * as ambiguous and nothing is trusted for it.
 */
export function resolveTrustedPlugins(
  plugins: readonly HermesPlugin[],
  trusted: readonly string[],
): TrustResolution {
  const trustedKeys = new Set<string>();
  const ambiguous: { name: string; keys: string[] }[] = [];
  const unmatched: string[] = [];
  for (const name of new Set(trusted)) {
    const byKey = plugins.find((p) => p.key === name);
    if (byKey) {
      trustedKeys.add(byKey.key);
      continue;
    }
    const byName = plugins.filter((p) => p.manifestName === name);
    if (byName.length === 1 && byName[0]) {
      trustedKeys.add(byName[0].key);
    } else if (byName.length > 1) {
      ambiguous.push({ name, keys: byName.map((p) => p.key) });
    } else {
      unmatched.push(name);
    }
  }
  return { trustedKeys, ambiguous, unmatched };
}

/**
 * MCP server name for a plugin: `hermes-<key>` lowercased, folded to the
 * `^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$` namespace rule.
 */
export function hermesPluginServerName(key: string): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = `${SERVER_NAME_PREFIX}${slug || "plugin"}`
    .slice(0, MAX_SERVER_NAME)
    .replace(/-+$/g, "");
  return name;
}

export function defaultPythonCommand(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? "python" : "python3";
}

export interface BuildPluginServerOptions {
  /** Absolute path of the installed shim script. */
  shimPath: string;
  /** Python interpreter; defaults to `python3` (`python` on Windows). */
  pythonCommand?: string;
  /** Hermes home, passed to the plugin as HERMES_HOME. */
  hermesHome: string;
}

export type BuildPluginServerResult =
  | { kind: "server"; server: McpServerConfig }
  | { kind: "skip"; reason: string };

/**
 * Build the validated MCP entry for one plugin. Trust stays the default
 * `approval_gated`, so every bridged tool call still asks first.
 */
export function buildHermesPluginMcpServer(
  plugin: HermesPlugin,
  options: BuildPluginServerOptions,
): BuildPluginServerResult {
  const candidate: Record<string, unknown> = {
    name: hermesPluginServerName(plugin.key),
    description: `Hermes plugin ${plugin.key} (bridged)`,
    transport: {
      kind: "stdio",
      command: options.pythonCommand ?? defaultPythonCommand(),
      args: [options.shimPath, plugin.dir],
      cwd: plugin.dir,
    },
    env: {
      HERMES_HOME: options.hermesHome,
      PYTHONUNBUFFERED: "1",
      // UTF-8 stdio whatever the locale (Windows pipes default to cp125x).
      // The shim also forces UTF-8 itself, so older entries keep working.
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
  };
  try {
    const first = parseMcpServers([candidate], "mcp.servers")[0];
    if (!first) return { kind: "skip", reason: "validation produced no config" };
    return { kind: "server", server: first };
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      return { kind: "skip", reason: `${err.field}: ${err.message}` };
    }
    return {
      kind: "skip",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Locate the packaged shim. npm / `node dist`: `<pkg>/assets/...` three
 * levels above this module; SEA bundle: `assets/...` next to the binary.
 * `ATOMIC_AGENT_HERMES_SHIM` overrides (tests, dev checkouts).
 */
export function resolvePackagedHermesShim(): string | null {
  const env = process.env.ATOMIC_AGENT_HERMES_SHIM?.trim();
  if (env && existsSync(env)) return env;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, SHIM_ASSET_DIR, HERMES_SHIM_FILENAME),
    join(moduleDir, "..", "..", "..", SHIM_ASSET_DIR, HERMES_SHIM_FILENAME),
  ];
  try {
    candidates.push(
      join(dirname(process.execPath), SHIM_ASSET_DIR, HERMES_SHIM_FILENAME),
    );
  } catch {
    // ignore
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Stable shim location the MCP entries point at. */
export function hermesShimInstallPath(stateDir: string): string {
  return join(stateDir, HERMES_SHIM_STATE_SUBDIR, HERMES_SHIM_FILENAME);
}

/**
 * Copy the packaged shim into the state dir (refreshing an older copy), so
 * config entries keep working across upgrades and install locations.
 */
export function installHermesShim(
  stateDir: string,
  sourcePath: string | null = resolvePackagedHermesShim(),
): string {
  if (!sourcePath) {
    throw new Error(
      `bundled ${HERMES_SHIM_FILENAME} not found (set ATOMIC_AGENT_HERMES_SHIM)`,
    );
  }
  const dest = hermesShimInstallPath(stateDir);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(sourcePath, dest);
  return dest;
}
