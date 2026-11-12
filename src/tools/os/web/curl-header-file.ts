import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Request headers for a spawned `curl`, kept out of its argv.
 *
 * Everything in argv is readable by every account on the machine for as
 * long as the process runs (`ps -ww -o args`), and also lands in a spawn
 * error's `spawnargs`. Search providers put their API key in a header
 * (Exa `x-api-key`, Brave `X-Subscription-Token`), and `os.http.request`
 * forwards whatever headers the model set, `Authorization` included, so
 * passing them as `-H "Name: value"` published the key (ATO-1177).
 *
 * Instead the headers go to a file readable by the owner only, in a fresh
 * owner-only directory, and curl reads them with `-H @file` (curl >= 7.55,
 * the oldest curl.exe Windows 10 shipped). stdin is not used because the
 * request body already travels there (`--data-binary @-`).
 *
 * The file lives only for the duration of one curl run: call `cleanup()`
 * in a `finally`. Header names and values are checked for CR/LF so one
 * value cannot smuggle a second header line into the file.
 */
export interface CurlHeaderFile {
  /** argv to splice in place of the `-H` pairs: `["-H", "@<path>"]`, or `[]`. */
  args: string[];
  /** Removes the file and its directory. Never throws. */
  cleanup: () => Promise<void>;
}

const NOOP: CurlHeaderFile = { args: [], cleanup: async () => {} };

export async function writeCurlHeaderFile(
  headers: Record<string, string>,
  options: { tmpDir?: string } = {},
): Promise<CurlHeaderFile> {
  const entries = Object.entries(headers);
  if (entries.length === 0) return NOOP;
  const lines = entries.map(([name, value]) => {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw new Error(`header ${JSON.stringify(name)} contains a line break`);
    }
    return `${name}: ${value}`;
  });
  const dir = await mkdtemp(join(options.tmpDir ?? tmpdir(), "atomic-curl-"));
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  const path = join(dir, "headers");
  try {
    // mkdtemp already creates the directory 0700; the file gets 0600.
    await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { args: ["-H", `@${path}`], cleanup };
}
