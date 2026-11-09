import type { GuardVerdict, NormalisedCommand } from "./guard-types.js";
import {
  invocationsOf,
  isLongOption,
  programName,
  shortOptionLetters,
  splitCommandSegments,
} from "./command-segments.js";
import { findGitSubcommand } from "./rules-policy.js";

/**
 * `git push --force-with-lease` (and `--force-if-includes`) still
 * rewrites the remote branch; it only refuses when someone else pushed
 * first. Treated as a force push, so it asks. Set to `false` to let it
 * through on the ordinary approval path instead.
 */
export const TREAT_FORCE_WITH_LEASE_AS_DANGEROUS = true;

/**
 * Pathspecs that name the whole working tree. `git checkout .` or
 * `git restore :/` throws away every uncommitted change at once; a
 * single named file is an ordinary edit and stays off this list.
 */
const WHOLE_TREE_PATHSPECS: ReadonlySet<string> = new Set([
  ".",
  "*",
  "./*",
  ":/",
  ":/*",
  ":/.",
  ":(top)",
  ":(top).",
  ":(top)*",
]);

/** Programs that delete what `find -exec` hands them. */
const FIND_EXEC_REMOVERS: ReadonlySet<string> = new Set([
  "rm",
  "unlink",
  "shred",
]);
const FIND_PROGRAMS: ReadonlySet<string> = new Set(["find", "gfind"]);
const FIND_EXEC_ACTIONS: ReadonlySet<string> = new Set(["-exec", "-execdir"]);

interface ArgvCheck {
  id: string;
  reason: string;
}

/**
 * Dangerous patterns read from the parsed words of each simple command
 * rather than from the joined line, so global options (`git -C dir
 * push`), bundled short flags (`-fu`) and refspecs (`+main`) cannot
 * hide them, and a flag in one command of `a && b` is not credited to
 * the other.
 */
export function matchDangerousArgv(
  input: NormalisedCommand,
): GuardVerdict | null {
  const segments = splitCommandSegments(input.joined);
  const hit = matchGit(segments) ?? matchFind(segments) ?? matchPluginConsent(segments);
  if (hit === null) return null;
  return { action: "approval_required", rule: hit.id, reason: hit.reason };
}

function matchGit(segments: readonly (readonly string[])[]): ArgvCheck | null {
  for (const args of invocationsOf(segments, "git")) {
    const sub = findGitSubcommand(args);
    if (!sub) continue;
    const rest = args.slice(sub.index + 1);
    const hit = checkGitVerb(sub.verb, rest);
    if (hit !== null) return hit;
  }
  return null;
}

function checkGitVerb(verb: string, rest: readonly string[]): ArgvCheck | null {
  switch (verb) {
    case "push": {
      const kind = pushForceKind(rest);
      if (kind === "force") {
        return { id: "dangerous.git_force_push", reason: "force push" };
      }
      if (kind === "lease" && TREAT_FORCE_WITH_LEASE_AS_DANGEROUS) {
        return {
          id: "dangerous.git_force_push",
          reason: "force push (with lease)",
        };
      }
      return null;
    }
    case "reset":
      return optionsBeforeDashDash(rest).some((w) =>
        isLongOption(w, "--hard", 4),
      )
        ? { id: "dangerous.git_reset_hard", reason: "hard reset" }
        : null;
    case "clean":
      return cleanForces(rest)
        ? {
            id: "dangerous.git_clean_force",
            reason: "delete untracked files",
          }
        : null;
    case "checkout":
      return checkoutDiscardsTree(rest)
        ? {
            id: "dangerous.git_discard_worktree",
            reason: "discard all uncommitted changes",
          }
        : null;
    case "restore":
      return restoreDiscardsTree(rest)
        ? {
            id: "dangerous.git_discard_worktree",
            reason: "discard all uncommitted changes",
          }
        : null;
    case "branch":
      return branchForceDeletes(rest)
        ? {
            id: "dangerous.git_branch_force_delete",
            reason: "force-delete a branch",
          }
        : null;
    default:
      return null;
  }
}

/** Words up to (not including) a bare `--`, after which all are paths. */
function optionsBeforeDashDash(rest: readonly string[]): readonly string[] {
  const end = rest.indexOf("--");
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * `force` for `--force`, `-f` (alone or bundled: `-fu`, `-uf`) or a
 * `+ref` refspec (`origin +main`, `origin +HEAD:main`); `lease` for
 * `--force-with-lease` / `--force-if-includes`. `-o` takes a value, so
 * letters after it in a bundle are not flags.
 */
function pushForceKind(rest: readonly string[]): "force" | "lease" | null {
  let lease = false;
  let options = true;
  for (const word of rest) {
    if (options && word === "--") {
      options = false;
      continue;
    }
    if (options) {
      if (shortOptionLetters(word, "o")?.includes("f")) return "force";
      if (isLongOption(word, "--force", 3)) return "force";
      if (
        isLongOption(word, "--force-with-lease", 9) ||
        isLongOption(word, "--force-if-includes", 9)
      ) {
        lease = true;
        continue;
      }
    }
    if (word.length > 1 && word.startsWith("+")) return "force";
  }
  return lease ? "lease" : null;
}

/**
 * `git clean` deletes only with `-f`/`--force` (bundled too: `-fdx`,
 * `-xdf`); `-n`/`--dry-run` anywhere makes it a listing. `-e` takes a
 * value.
 */
function cleanForces(rest: readonly string[]): boolean {
  let force = false;
  let dryRun = false;
  for (const word of optionsBeforeDashDash(rest)) {
    const letters = shortOptionLetters(word, "e");
    if (letters?.includes("f")) force = true;
    if (letters?.includes("n")) dryRun = true;
    if (isLongOption(word, "--force", 3)) force = true;
    if (isLongOption(word, "--dry-run", 3)) dryRun = true;
  }
  return force && !dryRun;
}

/** Options of `git checkout` / `git restore` whose value is the next word. */
const CHECKOUT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-b",
  "-B",
  "--orphan",
]);

