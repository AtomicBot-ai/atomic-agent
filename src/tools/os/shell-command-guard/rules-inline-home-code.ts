import { SECRET_HOME_PATHS } from "../../../sandbox/os-sandbox.js";
import type { NormalisedCommand } from "./guard-types.js";
import type { ArgScanFinding } from "./arg-scan-finding.js";
import { splitCommandSegments } from "./command-segments.js";
import { runsInlineCodeAt } from "./inline-code-flags.js";

/**
 * `dangerous.read_credentials` for inline code that builds a credential
 * path from the home folder at run time (ATO-2730): `node -e
 * "fs.readFileSync(os.homedir()+'/.ssh/id_rsa')"`, `python3 -c "open(
 * os.path.join(os.path.expanduser('~'), '.aws', 'credentials'))"`, `ruby
 * -e "File.read(File.join(Dir.home, '.netrc'))"`. The literal-path check
 * in `rules-credentials.ts` needs `~/.ssh` spelled out; here no such word
 * exists until the code runs.
 *
 * When an interpreter on the line has its code flag, the whole line is
 * read as its code, as the literal-path check does: a line the lexer
 * cannot read is split at `(` and would cut the code apart. The code may
 * be stuck to its flag (`python3 -c"..."`, `inline-code-flags.ts`). It
 * counts when it asks for the home folder (`homedir()`, `.homedir`,
 * `pw_dir`, `expanduser(`, `Path.home()`, `process.env.HOME`, `os.environ['HOME']`, `getenv('HOME')`, `$ENV{HOME}`,
 * `ENV['HOME']`, `Dir.home`, `Deno.env.get('HOME')`, `%USERPROFILE%` and
 * the Windows `USERPROFILE` variable) and names every part of one
 * credential entry as a separate string or path piece (`'.ssh'`,
 * `"/.aws/"`, `'.config', 'gcloud'`). Public SSH files alone (`.pub`,
 * `known_hosts`, `authorized_keys`) are not a finding.
 */

const SECRET_CONFIDENCE = 0.9;

/**
 * `homedir` with or without a call (`os.homedir()`, `os.userInfo().homedir`,
 * review round 1) and Python's `pwd` entry `pw_dir`.
 */
const HOME_EXPRESSION =
  /\bhomedir\b|\bpw_dir\b|expanduser\s*\(|path\.home\s*\(|process\.env\.(?:home|userprofile)\b|process\.env\s*\[\s*['"](?:home|userprofile)['"]|environ(?:\.get)?\s*[[(]\s*['"](?:home|userprofile)['"]|getenv\s*\(\s*['"](?:home|userprofile)['"]|\$env\{\s*['"]?(?:home|userprofile)|\benv\s*\[\s*['"](?:home|userprofile)['"]|\bdir\.home\b|deno\.env\.get\s*\(\s*['"](?:home|userprofile)['"]|%userprofile%|\$env:userprofile|\$_server\s*\[\s*['"]home['"]/;

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Each credential entry as the list of pieces that must all appear. */
const ENTRIES: readonly (readonly RegExp[])[] = SECRET_HOME_PATHS.map((entry) =>
  entry
    .toLowerCase()
    .split("/")
    .map((part) => new RegExp(String.raw`(?:^|['"/\\,\s(])${escapeRegex(part)}(?=$|['"/\\,\s)])`)),
);
const PUBLIC_SSH = /known_hosts|authorized_keys|\.pub\b/;
const PRIVATE_KEY_NAME = /\bid_[a-z0-9]+\b(?!\.pub)/;

/** Some interpreter on the line runs code given on the line, attached to its flag or not. */
function runsInlineCode(input: NormalisedCommand): boolean {
  return splitCommandSegments(input.joined).some((words) =>
    words.some((_, index) => runsInlineCodeAt(words, index)),
  );
}

function namedEntry(code: string): string | null {
  for (let i = 0; i < ENTRIES.length; i += 1) {
    if (!ENTRIES[i]!.every((piece) => piece.test(code))) continue;
    const entry = SECRET_HOME_PATHS[i]!;
    if (entry === ".ssh" && PUBLIC_SSH.test(code) && !PRIVATE_KEY_NAME.test(code)) continue;
    return entry;
  }
  return null;
}

export function matchInlineHomeCode(input: NormalisedCommand): ArgScanFinding | null {
  const code = input.joinedLower;
  if (!HOME_EXPRESSION.test(code) || !runsInlineCode(input)) return null;
  const entry = namedEntry(code);
  if (entry === null) return null;
  return {
    id: "dangerous.read_credentials",
    reason: `inline code reads a credential file below the home folder (~/${entry})`,
    confidence: SECRET_CONFIDENCE,
  };
}
