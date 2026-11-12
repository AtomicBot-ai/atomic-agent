/* ATO-1280 — the app's own stdout/stderr can be closed under it.
 *
 * A Linux AppImage started from a launcher, or from a terminal that was
 * closed later, has stdout/stderr on a pipe nobody reads any more. The next
 * console.log / console.error then fails with EPIPE; the stream emits
 * 'error', and with no listener Node turns that into an uncaught exception
 * that ends the whole app (Sentry CLI-MM, CLI-MK, CLI-N9: Socket._write).
 *
 * Every line the desktop prints also goes to the Diagnostics pane and
 * agent.log, so losing the console copy loses nothing. Once a stream has
 * failed this way it is marked dead and further writes to it are dropped
 * instead of failing again.
 */

/** Errors that mean "the reader of this stream is gone", not a bug of ours. */
const GONE_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END", "EIO", "ECONNRESET"]);

export function isClosedStreamError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && GONE_CODES.has(code);
}

/** The bits of a stream this guard touches; process.stdout/stderr fit it, and so does a test double. */
export interface GuardableStream {
  on(event: "error", listener: (err: unknown) => void): unknown;
  write: (...args: never[]) => boolean;
}

const GUARDED = new WeakSet<object>();

/**
 * Keep a closed stream from taking the app down. Idempotent. `onOther` gets
 * any error that is not a closed reader (rare: it is re-thrown on the next
 * tick by default so a real bug still shows up in Sentry).
 */
export function guardStream(stream: GuardableStream, onOther: (err: unknown) => void = (err) => { setImmediate(() => { throw err; }); }): void {
  if (GUARDED.has(stream)) return;
  GUARDED.add(stream);
  let dead = false;
  stream.on("error", (err) => {
    if (isClosedStreamError(err)) { dead = true; return; }
    onOther(err);
  });
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  (stream as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]): boolean => {
    if (dead) {
      // Call a write callback, if any, so nobody waits on it forever.
      const cb = args.find((a) => typeof a === "function") as ((err?: Error | null) => void) | undefined;
      if (cb) queueMicrotask(() => cb(null));
      return true;
    }
    try {
      return write(...args);
    } catch (err) {
      if (isClosedStreamError(err)) { dead = true; return true; }
      throw err;
    }
  };
}

/** Guard the app's own stdout and stderr. Called first thing in main.ts. */
export function guardProcessStdio(): void {
  guardStream(process.stdout as unknown as GuardableStream);
  guardStream(process.stderr as unknown as GuardableStream);
}

guardProcessStdio();