/**
 * `git checkout .`, `git checkout -- .`, `git checkout HEAD -- :/`: a
 * whole-tree pathspec overwrites every modified file.
 */
function checkoutDiscardsTree(rest: readonly string[]): boolean {
  return positionalWords(rest, (word) => CHECKOUT_VALUE_OPTIONS.has(word)).some(
    isWholeTree,
  );
}

/**
 * `git restore .` (worktree by default), `--worktree`/`-W`, or
 * `--staged --worktree`: whole-tree pathspec and the working tree is a
 * target. `git restore --staged .` only unstages and is left alone.
 */
function restoreDiscardsTree(rest: readonly string[]): boolean {
  let staged = false;
  let worktree = false;
  for (const word of optionsBeforeDashDash(rest)) {
    const letters = shortOptionLetters(word, "s");
    if (letters?.includes("S")) staged = true;
    if (letters?.includes("W")) worktree = true;
    if (isLongOption(word, "--staged", 5)) staged = true;
    if (isLongOption(word, "--worktree", 3)) worktree = true;
  }
  if (staged && !worktree) return false;
  return positionalWords(rest, (word) => {
    // `-s <tree>` / `--source <tree>`; `-Ws <tree>` bundles end in s.
    if (isLongOption(word, "--source", 4) && !word.includes("=")) return true;
    const letters = shortOptionLetters(word, "s");
    return letters !== null && word.endsWith("s") && letters.at(-1) === "s";
  }).some(isWholeTree);
}

/**
 * Non-option words (after `--` every word is one), skipping the value
 * of any option `takesValue` names.
 */
function positionalWords(
  rest: readonly string[],
  takesValue: (word: string) => boolean,
): string[] {
  const out: string[] = [];
  let options = true;
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i] ?? "";
    if (options && word === "--") {
      options = false;
      continue;
    }
    if (options && word.startsWith("-") && word.length > 1) {
      if (takesValue(word)) i += 1;
      continue;
    }
    out.push(word);
  }
  return out;
}

function isWholeTree(word: string): boolean {
  const trimmed = word.length > 1 ? word.replace(/\/+$/, "") || "/" : word;
  return WHOLE_TREE_PATHSPECS.has(trimmed) || WHOLE_TREE_PATHSPECS.has(word);
}

/**
 * `-D`, `-d -f`, `-df`, `--delete --force`: deletes a branch even when
 * it was never merged, so its commits can be lost. Plain `-d` refuses
 * an unmerged branch and stays on the ordinary path.
 */
function branchForceDeletes(rest: readonly string[]): boolean {
  let del = false;
  let force = false;
  for (const word of optionsBeforeDashDash(rest)) {
    const letters = shortOptionLetters(word);
    if (letters?.includes("D")) return true;
    if (letters?.includes("d")) del = true;
    if (letters?.includes("f")) force = true;
    if (isLongOption(word, "--delete", 5)) del = true;
    // `--for` is ambiguous with `--format`; `--forc` is the shortest.
    if (isLongOption(word, "--force", 6)) force = true;
  }
  return del && force;
}

/**
 * `find … -delete` and `find … -exec rm …` / `-execdir rm …` remove
 * every match, however many the expression finds.
 */
function matchFind(segments: readonly (readonly string[])[]): ArgvCheck | null {
  for (const program of FIND_PROGRAMS) {
    for (const args of invocationsOf(segments, program)) {
      for (let i = 0; i < args.length; i += 1) {
        const word = args[i] ?? "";
        if (word === "-delete") {
          return { id: "dangerous.find_delete", reason: "find -delete" };
        }
        if (
          FIND_EXEC_ACTIONS.has(word) &&
          FIND_EXEC_REMOVERS.has(programName(args[i + 1] ?? ""))
        ) {
          return {
            id: "dangerous.find_exec_rm",
            reason: "find -exec removing files",
          };
        }
      }
    }
  }
  return null;
}

/** The `plugin` subcommands whose consent flag lets a plugin run code. */
const PLUGIN_CONSENT_FLAG_VERBS: ReadonlySet<string> = new Set([
  "install",
  "update",
  "upgrade",
]);

/**
 * The agent granting itself plugin consent: `atomic-agent plugin
 * allow-code x`, or `plugin install|update … --accept-code`. Consent
 * only ever comes from a person, so these ask every time whatever the
 * level below full trust, and no `shell` grant covers them. Matched on
 * the words after `plugin`, not on the binary name: the same command
 * also runs as `atag`, `npx atomic-agent` or `node dist/index.js`.
 */
function matchPluginConsent(
  segments: readonly (readonly string[])[],
): ArgvCheck | null {
  for (const words of segments) {
    for (let i = 0; i < words.length - 1; i += 1) {
      if (words[i] !== "plugin") continue;
      const verb = words[i + 1];
      const rest = words.slice(i + 2);
      if (
        verb === "allow-code" ||
        (verb !== undefined &&
          PLUGIN_CONSENT_FLAG_VERBS.has(verb) &&
          rest.includes("--accept-code"))
      ) {
        return {
          id: "dangerous.plugin_code_consent",
          reason: "allow a plugin to run code",
        };
      }
    }
  }
  return null;
}
