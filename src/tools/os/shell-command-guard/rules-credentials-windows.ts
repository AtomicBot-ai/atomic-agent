import { SECRET_HOME_PATHS } from "../../../sandbox/os-sandbox.js";
import type { NormalisedCommand } from "./guard-types.js";
import type { ArgScanFinding } from "./arg-scan-finding.js";

/**
 * `dangerous.read_credentials` for Windows paths and readers (ATO-2728).
 * The POSIX rule (`rules-credentials.ts`) reads the line through a POSIX
 * lexer, where `\` is an escape: `type %USERPROFILE%\.ssh\id_rsa` comes
 * out as one unreadable word and the read went by unasked, bypass
 * included. This rule reads the joined line as text instead, and takes
 * `\` and `/` alike as a folder separator.
 *
 * Home folder: `%USERPROFILE%`, `%HOMEDRIVE%%HOMEPATH%`, `$env:USERPROFILE`
 * (also `${env:USERPROFILE}`), PowerShell's `$HOME\` and `~\` (with a
 * backslash: the forward-slash forms are the POSIX rule's), `C:\Users\<name>`,
 * Git Bash `/c/Users/<name>` and WSL `/mnt/c/Users/<name>`. `%APPDATA%` and
 * `%LOCALAPPDATA%` (and their `$env:` forms) stand for the AppData folders.
 * The credential folders are `SECRET_HOME_PATHS` plus the Windows ones
 * below (gcloud and GitHub CLI under AppData, the Credential Manager and
 * DPAPI key folders, PowerShell history, browser saved logins).
 *
 * A command counts when one of its words is a reader: the POSIX readers
 * Git Bash brings, cmd's `type`, `more`, `copy`, `xcopy`, `robocopy`,
 * `findstr`, `certutil`, PowerShell's `Get-Content` / `gc`, `Copy-Item`,
 * `Compress-Archive`, `Select-String`, `[IO.File]::Read*`, or a `cd` /
 * `Set-Location` into the folder. A copy whose only credential path is
 * the destination is a write, not a read. `cmdkey /list`, `vaultcmd
 * /listcreds`, `Get-StoredCredential`, the `PasswordVault` class and a
 * `reg save|export` of the SAM / SECURITY hive name saved credentials
 * themselves. Public material stays out, as on POSIX: `*.pub`,
 * `known_hosts`, `authorized_keys`; `.ssh/config` is the low 0.6.
 */

const SECRET_CONFIDENCE = 0.9;
const LOW_CONFIDENCE = 0.6;

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
/** One home-folder spelling, lowercased, up to and with its separator. */
const HOME = String.raw`(?:(?:%userprofile%|%homedrive%%homepath%|%home%|\$env:userprofile|\$\{env:userprofile\}|\$env:home|[a-z]:${SEP}users${SEP}${NAME}|/[a-z]/users/${NAME}|/mnt/[a-z]/users/${NAME})${SEP}|(?:~|\$home)\\+)`;
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
/** Group 4 is what is named below the credential entry. */
const END = String.raw`((?:[/\\][^"'|;&<>\s]*)?)(?=$|["'|;&<>\s),])`;
const SECRET_PATH = new RegExp(
  String.raw`(?:^|[\s"'=(,@:])(?:${HOME}(${BELOW})|${APPDATA}(${BELOW_ROAMING})|${LOCALAPPDATA}(${BELOW_LOCAL}))${END}`,
  "g",
);

