import { Text } from "ink";
import { Fragment, type ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { wrapOsc8 } from "./osc8-link.js";

/**
 * One slice of a plain-text string: either inert text (`url: null`) or a
 * detected URL that should render as a clickable hyperlink.
 */
export interface UrlSegment {
  /** Visible text of the segment — exactly as the author typed it. */
  text: string;
  /**
   * Non-null when the segment is a clickable URL: the normalised
   * `http(s)://` target (see {@link hrefFor}). Differs from `text` for
   * scheme-less `www.` matches, where the visible label keeps the bare
   * form but everything that *opens* the URL needs a real scheme.
   */
  url: string | null;
}

// `https?://` anywhere, plus scheme-less `www.` hosts — people type
// `www.example.com` far more often than they type the scheme. The
// lookbehind keeps mid-word runs from firing (`awww.cute` is not a
// link, and the `www.` inside `api.www.host` belongs to the larger
// hostname); it also stops a glued `xhttps://` from matching.
const URL_PATTERN = /(?<![\w.])(?:https?:\/\/|www\.)[^\s]+/g;
// Punctuation that commonly trails a URL in prose ("see https://x.io.")
// but is not part of the link itself. Trimmed back into a plain segment so
// the terminal's own URL detector (Terminal.app) and the OSC 8 target both
// stay clean.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>"'»]+$/;
// What must survive the punctuation trim to still count as a URL: the
// prefix plus at least one character of target. A trailing-punctuation
// run can eat a match down to a bare `www` or `https://`, and those are
// prose, not links.
const MINIMAL_URL = /^(?:https?:\/\/|www\.)[^\s]/;

/**
 * Normalises a detected URL into an openable target: a match without a
 * scheme (`www.example.com`) gets `https://` prefixed, a scheme'd match
 * passes through untouched. The visible text always stays as typed —
 * only OSC 8 hrefs and anything that hands the URL to a browser go
 * through here. Every consumer of the shared detector must use this
 * rather than the raw match, or a bare `www.` target opens nothing.
 */
export function hrefFor(urlText: string): string {
  // The pattern above admits exactly two shapes, so a missing scheme
  // is precisely the `www.` one.
  return urlText.startsWith("www.") ? `https://${urlText}` : urlText;
}

/**
 * Splits a plain-text string into ordered segments, isolating URLs
 * (`http(s)://` and bare `www.` hosts) from surrounding prose. Pure
 * function — no React, no Ink — so it is trivially unit-testable. The
 * URL text is preserved verbatim as the visible label, which keeps links
 * clickable even in terminals that do not support OSC 8 (Terminal.app),
 * since those rely on detecting the raw URL text on screen; the `url`
 * field carries the normalised target for OSC 8 and the open-in-browser
 * chips.
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
      segments.push({
        text: url,
        url: MINIMAL_URL.test(url) ? hrefFor(url) : null,
      });
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
 * Renders a single line of plain text with any detected URL (scheme'd or
 * bare `www.`) wrapped as a clickable OSC 8 hyperlink whose target is the
 * normalised href. Designed to be used as inline children of an outer
 * `<Text>` (so the caller controls the base colour); the URL slices
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
