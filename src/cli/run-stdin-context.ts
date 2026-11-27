/**
 * `cat log | atomic-agent run "explain this"` (ATO-2440): with a prompt
 * argument, piped stdin is part of the task, as in `codex exec`, Claude
 * Code `-p` and Gemini CLI. The prompt comes first, then the piped text
 * in a `<stdin>` block (Codex's shape).
 *
 * Gemini CLI's guard against a pipe nobody writes to (a CI runner's open
 * stdin): when nothing arrives within `waitMs`, stdin is left unread and
 * the run goes on with the prompt alone. Once text arrives, it is read to
 * the end, up to `maxBytes`.
 */

/** How long a pipe may stay silent before it is taken as empty. */
export const STDIN_CONTEXT_WAIT_MS = 500;

/** The most piped text one task carries; the rest is cut (Gemini CLI's 8 MB). */
export const STDIN_CONTEXT_MAX_BYTES = 8 * 1024 * 1024;

export interface StdinContext {
  text: string;
  /** Cut at `maxBytes`. */
  truncated: boolean;
  /**
   * Stdin was read (to its end, or up to the cut): it cannot answer
   * approval prompts any more. False when the pipe stayed silent and was
   * left for the approval reader.
   */
  consumed: boolean;
}

export function readStdinContext(
  input: NodeJS.ReadableStream & { readableEnded?: boolean },
  options: { waitMs?: number; maxBytes?: number } = {},
): Promise<StdinContext> {
  const waitMs = options.waitMs ?? STDIN_CONTEXT_WAIT_MS;
  const maxBytes = options.maxBytes ?? STDIN_CONTEXT_MAX_BYTES;
  if (input.readableEnded === true) {
    return Promise.resolve({ text: "", truncated: false, consumed: true });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (consumed: boolean, truncated: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      // Unread input stays buffered for the next reader.
      if (!consumed || truncated) input.pause();
      resolve({ text: Buffer.concat(chunks).toString("utf8"), truncated, consumed });
    };
    const onData = (chunk: unknown): void => {
      clearTimeout(timer);
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      if (size + buf.length > maxBytes) {
        chunks.push(buf.subarray(0, maxBytes - size));
        size = maxBytes;
        finish(true, true);
        return;
      }
      chunks.push(buf);
      size += buf.length;
    };
    const onEnd = (): void => finish(true, false);
    const timer = setTimeout(() => {
      if (size === 0) finish(false, false);
    }, waitMs);
    timer.unref?.();
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onEnd);
  });
}

/** The task one turn gets: the prompt, then the piped text when there is any. */
export function joinPromptWithStdin(prompt: string, stdin: StdinContext): string {
  const body = stdin.text.replace(/\s+$/u, "");
  if (body.trim().length === 0) return prompt;
  const cut = stdin.truncated ? `\n[stdin was cut at ${STDIN_CONTEXT_MAX_BYTES} bytes]` : "";
  return `${prompt}\n\n<stdin>\n${body}${cut}\n</stdin>`;
}
