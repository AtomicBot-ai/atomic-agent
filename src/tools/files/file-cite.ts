import { basename } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The citation a `files.search` hit carries, pasted by the model as is.
 * A plain markdown link with a `file://` URL and a standard fragment, so a
 * terminal shows a clickable file link and the desktop (ATO-1628) can
 * draw a chip that opens the right page:
 *
 *   - PDF page: `[report.pdf, p. 12](file:///Users/me/Docs/report.pdf#page=12)`
 *     (the PDF open-parameters fragment)
 *   - audio/video time: `[call.m4a, 1:23](file:///Users/me/Audio/call.m4a#t=83)`
 *     (seconds, media-fragments `#t=`)
 *   - anything else: `[notes.md](file:///Users/me/Docs/notes.md)`
 *
 * The path is percent-encoded per RFC 8089 (`pathToFileURL`: spaces are
 * `%20`, `#` and `?` are escaped). Parentheses and square brackets are
 * escaped too: a raw `)` would end the markdown link early.
 */
export interface CiteTarget {
  path: string;
  page?: number;
  timeSec?: number;
}

/** `file://` URL for an absolute path, safe inside a markdown link. */
export function fileUrlFor(path: string): string {
  return pathToFileURL(path)
    .href.replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D");
}

/** `83` → `1:23`, `3723` → `1:02:03`. */
export function formatTimestamp(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours === 0) return `${minutes}:${ss}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
}

/** The markdown link for one hit. */
export function citeFor(target: CiteTarget): string {
  const name = escapeLabel(basename(target.path));
  const url = fileUrlFor(target.path);
  if (target.page !== undefined && Number.isInteger(target.page) && target.page > 0) {
    return `[${name}, p. ${target.page}](${url}#page=${target.page})`;
  }
  if (target.timeSec !== undefined && Number.isFinite(target.timeSec) && target.timeSec >= 0) {
    const seconds = Math.floor(target.timeSec);
    return `[${name}, ${formatTimestamp(seconds)}](${url}#t=${seconds})`;
  }
  return `[${name}](${url})`;
}

/** Brackets and backslashes in a file name would break the link text. */
function escapeLabel(name: string): string {
  return name.replace(/[\\[\]]/g, (char) => `\\${char}`);
}