const READERS: ReadonlySet<string> = new Set([
  // POSIX readers, as Git Bash and WSL run them.
  "cat", "bat", "tac", "nl", "less", "head", "tail", "strings", "od", "xxd", "hexdump",
  "base64", "base32", "grep", "egrep", "rg", "awk", "sed", "scp", "rsync", "tar", "zip",
  "7z", "gzip", "curl", "wget", "nc", "ncat", "ssh-keygen", "openssl",
  // cmd.exe
  "type", "more", "copy", "xcopy", "robocopy", "findstr", "certutil", "move",
  // PowerShell, with its aliases
  "get-content", "gc", "copy-item", "cpi", "cp", "compress-archive", "select-string", "sls",
  "move-item", "mi", "mv", "import-clixml", "invoke-webrequest", "iwr", "invoke-restmethod",
  "irm", "start-bitstransfer", "send-mailmessage", "format-hex", "fhx",
]);
/** The destination is the last operand, or the second for robocopy. */
const COPIERS: ReadonlySet<string> = new Set([
  "copy", "xcopy", "copy-item", "cpi", "cp", "move", "move-item", "mi", "mv", "scp", "rsync",
]);
const CD: ReadonlySet<string> = new Set(["cd", "chdir", "pushd", "set-location", "sl", "push-location"]);
const CODE_RUNNER = /^(?:python[0-9.]*|py|node|perl|ruby)$/;
const CODE_FLAG = /^(?:-[a-z]*[ce]|--eval|--print)$/;
const DOTNET_READ = /\[(?:system\.)?io\.file\]::(?:read|copy|open)/;
const SAVED_CREDENTIALS: readonly RegExp[] = [
  /(?:^|[\s;&|(])cmdkey(?:\.exe)?\s+[/-]list\b/,
  /(?:^|[\s;&|(])vaultcmd(?:\.exe)?\s+[/-]list(?:creds|properties)?\b/,
  /\bget-storedcredential\b/,
  /\bwindows\.security\.credentials\.passwordvault\b/,
  /(?:^|[\s;&|(])reg(?:\.exe)?\s+(?:save|export)\s+(?:hklm|hkey_local_machine)[/\\]+(?:sam|security)\b/,
];

/** The joined line split into commands. */
function commandsOf(line: string): string[] {
  return line
    .split(/&&|\|\||[;|&\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Words of one command, quotes respected and removed; an inner quoted command adds its words too. */
function wordsOf(command: string): string[] {
  const words: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|([^\s"']+)/g)) {
    const word = match[1] ?? match[2] ?? match[3] ?? "";
    words.push(word);
    if (/\s/.test(word)) words.push(...wordsOf(word));
  }
  return words;
}

/** A word as a program name: no folder, no `.exe`, no PowerShell `&` or `(`. */
function program(word: string): string {
  const base = word.replace(/^[&(]+/, "").replace(/[)]+$/, "");
  const name = base.slice(Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\")) + 1);
  return name.replace(/\.exe$/, "");
}

interface SecretHit {
  entry: string;
  rest: string;
  /** The path as written on the line. */
  text: string;
}

function secretHits(command: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const match of command.matchAll(SECRET_PATH)) {
    const roaming = match[2] === undefined ? undefined : `appdata/roaming/${match[2]}`;
    const local = match[3] === undefined ? undefined : `appdata/local/${match[3]}`;
    const entry = (match[1] ?? roaming ?? local ?? "").replace(/[/\\]+/g, "/");
    const text = match[0]!.replace(/^[\s"'=(,@:]/, "");
    const rest = (match[4] ?? "").replace(/[/\\]+/g, "/");
    hits.push({ entry, rest, text });
  }
  return hits;
}

function hitFinding(hit: SecretHit, verb: string): ArgScanFinding | null {
  if (hit.entry === ".ssh" && /^\/(?:known_hosts\S*|authorized_keys\S*|\S*\.pub)$/.test(hit.rest)) {
    return null;
  }
  const confidence = hit.entry === ".ssh" && hit.rest === "/config" ? LOW_CONFIDENCE : SECRET_CONFIDENCE;
  return { id: "dangerous.read_credentials", reason: `${verb} (${hit.text})`, confidence };
}

/** The operands of the copier in `words`, options left out. */
function copyOperands(words: readonly string[], at: number): string[] {
  // `/Y`, `-Recurse` are options; `/c/Users/...` and `/mnt/c/...` are paths.
  return words
    .slice(at + 1)
    .filter((word) => !/^[-/][a-z]/.test(word) || /^\/(?:mnt\/)?[a-z]\//.test(word));
}

/** Only the destination of a copy names the credential folder: a write, not a read. */
function onlyDestination(words: readonly string[], hits: readonly SecretHit[]): boolean {
  const at = words.findIndex((word) => COPIERS.has(program(word)) || program(word) === "robocopy");
  if (at === -1) return false;
  const operands = copyOperands(words, at);
  if (operands.length < 2) return false;
  const destination = program(words[at]!) === "robocopy" ? operands[1]! : operands.at(-1)!;
  const sources = operands.filter((word) => word !== destination);
  return (
    hits.every((hit) => destination.startsWith(hit.text)) &&
    !sources.some((word) => hits.some((hit) => word.startsWith(hit.text)))
  );
}

function stronger(best: ArgScanFinding | null, hit: ArgScanFinding | null): ArgScanFinding | null {
  if (hit === null) return best;
  return best === null || hit.confidence > best.confidence ? hit : best;
}

function commandFinding(command: string): ArgScanFinding | null {
  for (const pattern of SAVED_CREDENTIALS) {
    if (pattern.test(command)) {
      return {
        id: "dangerous.read_credentials",
        reason: "lists or exports saved Windows credentials",
        confidence: SECRET_CONFIDENCE,
      };
    }
  }
  const hits = secretHits(command);
  if (hits.length === 0) return null;
  const words = wordsOf(command);
  const programs = words.map(program);
  if (programs.some((name) => CD.has(name))) {
    let best: ArgScanFinding | null = null;
    for (const hit of hits) best = stronger(best, hitFinding(hit, "enters a credential folder"));
    if (best !== null) return { ...best, confidence: SECRET_CONFIDENCE };
  }
  const codeRunner = programs.some(
    (name, i) => CODE_RUNNER.test(name) && words.slice(i + 1).some((w) => CODE_FLAG.test(w)),
  );
  const reads =
    codeRunner ||
    DOTNET_READ.test(command) ||
    programs.some((name) => READERS.has(name)) ||
    /(?:^|[^<])<\s*\S/.test(command);
  if (!reads || onlyDestination(words, hits)) return null;
  let best: ArgScanFinding | null = null;
  for (const hit of hits) best = stronger(best, hitFinding(hit, "reads a credential file"));
  return best;
}

export function matchWindowsCredentialRead(input: NormalisedCommand): ArgScanFinding | null {
  let best: ArgScanFinding | null = null;
  for (const command of commandsOf(input.joinedLower)) {
    best = stronger(best, commandFinding(command));
  }
  return best;
}
