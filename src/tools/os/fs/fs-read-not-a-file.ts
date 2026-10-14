import type { Stats } from "node:fs";

/**
 * The error `os.fs.read` raises for a path that exists but is not a
 * regular file, worded as the next move rather than a bare refusal.
 *
 * A bare "is not a regular file" left a local model nowhere to go: a
 * Fusion planner used `/dev/null` as a placeholder path and re-sent the
 * same read more than ten times after seeing that error (ATO-308). A
 * directory and a device each have a different right answer, so each
 * gets its own sentence. Every message keeps "is not a regular file" so
 * anything matching the old wording still matches.
 */
export function notARegularFileMessage(absolute: string, info: Stats): string {
  const head = `os.fs.read: ${absolute} is not a regular file`;
  if (info.isDirectory()) {
    return `${head} — it is a directory. List it with os.fs.list, then read a file inside it.`;
  }
  if (isDevice(absolute, info)) {
    return (
      `${head} — it is a device, so there is nothing to read. ` +
      "Do not use it as a placeholder: pass the path of a real file, or drop this call."
    );
  }
  return `${head} — it is a socket, pipe or other special file. Pass the path of a regular file.`;
}

function isDevice(absolute: string, info: Stats): boolean {
  return (
    info.isCharacterDevice() ||
    info.isBlockDevice() ||
    absolute === "/dev" ||
    absolute.startsWith("/dev/")
  );
}
