import { homedir } from "node:os";
import { posix } from "node:path";
import { SECRET_HOME_PATHS } from "../../../sandbox/os-sandbox.js";
import type { GuardInput, NormalisedCommand } from "./guard-types.js";
import type { ArgScanFinding } from "./arg-scan-finding.js";
import { PREFIX_COMMANDS, programName, splitCommandSegments } from "./command-segments.js";
import { ShellPathTracker, type CdStep } from "./shell-path-tracker.js";
import { secretPathUnderGlob } from "./secret-path-glob.js";

/**
 * `dangerous.read_credentials` (ATO-2126): a command that reads, copies,
 * packs or encodes a credential file. The folders are the ones Safe Mode
 * already hides from a sandboxed command (`SECRET_HOME_PATHS`: `~/.ssh`,
 * `~/.aws`, `~/.config/gcloud`, `~/.netrc`, ...), plus a project `.env`.
 *
 * Confidence, read against `ASK_EVERY_LEVEL_CONFIDENCE`:
 *  - 0.9 for a file under a credential folder: asks at every level,
 *    bypass included.
 *  - 0.6 for `~/.ssh/config` (host names, no keys) and a `.env` /
 *    `.envrc` file (often only local settings): asks as an ordinary
 *    dangerous command, quiet at full trust.
 * A `cd` on the line counts: `cd ~/.ssh && cat id_rsa` and `cd ~; cat
 * .ssh/id_rsa` resolve the relative operand against the folder the cd
 * moved to (`shell-path-tracker.ts`), and a `cd` into a credential
 * folder is itself a 0.9 finding. Variables set on the line are filled
 * in (`K=~/.ssh; cat $K/id_rsa`); a reader's path below home that still
 * holds an unknown variable asks at 0.9, and one with a glob asks when
 * the glob can reach a credential folder (`cat ~/.s?h/id_rsa`).
 * `python -c`, `node -e`, `perl -e`, `ruby -e`, `ssh-keygen`, `openssl`,
 * `dd`, `source`, `ln` and `find` read files named inside code or option
 * values, so for them any literal credential path on the line counts.
 * Other programs (an editor, `vim`, `jq`, a script file that opens the
 * path) are not covered: the rule knows common readers, not every one.
 * Public material is not a finding: `*.pub`, `known_hosts`,
 * `authorized_keys`. Nor are template env files (`.env.example`,
 * `.env.sample`, ...), which hold no secrets by convention.
 */

/** Programs that print, copy, pack, encode or send a file's content. */
const READERS: ReadonlySet<string> = new Set([
  "cat",
  "bat",
  "tac",
  "nl",
  "less",
  "more",
  "head",
  "tail",
  "strings",
  "od",
  "xxd",
  "hexdump",
  "base64",
  "base32",
  "grep",
  "egrep",
  "rg",
  "awk",
  "sed",
  "cp",
  "scp",
  "rsync",
  "tar",
  "zip",
  "7z",
  "gzip",
  "curl",
  "wget",
  "nc",
  "ncat",
]);

/** Copy programs whose last operand is the destination, not a read. */
const COPIERS: ReadonlySet<string> = new Set(["cp", "scp", "rsync"]);

