/**
 * Reading the system clipboard for the TUI's paste actions.
 *
 * Writing (`copy-to-clipboard.ts`) hand-rolls OSC 52 + platform
 * commands because a write must survive SSH. Reading cannot: OSC 52
 * reads are disabled by default in every terminal that matters
 * (arbitrary clipboard exfiltration), so the only honest source is the
 * machine the process runs on — which is exactly what `clipboardy`
 * (already a direct dependency, used by the agent's `os.clipboard`
 * tool) implements per platform. The import is dynamic for the same
 * reason it is in `src/tools/os/clipboard.ts`: clipboardy is ESM-only
 * and probes the session (X11/Wayland) at load time.
 */

export interface ClipboardReader {
  /** Resolves the clipboard text, or `""` when nothing readable exists. */
  read(): Promise<string>;
}

/** Injection point for tests: whatever supplies the clipboard text. */
export type ClipboardReadFn = () => Promise<string>;

export interface ClipboardReaderOptions {
  /**
   * Same guard the writer uses: on a non-TTY stdout (the test runner,
   * a piped run) the reader answers `""` instead of touching the real
   * clipboard of whoever happens to be running the process.
   */
  readonly stdout?: { readonly isTTY?: boolean };
  readonly readText?: ClipboardReadFn;
}

const clipboardyRead: ClipboardReadFn = async () => {
  const mod = await import("clipboardy");
  return mod.default.read();
};

/** The reader the real TUI uses. */
export function createClipboardReader(
  options: ClipboardReaderOptions = {},
): ClipboardReader {
  const stdout = options.stdout ?? process.stdout;
  const readText = options.readText ?? clipboardyRead;
  return {
    async read(): Promise<string> {
      if (stdout.isTTY !== true) return "";
      try {
        return await readText();
      } catch {
        // No clipboard (headless box, missing xclip): paste is simply
        // empty rather than an error the operator cannot act on.
        return "";
      }
    },
  };
}

/** A reader with nothing in it — the stand-in where paste must no-op. */
export function createNullClipboardReader(): ClipboardReader {
  return { read: async () => "" };
}

/** A reader that always answers `text` — for tests that observe a paste. */
export function createStaticClipboardReader(text: string): ClipboardReader {
  return { read: async () => text };
}
