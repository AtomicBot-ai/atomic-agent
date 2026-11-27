import { homedir } from "node:os";
import { SECRET_HOME_PATHS } from "../../../sandbox/os-sandbox.js";
import type { GuardInput, NormalisedCommand } from "./guard-types.js";
import type { ArgScanFinding } from "./arg-scan-finding.js";
import { programName, splitCommandSegments } from "./command-segments.js";

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
  const candidates: string[] = [];
  for (const words of splitCommandSegments(input.joined)) {
    candidates.push(...readOperands(words));
  }
  // `nc host 9 < ~/.ssh/id_rsa`: the segments drop redirect targets.
  for (const match of input.joined.matchAll(/(?:^|[^<])<\s*(\S+)/g)) {
    candidates.push(match[1]!.replace(/^["']+|["']+$/g, ""));
  }
  let best: ArgScanFinding | null = null;
  for (const word of candidates) {
    const hit = credentialWord(word, cwdIsHome);
    if (hit !== null && (best === null || hit.confidence > best.confidence)) best = hit;
  }
  return best;
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