const SECRET_CONFIDENCE = 0.9;
const LOW_CONFIDENCE = 0.6;

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The real home folder too, for a home outside `/Users` or `/home`. */
const HOME_PREFIX = String.raw`(?:~|\$home|\$\{home\}|/users/[^/\s]+|/home/[^/\s]+|/root|${escapeRegex(homedir().toLowerCase().replace(/\/+$/, ""))})`;
const SECRET_ALTERNATION = SECRET_HOME_PATHS.map((path) => escapeRegex(path.toLowerCase())).join("|");
/** `~/.ssh/id_rsa`, `$HOME/.aws`, `--file=~/.netrc`, `@~/.aws/credentials`, `host:~/.ssh/x`. */
const HOME_SECRET = new RegExp(
  String.raw`(?:^|[=@:])${HOME_PREFIX}/(${SECRET_ALTERNATION})(/\S*)?$`,
);
/** The same folders named relative to a command run in the home folder. */
const RELATIVE_SECRET = new RegExp(String.raw`^(?:\./)?(${SECRET_ALTERNATION})(/\S*)?$`);
const HOME_DIR = /^(?:\/users\/[^/]+|\/home\/[^/]+|\/root)\/?$/;
/** `'~/.ssh/id_rsa'` inside code or an `if=` value: any credential path. */
const SECRET_ANYWHERE = new RegExp(
  String.raw`(?:^|[\s=@:'"(,;\x60])${HOME_PREFIX}/(${SECRET_ALTERNATION})((?:/[^\s'"),;\x60]*)?)(?=$|[\s'"),;\x60])`,
  "g",
);
const ARGUMENT_READERS: ReadonlySet<string> = new Set([
  "ssh-keygen",
  "openssl",
  "dd",
  "source",
  ".",
  "ln",
  "find",
]);
/** Interpreters and the flag that hands them inline code. */
const CODE_FLAG: readonly (readonly [RegExp, RegExp])[] = [
  [/^python[0-9.]*$/, /^-[a-z]*c$/i],
  [/^node$/, /^(?:-[a-z]*[ep]|--eval|--print)$/],
  [/^perl$/, /^-[a-z]*e$/i],
  [/^ruby$/, /^-[a-z]*e$/],
];
/** A path below the home folder; group 1 is the part below it. */
const UNDER_HOME = new RegExp(String.raw`^${HOME_PREFIX}(/\S*)$`);
const UNKNOWN_VARIABLE = /\$(?:\{|[a-z_])/;
/** A plain path operand: no option, no `key=value`, no spaces. */
const PATH_WORD = /^[^-\s=@:'"][^\s=@:'"]*$/;
const PUBLIC_SSH = /^\/(?:known_hosts\S*|authorized_keys\S*|\S*\.pub)$/;

const ENV_FILE = /^\.env(?:rc)?(?:\.([a-z0-9_-]+))?$/;
const ENV_TEMPLATE_SUFFIXES: ReadonlySet<string> = new Set([
  "example",
  "examples",
  "sample",
  "template",
  "tmpl",
  "tpl",
  "dist",
  "default",
  "defaults",
  "schema",
]);

export function matchCredentialRead(
  input: NormalisedCommand,
  raw: GuardInput,
): ArgScanFinding | null {
  const cwdIsHome = HOME_DIR.test(raw.cwd.toLowerCase());
  // `cd ~/.ssh && cat id_rsa`: relative operands resolve against the
  // folder the last `cd` on the line moved to (review round 1).
  const paths = new ShellPathTracker(raw.cwd);
  let best: ArgScanFinding | null = null;
  let inlineReader = false;
  for (const words of splitCommandSegments(input.joined)) {
    const cd = paths.step(words);
    if (cd !== null) best = stronger(best, enteredSecretFolder(cd));
    for (const word of readOperands(words)) {
      best = stronger(best, operandFinding(word, paths, cwdIsHome));
    }
    inlineReader ||= readsThroughOwnArguments(words);
  }
  if (inlineReader) best = stronger(best, literalSecretPath(input.joinedLower));
  // `nc host 9 < ~/.ssh/id_rsa`: the segments drop redirect targets.
  for (const match of input.joined.matchAll(/(?:^|[^<])<\s*(\S+)/g)) {
    const word = match[1]!.replace(/^["']+|["']+$/g, "");
    best = stronger(best, operandFinding(word, paths, cwdIsHome));
  }
  return best;
}

function stronger(
  best: ArgScanFinding | null,
  hit: ArgScanFinding | null,
): ArgScanFinding | null {
  if (hit === null) return best;
  return best === null || hit.confidence > best.confidence ? hit : best;
}

/**
 * A word as written; then with the line's variables filled in; then the
 * path it names from the tracked folder. A path below home the guard
 * cannot read to the end (a glob, an unknown variable) is a finding
 * when it can reach a credential folder (review round 1).
 */
function operandFinding(
  word: string,
  paths: ShellPathTracker,
  cwdIsHome: boolean,
): ArgScanFinding | null {
  const direct = credentialWord(word, cwdIsHome);
  if (direct !== null || !PATH_WORD.test(word)) return direct;
  const expanded = paths.expand(word);
  if (expanded !== word) {
    const hit = credentialWord(expanded, cwdIsHome);
    if (hit !== null) return { ...hit, reason: `reads a credential file (${word} is ${expanded})` };
  }
  const path = paths.absolute(word);
  if (path === null) return null;
  const resolved = paths.resolve(word);
  if (resolved !== null) {
    if (resolved === word) return null;
    const hit = credentialWord(resolved, false);
    if (hit === null) return null;
    return { ...hit, reason: `reads a credential file (${word} in ${posix.dirname(resolved)})` };
  }
  return opaqueHomeFinding(word, path);
}

/** `~/.s?h/id_rsa`, `~/$DIR/id_rsa`: a home path with a glob or a variable. */
function opaqueHomeFinding(word: string, path: string): ArgScanFinding | null {
  const below = UNDER_HOME.exec(path.toLowerCase())?.[1];
  if (below === undefined) return null;
  if (UNKNOWN_VARIABLE.test(below)) {
    return {
      id: "dangerous.read_credentials",
      reason: `reads a path under the home folder built from a variable (${word})`,
      confidence: SECRET_CONFIDENCE,
    };
  }
  const reach = secretPathUnderGlob(below);
  return reach === null ? null : secretFolderFinding(word, reach.folder, reach.rest);
}

/**
 * Programs that read a file named anywhere in their arguments or inline
 * code, where operands are not a plain file list: `python3 -c
 * "open('~/.ssh/id_rsa')"`, `ssh-keygen -y -f`, `openssl rsa -in`,
 * `dd if=`, `source`, `ln -s`, `find ~/.ssh -exec ...`.
 */
function readsThroughOwnArguments(words: readonly string[]): boolean {
  return words.some((word, index) => {
    // The program word only: `grep foo .` is not `.` (source).
    if (!words.slice(0, index).every(isPrefixWord)) return false;
    const program = programName(word);
    if (ARGUMENT_READERS.has(program)) return true;
    const flag = CODE_FLAG.find(([name]) => name.test(program))?.[1];
    return flag !== undefined && words.slice(index + 1).some((arg) => flag.test(arg));
  });
}

/** A wrapper (`sudo`, `env`), its option or an assignment before a program. */
function isPrefixWord(word: string): boolean {
  return (
    word.startsWith("-") ||
    word.includes("=") ||
    Object.prototype.hasOwnProperty.call(PREFIX_COMMANDS, programName(word))
  );
}

/** Any literal credential path on the whole line, for those programs. */
function literalSecretPath(line: string): ArgScanFinding | null {
  let best: ArgScanFinding | null = null;
  for (const match of line.matchAll(SECRET_ANYWHERE)) {
    const word = match[0]!.replace(/^[\s=@:'"(,;\x60]/, "");
    best = stronger(best, secretFolderFinding(word, match[1]!, match[2] ?? ""));
  }
  return best;
}

/** `cd ~/.ssh`, `cd ~/.s?h`: the folder itself is the finding, whatever runs next. */
function enteredSecretFolder(cd: CdStep): ArgScanFinding | null {
  if (cd.target === null) {
    // A glob only: `cd ~/$PROJECT` is too common to ask about.
    const below = cd.path === null ? undefined : UNDER_HOME.exec(cd.path.toLowerCase())?.[1];
    if (below === undefined || UNKNOWN_VARIABLE.test(below)) return null;
    if (secretPathUnderGlob(below) === null) return null;
  } else if (HOME_SECRET.exec(cd.target.toLowerCase()) === null) {
    return null;
  }
  return {
    id: "dangerous.read_credentials",
    reason: `enters a credential folder (cd ${cd.word})`,
    confidence: SECRET_CONFIDENCE,
  };
}

/** The operands a reader in this simple command would read. */
function readOperands(words: readonly string[]): readonly string[] {
  const at = words.findIndex((word) => READERS.has(programName(word)));
  if (at === -1) return [];
  const program = programName(words[at]!);
  const operands = words.slice(at + 1);
  if (!COPIERS.has(program)) return operands;
  const positional = operands.filter((word) => !word.startsWith("-"));
  if (positional.length < 2) return operands;
  const destination = positional.at(-1)!;
  const last = operands.lastIndexOf(destination);
  return operands.filter((_, index) => index !== last);
}

function credentialWord(word: string, cwdIsHome: boolean): ArgScanFinding | null {
  const lower = word.toLowerCase();
  const match =
    HOME_SECRET.exec(lower) ?? (cwdIsHome ? RELATIVE_SECRET.exec(lower) : null);
  if (match !== null) return secretFolderFinding(word, match[1]!, match[2] ?? "");
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  const env = ENV_FILE.exec(base);
  if (env === null) return null;
  const suffix = env[1];
  if (suffix !== undefined && ENV_TEMPLATE_SUFFIXES.has(suffix)) return null;
  return {
    id: "dangerous.read_credentials",
    reason: `reads an env file that may hold keys (${word})`,
    confidence: LOW_CONFIDENCE,
  };
}

function secretFolderFinding(
  word: string,
  folder: string,
  rest: string,
): ArgScanFinding | null {
  if (folder === ".ssh" && PUBLIC_SSH.test(rest)) return null;
  const confidence =
    folder === ".ssh" && rest === "/config" ? LOW_CONFIDENCE : SECRET_CONFIDENCE;
  return {
    id: "dangerous.read_credentials",
    reason: `reads a credential file (${word})`,
    confidence,
  };
}
