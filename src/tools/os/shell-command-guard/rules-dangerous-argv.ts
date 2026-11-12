import type { GuardVerdict, NormalisedCommand } from "./guard-types.js";
import {
  invocationsOf,
  isLongOption,
  NESTED_SHELL_PROGRAMS,
  programName,
  scanNestedShellOptions,
  shortOptionLetters,
  splitCommandSegments,
} from "./command-segments.js";
import { isComputedOption, isComputedWord } from "./command-substitution.js";
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
  const hit =
    matchGit(segments) ??
    matchFind(segments) ??
    matchXargsRm(segments) ??
    matchRm(segments) ??
    matchNestedShell(segments) ??
    matchPluginConsent(segments);
  if (hit === null) return null;
  return { action: "approval_required", rule: hit.id, reason: hit.reason };
}

function matchGit(segments: readonly (readonly string[])[]): ArgvCheck | null {
  for (const { args, named } of gitInvocations(segments)) {
    const sub = findGitSubcommand(args);
    if (!sub) continue;
    const globals = args.slice(0, sub.index);
    const rest = args.slice(sub.index + 1);
    const hit =
      (named ? (gitCommandOnTheLine(globals) ?? computedGitVerb(sub.verb)) : null) ??
      checkGitVerb(sub.verb, rest, globals) ??
      computedGitArgs(sub.verb, rest);
    if (hit !== null) return hit;
  }
  return matchGitConfigEnv(segments);
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Every `git` of the line (`named`), plus the words after any word that
 * is only known when the line runs (`g=git; $g push -f`, `"$GIT" reset
 * --hard`, `command $g push --force`, `env $g …`, `time $g …`): that
 * word may be git, wherever a front command puts it, the same way
 * `invocationsOf` finds a literal `git` behind one. Only the rules that
 * name a destructive verb or flag apply there, so `$EDITOR notes.md` or
 * `cp $A $B` are not affected. Options and assignments are skipped.
 */
function gitInvocations(
  segments: readonly (readonly string[])[],
): { args: readonly string[]; named: boolean }[] {
  const found = invocationsOf(segments, "git").map((args) => ({ args, named: true }));
  for (const words of segments) {
    words.forEach((word, index) => {
      if (word.startsWith("-") || ENV_ASSIGNMENT.test(word)) return;
      if (isComputedWord(word)) found.push({ args: words.slice(index + 1), named: false });
    });
  }
  return found;
}

/** `git $S --force`: the subcommand itself is only known when it runs. */
function computedGitVerb(verb: string): ArgvCheck | null {
  return isComputedWord(verb)
    ? {
        id: "dangerous.git_computed_args",
        reason: "git subcommand only known when the command runs",
      }
    : null;
}

/**
 * Config keys that make a later git command run something the line
 * chose: `alias.*` (a new subcommand, or a shell command with `!`),
 * `core.sshCommand` and `core.gitProxy` (run on every fetch and push),
 * `core.fsmonitor` (a program run on every status), `core.hooksPath`
 * (hooks from any folder). `core.pager` and `core.editor` are left out:
 * `-c core.pager=cat log` and `-c core.editor=true rebase --continue`
 * are how a non-interactive agent runs git, and asking every time would
 * be a question with no session grant (ATO-1263 review).
 */
const COMMAND_CONFIG_KEY = /^(?:alias\.|core\.(?:sshcommand|gitproxy|fsmonitor|hookspath)\b)/i;

/**
 * `git -c alias.p='push --force' p`, `git -c core.sshCommand=… fetch`,
 * `git --config-env=alias.p=VAR p`: the line defines what runs, so none
 * of the rules below can read it. A `-c` key only known when the line
 * runs (`-c "$X"`, `-c "$(echo alias.p=…)"`) may be an alias too.
 */
function gitCommandOnTheLine(globals: readonly string[]): ArgvCheck | null {
  for (let i = 0; i < globals.length; i += 1) {
    const word = globals[i] ?? "";
    const value =
      word === "-c" ? (globals[i + 1] ?? "") : word.startsWith("-c") ? word.slice(2) : null;
    if (
      // Only a computed key matters: `-c user.name=$N` sets a known key.
      (value !== null &&
        (COMMAND_CONFIG_KEY.test(value) || isComputedWord(value.split("=")[0] ?? ""))) ||
      isLongOption(word, "--config-env")
    ) {
      return {
        id: "dangerous.git_config_command",
        reason: "git alias or command defined on the line",
      };
    }
  }
  return null;
}

const GIT_CONFIG_ENV = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)=/;

