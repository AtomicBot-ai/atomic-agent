/**
 * Refuse a model-supplied git argument that git would read as an option
 * (ATO-2731).
 *
 * The `os.git.*` tools pass revisions, ranges, remote names and branch
 * names to git as separate argv entries. Git does not know they came
 * from a tool argument: a `revision` of `--output=/some/file` makes the
 * "read-only" `git show` / `git log` / `git diff` write a file, and a
 * `remote` of `--upload-pack=<program>` makes `git fetch` run a program.
 * The tool's read-only flag and its approval preview would both say
 * something harmless.
 *
 * So every such value is refused when it starts with `-`, for the owner
 * as well as for a channel guest (guests were already covered by
 * `read-scope/guest-reads.ts`). No real revision, range or ref starts
 * with `-`: `git check-ref-format` forbids it, and a range always starts
 * with a revision (or `^`). Leading whitespace is skipped before the
 * check so `" --output=x"` cannot slip past a later trim.
 *
 * Paths are not checked here: every tool that takes a path puts it
 * after `--`, where git reads nothing as an option.
 *
 * Rejecting instead of inserting `--end-of-options` keeps the tools
 * working with any git version (that flag needs git 2.24+) and gives the
 * model a clear error instead of git's "bad revision". Precedent: Git's
 * own advice for scripts, and the `git-checkout.ts` / `git-commit.ts`
 * checks in this folder, which already refuse a leading `-`.
 */

/** Throws when `value` would be parsed by git as an option. */
export function refuseOptionLike(
  tool: string,
  field: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  if (value.trimStart().startsWith("-")) {
    throw new Error(
      `${tool}: \`${field}\` must not start with '-' (git would read it as an option)`,
    );
  }
}
