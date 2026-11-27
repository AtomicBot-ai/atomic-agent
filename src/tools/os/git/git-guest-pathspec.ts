import {
  MCP_SECRET_HOME_PATHS,
  SECRET_HOME_PATHS,
} from "../../../sandbox/os-sandbox.js";

/**
 * What a channel guest's `os.git.show` / `os.git.diff` leave out of a
 * patch (ATO-2732).
 *
 * `read-scope/guest-reads.ts` refuses a guest's direct read of a `.env`
 * file or a credential folder, but a whole-commit `git show HEAD` or a
 * plain `git diff` names no path: git prints every changed file, so a
 * `.env` committed inside the working directory reached the guest. For
 * a guest call the tools therefore append these exclude pathspecs after
 * `--`. They mirror the guest read rules: `.env`, `.env.*` and `.envrc`
 * in any folder and any case, and the credential files and folders of
 * `SECRET_HOME_PATHS` / `MCP_SECRET_HOME_PATHS` wherever they sit in the
 * repository (a working directory may be the home folder itself).
 * A pathspec made only of excludes still matches every other file
 * (git 2.13+). The owner's calls are unchanged.
 *
 * Precedent: Claude Code denies reads of `.env` whatever the mode, and
 * GitHub's secret scanning treats the same files as secrets; a guest
 * here is a stranger in a group chat.
 */

const EXCLUDE = ":(exclude,glob,icase)";

function excludeEverywhere(path: string): string[] {
  return [`${EXCLUDE}**/${path}`, `${EXCLUDE}**/${path}/**`];
}

const ENV_FILE_EXCLUDES: readonly string[] = [
  `${EXCLUDE}**/.env`,
  `${EXCLUDE}**/.env.*`,
  `${EXCLUDE}**/.envrc`,
];

/** The exclude pathspecs for a guest's patch, in a stable order. */
export const GUEST_SECRET_EXCLUDES: readonly string[] = [
  ...ENV_FILE_EXCLUDES,
  ...[...new Set([...SECRET_HOME_PATHS, ...MCP_SECRET_HOME_PATHS])].flatMap(
    excludeEverywhere,
  ),
];

/**
 * A guest's revision or range with each side peeled to a commit
 * (`X^{commit}`). A pathspec filters a commit's patch but not a blob, so
 * `git show <blob id of .env>` or `git diff <blob>..<blob>` would print
 * the file whatever the excludes say. Peeling makes git refuse a blob or
 * tree instead. `A..B`, `A...B`, `A..` and `^A` keep their meaning.
 */
export function guestCommitRevision(revision: string): string {
  const parts = revision.split(/(\.\.\.?)/);
  return parts
    .map((part, i) => (i % 2 === 1 || part.length === 0 ? part : `${part}^{commit}`))
    .join("");
}
