import type { Rule, ShellGuardPolicy } from "./guard-types.js";

/**
 * Git verbs that move a repository over the network. `remote add` and
 * `remote set-url` are included because attaching a remote is the step
 * before the first push — the closed-repository promise ("nothing the
 * agent versions here reaches a server") has to cover the setup, not
 * only the transfer.
 */
const NETWORK_VERBS: ReadonlySet<string> = new Set([
  "push",
  "fetch",
  "pull",
  "clone",
]);
const REMOTE_MUTATORS: ReadonlySet<string> = new Set(["add", "set-url"]);

/**
 * Global git options that consume the next token, so the subcommand is
 * found after them: `git -C <dir> push`, `git -c key=val fetch`.
 */
const GLOBAL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
]);

export const GIT_REMOTE_SYNC_OFF_RULE = "policy.git_remote_sync_off";
export const GIT_REMOTE_SYNC_OFF_REASON =
  "remote sync is off — this repository stays on this machine (Integrations → GitHub → Remote sync)";

/**
 * Locate the git subcommand and the token after it, skipping global
 * options. Returns `null` when the command has no subcommand.
 */
export function readGitSubcommand(
  args: readonly string[],
): { verb: string; next: string | undefined } | null {
  const found = findGitSubcommand(args);
  if (!found) return null;
  return { verb: found.verb, next: args[found.index + 1] };
}

/**
 * Index and lowercased name of the git subcommand in `args` (the words
 * after `git`), skipping global options and their values: `-C dir`,
 * `-c k=v`, `--git-dir=x`, `--work-tree x`, `--no-pager`, `-P`.
 * `null` when there is no subcommand.
 */
export function findGitSubcommand(
  args: readonly string[],
): { verb: string; index: number } | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return { verb: arg.toLowerCase(), index: i };
  }
  return null;
}

/**
 * Refuse network git verbs through `os.shell.run` while the operator's
 * remote-sync switch is off. This is what makes the switch a promise
 * rather than a preference: the dedicated `os.git.*` tools honour it,
 * and so does the escape hatch. The verdict is `block`, not
 * `approval_required`, because an approval prompt at level 4 would go
 * silent and the repository would quietly leave the machine.
 */
export function buildGitRemotePolicyRule(policy: ShellGuardPolicy): Rule {
  return {
    id: "policy.git_remote_sync",
    layer: "policy",
    match(input) {
      if (input.cmd !== "git") return null;
      if (policy.isGitRemoteSyncEnabled()) return null;
      const sub = readGitSubcommand(input.args);
      if (!sub) return null;
      const blocked =
        NETWORK_VERBS.has(sub.verb) ||
        (sub.verb === "remote" &&
          sub.next !== undefined &&
          REMOTE_MUTATORS.has(sub.next.toLowerCase()));
      if (!blocked) return null;
      return {
        action: "block",
        rule: GIT_REMOTE_SYNC_OFF_RULE,
        reason: GIT_REMOTE_SYNC_OFF_REASON,
      };
    },
  };
}
