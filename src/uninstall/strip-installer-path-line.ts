/**
 * The comment `install.sh` writes above the PATH line it appends. The
 * two strings have to stay identical; there is no way to share them
 * across a shell script and a TypeScript module, so the test asserts
 * the marker is still present in `scripts/install.sh`.
 */
export const INSTALLER_PATH_MARKER = "# added by atomic-agent installer";

export interface StripResult {
  readonly content: string;
  /** Whether anything was removed — drives "PATH entry removed" output. */
  readonly changed: boolean;
}

/**
 * Remove the installer's PATH stanza from an rc file's contents.
 *
 * The installer appends exactly two lines — the marker, then one
 * `export PATH=…` / `set -gx PATH …` — preceded by a blank line. This
 * takes the marker, the line under it, and one blank line above if the
 * installer put it there, and leaves every other byte of the operator's
 * rc file untouched. Anything else (a hand-edited line, a second copy
 * with a different marker) is theirs, and we do not guess at it.
 */
export function stripInstallerPathLine(content: string): StripResult {
  const lines = content.split("\n");
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.trim() !== INSTALLER_PATH_MARKER) {
      out.push(lines[i] ?? "");
      continue;
    }
    changed = true;
    // Drop the blank line the installer printed before the marker, but
    // only one, and only if it is blank — otherwise we would eat a
    // deliberate separator between two unrelated stanzas.
    if (out.length > 0 && out[out.length - 1]?.trim() === "") out.pop();
    // Skip the marker and the PATH line it introduces.
    i += 1;
  }
  return { content: out.join("\n"), changed };
}
