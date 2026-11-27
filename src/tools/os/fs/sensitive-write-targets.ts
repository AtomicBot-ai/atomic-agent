import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
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

function below(home: string, path: string): string | null {
  const rel = relative(home, path).replace(/\\/g, "/");
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return null;
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
  return paths.filter((path) => {
    const rel = below(home, resolve(cwd, path).toLowerCase());
    return rel !== null && SENSITIVE_HOME_ENTRIES.some((entry) => matchesEntry(rel, entry));
  });
}

/** The line the approval card adds for such a write. */
export function sensitiveWriteReason(targets: readonly string[]): string {
  const shown = targets.slice(0, 3).join(", ");
  const more = targets.length > 3 ? ` and ${targets.length - 3} more` : "";
  return `changes a startup, SSH or credential file in your home folder (${shown}${more}); asks in every mode`;
}
