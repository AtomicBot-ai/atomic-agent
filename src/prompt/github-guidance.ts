/**
 * The GitHub half of the `### integrations` section of the stable prefix.
 *
 * Same reasoning as `composio-guidance.ts`: a catalog line that says
 * `github.pr.create` exists does not tell the model that "push this and
 * open a PR" is a two-tool job, or that the branch has to be pushed
 * before the PR can point at it. Two sentences here are the difference
 * between the model reaching for `os.shell.run gh pr create` (which
 * works, but bypasses the structured preview the approval prompt
 * shows) and the tools built for it.
 *
 * Present only while the hub holds a token — `github.*` descriptors
 * are filtered out otherwise (`filter-disabled-tools.ts`), so an
 * install with no GitHub pays nothing for this and its prefix is
 * byte-identical to before the integration existed.
 */

import type { ToolDescriptor } from "./stable-prefix.js";

/** Any `github.*` descriptor in the catalog means the hub is connected. */
export const GITHUB_MARKER_TOOL = "github.whoami";

export function isGithubActive(
  descriptors: readonly ToolDescriptor[],
): boolean {
  return descriptors.some((d) => d.name === GITHUB_MARKER_TOOL);
}

export const GITHUB_GUIDANCE = [
  "GitHub is connected: `os.git.checkout` / `os.git.commit` / `os.git.push` change branches, commit and push; `github.pr.create`, `github.issue.create` and `github.issue.comment` publish under the user's account; `github.pr.list` / `github.issue.list` / `github.whoami` read.",
  "To open a pull request: commit, push the branch with `os.git.push`, then call `github.pr.create` — `repo`, `head` and `base` default to the working directory's origin, current branch and the repo's default branch. Never force-push; ask the user instead.",
].join("\n");
