import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readlink, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Copy one model folder to another disk with a byte count as it goes
 * (ATO-2503). `fs.cp` says nothing until a 20 GB GGUF is done, so the
 * desktop card and the CLI sat on "moving qwen (1/1)" for many minutes
 * with no sign of life, and a hung copy looked the same as a slow one.
 * Same shape as Finder's or LM Studio's copy progress: bytes done of bytes
 * in all, reported at most every `everyMs`.
 *
 * Files are streamed (so `signal` stops a copy between two chunks), folders
 * are created, symlinks are copied as links, never followed. The target
 * must not exist (`wx`); timestamps are kept.
 */

export interface CopyTreeOptions {
  /** Bytes copied so far in this tree. */
  onBytes?: (done: number) => void;
  signal?: AbortSignal;
  /** Fewest milliseconds between two `onBytes` calls (default 500); the last count always goes out. */
  everyMs?: number;
}

export async function copyTreeWithProgress(from: string, to: string, opts: CopyTreeOptions = {}): Promise<number> {
  const every = opts.everyMs ?? 500;
  let done = 0;
  let lastAt = 0;
  const tick = (force: boolean): void => {
    const now = Date.now();
    if (!force && now - lastAt < every) return;
    lastAt = now;
    opts.onBytes?.(done);
  };

  const copyOne = async (a: string, b: string): Promise<void> => {
    opts.signal?.throwIfAborted();
    const st = await lstat(a);
    if (st.isSymbolicLink()) {
      await symlink(await readlink(a), b);
      return;
    }
    if (st.isDirectory()) {
      await mkdir(b);
      for (const name of (await readdir(a)).sort()) await copyOne(join(a, name), join(b, name));
      await utimes(b, st.atime, st.mtime).catch(() => {});
      return;
    }
    if (!st.isFile()) return;
    const count = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        done += chunk.length;
        tick(false);
        cb(null, chunk);
      },
    });
    await pipeline(
      createReadStream(a),
      count,
      createWriteStream(b, { flags: "wx", mode: st.mode & 0o777 }),
      opts.signal ? { signal: opts.signal } : {},
    );
    await utimes(b, st.atime, st.mtime).catch(() => {});
  };

  await copyOne(from, to);
  tick(true);
  return done;
}