/**
 * `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0='push
 * -f' git p`: the same, through the environment. Read anywhere on the
 * line, not only in front of git: `export GIT_CONFIG_PARAMETERS=…; git
 * p` sets it for every later command. An export in an earlier call of
 * the session is not seen.
 */
function matchGitConfigEnv(
  segments: readonly (readonly string[])[],
): ArgvCheck | null {
  const runsGit = segments.some((words) => words.some((word) => programName(word) === "git"));
  if (!runsGit) return null;
  for (const words of segments) {
    if (words.some((word) => GIT_CONFIG_ENV.test(word))) {
      return {
        id: "dangerous.git_config_command",
        reason: "git configuration set for this command",
      };
    }
  }
  return null;
}

/**
 * Git verbs with a rule below: a flag that only appears when the line
 * runs (`git push $(echo -f)`, `git reset --$m`) could turn any of them
 * destructive, so a computed option among their words asks too. A plain
 * `$BRANCH` in an argument slot does not (`isComputedOption`).
 */
const GIT_VERBS_WITH_RULES: ReadonlySet<string> = new Set([
  "push",
  "reset",
  "clean",
  "checkout",
  "switch",
  "restore",
  "branch",
  "stash",
]);

function computedGitArgs(verb: string, rest: readonly string[]): ArgvCheck | null {
  if (!GIT_VERBS_WITH_RULES.has(verb)) return null;
  return optionsBeforeDashDash(rest).some(isComputedOption)
    ? {
        id: "dangerous.git_computed_args",
        reason: "git arguments only known when the command runs",
      }
    : null;
}

