import { Box, Text } from "ink";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useClipboard } from "../clipboard/clipboard-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { theme } from "../theme/theme.js";

interface ChatCopyButtonProps {
  /** Exactly the text that lands on the clipboard — no markdown, no borders. */
  readonly text: string;
  /** How long `copied!` stays up before the label reverts. */
  readonly revertAfterMs?: number;
}

/** Idle / just-copied / copy-was-refused. Drives the label and nothing else. */
type CopyStatus = "idle" | "copied" | "failed";

const DEFAULT_REVERT_MS = 2_000;

const LABELS: Readonly<Record<CopyStatus, string>> = {
  idle: "[copy]",
  copied: "[copied!]",
  failed: "[copy failed]",
};

/**
 * The per-message copy affordance in the chat log.
 *
 * **Why a button at all.** Mouse reporting takes the terminal's own
 * drag-to-select away (see `mouse-tracking.ts`), and "I want that reply
 * on my clipboard" is overwhelmingly the reason anyone selects text in a
 * chat TUI. A button answers that intent directly and, unlike a
 * selection, copies the message *source* — the raw text, not the
 * markdown-rendered, border-decorated, hard-wrapped thing on screen,
 * which is what a drag would have given you.
 *
 * **Why brackets and no colour.** `[copy]` in the palette's `muted`
 * grey, dimmed, is the quietest thing that still reads as a control.
 * There is one of these under every message; anything with hue would
 * turn the transcript into a column of badges. "Dark grey" is expressed
 * as a theme token rather than a literal because the four light palettes
 * would swallow a literal `#555` whole — `muted` + `dimColor` is the
 * darkest grey each palette actually has.
 *
 * **Without a mouse provider** (component tests, `--no-mouse`) the
 * button still renders — it is a legible hint that the message has a
 * copy affordance when the mouse is on — but registers no target.
 */
export function ChatCopyButton({
  text,
  revertAfterMs = DEFAULT_REVERT_MS,
}: ChatCopyButtonProps): ReactElement {
  const clipboard = useClipboard();
  const mouse = useMouseCommands();
  const [status, setStatus] = useState<CopyStatus>("idle");
  // Both refs exist to survive re-renders, which happen constantly here:
  // every streamed token repaints the whole chat log. A timer id in
  // component state would be replaced mid-flight and the old timeout
  // would fire against a stale closure, stranding the label.
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, []);

  const flash = useCallback(
    (next: CopyStatus) => {
      if (!mountedRef.current) return;
      setStatus(next);
      // Restart rather than stack: a second click while `copied!` is up
      // must extend the badge, not leave an older timeout to clear it
      // early and blink the label back mid-feedback.
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (mountedRef.current) setStatus("idle");
      }, revertAfterMs);
    },
    [revertAfterMs],
  );

  const copy = useCallback(() => {
    // Fire-and-forget: the click handler runs outside React's render
    // pass and the clipboard write can outlive the frame. `flash` is the
    // only thing that touches state, and it checks `mountedRef` first.
    void clipboard
      .copy(text)
      .then((ok) => flash(ok ? "copied" : "failed"))
      .catch(() => flash("failed"));
  }, [clipboard, text, flash]);

  const label = (
    <Text color={theme.colors.muted} dimColor={status === "idle"}>
      {LABELS[status]}
    </Text>
  );

  // A row wrapper, not a column child: in a column Yoga stretches the
  // target to the full chat width and every click on the line would
  // copy. In a row it hugs the six cells the label actually occupies.
  return (
    <Box marginLeft={3} flexDirection="row">
      {mouse ? (
        <MouseTarget
          flexShrink={0}
          onMouse={(hit) => {
            if (!isPrimaryPress(hit.event)) return false;
            copy();
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
