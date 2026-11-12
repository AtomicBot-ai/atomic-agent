/**
 * ATO-563 step 0: the lines of a unified diff, coloured by what they do.
 * The diff already reaches the terminal (an `os.fs.edit` approval's
 * preview, an edit card's result); this only decides each line's tone.
 * The desktop's twin is `desktop/renderer/diff-lines.js`.
 */

export type DiffLineTone = "add" | "del" | "hunk" | "file" | null;

/**
 * Is this text a unified diff? A file header pair (`--- ` then `+++ `) or
 * a hunk line, plus at least one added or removed line. Plain file content
 * (a Markdown list starts with `- `) is not coloured.
 */
export function looksLikeUnifiedDiff(text: string): boolean {
  const lines = text.split(/\r?\n/);
  let header = false;
  let change = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")) {
      header = true;
      i++;
      continue;
    }
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) header = true;
    else if (/^[+-]/.test(line)) change = true;
  }
  return header && change;
}

/** One line's tone inside a diff (call only when `looksLikeUnifiedDiff`). */
export function diffLineTone(line: string): DiffLineTone {
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return "file";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return null;
}

/** The ink colour for a tone, from the theme's own tokens; `fallback` for context lines. */
export function diffToneColor(
  tone: DiffLineTone,
  colors: { success: string; error: string; muted: string },
  fallback?: string,
): string | undefined {
  if (tone === "add") return colors.success;
  if (tone === "del") return colors.error;
  if (tone === "hunk" || tone === "file") return colors.muted;
  return fallback;
}
