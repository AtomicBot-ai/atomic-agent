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
 * folders. Review round 2 adds cmd's delayed `!USERPROFILE!` /
 * `!HOMEDRIVE!!HOMEPATH!`, the braced `${HOME}` / `${env:HOMEPATH}` forms
 * and a drive-relative `\Users\<name>`.
 *
 * Fail closed (review round 2): `UNRESOLVED_SECRET_PATH` is a credential
 * entry behind a folder the guard cannot work out: after a variable it
 * does not know (`%X%`, `!X!`, `$x`, `${x}`), a `)` of a subexpression
 * (`$([Environment]::GetFolderPath(...))`), a `..` segment, or a `+`
 * string concatenation. It counts as below the home folder.
 *
 * Review round 3: `USERS_SECRET_PATH` is `\Users\<name>\<entry>` anywhere
 * inside a word, whatever comes before it (`C:\Windows\..\Users\x`,
 * `%SystemDrive%\Users\x`, `%ALLUSERSPROFILE%\..\Users\x`), and
 * `HOME_MENTION` is any home folder spelling anywhere on the line, for the
 * fail-closed check on strings built in PowerShell.
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
const HOME_ROOT = String.raw`(?:[%!]userprofile[%!]|(?:[%!]homedrive[%!])?[%!]homepath[%!]|[%!]home[%!]|(?:\$\{?env:homedrive\}?)?\$\{?env:homepath\}?|\$\{?env:(?:userprofile|home)\}?|\$\{?home\}?|~|${DRIVE}${SEP}users${SEP}${NAME}|[/\\]users${SEP}${NAME}|/[a-z]/users/${NAME}|/mnt/[a-z]/users/${NAME})`;
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
const END = String.raw`((?:[/\\][^"'|;&<>\s{}]*)?)(?=$|["'|;&<>\s),{}])`;
const LEFT = String.raw`(?:^|[\s"'=(,@:])`;

/** A credential path below the home folder: groups 1-3 the entry, 4 the rest. */
export const SECRET_PATH = new RegExp(
  String.raw`${LEFT}(?:${HOME_ROOT}${SEP}(${BELOW})|${APPDATA}(${BELOW_ROAMING})|${LOCALAPPDATA}(${BELOW_LOCAL}))${END}`,
  "g",
);
/**
 * A credential entry behind a folder the guard cannot resolve: group 1
 * the entry, 2 the rest. A `+` may be followed straight by the entry
 * (`$HOME + '.ssh\id_rsa'`); every other form needs the separator.
 */
export const UNRESOLVED_SECRET_PATH = new RegExp(
  String.raw`(?:(?:[)}%!]|\.\.|\$[a-z_][a-z_0-9]*(?::[a-z_0-9]+)?)${SEP}|\+\s*['"]?(?:${SEP})?)(?:\.${SEP})?(${BELOW})${END}`,
  "g",
);
/** `\Users\<name>\<entry>` after anything at all: group 1 the entry, 2 the rest. */
export const USERS_SECRET_PATH = new RegExp(String.raw`[/\\]users${SEP}${NAME}${SEP}(${BELOW})${END}`, "g");
/** Any spelling of the home folder, anywhere on the line. */
export const HOME_MENTION = new RegExp(String.raw`${HOME_ROOT}|getfolderpath|getenvironmentvariable`);
/** An 8.3 short name right below the home folder (`SSH~1`): group 1 the name, 2 the rest. */
export const SHORT_NAME_PATH = new RegExp(
  String.raw`${LEFT}${HOME_ROOT}${SEP}([^/\\\s"'|;&<>~]{1,8}~[0-9])${END}`,
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
