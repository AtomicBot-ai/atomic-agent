import { Box, Text } from "ink";
import { useCallback, type ReactElement } from "react";
import { useClipboard } from "../clipboard/clipboard-context.js";
import { useTransientStatus } from "../hooks/use-transient-status.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { theme } from "../theme/theme.js";

/**
 * Single-file tools whose card gets a `[copy path]` chip. Each takes
 * the file as a plain string `path` argument, so the chip copies
 * exactly what the agent asked for. Multi-path tools (patch, move,
 * trash, diff) are left for a later slice: one chip cannot say which
 * of several files it would copy.
 */
const SINGLE_PATH_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.read",
  "os.fs.write",
  "os.fs.edit",
]);

/**
 * The file a finished tool card is about, or `null` when the card has
 * no single file to offer. Pure, so the "which cards get a chip"
 * decision is testable without rendering.
 */
export function toolCardFilePath(card: {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}): string | null {
  if (!SINGLE_PATH_TOOLS.has(card.tool)) return null;
  const raw = card.args["path"];
  if (typeof raw !== "string") return null;
  const path = raw.trim();
  return path.length > 0 ? path : null;
}

type CopyStatus = "idle" | "copied" | "failed";

const DEFAULT_REVERT_MS = 2_000;

const LABELS: Readonly<Record<CopyStatus, string>> = {
  idle: "[copy path]",
  copied: "[copied!]",
  failed: "[copy failed]",
};

interface ToolCardPathChipProps {
  /** Exactly the text that lands on the clipboard. */
  readonly path: string;
  readonly revertAfterMs?: number;
}

/**
 * `[copy path]` beside a finished read / write / edit card header: one
 * click puts the file path on the clipboard. First slice of making the
 * files a transcript mentions clickable.
 *
 * **Copy, not open.** Opening a file hands it to whatever OS handler is
 * registered for its type, which for an arbitrary path the model chose
 * can mean running it. `open-url.ts` refuses every non-http scheme for
 * that reason; copying is the safe action that works on every platform.
 *
 * **Its own target, beside the header, never inside a `Text`.** A
 * `MouseTarget` nested in a `Text` does not get its own hit box, so the
 * chip sits in the header row as a sibling of the expand toggle. Same
 * row, so the card's height estimate does not change.
 *
 * **Without a mouse provider** the chip still renders as a hint and
 * registers no target, like `ChatCopyButton`.
 */
export function ToolCardPathChip({
  path,
  revertAfterMs = DEFAULT_REVERT_MS,
}: ToolCardPathChipProps): ReactElement {
  const clipboard = useClipboard();
  const mouse = useMouseCommands();
  const [status, flash] = useTransientStatus<CopyStatus>("idle", revertAfterMs);

  const copy = useCallback(() => {
    void clipboard
      .copy(path)
      .then((ok) => flash(ok ? "copied" : "failed"))
      .catch(() => flash("failed"));
  }, [clipboard, path, flash]);

  const label = (
    <Text color={theme.colors.muted} dimColor={status === "idle"}>
      {LABELS[status]}
    </Text>
  );

  return (
    <Box marginLeft={1} flexDirection="row" flexShrink={0}>
      {mouse ? (
        <MouseTarget
          flexShrink={0}
          onMouse={(hit) => {
            if (!isPrimaryPress(hit.event)) return false;
            copy();
            // Claim the press so it does not also fold the card or fall
            // through to the chat log's wheel target.
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
