import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { PluginFormat, PluginManifest } from "./plugin-types.js";

/** Plugin names are kebab-case so `plugin:skill` stays a safe identifier. */
export const PLUGIN_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export class PluginManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginManifestError";
  }
}

/** Manifest locations in detection order (same order OpenClaw and Hermes use). */
const MANIFESTS: ReadonlyArray<{ format: PluginFormat; path: string }> = [
  { format: "claude", path: ".claude-plugin/plugin.json" },
  { format: "codex", path: ".codex-plugin/plugin.json" },
  { format: "cursor", path: ".cursor-plugin/plugin.json" },
  { format: "agent-plugins", path: "plugin.json" },
];

/** Folders whose presence makes a manifest-less folder a Claude-layout plugin. */
const CONVENTIONAL_DIRS = ["skills", "commands", "agents", "hooks"];

/** Manifest keys from the Claude format we know about but do not load yet. */
const KNOWN_UNSUPPORTED = ["outputStyles", "lspServers", "monitors", "bin", "settings"];

const MAX_MANIFEST_BYTES = 256 * 1024;

export interface DetectedPlugin {
  format: PluginFormat;
  /** Absolute manifest path; undefined for the conventional layout. */
  manifestPath?: string;
}

/** Find which convention describes `root`, or null when it is not a plugin. */
export function detectPluginFormat(root: string): DetectedPlugin | null {
  for (const m of MANIFESTS) {
    const p = join(root, m.path);
    if (isFile(p)) return { format: m.format, manifestPath: p };
  }
  if (CONVENTIONAL_DIRS.some(d => isDir(join(root, d))) || isFile(join(root, ".mcp.json")) || isFile(join(root, "SKILL.md"))) {
    return { format: "conventional" };
  }
  return null;
}

/** Read and validate the manifest of the plugin at `root`. Never runs code. */
export function readPluginManifest(root: string): { format: PluginFormat; manifest: PluginManifest } {
  const absRoot = resolve(root);
  const detected = detectPluginFormat(absRoot);
  if (!detected) {
    throw new PluginManifestError(
      `${absRoot} is not a plugin: no .claude-plugin/plugin.json, plugin.json, SKILL.md, skills/, commands/, agents/, hooks/ or .mcp.json`,
    );
  }
  if (!detected.manifestPath) {
    return { format: "conventional", manifest: conventionalManifest(absRoot) };
  }
  const size = statSync(detected.manifestPath).size;
  if (size > MAX_MANIFEST_BYTES) throw new PluginManifestError(`plugin manifest is larger than 256 KiB: ${detected.manifestPath}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(detected.manifestPath, "utf8"));
  } catch (err) {
    throw new PluginManifestError(`plugin manifest is not valid JSON (${detected.manifestPath}): ${err instanceof Error ? err.message : String(err)}`);
  }
  return { format: detected.format, manifest: parseManifestObject(raw, absRoot) };
}

export function parseManifestObject(raw: unknown, root: string): PluginManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PluginManifestError("plugin manifest must be a JSON object");
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) throw new PluginManifestError("plugin manifest needs a `name`");
  if (!PLUGIN_NAME_RE.test(name)) throw new PluginManifestError(`plugin name must be kebab-case (a-z, 0-9, '-'), got ${JSON.stringify(name)}`);
  const manifest: PluginManifest = {
    name,
    version: str(obj.version) ?? "0.0.0",
    description: str(obj.description) ?? "",
    keywords: Array.isArray(obj.keywords) ? obj.keywords.filter((k): k is string => typeof k === "string") : [],
    skillPaths: paths(obj.skills, root, "skills"),
    commandPaths: paths(obj.commands, root, "commands"),
    agentPaths: paths(obj.agents, root, "agents"),
    unsupportedKeys: KNOWN_UNSUPPORTED.filter(k => obj[k] !== undefined),
  };
  const author = obj.author;
  if (typeof author === "string") manifest.author = { name: author };
  else if (author && typeof author === "object") {
    const a = author as Record<string, unknown>;
    manifest.author = { name: str(a.name), email: str(a.email), url: str(a.url) };
  }
  manifest.homepage = str(obj.homepage);
  manifest.license = str(obj.license);
  const repo = obj.repository;
  manifest.repository = typeof repo === "string" ? repo : repo && typeof repo === "object" ? str((repo as Record<string, unknown>).url) : undefined;
  if (typeof obj.hooks === "string") manifest.hooksPath = insideRoot(obj.hooks, root, "hooks");
  else if (obj.hooks && typeof obj.hooks === "object" && !Array.isArray(obj.hooks)) manifest.hooksInline = obj.hooks as Record<string, unknown>;
  if (typeof obj.mcpServers === "string") manifest.mcpPath = insideRoot(obj.mcpServers, root, "mcpServers");
  else if (obj.mcpServers && typeof obj.mcpServers === "object" && !Array.isArray(obj.mcpServers)) manifest.mcpInline = obj.mcpServers as Record<string, unknown>;
  return manifest;
}

function conventionalManifest(root: string): PluginManifest {
  const name = basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "plugin";
  return { name, version: "0.0.0", description: "", keywords: [], skillPaths: [], commandPaths: [], agentPaths: [], unsupportedKeys: [] };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** A manifest path field may be a string or a list; every entry must stay inside the plugin. */
function paths(v: unknown, root: string, field: string): string[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.filter((p): p is string => typeof p === "string").map(p => insideRoot(p, root, field));
}

/** Resolve a manifest-relative path and refuse anything that escapes the plugin root. */
export function insideRoot(p: string, root: string, field: string): string {
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new PluginManifestError(`plugin manifest \`${field}\` points outside the plugin: ${p}`);
  return abs;
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
