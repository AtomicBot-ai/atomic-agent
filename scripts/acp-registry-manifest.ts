/**
 * The ACP registry entry for atomic-agent (ATO-689): what goes into
 * `agent.json` and `icon.svg` in a fork of
 * https://github.com/agentclientprotocol/registry, and the offline checks
 * that registry's CI runs on them (`agent.schema.json`, `CONTRIBUTING.md`,
 * "Validation"). Pure: no I/O. The CLI is `acp-registry.ts`.
 *
 * Zed and JetBrains install agents from that registry. An entry points at
 * our release archives (`distribution.binary`, one per platform, each with
 * its sha256) and names the command that starts the agent speaking ACP over
 * stdio. The registry's CI also launches the agent and calls `initialize`:
 * it must answer with `authMethods` holding one `agent` or `terminal`
 * method (`AUTHENTICATION.md`). That ACP server is ATO-543; until it ships
 * an entry would fail that check, so nothing here is submitted.
 */
import { BUNDLE_TARGETS, type BundleTarget } from "./bundle-targets.js";

/** The registry entry's id and folder name. */
export const ACP_AGENT_ID = "atomic-agent";

/**
 * The arguments that start the ACP server (ATO-543). The registry runs
 * `<cmd> <args>` and talks JSON-RPC on its stdin/stdout.
 */
export const ACP_ARGS: readonly string[] = ["acp"];

export const ACP_REPOSITORY = "https://github.com/AtomicBot-ai/atomic-agent";

/** Registry platform key for each of our bundle slugs. */
export const ACP_PLATFORMS: Readonly<Record<string, string>> = {
  "darwin-arm64": "darwin-aarch64",
  "darwin-x64": "darwin-x86_64",
  "linux-arm64": "linux-aarch64",
  "linux-x64": "linux-x86_64",
  "win32-x64": "windows-x86_64",
};

/** Every platform key the registry schema allows. */
const REGISTRY_PLATFORMS: ReadonlySet<string> = new Set([
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-aarch64",
  "linux-aarch64-musl",
  "linux-x86_64",
  "linux-x86_64-musl",
  "windows-aarch64",
  "windows-x86_64",
]);

const INSTALLER_EXTENSIONS = [".dmg", ".pkg", ".deb", ".rpm", ".msi", ".appimage"];
const ARCHIVE_EXTENSIONS = [".zip", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2"];

export interface AcpBinaryTarget {
  archive: string;
  sha256: string;
  cmd: string;
  args: string[];
}

export interface AcpAgentManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  repository: string;
  website: string;
  authors: string[];
  license: string;
  license_url: string;
  distribution: { binary: Record<string, AcpBinaryTarget> };
}

export interface ManifestInput {
  /** The terminal release, `0.7.0` (a leading `v` is dropped). */
  version: string;
  /** sha256 of each release archive, by bundle slug (`darwin-arm64`). Slugs left out are left out of the entry. */
  sha256: Readonly<Record<string, string>>;
}

/** The release asset a bundle is published as. */
export function archiveName(target: BundleTarget): string {
  return `atomic-agent-${target.slug}.${target.archiveExt}`;
}

/**
 * The executable inside the archive, relative to where it is extracted.
 * A `.tar.gz` holds one folder named after the slug (`package-bundle.ts`
 * tars `./<slug>`); the Windows `.zip` holds the files at its root.
 */
export function archiveCommand(target: BundleTarget): string {
  return target.archiveExt === "zip"
    ? `./${target.executableName}`
    : `./${target.slug}/${target.executableName}`;
}

export function buildAcpManifest(input: ManifestInput): AcpAgentManifest {
  const version = input.version.replace(/^v/, "");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new Error(`the registry takes a plain X.Y.Z release version, not "${input.version}"`);
  }
  const binary: Record<string, AcpBinaryTarget> = {};
  for (const target of BUNDLE_TARGETS) {
    const digest = input.sha256[target.slug];
    if (digest === undefined) continue;
    const platform = ACP_PLATFORMS[target.slug];
    if (platform === undefined) throw new Error(`no registry platform for bundle ${target.slug}`);
    binary[platform] = {
      archive: `${ACP_REPOSITORY}/releases/download/v${version}/${archiveName(target)}`,
      sha256: digest.toLowerCase(),
      cmd: archiveCommand(target),
      args: [...ACP_ARGS],
    };
  }
  const unknown = Object.keys(input.sha256).filter((slug) => !BUNDLE_TARGETS.some((t) => t.slug === slug));
  if (unknown.length > 0) throw new Error(`unknown bundle slug(s): ${unknown.join(", ")}`);
  if (Object.keys(binary).length === 0) throw new Error("no archive digests given");
  return {
    id: ACP_AGENT_ID,
    name: "Atomic Agent",
    version,
    description: "Local-first AI agent that runs on your own models or any cloud provider",
    repository: ACP_REPOSITORY,
    website: "https://atomicagent.io",
    authors: ["Atomic Bot"],
    license: "MIT",
    license_url: `${ACP_REPOSITORY}/blob/main/LICENSE`,
    distribution: { binary },
  };
}

/** The registry entry as written to `agent.json`. */
export function renderAcpManifest(manifest: AcpAgentManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * The registry CI's offline checks on `agent.json` (schema, id, version,
 * distribution, version-in-URL, no `latest`). URL reachability and the
 * launch / `initialize` check need the network and the agent; they run in
 * the registry's own CI. Returns the problems; empty means it passes.
 */
