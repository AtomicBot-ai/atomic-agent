/**
 * Outbound messages through `imsg send`.
 *
 * Always `execFile` with an argument array, never a shell: the text is
 * whatever the model wrote, and a reply containing `$(...)` or a quote
 * must reach the phone as text, not run on the Mac.
 *
 * `imsg send` drives Messages.app over AppleScript and, when it can
 * read `chat.db`, waits up to eight seconds to confirm the outgoing
 * row. A failed send can still have been delivered (imsg reports that
 * as `may_have_completed`), so a send is never retried here: a
 * duplicated reply is worse than a missing one the owner can ask for.
 */

import { execFile } from "node:child_process";

/** Where a reply goes: a direct chat by handle, or a group by chat rowid. */
export type ImessageTarget =
  | { kind: "handle"; handle: string }
  | { kind: "chat"; chatId: number };

/**
 * Soft cap per outbound message. iMessage itself takes far longer
 * texts, but a 10 kB wall on a phone is unreadable and long AppleScript
 * sends are the ones that time out.
 */
export const IMESSAGE_CHUNK_CHARS = 2000;

/** Upper bound for one `imsg send`; imsg's own confirmation wait is ~8 s. */
const SEND_TIMEOUT_MS = 30_000;

/** The `execFile` subset used here, so tests can swap in a fake. */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

export class ImsgSendError extends Error {
  constructor(
    readonly original: unknown,
    readonly stderr: string,
  ) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "ImsgSendError";
  }
}

/** The argv for one `imsg send`. Exported for tests. */
export function sendArgs(target: ImessageTarget, text: string): string[] {
  return target.kind === "handle"
    ? ["send", "--to", target.handle, "--text", text]
    : ["send", "--chat-id", String(target.chatId), "--text", text];
}

export interface ImsgSender {
  /** Send `text`, chunked; rejects with `ImsgSendError` on the first failed chunk. */
  send(target: ImessageTarget, text: string): Promise<void>;
}

export function createImsgSender(opts: {
  binary: string;
  execFileImpl?: ExecFileLike;
  chunkChars?: number;
}): ImsgSender {
  const run = opts.execFileImpl ?? (execFile as unknown as ExecFileLike);
  const sendOne = (target: ImessageTarget, text: string): Promise<void> =>
    new Promise((resolve, reject) => {
      run(
        opts.binary,
        sendArgs(target, text),
        { timeout: SEND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (error) reject(new ImsgSendError(error, String(stderr ?? "")));
          else resolve();
        },
      );
    });
  return {
    async send(target, text) {
      // Sequential, so the phone shows the parts in order.
      for (const chunk of chunkText(text, opts.chunkChars ?? IMESSAGE_CHUNK_CHARS)) {
        await sendOne(target, chunk);
      }
    },
  };
}

/**
 * Split `text` into chunks of at most `limit` characters, preferring a
 * paragraph break, then a line break, then a space in the second half
 * of the window; a word longer than the limit is hard-cut.
 */
export function chunkText(text: string, limit = IMESSAGE_CHUNK_CHARS): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut =
      breakAfterHalf(window, "\n\n") ?? breakAfterHalf(window, "\n") ?? breakAfterHalf(window, " ") ?? limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function breakAfterHalf(window: string, needle: string): number | undefined {
  const idx = window.lastIndexOf(needle);
  return idx > window.length / 2 ? idx : undefined;
}
