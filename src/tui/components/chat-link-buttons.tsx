import { Box, Text } from "ink";
import { type ReactElement } from "react";
import { useTransientStatus } from "../hooks/use-transient-status.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { splitUrlSegments } from "../render/linkify-text.js";
import { theme } from "../theme/theme.js";

interface ChatLinkButtonsProps {
  /**
   * The message source. URLs are re-detected here with the same
   * detector the bubbles render with, so a chip exists exactly for the
   * text that shows as a link.
   */
  readonly text: string;
  /** How long `[opening…]` stays up before the label reverts. */
  readonly revertAfterMs?: number;
}

/** Idle / just-fired. The badge doubles as the double-click guard. */
type OpenStatus = "idle" | "opening";

const DEFAULT_REVERT_MS = 2_000;

/**
 * At most this many chips per message. The footer is a single row that
 * already carries `[copy]` (and `[try again]` on user messages), and a
 * reply quoting a dozen references would otherwise push chips past the
 * terminal's right edge, where Yoga clips them into unclickable
 * half-labels. The first three URLs win — they are the ones the author
 * led with — and the remainder is summed up in a muted `+N more` note
 * so the cap is visible rather than silent. The in-text OSC 8 links
 * still cover every URL on terminals that support them.
 */
const MAX_LINK_CHIPS = 3;

/**
 * Hostnames longer than this ellipsise mid-label. Long enough for any
 * mainstream host, short enough that three chips fit an 80-column row.
 */
const MAX_LABEL_CHARS = 24;

/**
 * The ordered, deduped, normalised URL targets of a message. Dedupe is
 * on the exact normalised href — `https://a.io` and `https://a.io/` are
 * two entries, which is the honest reading of a message that spells
 * them differently.
 */
export function extractMessageUrls(text: string): readonly string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const segment of splitUrlSegments(text)) {
    if (segment.url === null || seen.has(segment.url)) continue;
    seen.add(segment.url);
    urls.push(segment.url);
  }
  return urls;
}

/**
 * The chip's label: the hostname alone, `www.` shorn — `[open
 * example.com]` says where a click lands without repeating the URL the
 * message just showed. Falls back to the raw text for a target the URL
 * parser refuses (unreachable for detector output, but a label function
 * must not throw).
 */
export function linkChipLabel(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    host = url;
  }
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  if (bare.length <= MAX_LABEL_CHARS) return bare;
  return `${bare.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

/**
 * The per-message "open that in the browser" affordance, beside
 * `[copy]`.
 *
 * **Why a chip when the URL text is already an OSC 8 link.** OSC 8 is a
 * terminal feature, and plenty of terminals — including the stock
 * macOS Terminal.app — ignore it entirely: the styled URL looks
 * clickable and does nothing. These chips route through the app's own
 * mouse layer instead, the same machinery `[copy]` rides, so one click
 * opens the default browser in *every* terminal the TUI runs in. The
 * in-text links stay for the terminals that do support them.
 *
 * **Why the badge.** The browser can take a beat to front itself, and a
 * click with no feedback reads as a dead button and gets clicked again
 * — two tabs for one intent. `[opening…]` closes the gap and, as with
 * `[try again]`, ignores clicks while up so a double-press cannot fire
 * twice.
 *
 * **Without a mouse provider** (component tests, `--no-mouse`) the
 * chips still render as legible hints but register no targets — the
 * same degradation as `ChatCopyButton`.
 */
export function ChatLinkButtons({
  text,
  revertAfterMs = DEFAULT_REVERT_MS,
}: ChatLinkButtonsProps): ReactElement | null {
  const urls = extractMessageUrls(text);
  if (urls.length === 0) return null;
  const shown = urls.slice(0, MAX_LINK_CHIPS);
  const hidden = urls.length - shown.length;
  return (
    <Box flexDirection="row">
      {shown.map((url) => (
        <LinkChip key={url} url={url} revertAfterMs={revertAfterMs} />
      ))}
      {hidden > 0 ? (
        <Box marginLeft={1} flexShrink={0}>
          <Text color={theme.colors.muted} dimColor>
            +{hidden} more
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function LinkChip({
  url,
  revertAfterMs,
}: {
  readonly url: string;
  readonly revertAfterMs: number;
}): ReactElement {
  const mouse = useMouseCommands();
  const [status, flash] = useTransientStatus<OpenStatus>(
    "idle",
    revertAfterMs,
  );

  const label = (
    <Text color={theme.colors.muted} dimColor={status === "idle"}>
      {status === "idle" ? `[open ${linkChipLabel(url)}]` : "[opening…]"}
    </Text>
  );

  // One space off the previous chip, on the same row — the footer stays
  // a single line whatever the role, so `estimateMessageHeight` does
  // not have to branch (see `ChatTryAgainButton` for why an under-count
  // is not merely cosmetic in Ink 7).
  return (
    <Box marginLeft={1} flexDirection="row">
      {mouse ? (
        <MouseTarget
          flexShrink={0}
          onMouse={(hit) => {
            if (!isPrimaryPress(hit.event)) return false;
            // Claim the press either way — the click landed on this
            // chip, and letting it fall through would hand it to the
            // viewport wheel target behind the chat log.
            if (status !== "idle") return true;
            mouse.callbacks.onOpenUrlRequested?.(url);
            flash("opening");
            return true;
          }}
        >
          {label}
        </MouseTarget>
      ) : (
        label
      )}
    </Box>
  );
}
