/**
 * The registry a package publish sends to, read from the project's own
 * config files without running the tool (ATO-2528), so the card says
 * `sends data to -> npm.internal.example` rather than the public default.
 *
 * npm, pnpm and yarn: `publishConfig.registry` in the nearest
 * `package.json`, then `@scope:registry` (for a scoped package name) or
 * `registry` in an `.npmrc` from the project folder up, then `~/.npmrc`.
 * cargo: the `[registries.<name>]` `index` of `--registry <name>` or of
 * `[registry] default`, in `.cargo/config.toml` (or `config`) from the
 * project folder up, then `~/.cargo/`.
 *
 * `undefined`: nothing set, the tool's public default applies. `null`:
 * set but not readable here (a `${VAR}`, a registry name with no index,
 * an unreadable file), which the egress hold treats as an unknown host.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MAX_BYTES = 256 * 1024;
const MAX_WALK_UP = 64;

function readSmall(path: string): string | null {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** `start` and each folder above it. */
function folders(start: string): string[] {
  const out: string[] = [];
  let dir = resolve(start);
  for (let i = 0; i < MAX_WALK_UP; i += 1) {
    out.push(dir);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

const plain = (value: string): string | null => (/\$\{|\$[A-Za-z_]/.test(value) ? null : value);

function npmrcValue(text: string, key: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const at = line.indexOf("=");
    if (at === -1 || line.slice(0, at).trim() !== key) continue;
    return line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

function npmRegistry(cwd: string, home: string): string | null | undefined {
  let scope: string | undefined;
  for (const dir of folders(cwd)) {
    const text = readSmall(join(dir, "package.json"));
    if (text === null) continue;
    try {
      const pkg = JSON.parse(text) as { name?: unknown; publishConfig?: { registry?: unknown } };
      const registry = pkg.publishConfig?.registry;
      if (typeof registry === "string") return plain(registry);
      if (typeof pkg.name === "string" && pkg.name.startsWith("@")) scope = pkg.name.split("/")[0];
    } catch {
      return null;
    }
    break;
  }
  const keys = scope !== undefined ? [`${scope}:registry`, "registry"] : ["registry"];
  for (const dir of [...folders(cwd), home]) {
    const text = readSmall(join(dir, ".npmrc"));
    if (text === null) continue;
    for (const key of keys) {
      const value = npmrcValue(text, key);
      if (value !== undefined) return plain(value);
    }
  }
  return undefined;
}

/** `[registries.NAME] index = "…"`, `[registries] NAME = { index = "…" }`, `[registry] default = "…"`. */
function cargoValue(text: string, section: string, key: string): string | undefined {
  let current = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header !== null) {
      current = header[1]!.replace(/["']/g, "");
      continue;
    }
    const entry = /^([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.+)$/.exec(line);
    if (entry === null) continue;
    const name = entry[1]!.replace(/"/g, "");
    const value = entry[2]!;
    if (current === section && name === key) return /^["']([^"']*)["']/.exec(value)?.[1];
    const [parent, child] = section.split(/\.(.*)/s);
    if (current === parent && name === child) return /\bindex\s*=\s*["']([^"']*)["']/.exec(value)?.[1];
  }
  return undefined;
}

function cargoConfigs(cwd: string, home: string): string[] {
  const texts: string[] = [];
  for (const dir of [...folders(cwd), home]) {
    for (const name of ["config.toml", "config"]) {
      const text = readSmall(join(dir, ".cargo", name));
      if (text !== null) texts.push(text);
    }
  }
  return texts;
}

function cargoRegistry(cwd: string, name: string | undefined, home: string): string | null | undefined {
  const configs = cargoConfigs(cwd, home);
  const chosen = name ?? configs.map((t) => cargoValue(t, "registry", "default")).find((v) => v !== undefined);
  if (chosen === undefined) return undefined;
  for (const text of configs) {
    const index = cargoValue(text, `registries.${chosen}`, "index");
    if (index !== undefined) return plain(index.replace(/^(?:sparse|registry)\+/, ""));
  }
  return null;
}

export function publishRegistryUrl(
  cwd: string,
  program: string,
  registryName?: string,
  home: string = homedir(),
): string | null | undefined {
  try {
    if (program === "npm" || program === "pnpm" || program === "yarn") return npmRegistry(cwd, home);
    if (program === "cargo") return cargoRegistry(cwd, registryName, home);
    return undefined;
  } catch {
    return null;
  }
}
