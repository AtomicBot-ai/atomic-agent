export interface ParsedSlashCommand {
  readonly name: string;
  readonly args: string;
}

/**
 * Identify a slash command from a raw buffer. Returns `null` if the
 * buffer does not start with `/` or only contains whitespace — allowing
 * the caller to fall back to normal message submission.
 */
export function parseSlashCommand(raw: string): ParsedSlashCommand | null {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const firstSpace = body.search(/\s/);
  if (firstSpace === -1) {
    const name = body.trim().toLowerCase();
    if (name.length === 0) return null;
    return { name, args: "" };
  }
  return {
    name: body.slice(0, firstSpace).trim().toLowerCase(),
    args: body.slice(firstSpace + 1).trim(),
  };
}

/**
 * Detects "editor is currently typing a slash command" — used by the
 * parent to decide whether to open the autocomplete palette. Returns the
 * query after the leading `/` (may be empty when the user just typed
 * `/`).
 */
export function slashPrefix(raw: string): string | null {
  const leading = raw.trimStart();
  if (!leading.startsWith("/")) return null;
  const body = leading.slice(1);
  if (/\s/.test(body)) return null;
  return body;
}
