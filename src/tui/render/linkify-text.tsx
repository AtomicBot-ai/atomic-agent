import { Text } from "ink";
import { Fragment, type ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { wrapOsc8 } from "./osc8-link.js";

/**
 * One slice of a plain-text string: either inert text (`url: null`) or a
 * detected `http(s)://` URL that should render as a clickable hyperlink.
 */
export interface UrlSegment {
  /** Visible text of the segment. */
  text: string;
  /** Non-null when the segment is a clickable URL. */
  url: string | null;
}

const URL_PATTERN = /https?:\/\/[^\s]+/g;
// Punctuation that commonly trails a URL in prose ("see https://x.io.")
// but is not part of the link itself. Trimmed back into a plain segment so
// the terminal's own URL detector (Terminal.app) and the OSC 8 target both
// stay clean.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>"'»]+$/;

/**
 * Splits a plain-text string into ordered segments, isolating `http(s)://`
 * URLs from surrounding prose. Pure function — no React, no Ink — so it is
 * trivially unit-testable. The URL text is preserved verbatim as the visible
 * label (label === url), which keeps links clickable even in terminals that
 * do not support OSC 8 (Terminal.app), since those rely on detecting the raw
 * URL text on screen.
 */
export function splitUrlSegments(text: string): UrlSegment[] {
  if (text.length === 0) return [];
  const segments: UrlSegment[] = [];
  const re = new RegExp(URL_PATTERN.source, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    let url = match[0];
    let trailing = "";
    const trimMatch = TRAILING_PUNCTUATION.exec(url);
    if (trimMatch) {
      trailing = url.slice(trimMatch.index);
      url = url.slice(0, trimMatch.index);
    }
    const start = match.index;
    if (start > lastIndex) {
      segments.push({ text: text.slice(lastIndex, start), url: null });
    }
    if (url.length > 0) {
      segments.push({ text: url, url });
    }
    if (trailing.length > 0) {
      segments.push({ text: trailing, url: null });
    }
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), url: null });
  }
  return segments;
}

/**
 * Renders a single line of plain text with any `http(s)://` URL wrapped as a
 * clickable OSC 8 hyperlink. Designed to be used as inline children of an
 * outer `<Text>` (so the caller controls the base colour); the URL slices
 * override the colour with `info` + underline to read as links.
 */
export function LinkifiedText({ text }: { text: string }): ReactElement {
  const segments = splitUrlSegments(text);
  if (segments.length === 0) return <Fragment>{text}</Fragment>;
  return (
    <Fragment>
      {segments.map((segment, idx) =>
        segment.url === null ? (
          <Fragment key={idx}>{segment.text}</Fragment>
        ) : (
          <Text key={idx} color={theme.colors.info} underline>
            {wrapOsc8(segment.text, segment.url)}
          </Text>
        ),
      )}
    </Fragment>
  );
}
