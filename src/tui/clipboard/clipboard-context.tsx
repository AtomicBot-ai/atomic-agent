/**
 * React access to the clipboard writer.
 *
 * Shaped like `mouse-context.tsx` and for the same reason: the chat
 * bubbles are presentational and prop-drilling a writer down through
 * `ChatLog` → `FinalisedMessage` → every bubble would be a bigger change
 * than the feature earns.
 *
 * Unlike the mouse context there is a **default** when no provider is
 * mounted, because a copy button with no clipboard is not a degraded
 * button, it is a broken one. The default is created lazily and shared,
 * so the common case — the real TUI, which mounts no provider — needs no
 * wiring at all. `createClipboardWriter` refuses to act on a non-TTY
 * stdout, which is what keeps that default from touching a real human's
 * clipboard when a component test happens to render a copy button.
 *
 * Tests that want to *observe* a copy mount `ClipboardProvider` with a
 * fake and get an exact record of what was copied.
 */
import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import {
  createClipboardWriter,
  type ClipboardWriter,
} from "./copy-to-clipboard.js";

const ClipboardContext = createContext<ClipboardWriter | null>(null);

let defaultWriter: ClipboardWriter | null = null;

/**
 * The process-wide writer used when no provider is mounted. Lazy so that
 * merely importing a chat component does not read `process.platform` or
 * capture a `process.stdout` that a harness may still replace.
 */
export function getDefaultClipboardWriter(): ClipboardWriter {
  defaultWriter ??= createClipboardWriter();
  return defaultWriter;
}

export interface ClipboardProviderProps {
  readonly writer: ClipboardWriter;
  readonly children: ReactNode;
}

export function ClipboardProvider({
  writer,
  children,
}: ClipboardProviderProps): ReactElement {
  return (
    <ClipboardContext.Provider value={writer}>
      {children}
    </ClipboardContext.Provider>
  );
}

/** The active clipboard writer — the provider's, or the shared default. */
export function useClipboard(): ClipboardWriter {
  return useContext(ClipboardContext) ?? getDefaultClipboardWriter();
}
