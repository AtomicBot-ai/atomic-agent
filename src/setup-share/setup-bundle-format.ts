/**
 * ATO-1073: the shape of a shareable setup bundle, shared by the export
 * and import sides so both agree on what may be inside.
 *
 * A bundle is a `.tar.gz` (the same tar-stream + gzip the `atag data
 * backup` archive uses) with every entry under `atomic-agent-setup/`:
 *
 *   manifest.json      what is inside, what was redacted (always first)
 *   config.json        MCP servers, cloud providers, persona definitions; secrets blanked
 *   skills/<name>/...  the person's own skills (starter skills left out)
 *   agents/<name>.md   subagent profiles
 *   memory.sqlite      only with `--include-memory`
 *
 * Anything else is refused on import, however it got into the archive.
 */
export const BUNDLE_ROOT = "atomic-agent-setup";
export const BUNDLE_FORMAT = "atomic-agent-setup";
export const BUNDLE_VERSION = 1;
export const MANIFEST_NAME = "manifest.json";
export const CONFIG_NAME = "config.json";
export const MEMORY_NAME = "memory.sqlite";

/** One file in a skill or a profile; larger ones are left out on export and refused on import. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** The memory snapshot may be larger than any skill file. */
export const MAX_MEMORY_BYTES = 256 * 1024 * 1024;
/** The whole unpacked bundle, so a crafted archive cannot fill the disk. */
export const MAX_TOTAL_BYTES = 320 * 1024 * 1024;
export const MAX_ENTRIES = 5_000;

export interface SetupManifestFile {
  path: string;
  size: number;
}

export interface SetupManifest {
  format: typeof BUNDLE_FORMAT;
  version: number;
  createdAt: string;
  appVersion: string | null;
  contents: {
    skills: string[];
    agents: string[];
    mcpServers: string[];
    providers: string[];
    personas: string[];
    memory: boolean;
  };
  /** Config paths whose values were blanked; the recipient fills them in. */
  redacted: string[];
  /** Files left out on export (credential-looking names, over the size cap). */
  leftOut: string[];
  files: SetupManifestFile[];
}

/**
 * Names that hold credentials or local state even inside a skill folder
 * (Hermes filters exported profiles the same way, by file name).
 */
const CREDENTIAL_FILE_RE =
  /^(\.env(\..*)?|\.netrc|\.npmrc|\.pypirc|auth\.json|credentials?(\.json)?|.*token.*\.json|secrets?\.(json|ya?ml|toml|txt|env)|\.DS_Store|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|jks|sqlite|sqlite3|db)(-wal|-shm)?)$/i;
/** Folders that are installs, caches or VCS data, never part of a skill as written. */
const SKIPPED_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".cache"]);

export function isCredentialFileName(name: string): boolean {
  return CREDENTIAL_FILE_RE.test(name);
}

export function isSkippedDirName(name: string): boolean {
  return SKIPPED_DIRS.has(name);
}

const SAFE_SEGMENT = /^[A-Za-z0-9._@+ -]+$/;
const AGENT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

/**
 * Whether a bundle-relative path (no `atomic-agent-setup/` prefix) may be
 * unpacked: relative, no `..`, no backslash or drive letter, plain
 * segment characters, and under an allow-listed destination.
 */
export function isAllowedBundlePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || !SAFE_SEGMENT.test(p))) return false;
  if (parts.length === 1) return parts[0] === MANIFEST_NAME || parts[0] === CONFIG_NAME || parts[0] === MEMORY_NAME;
  if (parts[0] === "agents") return parts.length === 2 && AGENT_FILE.test(parts[1]!);
  if (parts[0] === "skills") {
    if (parts.length < 3) return false;
    return !parts.some((p) => isSkippedDirName(p) || isCredentialFileName(p));
  }
  return false;
}

/** The skill folder name a `skills/<name>/...` path belongs to, else null. */
export function skillNameOf(path: string): string | null {
  const parts = path.split("/");
  return parts[0] === "skills" && parts.length >= 3 ? parts[1]! : null;
}

/** Validate a parsed manifest; returns the reason it is unusable, or null. */
export function manifestProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "manifest is not an object";
  const m = raw as Partial<SetupManifest>;
  if (m.format !== BUNDLE_FORMAT) return `not an Atomic Agent setup bundle (format ${JSON.stringify(m.format)})`;
  if (typeof m.version !== "number" || m.version > BUNDLE_VERSION) {
    return `bundle version ${String(m.version)} is newer than this app understands (${BUNDLE_VERSION}); update Atomic Agent`;
  }
  if (!Array.isArray(m.files)) return "manifest has no file list";
  for (const f of m.files) {
    if (!f || typeof f.path !== "string" || !isAllowedBundlePath(f.path)) {
      return `manifest lists a path outside the allowed folders: ${JSON.stringify(f?.path)}`;
    }
  }
  if (!m.contents || !Array.isArray(m.redacted)) return "manifest is missing its contents or redacted list";
  return null;
}
