/**
 * ATO-2532: the global options in front of every git call the desktop
 * main process makes in a folder it did not create (the chat folder, a
 * project folder, a worker worktree).
 *
 * A folder's own `.git/config` can name programs git runs on its own:
 * `core.fsmonitor` (run by status, diff and ls-files to refresh the
 * index), hooks under `core.hooksPath` or `.git/hooks` (post-checkout on
 * `worktree add`), and `log.showSignature`, which makes `git log` run
 * `gpg.program`. Opening someone else's repository in a chat must not
 * run any of them. So every call starts with:
 *
 *  - `--no-pager`: git never starts `core.pager`;
 *  - `--no-optional-locks`: a read does not rewrite the index (and so
 *    fires no `post-index-change` hook);
 *  - `core.fsmonitor=false`, `core.untrackedCache=false`;
 *  - `core.hooksPath=<null>`: no hook is found. `/dev/null` on macOS and
 *    Linux; `NUL` on Windows, where the hooks folder becomes `NUL\<hook>`,
 *    a folder Windows refuses to create, so the lookup finds nothing
 *    whatever folder git resolves it from;
 *  - `log.showSignature=false`: no `gpg.program` on `git log`;
 *  - `protocol.ext.allow=never`: no `ext::` remote helper command, in
 *    case a call ever reaches a submodule or remote;
 *  - `diff.submodule=short`: a repo's `diff.submodule=diff` would make
 *    a diff or `log -p` start a child `git diff` inside a changed
 *    submodule, where `--no-ext-diff` does not reach and the submodule's
 *    own `diff.external` runs (review round 2, R2-1979.A).
 *
 * Diff calls add `--no-ext-diff --no-textconv --submodule=short` themselves
 * (mention-git.ts). The system config (`GIT_CONFIG_NOSYSTEM`) is left
 * alone: it belongs to the machine's admin, not to the folder.
 *
 * Precedent: VS Code's Git extension and GitHub Desktop turn off the
 * fsmonitor and optional locks for background calls; the agent core does
 * the same for fetched plugin repositories (src/plugins/marketplace-fetch.ts).
 */

/** The "no folder" path for `core.hooksPath` on this platform. */
export function gitNullPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "NUL" : "/dev/null";
}

/** Options to put before the git subcommand (they are global options). */
export function gitSafeArgs(platform: NodeJS.Platform = process.platform): string[] {
  return [
    "--no-pager",
    "--no-optional-locks",
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-c", `core.hooksPath=${gitNullPath(platform)}`,
    "-c", "log.showSignature=false",
    "-c", "protocol.ext.allow=never",
    "-c", "diff.submodule=short",
  ];
}
