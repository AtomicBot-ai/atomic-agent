/**
 * Stdio MCP servers report why they died on stderr — `ERR_REQUIRE_ESM`,
 * `ERR_UNKNOWN_FILE_EXTENSION`, `Cannot find module`, a missing API key.
 * The transport pipes that stream, but nothing used to read it, so the
 * operator was left with `MCP error -32000: Connection closed`.
 *
 * Reading it also drains the pipe: an unread `stderr: "pipe"` fills the
 * OS buffer and stalls a chatty server.
 */

import type { EventEmitter } from "node:events";

/** Enough for a Node stack trace, small enough to hold per server forever. */
const MAX_TAIL_CHARS = 4000;

const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

export type StderrTail = {
  /** Everything captured so far, clipped to the last `MAX_TAIL_CHARS`. */
  read(): string;
  /**
   * Resolve once the stream ends (the child exited) or `ms` elapses. A
   * dying server loses the race between its stderr and the transport's
   * `Connection closed`, so the failure path waits briefly before it
   * reports.
   */
  settle(ms: number): Promise<void>;
};

/** Start consuming `stream` into a bounded tail. */
export function attachStderrTail(
  stream: EventEmitter | null | undefined,
): StderrTail {
  if (!stream) return { read: () => "", settle: async () => {} };

  let tail = "";
  let ended = false;
  let notifyEnd: (() => void) | null = null;
  const markEnded = (): void => {
    ended = true;
    notifyEnd?.();
  };

  stream.on("data", (chunk: Buffer | string) => {
    tail = (tail + String(chunk)).slice(-MAX_TAIL_CHARS);
  });
  stream.on("end", markEnded);
  stream.on("close", markEnded);
  // A broken pipe on a server that already died must not take the agent down.
  stream.on("error", () => {});

  return {
    read: () => tail,
    settle: (ms) =>
      new Promise<void>((resolve) => {
        if (ended) {
          resolve();
          return;
        }
        const finish = (): void => {
          clearTimeout(timer);
          notifyEnd = null;
          resolve();
        };
        const timer = setTimeout(finish, ms);
        timer.unref?.();
        notifyEnd = finish;
      }),
  };
}

/** Stack frames and the decoration Node wraps its crash dumps in. */
const NOISE_RE = /^(at\s|[\^{}()[\]]+$|Node\.js v|\.\.\.|throw\b)/;

/** Lines an operator actually needs: the cause, not the frames around it. */
const CAUSE_RE =
  /(error|exception|traceback|cannot|unable|missing|denied|refused|not found|no such|ERR_|ENOENT|EACCES)/i;

/**
 * Condense a tail into one operator-facing line, ANSI stripped and
 * clipped. Prefers cause-shaped lines — a Node crash dump ends with
 * `}` / `Node.js v22`, so the plain last lines say nothing. Empty when
 * the server printed nothing.
 */
export function formatStderrTail(
  tail: string,
  maxLines = 3,
  maxChars = 300,
): string {
  const all = tail
    .replace(ANSI_RE, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !NOISE_RE.test(line));
  const causes = all.filter((line) => CAUSE_RE.test(line));
  const lines = (causes.length > 0 ? causes : all).slice(-maxLines);
  if (lines.length === 0) return "";
  const joined = lines.join(" / ");
  return joined.length > maxChars
    ? `${joined.slice(0, maxChars - 1)}…`
    : joined;
}
