import type { NormalisedCommand } from "./guard-types.js";
import type { ArgScanFinding } from "./arg-scan-finding.js";
import {
  HOME_ONLY,
  HOME_VALUE,
  RELATIVE_SECRET_PATH,
  SECRET_PATH,
  SECRET_PIECE,
} from "./windows-credential-paths.js";

/**
 * `dangerous.read_credentials` for Windows paths and readers (ATO-2728).
 * The POSIX rule (`rules-credentials.ts`) reads the line through a POSIX
 * lexer, where `\` is an escape: `type %USERPROFILE%\.ssh\id_rsa` comes
 * out as one unreadable word and the read went by unasked, bypass
 * included. This rule reads the joined line as text instead, and takes
 * `\` and `/` alike as a folder separator.
 *
 * The home folder spellings are in `windows-credential-paths.ts`; `~` and
 * `$HOME` count with `/` too, since PowerShell takes both (review round
 * 1). The credential folders are `SECRET_HOME_PATHS` plus the Windows ones
 * below (gcloud and GitHub CLI under AppData, the Credential Manager and
 * DPAPI key folders, PowerShell history, browser saved logins).
 *
 * A command counts when one of its words is a reader: the POSIX readers
 * Git Bash brings, cmd's `type`, `more`, `copy`, `xcopy`, `robocopy`,
 * `findstr`, `certutil`, PowerShell's `Get-Content` / `gc`, `Copy-Item`,
 * `Compress-Archive`, `Select-String`, `[IO.File]::Read*`, or a `cd` /
 * `Set-Location` into the folder. A `cd /d %USERPROFILE%` (or a tool
 * working folder that is the home folder) makes `.ssh\id_rsa` after it a
 * home path; so does the home folder as a value of its own next to a
 * credential entry (`Join-Path $env:USERPROFILE .ssh\id_rsa`). cmd's `^`
 * escape is dropped before reading. A copy whose only credential path is
 * the destination is a write, not a read. `cmdkey /list`, `vaultcmd
 * /listcreds`, `Get-StoredCredential`, the `PasswordVault` class and a
 * `reg save|export` of the SAM / SECURITY hive name saved credentials
 * themselves. Public material stays out, as on POSIX: `*.pub`,
 * `known_hosts`, `authorized_keys`; `.ssh/config` is the low 0.6.
 */

const SECRET_CONFIDENCE = 0.9;
const LOW_CONFIDENCE = 0.6;

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
  /** The path is the target of a `<` redirect. */
  redirected: boolean;
}

function hitsOf(command: string, pattern: RegExp): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const match of command.matchAll(pattern)) {
    const groups = match.slice(1);
    const rest = (groups.pop() ?? "").replace(/[/\\]+/g, "/");
    let entry = groups[0];
    if (pattern === SECRET_PATH) {
      if (groups[1] !== undefined) entry = `appdata/roaming/${groups[1]}`;
      if (groups[2] !== undefined) entry = `appdata/local/${groups[2]}`;
    }
    const text = match[0]!.replace(/^[\s"'=(,@:]/, "");
    const before = command.slice(0, match.index! + match[0]!.length - text.length);
    hits.push({
      entry: (entry ?? "").replace(/[/\\]+/g, "/"),
      rest,
      text,
      redirected: /(?:^|[^<])<\s*["']?$/.test(before),
    });
  }
  return hits;
}

/** `gc (Join-Path $env:USERPROFILE '.ssh\id_rsa')`: home and entry as separate values. */
function pieceHits(command: string, words: readonly string[]): SecretHit[] {
  if (!HOME_VALUE.test(command)) return [];
  const hits: SecretHit[] = [];
  for (const word of words) {
    const match = SECRET_PIECE.exec(word.replace(/[),]+$/, ""));
    if (match === null) continue;
    const entry = match[1]!.replace(/[/\\]+/g, "/");
    hits.push({ entry, rest: match[2]!.replace(/[/\\]+/g, "/"), text: word, redirected: false });
  }
  return hits;
}

function secretHits(command: string, words: readonly string[], inHome: boolean): SecretHit[] {
  return [
    ...hitsOf(command, SECRET_PATH),
    ...(inHome ? hitsOf(command, RELATIVE_SECRET_PATH) : []),
    ...pieceHits(command, words),
  ];
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
  // `/Y`, `/R:3`, `-Recurse` are options; `/c/Users/...`, `/tmp/k` are paths.
  return words
    .slice(at + 1)
    .filter((word) => !/^-[a-z]/.test(word) && !/^\/[a-z0-9?]+(?::[^/\\]*)?$/.test(word));
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

function commandFinding(command: string, inHome: boolean): ArgScanFinding | null {
  for (const pattern of SAVED_CREDENTIALS) {
    if (pattern.test(command)) {
      return {
        id: "dangerous.read_credentials",
        reason: "lists or exports saved Windows credentials",
        confidence: SECRET_CONFIDENCE,
      };
    }
  }
  const words = wordsOf(command);
  const hits = secretHits(command, words, inHome);
  if (hits.length === 0) return null;
  const programs = words.map(program);
  if (programs.some((name) => CD.has(name))) {
    let best: ArgScanFinding | null = null;
    for (const hit of hits) best = stronger(best, hitFinding(hit, "enters a credential folder"));
    if (best !== null) return { ...best, confidence: SECRET_CONFIDENCE };
  }
  const codeRunner = programs.some(
    (name, i) => CODE_RUNNER.test(name) && words.slice(i + 1).some((w) => CODE_FLAG.test(w)),
  );
  const reads = codeRunner || DOTNET_READ.test(command) || programs.some((name) => READERS.has(name));
  // Without a reader only a `<` redirect of the path itself reads it.
  const read = reads ? (onlyDestination(words, hits) ? [] : hits) : hits.filter((hit) => hit.redirected);
  let best: ArgScanFinding | null = null;
  for (const hit of read) best = stronger(best, hitFinding(hit, "reads a credential file"));
  return best;
}

/** Whether the next command runs in the home folder, after `command`. */
function inHomeAfter(command: string, inHome: boolean): boolean {
  const words = wordsOf(command);
  const at = words.findIndex((word) => CD.has(program(word)));
  if (at === -1) return inHome;
  // `cd /d X`, `Set-Location -Path X`.
  const target = words.slice(at + 1).find((word) => !/^(?:\/d|-(?:literal)?path)$/.test(word));
  return target === undefined ? inHome : HOME_ONLY.test(target);
}

/** `cwd`: the tool's working folder; the home folder makes relative entries home paths. */
export function matchWindowsCredentialRead(input: NormalisedCommand, cwd = ""): ArgScanFinding | null {
  let inHome = HOME_ONLY.test(cwd.toLowerCase());
  let best: ArgScanFinding | null = null;
  // cmd drops `^` before the program sees its arguments: `.s^sh` is `.ssh`.
  for (const command of commandsOf(input.joinedLower.replace(/\^/g, ""))) {
    best = stronger(best, commandFinding(command, inHome));
    inHome = inHomeAfter(command, inHome);
  }
  return best;
}