function checkGitVerb(
  verb: string,
  rest: readonly string[],
  globals: readonly string[],
): ArgvCheck | null {
  switch (verb) {
    case "push": {
      const remote = pushRewritesRemote(rest);
      if (remote !== null) return remote;
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
      return cleanForces(rest, cleanForceOffInGlobals(globals))
        ? {
            id: "dangerous.git_clean_force",
            reason: "delete untracked files",
          }
        : null;
    case "checkout":
      return checkoutDiscardsTree(rest) || checkoutForces(rest)
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
    case "switch":
      return switchDiscards(rest)
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
    case "stash":
      return stashDeletes(rest)
        ? { id: "dangerous.git_stash_drop", reason: "delete stashed changes" }
        : null;
    case "config":
      if (configSetsCommandKey(rest)) {
        return {
          id: "dangerous.git_config_command",
          reason: "define a git alias or a command git runs",
        };
      }
      return configTurnsOffCleanForce(rest)
        ? {
            id: "dangerous.git_clean_force",
            reason: "turn off the safety check of git clean",
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
 * `git push origin :main` (an empty source deletes the branch),
 * `--delete` / `-d`, `--mirror` (the remote becomes an exact copy:
 * branches missing here are deleted there, the rest overwritten) and
 * `--prune` (deletes remote branches with no local twin).
 */
function pushRewritesRemote(rest: readonly string[]): ArgvCheck | null {
  let options = true;
  for (const word of rest) {
    if (options && word === "--") {
      options = false;
      continue;
    }
    if (options && word.startsWith("-")) {
      if (shortOptionLetters(word, "o")?.includes("d")) {
        return { id: "dangerous.git_push_delete", reason: "delete a remote branch" };
      }
      if (isLongOption(word, "--delete", 4)) {
        return { id: "dangerous.git_push_delete", reason: "delete a remote branch" };
      }
      if (isLongOption(word, "--mirror", 4)) {
        return {
          id: "dangerous.git_push_mirror",
          reason: "overwrite and delete remote branches (mirror push)",
        };
      }
      // `--pr` and `--pro` are ambiguous with `--progress`.
      if (isLongOption(word, "--prune", 5)) {
        return {
          id: "dangerous.git_push_prune",
          reason: "delete remote branches missing here (prune)",
        };
      }
      continue;
    }
    // `:main`, `+:main`: nothing on the left of the colon.
    if (/^\+?:[^:]/.test(word)) {
      return { id: "dangerous.git_push_delete", reason: "delete a remote branch" };
    }
  }
  return null;
}

/** A `-c clean.requireForce=false` (or `no`/`off`/`0`) before `clean`. */
const CLEAN_FORCE_OFF = /^clean\.requireforce=(?:false|no|off|0)$/i;

function cleanForceOffInGlobals(globals: readonly string[]): boolean {
  for (let i = 0; i < globals.length; i += 1) {
    const word = globals[i] ?? "";
    if (word === "-c" && CLEAN_FORCE_OFF.test(globals[i + 1] ?? "")) return true;
    if (word.startsWith("-c") && CLEAN_FORCE_OFF.test(word.slice(2))) return true;
  }
  return false;
}

/**
 * `git config alias.p 'push -f'` (or `git config set …`, `--add`): every
 * later `git p` runs a force push the rules cannot read, on this line
 * (`git config alias.p …; git p`) or any later one. Reading a key
 * (`git config alias.p`, `--get`, `--unset`) is not a set.
 */
function configSetsCommandKey(rest: readonly string[]): boolean {
  const words = rest.filter((w) => !w.startsWith("-"));
  const start = words[0] === "set" ? 1 : 0;
  const key = words[start];
  if (key === undefined || !COMMAND_CONFIG_KEY.test(key)) return false;
  if (rest.some((w) => isLongOption(w, "--unset") || isLongOption(w, "--unset-all") || w === "--get" || w.startsWith("--get-"))) {
    return false;
  }
  return words.length > start + 1;
}

/**
 * `git config clean.requireForce false`: every later `git clean` in the
 * repository deletes without `-f`, so it asks the way `clean -f` does.
 */
function configTurnsOffCleanForce(rest: readonly string[]): boolean {
  const words = rest.filter((w) => !w.startsWith("-"));
  const key = words.findIndex((w) => w.toLowerCase() === "clean.requireforce");
  if (key === -1) return false;
  return /^(?:false|no|off|0)$/i.test(words[key + 1] ?? "");
}

/**
 * `git clean` deletes only with `-f`/`--force` (bundled too: `-fdx`,
 * `-xdf`), or with no flag at all once `clean.requireForce` is off for
 * the call; `-n`/`--dry-run` anywhere makes it a listing. `-e` takes a
 * value.
 */
function cleanForces(rest: readonly string[], forceImplied = false): boolean {
  let force = forceImplied;
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
 * `git checkout -f <branch>` / `--force`: switches and throws away every
 * local change on the way. `-b` / `-B` take a value.
 */
function checkoutForces(rest: readonly string[]): boolean {
  return optionsBeforeDashDash(rest).some(
    (word) =>
      shortOptionLetters(word, "bB")?.includes("f") === true ||
      isLongOption(word, "--force", 4),
  );
}

/**
 * `git switch --discard-changes`, `-f` / `--force` (its alias). `-c` /
 * `-C` take a value.
 */
function switchDiscards(rest: readonly string[]): boolean {
  return optionsBeforeDashDash(rest).some(
    (word) =>
      shortOptionLetters(word, "cC")?.includes("f") === true ||
      isLongOption(word, "--force", 4) ||
      isLongOption(word, "--discard-changes", 4),
  );
}

/**
 * `git stash drop` and `git stash clear` delete stashed work for good
 * (it only lingers as an unreachable commit until gc). `pop`, `apply`,
 * `list`, `push` keep it.
 */
function stashDeletes(rest: readonly string[]): boolean {
  const sub = rest.find((word) => !word.startsWith("-"));
  return sub === "drop" || sub === "clear";
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

/**
 * Options of `xargs` whose value is the next word when it is not
 * attached (`-n 1`, `-I {}`). `-i`, `-e`, `-l` and the GNU long forms
 * `--replace`, `--eof`, `--max-lines` only take an attached one
 * (`--replace={}`) and are left out.
 */
const XARGS_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-I", "-n", "-L", "-P", "-d", "-E", "-s", "-a",
  "--max-args", "--max-procs", "--delimiter", "--arg-file", "--max-chars",
]);

/**
 * `find … | xargs rm`, `ls | xargs -n1 unlink`: removes every file the
 * list on stdin names, however long it is, even without `-r` or `-f`.
 */
function matchXargsRm(
  segments: readonly (readonly string[])[],
): ArgvCheck | null {
  for (const args of invocationsOf(segments, "xargs")) {
    for (let i = 0; i < args.length; i += 1) {
      const word = args[i] ?? "";
      if (word === "--") {
        i += 1;
      } else if (word.startsWith("-")) {
        if (XARGS_VALUE_OPTIONS.has(word)) i += 1;
        continue;
      }
      if (FIND_EXEC_REMOVERS.has(programName(args[i] ?? ""))) {
        return { id: "dangerous.xargs_rm", reason: "remove every file a list names" };
      }
      break;
    }
  }
  return null;
}

interface RmInvocation {
  recursive: boolean;
  force: boolean;
  targets: readonly string[];
}

/** Every `rm` of the line, with flags read wherever they stand. */
function rmInvocations(
  segments: readonly (readonly string[])[],
): RmInvocation[] {
  return invocationsOf(segments, "rm").map((args) => {
    let recursive = false;
    let force = false;
    const targets: string[] = [];
    let options = true;
    for (const word of args) {
      if (options && word === "--") {
        options = false;
        continue;
      }
      const letters = options ? shortOptionLetters(word) : null;
      if (letters !== null) {
        if (letters.includes("r") || letters.includes("R")) recursive = true;
        if (letters.includes("f")) force = true;
      } else if (options && word.startsWith("--") && word.length > 2) {
        if (isLongOption(word, "--recursive", 3)) recursive = true;
        if (isLongOption(word, "--force", 3)) force = true;
      } else {
        targets.push(word);
      }
    }
    return { recursive, force, targets };
  });
}

/** `rm -v -rf x`, `rm --verbose -r x`: the patterns read only the first flag. */
function matchRm(segments: readonly (readonly string[])[]): ArgvCheck | null {
  const all = rmInvocations(segments);
  if (all.some((rm) => rm.recursive)) {
    return { id: "dangerous.rm_recursive", reason: "recursive remove" };
  }
  if (all.some((rm) => rm.force)) {
    return { id: "dangerous.rm_force", reason: "force remove" };
  }
  return null;
}

const HOME_TARGET = /^(?:~|\$home|\$\{home\})(?:\/|$)/i;

/**
 * `rm -rf` of the filesystem root or the home directory with the flags
 * anywhere (`rm -rf -v ~`, `rm -rf --no-preserve-root /`). The rule ids
 * are the hardline patterns' own.
 */
export function matchHardlineRm(input: NormalisedCommand): GuardVerdict | null {
  for (const rm of rmInvocations(splitCommandSegments(input.joined))) {
    if (!rm.recursive || !rm.force) continue;
    for (const target of rm.targets) {
      if (target === "/") {
        return { action: "block", rule: "hardline.rm_root", reason: "recursive delete of filesystem root" };
      }
      if (target.startsWith("/*")) {
        return { action: "block", rule: "hardline.rm_root_glob", reason: "recursive delete of /*" };
      }
      if (HOME_TARGET.test(target)) {
        return { action: "block", rule: "hardline.rm_home", reason: "recursive delete of home directory" };
      }
    }
  }
  return null;
}

/**
 * `bash -lc …`, `env bash -c …`, `cd x && sh -c …`: a nested shell
 * however it is started. Only the options before the first script
 * argument count: `bash run.sh -c` passes `-c` to the script.
 */
function matchNestedShell(
  segments: readonly (readonly string[])[],
): ArgvCheck | null {
  for (const program of NESTED_SHELL_PROGRAMS) {
    for (const args of invocationsOf(segments, program)) {
      if (scanNestedShellOptions(args, program).runsCommand) {
        return { id: "dangerous.shell_dash_c", reason: "nested shell command" };
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
