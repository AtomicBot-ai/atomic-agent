import { Box, Text, useStdout } from "ink";
import { useEffect, type ReactElement } from "react";
import type { ImageProtocol } from "./detect-image-protocol.js";
import {
  getDefaultImageProtocol,
  getDefaultInlineImageStore,
  toolCardInlineImages,
  type InlineImage,
  type InlineImageStore,
} from "./inline-image-store.js";
import { kittyPlaceholderRows } from "./kitty-graphics.js";

interface ToolCardImagesProps {
  readonly card: Parameters<typeof toolCardInlineImages>[0];
  /** Injected in tests; the default reads `process.env` once. */
  readonly protocol?: ImageProtocol | null;
  readonly store?: InlineImageStore;
}

/**
 * The pictures a finished `image.generate` card saved, drawn right under
 * it in kitty and Ghostty (ATO-660). Renders nothing — the card keeps
 * its path line — for every other terminal, for anything but a PNG
 * under 5 MB, and unless `ATOMIC_AGENT_INLINE_IMAGES=1` is set.
 *
 * The strip is placeholder text (see `kitty-graphics.ts`), so Ink lays
 * it out and repaints it like the rest of the card: no escape is
 * written at a screen position, nothing is left behind when the chat
 * scrolls. The picture bytes go to the terminal once, from an effect,
 * as a quiet (`q=2`) transmit that does not move the cursor.
 */
export function ToolCardImages({ card, protocol, store }: ToolCardImagesProps): ReactElement | null {
  const activeProtocol = protocol === undefined ? getDefaultImageProtocol() : protocol;
  if (activeProtocol !== "kitty") return null;
  const activeStore = store ?? getDefaultInlineImageStore();
  const images = toolCardInlineImages(card, activeProtocol, activeStore);
  if (images.length === 0) return null;
  return (
    <Box flexDirection="row" marginLeft={3} columnGap={1} flexShrink={0}>
      {images.map((image) => (
        <KittyImage key={image.path} image={image} store={activeStore} />
      ))}
    </Box>
  );
}

function KittyImage({ image, store }: { image: InlineImage; store: InlineImageStore }): ReactElement {
  const { stdout } = useStdout();
  useEffect(() => {
    const sequence = store.takeTransmit(image.path);
    if (sequence !== null) stdout.write(sequence);
  }, [image.path, store, stdout]);
  const rows = kittyPlaceholderRows(image.id, image.cols, image.rows);
  return (
    <Box flexDirection="column" width={image.cols} height={image.rows} flexShrink={0} overflow="hidden">
      {rows.map((line, index) => (
        <Text key={index} wrap="truncate">
          {line}
        </Text>
      ))}
    </Box>
  );
}
