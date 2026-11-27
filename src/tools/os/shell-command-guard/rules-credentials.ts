import { homedir } from "node:os";
import { posix } from "node:path";
import { SECRET_HOME_PATHS } from "../../../sandbox/os-sandbox.js";
import type { GuardInput, NormalisedCommand } from "./guard-types.js";
import type { ArgScanFinding } from "./arg-scan-finding.js";
import { programName, splitCommandSegments } from "./command-segments.js";
import { ShellPathTracker, type CdStep } from "./shell-path-tracker.js";

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
 * folder is itself a 0.9 finding.
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
  for (const words of splitCommandSegments(input.joined)) {
    const cd = paths.step(words);
    if (cd !== null) best = stronger(best, enteredSecretFolder(cd));
    for (const word of readOperands(words)) {
      best = stronger(best, operandFinding(word, paths, cwdIsHome));
    }
  }
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

/** A word as written, then the path it names from the tracked folder. */
function operandFinding(
  word: string,
  paths: ShellPathTracker,
  cwdIsHome: boolean,
): ArgScanFinding | null {
  const direct = credentialWord(word, cwdIsHome);
  if (direct !== null || !PATH_WORD.test(word)) return direct;
  const resolved = paths.resolve(word);
  if (resolved === null || resolved === word) return null;
  const hit = credentialWord(resolved, false);
  if (hit === null) return null;
  return { ...hit, reason: `reads a credential file (${word} in ${posix.dirname(resolved)})` };
}

/** `cd ~/.ssh`: the folder itself is the finding, whatever runs next. */
function enteredSecretFolder(cd: CdStep): ArgScanFinding | null {
  if (cd.target === null) return null;
  const match = HOME_SECRET.exec(cd.target.toLowerCase());
  if (match === null) return null;
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
