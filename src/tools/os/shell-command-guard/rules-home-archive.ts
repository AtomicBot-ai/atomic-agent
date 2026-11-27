import { homedir } from "node:os";
import { posix } from "node:path";
import type { GuardInput, NormalisedCommand } from "./guard-types.js";
import type { ArgScanFinding } from "./arg-scan-finding.js";
import { programName, splitCommandSegments } from "./command-segments.js";
import { ShellPathTracker } from "./shell-path-tracker.js";

/**
 * `dangerous.read_credentials` for a whole home folder packed or copied
 * (ATO-2730): `tar czf x.tgz ~`, `zip -r x.zip $HOME`, `cd ~ && tar czf x
 * .`, `rsync -a ~/ host:`, `cp -r ~ /tmp/x`. The archive holds `~/.ssh`,
 * `~/.aws` and every other credential folder, but no word on the line
 * names one, so the credential rule did not see it.
 *
 * A source operand counts when it is the home folder itself (`~`, `~/`,
 * `$HOME`, `/Users/<name>`, `.` after a `cd` there), a folder above it
 * (`/Users`, `/home`, `/`), or every entry of one of those (`~/*`, `~/.*`,
 * `*` in it). A destination does not: `cp -r x ~`,
 * `tar xzf x.tgz -C ~` (extracting is not reading). `tar -C <dir>` moves
 * the folder the members after it are read from.
 */

const SECRET_CONFIDENCE = 0.9;
const HOME_DIR = /^(?:\/users\/[^/]+|\/home\/[^/]+|\/root)$/;
/** The folders every home folder sits in, and the root. */
const HOMES_PARENT = /^(?:\/|\/users|\/home)$/;
const WHOLE_FOLDER = /^(?:\*|\.\*|\.\[!.\]\*|\.\?\*|\{\*,\.\*\}|\{\.\*,\*\})$/;
/** Copy programs: every operand but the last is a source. */
const COPIERS: ReadonlySet<string> = new Set(["cp", "scp", "rsync", "ditto", "rclone"]);
const RECURSIVE_FLAG = /^(?:-[a-z]*[raR][a-z]*|--recursive|--archive)$/;
/** tar options that take the next word as their value (`-f x.tgz`, `-T list`). */
const TAR_VALUE_LETTERS = "fbTXLNV";

function stripSlashes(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * The home folder or a folder that holds it (`/`, `/Users`, `/home`, the
 * parents of the real home; review round 1): their archive has `~/.ssh`
 * in it too.
 */
function holdsHome(lower: string, home: string): boolean {
  if (lower === home || HOME_DIR.test(lower) || HOMES_PARENT.test(lower)) return true;
  return home.startsWith(`${lower}/`);
}

/** The path is the home folder (or above it), or a glob of all its entries. */
function namesWholeHome(path: string, home: string): boolean {
  const clean = stripSlashes(posix.normalize(path));
  const lower = clean.toLowerCase();
  if (holdsHome(lower, home)) return true;
  const dir = posix.dirname(clean).toLowerCase();
  const base = posix.basename(clean);
  return holdsHome(dir, home) && WHOLE_FOLDER.test(base);
}

function finding(word: string): ArgScanFinding {
  return {
    id: "dangerous.read_credentials",
    reason: `packs or copies the whole home folder or a folder above it, credential folders included (${word})`,
    confidence: SECRET_CONFIDENCE,
  };
}

/** Each operand that names the whole home folder, read from `base`. */
function homeOperand(
  words: readonly string[],
  paths: ShellPathTracker,
  base: string | null,
  home: string,
): string | null {
  for (const word of words) {
    const expanded = paths.expand(word);
    let path: string | null;
    if (expanded.startsWith("/")) path = expanded;
    else path = base === null ? paths.absolute(word) : posix.join(base, expanded);
    if (path !== null && namesWholeHome(path, home)) return word;
  }
  return null;
}

/** tar: members after the mode, the archive name and other values; `-C` moves the base. */
function tarSources(args: readonly string[], paths: ShellPathTracker, home: string): string | null {
  let base: string | null = null;
  const members: string[] = [];
  let skip = 0;
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i]!;
    if (skip > 0) {
      skip -= 1;
      continue;
    }
    // `czf` (old style, first word only) or `-czf`.
    let bundle: string | null = null;
    if (i === 0 && /^[a-zA-Z]+$/.test(word)) bundle = word;
    else if (/^-[a-zA-Z]+$/.test(word)) bundle = word.slice(1);
    if (/^--(?:extract|get|list|diff|compare)$/.test(word) || (bundle !== null && /[xtd]/.test(bundle))) {
      return null;
    }
    if (word === "-C" || word === "--directory") {
      const dir = args[i + 1];
      if (dir !== undefined) {
        const hit = homeOperand(members, paths, base, home);
        if (hit !== null) return hit;
        members.length = 0;
        base = paths.absolute(dir);
        if (base !== null) base = stripSlashes(base);
      }
      i += 1;
      continue;
    }
    if (word.startsWith("--directory=")) {
      base = paths.absolute(word.slice("--directory=".length));
      continue;
    }
    if (bundle !== null) {
      skip = [...bundle].filter((letter) => TAR_VALUE_LETTERS.includes(letter)).length;
      continue;
    }
    if (word.startsWith("-")) continue;
    members.push(word);
  }
  return homeOperand(members, paths, base, home);
}

function segmentHit(words: readonly string[], paths: ShellPathTracker, home: string): string | null {
  const at = words.findIndex((word) => {
    const name = programName(word);
    return /^(?:b|g)?tar$|^zip$|^7z[a-z]?$|^pax$/.test(name) || COPIERS.has(name);
  });
  if (at === -1) return null;
  const program = programName(words[at]!);
  const args = words.slice(at + 1);
  if (/tar$/.test(program)) return tarSources(args, paths, home);
  const operands = args.filter((word) => !word.startsWith("-"));
  if (program === "zip") return homeOperand(operands.slice(1), paths, null, home);
  if (program.startsWith("7z")) {
    return operands[0] === "a" ? homeOperand(operands.slice(2), paths, null, home) : null;
  }
  if (program === "pax") return args.includes("-w") ? homeOperand(operands, paths, null, home) : null;
  if (program === "cp" && !args.some((word) => RECURSIVE_FLAG.test(word))) return null;
  return homeOperand(operands.slice(0, -1), paths, null, home);
}

export function matchHomeArchive(input: NormalisedCommand, raw: GuardInput): ArgScanFinding | null {
  const home = stripSlashes(homedir()).toLowerCase();
  const paths = new ShellPathTracker(raw.cwd);
  for (const words of splitCommandSegments(input.joined)) {
    paths.step(words);
    const hit = segmentHit(words, paths, home);
    if (hit !== null) return finding(hit);
  }
  return null;
}