export function validateAcpManifest(value: unknown, folderName: string = ACP_AGENT_ID): string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["agent.json must be an object"];
  const m = value as Record<string, unknown>;
  const allowed = new Set([
    "id", "name", "version", "description", "repository", "website", "authors",
    "license", "license_url", "icon", "distribution", "preview",
  ]);
  for (const key of Object.keys(m)) if (!allowed.has(key)) errors.push(`unknown field "${key}"`);
  for (const key of ["id", "name", "version", "description", "license_url"]) {
    if (typeof m[key] !== "string" || (m[key] as string).length === 0) errors.push(`"${key}" is required`);
  }
  const id = m["id"];
  if (typeof id === "string") {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) errors.push(`id "${id}" must be lowercase letters, digits and hyphens, starting with a letter`);
    if (id !== folderName) errors.push(`id "${id}" must match its folder "${folderName}"`);
  }
  const version = m["version"];
  if (typeof version === "string" && !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    errors.push(`version "${version}" must be X.Y.Z`);
  }
  for (const key of ["repository", "website", "license_url"]) {
    const url = m[key];
    if (url !== undefined && !isHttpUrl(url)) errors.push(`"${key}" must be a URL`);
  }
  if (m["authors"] !== undefined && (!Array.isArray(m["authors"]) || !m["authors"].every((a) => typeof a === "string"))) {
    errors.push(`"authors" must be a list of strings`);
  }
  const distribution = m["distribution"];
  if (typeof distribution !== "object" || distribution === null || Array.isArray(distribution)) {
    errors.push(`"distribution" is required`);
    return errors;
  }
  const kinds = Object.keys(distribution);
  if (kinds.length === 0) errors.push("distribution needs at least one of binary, npx, uvx");
  for (const kind of kinds) if (!["binary", "npx", "uvx"].includes(kind)) errors.push(`unknown distribution "${kind}"`);
  const binary = (distribution as Record<string, unknown>)["binary"];
  if (binary !== undefined) {
    if (typeof binary !== "object" || binary === null || Object.keys(binary).length === 0) {
      errors.push("distribution.binary needs at least one platform");
    } else {
      for (const [platform, raw] of Object.entries(binary as Record<string, unknown>)) {
        errors.push(...validateBinaryTarget(platform, raw, typeof version === "string" ? version : ""));
      }
    }
  }
  return errors;
}

function validateBinaryTarget(platform: string, raw: unknown, version: string): string[] {
  const errors: string[] = [];
  const at = `distribution.binary.${platform}`;
  if (!REGISTRY_PLATFORMS.has(platform)) errors.push(`${at}: unknown platform`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [...errors, `${at} must be an object`];
  const t = raw as Record<string, unknown>;
  for (const key of Object.keys(t)) {
    if (!["archive", "sha256", "cmd", "args", "env"].includes(key)) errors.push(`${at}: unknown field "${key}"`);
  }
  const archive = t["archive"];
  if (!isHttpUrl(archive)) {
    errors.push(`${at}.archive must be a URL`);
  } else {
    const lower = archive.toLowerCase();
    if (INSTALLER_EXTENSIONS.some((ext) => lower.endsWith(ext))) errors.push(`${at}.archive: installer formats are not supported`);
    if (!ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext))) errors.push(`${at}.archive: expected .zip or .tar.gz`);
    if (lower.includes("/latest/")) errors.push(`${at}.archive must not point at /latest/`);
    const tagged = /\/download\/v?([0-9]+\.[0-9]+\.[0-9]+)\//.exec(archive);
    if (tagged && tagged[1] !== version) errors.push(`${at}.archive is version ${tagged[1]}, the entry is ${version}`);
  }
  if (typeof t["cmd"] !== "string" || t["cmd"].length === 0) errors.push(`${at}.cmd is required`);
  if (t["sha256"] !== undefined && (typeof t["sha256"] !== "string" || !/^[a-fA-F0-9]{64}$/.test(t["sha256"]))) {
    errors.push(`${at}.sha256 must be 64 hex characters`);
  }
  if (t["args"] !== undefined && (!Array.isArray(t["args"]) || !t["args"].every((a) => typeof a === "string"))) {
    errors.push(`${at}.args must be a list of strings`);
  }
  return errors;
}

/**
 * The registry's icon checks: 16x16 (width/height or viewBox), square, and
 * monochrome (`fill` / `stroke` only `currentColor`, `none` or `inherit`).
 */
export function validateAcpIcon(svg: string): string[] {
  const errors: string[] = [];
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (root === undefined) return ["icon.svg has no <svg> element"];
  const attr = (name: string): string | undefined =>
    new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(root)?.[1];
  const width = attr("width");
  const height = attr("height");
  const viewBox = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  let size: [number, number] | null = null;
  if (width !== undefined && height !== undefined) size = [parseFloat(width), parseFloat(height)];
  else if (viewBox !== undefined && viewBox.length === 4) size = [viewBox[2]!, viewBox[3]!];
  if (size === null) errors.push("icon.svg needs width/height or a viewBox");
  else {
    if (size[0] !== size[1]) errors.push(`icon.svg must be square, is ${size[0]}x${size[1]}`);
    if (size[0] !== 16) errors.push(`icon.svg must be 16x16, is ${size[0]}x${size[1]}`);
  }
  const ok = new Set(["currentcolor", "none", "inherit"]);
  for (const match of svg.matchAll(/\s(fill|stroke)\s*=\s*["']([^"']*)["']/gi)) {
    if (!ok.has(match[2]!.trim().toLowerCase())) errors.push(`icon.svg: ${match[1]}="${match[2]}" is a hardcoded color`);
  }
  for (const match of svg.matchAll(/(fill|stroke)\s*:\s*([^;"']+)/gi)) {
    if (!ok.has(match[2]!.trim().toLowerCase())) errors.push(`icon.svg: style ${match[1]}: ${match[2]!.trim()} is a hardcoded color`);
  }
  return errors;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
