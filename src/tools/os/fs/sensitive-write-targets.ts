import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { SECRET_HOME_PATHS } from "../../../sandbox/os-sandbox.js";

/**
 * Files below the home folder whose change runs code or lets someone in
 * later (ATO-2505): the SSH folder (`authorized_keys`, `config`, keys),
 * shell startup files (`.bashrc`, `.zshrc`, `.profile`, fish and
 * PowerShell profiles), login items and autostart folders (macOS
 * LaunchAgents, XDG autostart, systemd user units, the Windows Startup
 * folder), git's global config (`core.hooksPath`, `core.sshCommand`),
 * curl / wget config (a proxy reroutes every request), and the
 * credential folders of `SECRET_HOME_PATHS`. A write there asks at every
 * approval level, bypass included, the way a credential read does: the
 * file is the user's, not the project's, and it outlives the session.
 *
 * Paths are compared case-folded (macOS and Windows home volumes ignore
 * case) and with `\` read as `/`. `homeDir` is a test seam.
 */

/** Below the home folder; an entry ending in `/` is a folder and covers everything in it. */
const SENSITIVE_HOME_ENTRIES: readonly string[] = [
  ".ssh/",
  ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile",
  ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout",
  ".kshrc", ".cshrc", ".tcshrc", ".xprofile", ".xinitrc", ".pam_environment",
  ".config/fish/config.fish", ".config/fish/conf.d/", ".config/fish/functions/",
  ".config/autostart/", ".config/systemd/user/", ".config/environment.d/",
  "library/launchagents/",
  ".gitconfig", ".config/git/config",
  ".curlrc", ".wgetrc", ".npmrc",
  "documents/windowspowershell/", "documents/powershell/",
  "appdata/roaming/microsoft/windows/start menu/programs/startup/",
  ...SECRET_HOME_PATHS.map((entry) => entry.toLowerCase()),
];

/**
 * `path` relative to home, lowercased; `""` for the home folder itself,
 * `null` outside it.
 */
function below(home: string, path: string): string | null {
  const rel = relative(home, path).replace(/\\/g, "/");
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.toLowerCase();
}

function matchesEntry(rel: string, entry: string): boolean {
  if (entry.endsWith("/")) return rel === entry.slice(0, -1) || rel.startsWith(entry);
  return rel === entry || rel.startsWith(`${entry}/`);
}

/** The entries of `paths` (absolute, or relative to `cwd`) that are sensitive home files. */
export function sensitiveWriteTargets(
  paths: readonly string[],
  cwd: string = process.cwd(),
  homeDir: string = homedir(),
): string[] {
  const home = resolve(homeDir).toLowerCase();
  return paths.filter((path) => isSensitive(home, resolve(cwd, path)));
}

/**
 * The home folder itself counts too (review round 1): a copy, move or
 * extract into it (`cp /tmp/x/.bashrc ~/`, `tar xzf p.tgz -C ~`) can
 * drop any startup file there without naming it.
 */
function isSensitive(home: string, absolute: string): boolean {
  const rel = below(home, absolute.toLowerCase());
  if (rel === null) return false;
  return rel === "" || SENSITIVE_HOME_ENTRIES.some((entry) => matchesEntry(rel, entry));
}

/** `path` with symlinks resolved, through its nearest existing parent. */
async function realPathOf(path: string): Promise<string> {
  let existing = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return path;
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

/**
 * `sensitiveWriteTargets` that also follows symlinks (review round 1):
 * `ln -s ~ h` then a write of `h/.ssh/authorized_keys` is a write into
 * the SSH folder. A path counts when either its written form or its real
 * one is sensitive, compared with the real home folder too.
 */
export async function realSensitiveWriteTargets(
  paths: readonly string[],
  cwd: string = process.cwd(),
  homeDir: string = homedir(),
): Promise<string[]> {
  const lexical = new Set(sensitiveWriteTargets(paths, cwd, homeDir));
  const homes = [resolve(homeDir), await realPathOf(resolve(homeDir))].map((h) => h.toLowerCase());
  const found: string[] = [];
  for (const path of paths) {
    if (lexical.has(path)) {
      found.push(path);
      continue;
    }
    const real = await realPathOf(resolve(cwd, path));
    if (homes.some((home) => isSensitive(home, real))) found.push(path);
  }
  return found;
}

/** Names that, on a line whose targets cannot be read, mean a sensitive write may be in it. */
const SENSITIVE_NAMES: readonly string[] = [
  ...new Set([
    ...SENSITIVE_HOME_ENTRIES.map((entry) => entry.replace(/\/$/, "")),
    "authorized_keys",
    "start menu/programs/startup",
  ]),
];

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SENSITIVE_NAME_RE = new RegExp(
  `(?:^|[^a-z0-9_.-])(?:${SENSITIVE_NAMES.map(escapeRegExp).join("|")})(?![a-z0-9_-])`,
);

/**
 * Whether a command line names one of the sensitive home entries
 * (`.ssh`, `.bashrc`, `LaunchAgents`, ...), case-folded and with `\`
 * read as `/`. The shell uses it when it cannot read the line's write
 * targets (`$(…)`, a variable, a glob): then a sensitive name on the line
 * is taken as a sensitive write, so the check fails closed.
 */
export function mentionsSensitiveHomeEntry(line: string): boolean {
  return SENSITIVE_NAME_RE.test(line.toLowerCase().replace(/\\/g, "/"));
}

/** The line the approval card adds for such a write. */
export function sensitiveWriteReason(targets: readonly string[]): string {
  const shown = targets.slice(0, 3).join(", ");
  const more = targets.length > 3 ? ` and ${targets.length - 3} more` : "";
  return `changes a startup, SSH or credential file in your home folder (${shown}${more}); asks in every mode`;
}
