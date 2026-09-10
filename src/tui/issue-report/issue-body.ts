/**
 * Turn report sections into what GitHub will accept.
 *
 * An issue body and a comment are each capped at 65,536 characters.
 * A report with traces is routinely larger, so the sections are packed
 * greedily: the first page becomes the issue body, each further page a
 * follow-up comment, and a section that would not fit even alone is
 * cut with a marker rather than dropped — a truncated log with a note
 * beats a missing one. Everything past `maxPages` stays in the zip the
 * operator was shown before sending; the last page says so.
 */

import { GITHUB_BODY_LIMIT } from "../../github/index.js";

export interface ReportSection {
  title: string;
  /** Rendered inside a fenced block when `fenced` is set. */
  body: string;
  fenced?: boolean;
  /** Language tag for the fence, e.g. `json`, `text`. */
  lang?: string;
  /** Wrap in `<details>` so a long section does not bury the summary. */
  collapsed?: boolean;
}

export interface PackedIssue {
  body: string;
  comments: string[];
  /** Sections that did not fit into the page budget. */
  overflow: string[];
}

export interface PackOptions {
  /** Body + comment character cap; GitHub's is the default. */
  limit?: number;
  /** Body plus this many comments; the rest is left in the zip. */
  maxComments?: number;
  /** Line appended to the final page when sections overflowed. */
  overflowNote?: string;
}

const CUT_MARKER = "\n… [cut — the rest is in the attached zip]\n";
const NOTE_RESERVE = 400;

export function renderSection(section: ReportSection): string {
  const content = section.fenced
    ? `\`\`\`${section.lang ?? ""}\n${section.body.replace(/```/g, "` ` `")}\n\`\`\``
    : section.body;
  if (section.collapsed) {
    return `<details>\n<summary>${section.title}</summary>\n\n${content}\n\n</details>`;
  }
  return `### ${section.title}\n\n${content}`;
}

/**
 * Pack rendered sections into pages of at most `limit` characters.
 * `header` always opens the body page and is never cut.
 */
export function packIssue(
  header: string,
  sections: readonly ReportSection[],
  options: PackOptions = {},
): PackedIssue {
  const limit = options.limit ?? GITHUB_BODY_LIMIT;
  const maxComments = options.maxComments ?? 3;
  // Room kept on every page for the overflow note, so it always fits
  // on the last one — including a page that is a cut section.
  const reserve = Math.min(NOTE_RESERVE, Math.floor(limit / 10));
  const pageLimit = limit - reserve;
  const pages: string[] = [];
  const overflow: string[] = [];
  let current = header.trimEnd();
  const pageOpen = (): boolean => pages.length <= maxComments;

  for (const section of sections) {
    // Every page is spent and nothing is open: the rest is zip-only.
    if (current.length === 0 && !pageOpen()) {
      overflow.push(section.title);
      continue;
    }
    let rendered = renderSection(section);
    const separator = current.length > 0 ? "\n\n" : "";
    if (current.length + separator.length + rendered.length <= pageLimit) {
      current = `${current}${separator}${rendered}`;
      continue;
    }
    // The body page holds the header and at least the start of the
    // first section: a body that is only a header, with the first
    // section pushed to a comment or the zip, reads as an empty report.
    if (pages.length === 0 && current === header.trimEnd()) {
      const room = pageLimit - current.length - separator.length;
      // Only when a cut fragment has something to show; a header that
      // fills the page on its own keeps the section for the next one.
      const minRoom =
        renderSection({ ...section, body: CUT_MARKER }).length + 16;
      if (room >= minRoom) {
        current = `${current}${separator}${cutSection(section, room)}`;
        continue;
      }
    }
    // Start a new page for it, if the budget allows one.
    if (current.length > 0) {
      pages.push(current);
      current = "";
    }
    if (!pageOpen()) {
      overflow.push(section.title);
      continue;
    }
    if (rendered.length > pageLimit) {
      rendered = cutSection(section, pageLimit);
    }
    current = rendered;
  }
  if (current.length > 0) {
    if (pageOpen()) pages.push(current);
    else overflow.push("(remaining sections)");
  }
  if (overflow.length > 0 && pages.length > 0) {
    const note =
      options.overflowNote ??
      `_Not included inline (over GitHub's size limit): ${overflow.join(", ")} — see the attached zip._`;
    const last = pages.length - 1;
    const withNote = `${pages[last]}\n\n${note}`;
    // The reserve covers the note at GitHub's limit; at a tiny limit the
    // titles alone can exceed it, so fall back to a note without them.
    const short = `${pages[last]}\n\n_More sections in the attached zip._`;
    pages[last] =
      withNote.length <= limit
        ? withNote
        : short.length <= limit
          ? short
          : pages[last]!;
  }
  const [body = header, ...comments] = pages;
  return { body, comments, overflow };
}

/**
 * Cut a section's body so its rendering fits `limit`, keeping the
 * *end* of the text: for a log or a trace the last lines are the ones
 * nearest the failure.
 */
function cutSection(section: ReportSection, limit: number): string {
  const envelope = renderSection({ ...section, body: "" }).length;
  const room = Math.max(0, limit - envelope - CUT_MARKER.length - 8);
  const body = section.body;
  const tail = body.slice(body.length - room);
  // Start on a line boundary so a half JSON row is not the first thing
  // seen; trace rows run long, so no cap on how far the first break is.
  const nl = tail.indexOf("\n");
  const clean = nl >= 0 ? tail.slice(nl + 1) : tail;
  return renderSection({ ...section, body: `${CUT_MARKER}${clean}` });
}
