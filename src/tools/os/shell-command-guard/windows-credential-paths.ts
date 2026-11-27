import { SECRET_HOME_PATHS } from "../../../sandbox/os-sandbox.js";

/**
 * Windows spellings of the home folder and the credential entries below
 * it, for `rules-credentials-windows.ts` (ATO-2728). Every pattern reads
 * lowercased text and takes `\` and `/` alike as a folder separator.
 *
 * Home folder: `%USERPROFILE%`, `%HOMEDRIVE%%HOMEPATH%`, `%HOMEPATH%`
 * (the current drive), `$env:USERPROFILE` (also `${env:USERPROFILE}`),
 * `$env:HOMEPATH`, PowerShell `$HOME` and `~`, `C:\Users\<name>` (also
 * behind `\\?\` / `\\.\`, and the UNC admin share `\\<host>\c$\Users\<name>`),
 * Git Bash `/c/Users/<name>` and WSL `/mnt/c/Users/<name>`. `%APPDATA%`
 * and `%LOCALAPPDATA%` (and their `$env:` forms) stand for the AppData
 * folders.
 */

const WINDOWS_SECRET_PATHS: readonly string[] = [
  "appdata/roaming/gcloud",
  "appdata/roaming/github cli",
  "appdata/roaming/microsoft/credentials",
  "appdata/local/microsoft/credentials",
  "appdata/roaming/microsoft/protect",
  "appdata/roaming/microsoft/windows/powershell/psreadline",
  "appdata/local/google/chrome/user data/default/login data",
  "appdata/local/microsoft/edge/user data/default/login data",
];

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A folder separator: `\` or `/`, doubled or not. */
const SEP = String.raw`[/\\]+`;
const NAME = String.raw`[^/\\"'|;&<>\s][^/\\"'|;&<>]*`;
/** `C:`, `\\?\C:`, `\\.\C:`, `\\host\c$`, `\\?\UNC\host\c$`. */
const DRIVE = String.raw`(?:(?:[/\\]{2}[?.][/\\]+)?[a-z]:|[/\\]{2}(?:[?.][/\\]+unc[/\\]+)?[^/\\\s"'|;&<>]+[/\\]+[a-z]\$)`;
/** The home folder itself, without the separator after it. */
const HOME_ROOT = String.raw`(?:%userprofile%|%homedrive%%homepath%|%homepath%|%home%|\$env:homedrive\$env:homepath|\$env:userprofile|\$\{env:userprofile\}|\$env:homepath|\$env:home|\$home|~|${DRIVE}${SEP}users${SEP}${NAME}|/[a-z]/users/${NAME}|/mnt/[a-z]/users/${NAME})`;
const APPDATA = String.raw`(?:%appdata%|\$env:appdata|\$\{env:appdata\})${SEP}`;
const LOCALAPPDATA = String.raw`(?:%localappdata%|\$env:localappdata|\$\{env:localappdata\})${SEP}`;

const ALL_SECRETS = [...SECRET_HOME_PATHS.map((p) => p.toLowerCase()), ...WINDOWS_SECRET_PATHS];
/** Longest first, each `/` read as either separator. */
const alternation = (paths: readonly string[]): string =>
  [...paths]
    .sort((a, b) => b.length - a.length)
    .map((path) => path.split("/").map(escapeRegex).join(SEP))
    .join("|");
const BELOW = alternation(ALL_SECRETS);
const BELOW_ROAMING = alternation(
  WINDOWS_SECRET_PATHS.filter((p) => p.startsWith("appdata/roaming/")).map((p) => p.slice(16)),
);
const BELOW_LOCAL = alternation(
  WINDOWS_SECRET_PATHS.filter((p) => p.startsWith("appdata/local/")).map((p) => p.slice(14)),
);
/** What is named below the credential entry. */
const END = String.raw`((?:[/\\][^"'|;&<>\s]*)?)(?=$|["'|;&<>\s),])`;
const LEFT = String.raw`(?:^|[\s"'=(,@:])`;

/** A credential path below the home folder: groups 1-3 the entry, 4 the rest. */
export const SECRET_PATH = new RegExp(
  String.raw`${LEFT}(?:${HOME_ROOT}${SEP}(${BELOW})|${APPDATA}(${BELOW_ROAMING})|${LOCALAPPDATA}(${BELOW_LOCAL}))${END}`,
  "g",
);
/** The same entries named relative to the home folder: group 1 the entry, 2 the rest. */
export const RELATIVE_SECRET_PATH = new RegExp(String.raw`${LEFT}(?:\.${SEP})?(${BELOW})${END}`, "g");
/** One word that is a credential entry on its own (`'.ssh\id_rsa'`, `\.aws`), for Join-Path. */
export const SECRET_PIECE = new RegExp(
  String.raw`^[/\\]*(?:\.${SEP})?(${BELOW})((?:[/\\][^"'|;&<>\s]*)?)$`,
);
/** A word that is the home folder itself (`%USERPROFILE%`, `C:\Users\x\`). */
export const HOME_ONLY = new RegExp(String.raw`^${HOME_ROOT}[/\\]*$`);
/**
 * The home folder as a value of its own in PowerShell code: `Join-Path
 * $env:USERPROFILE ...`, `[Environment]::GetFolderPath('UserProfile') + ...`.
 */
export const HOME_VALUE =
  /(?:^|[\s"'=(,@:+])(?:%userprofile%|%homepath%|\$env:(?:userprofile|homepath|home)|\$\{env:userprofile\}|\$home|~)(?=$|[\s"'),+;])|getfolderpath\s*\(\s*['"]?(?:\[environment\+specialfolder\]::)?userprofile|getenvironmentvariable\s*\(\s*['"](?:userprofile|home)['"]/;
