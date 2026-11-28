import { serveApiKeyError } from "./serve-api-key-rules.js";
import type { ServeArgs } from "./serve-args.js";

/**
 * `atomic-agent serve --api-key-stdin` (ATO-2538): the key arrives as the
 * first line of stdin, the way `docker login --password-stdin` and
 * `gh auth login --with-token` take a secret.
 *
 * Why not the environment: removing `ATOMIC_AGENT_API_KEY` from
 * `process.env` (serve-command.ts) stops serve's children inheriting it,
 * but the launch environment block stays readable by every process of the
 * same user (`/proc/<pid>/environ` on Linux, `ps eww` on macOS), the
 * agent's own shell tool included (`cat /proc/$PPID/environ`). A pipe is
 * read once and is then empty: nothing else can read the key back from it.
 *
 * Only the first line is taken, up to `MAX_KEY_BYTES`; serve then stops
 * reading, so whatever else is on the pipe is never parsed as a key. A
 * spawner that never writes is cut off after `timeoutMs`, and serve exits.
 */

export const MAX_KEY_BYTES = 4096;
export const STDIN_KEY_TIMEOUT_MS = 10_000;

/** The first line of `stream` (without `\r\n`), or why there is none. */
export function readKeyLine(
  stream: NodeJS.ReadableStream,
  timeoutMs: number = STDIN_KEY_TIMEOUT_MS,
): Promise<{ key: string } | { error: string }> {
  return new Promise((resolve) => {
    let buffered = "";
    let done = false;
    const finish = (result: { key: string } | { error: string }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      stream.pause();
      resolve(result);
    };
    const fromLine = (line: string): { key: string } | { error: string } => {
      const key = line.replace(/\r$/, "");
      if (Buffer.byteLength(key) > MAX_KEY_BYTES) {
        return { error: `--api-key-stdin: no key line within ${MAX_KEY_BYTES} bytes of stdin` };
      }
      return key.length === 0 ? { error: "--api-key-stdin: the first line of stdin is empty" } : { key };
    };
    const onData = (chunk: Buffer | string): void => {
      buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline >= 0) return finish(fromLine(buffered.slice(0, newline)));
      if (Buffer.byteLength(buffered) > MAX_KEY_BYTES) {
        finish({ error: `--api-key-stdin: no key line within ${MAX_KEY_BYTES} bytes of stdin` });
      }
    };
    const onEnd = (): void => finish(fromLine(buffered));
    const onError = (): void => finish({ error: "--api-key-stdin: stdin could not be read" });
    const timer = setTimeout(
      () => finish({ error: `--api-key-stdin: no key arrived on stdin within ${Math.round(timeoutMs / 1000)}s` }),
      timeoutMs,
    );
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.resume();
  });
}

/**
 * The key serve runs with: from stdin under `--api-key-stdin`, checked by
 * the same rules as a key from `--api-key` (`serveApiKeyError`), else the
 * parsed one (`null`: serve's own persisted key).
 */
export async function givenServeApiKey(
  parsed: ServeArgs,
  stdin: NodeJS.ReadableStream,
  timeoutMs?: number,
): Promise<{ key: string | null } | { error: string }> {
  if (!parsed.apiKeyStdin) return { key: parsed.apiKey };
  const read = await readKeyLine(stdin, timeoutMs);
  if ("error" in read) return read;
  const error = serveApiKeyError(read.key, parsed);
  return error === null ? { key: read.key } : { error };
}
