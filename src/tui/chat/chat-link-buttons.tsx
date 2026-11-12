import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Box, Text } from "ink";
import { type ReactElement, useMemo } from "react";
import { useTransientStatus } from "../hooks/use-transient-status.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { splitUrlSegments } from "../render/linkify-text.js";
import { theme } from "../theme/theme.js";
import type { ToolCardEntry } from "../tui-state.js";

interface ChatLinkButtonsProps {
  /**
   * The message source. URLs are re-detected here with the same
   * detector the bubbles render with, so a chip exists exactly for the
   * text that shows as a link.
   */
  readonly text: string;
  /**
   * The message's tool cards. An ok `canvas.render` card carries the
   * page it wrote in `details.canvas` (ATO-1137) even when the reply
   * never repeats the path, so its chip comes from here.
   */
  readonly toolCards?: readonly ToolCardEntry[];
  /** How long `[opening…]` stays up before the label reverts. */
  readonly revertAfterMs?: number;
  /**
   * Whether a path is a regular file, for the local `.html` chips.
   * Injectable for the tests; defaults to a `stat` of the real disk.
   */
  readonly isFile?: (path: string) => boolean;
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

/** A local page a browser opens: `.html` / `.htm`, any case. */
const LOCAL_HTML = /\.html?$/i;

/** Characters that end a path token in prose, markdown and code spans. */
const PATH_DELIMITERS = /[\s`'"()<>[\]{}]+/;

/** Trailing sentence punctuation that is not part of a path. */
const PATH_TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The local `.html` files a message names (ATO-1139): an absolute path,
 * a `~/` path, a path relative to the working folder, or a `file://`
 * link — whatever exists on disk as a regular file. This is how an
 * artifact the agent wrote (a canvas page, a report) gets an `[open in
 * browser]` chip. Web URLs are left to {@link extractMessageUrls}; a
 * path that does not exist gets no chip, so the button never promises
 * a page that is not there.
 */
export function extractLocalHtmlFiles(
  text: string,
  workingDir: string,
  isFile: (path: string) => boolean = defaultIsFile,
): readonly string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const raw of text.split(PATH_DELIMITERS)) {
    const token = raw.replace(PATH_TRAILING_PUNCTUATION, "");
    if (!LOCAL_HTML.test(token)) continue;
    let path: string | null;
    if (token.toLowerCase().startsWith("file://")) {
      try {
        path = fileURLToPath(token);
      } catch {
        path = null;
      }
    } else if (token.includes("://")) {
      path = null;
    } else if (token.startsWith("~/")) {
      path = resolve(homedir(), token.slice(2));
    } else {
      path = isAbsolute(token) ? token : resolve(workingDir, token);
    }
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    if (isFile(path)) files.push(path);
  }
  return files;
}

/** A page the chat can open: its absolute path, and its title if known. */
export interface LocalPage {
  readonly path: string;
  readonly title?: string;
}

/**
 * The pages `canvas.render` wrote in this message (ATO-1137 / ATO-1139),
 * read from its ok cards' `details.canvas = { path, title, … }`. Read
 * defensively: `details` is untyped, and an older or newer tool shape
 * simply yields nothing.
 */
export function canvasPagesFromToolCards(
  cards: readonly ToolCardEntry[] | undefined,
): readonly LocalPage[] {
  const pages: LocalPage[] = [];
  for (const card of cards ?? []) {
    if (card.tool !== "canvas.render" || card.status !== "ok") continue;
    const canvas = card.details?.["canvas"];
    if (typeof canvas !== "object" || canvas === null) continue;
    const { path, title } = canvas as { path?: unknown; title?: unknown };
    if (typeof path !== "string" || !isAbsolute(path) || !LOCAL_HTML.test(path)) {
      continue;
    }
    pages.push(
      typeof title === "string" && title.trim().length > 0
        ? { path, title: title.trim() }
        : { path },
    );
  }
  return pages;
}

/**
 * The label of a local page's chip. One page in the message: `[open in
 * browser]`, the message already says which. Several: each chip names
 * its file, ellipsised like a hostname.
 */
export function localFileChipLabel(
  path: string,
  many: boolean,
  title?: string,
): string {
  // A canvas names itself; its title is the better label when it fits.
  if (title !== undefined && title.length <= MAX_LABEL_CHARS) {
    return `open ${title} in browser`;
  }
  if (!many) return "open in browser";
  const name = basename(path);
  const short =
    name.length <= MAX_LABEL_CHARS
      ? name
      : `${name.slice(0, MAX_LABEL_CHARS - 1)}…`;
  return `open ${short} in browser`;
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
  toolCards,
  revertAfterMs = DEFAULT_REVERT_MS,
  isFile = defaultIsFile,
}: ChatLinkButtonsProps): ReactElement | null {
  const mouse = useMouseCommands();
  const workingDir = mouse?.getState().session.workingDir ?? process.cwd();
  // Memoised: a finalised message re-renders on every chat repaint, and
  // the file check is a `stat` per candidate path.
  const files = useMemo((): readonly LocalPage[] => {
    const pages = [...canvasPagesFromToolCards(toolCards)].filter((page) =>
      isFile(page.path),
    );
    const seen = new Set(pages.map((page) => page.path));
    for (const path of extractLocalHtmlFiles(text, workingDir, isFile)) {
      if (seen.has(path)) continue;
      seen.add(path);
      pages.push({ path });
    }
    return pages;
  }, [text, toolCards, workingDir, isFile]);
  const urls = extractMessageUrls(text);
  if (urls.length === 0 && files.length === 0) return null;
  // Local pages first — an artifact the agent just made is the likelier
  // click — then web links, under one cap for the single footer row.
  const shownFiles = files.slice(0, MAX_LINK_CHIPS);
  const shown = urls.slice(0, MAX_LINK_CHIPS - shownFiles.length);
  const hidden = files.length + urls.length - shownFiles.length - shown.length;
  return (
    <Box flexDirection="row">
      {shownFiles.map((page) => (
        <LinkChip
          key={page.path}
          url={page.path}
          label={localFileChipLabel(page.path, files.length > 1, page.title)}
          local
          revertAfterMs={revertAfterMs}
        />
      ))}
      {shown.map((url) => (
        <LinkChip
          key={url}
          url={url}
          label={`open ${linkChipLabel(url)}`}
          revertAfterMs={revertAfterMs}
        />
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
  label: idleLabel,
  local = false,
  revertAfterMs,
}: {
  /** The web URL, or the absolute path of a local page when `local`. */
  readonly url: string;
  /** The idle text inside the brackets. */
  readonly label: string;
  readonly local?: boolean;
  readonly revertAfterMs: number;
}): ReactElement {
  const mouse = useMouseCommands();
  const [status, flash] = useTransientStatus<OpenStatus>("idle", revertAfterMs);

  const label = (
    <Text color={theme.colors.muted} dimColor={status === "idle"}>
      {status === "idle" ? `[${idleLabel}]` : "[opening…]"}
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
            if (local) mouse.callbacks.onOpenLocalFileRequested?.(url);
            else mouse.callbacks.onOpenUrlRequested?.(url);
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
