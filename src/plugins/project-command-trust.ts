import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";

/**
 * Trust key of a project slash command file (ATO-2531): its path relative
 * to the working folder, with forward slashes, then `#` and the first 16
 * hex digits of the SHA-256 of its text, e.g.
 * `.claude/commands/deploy.md#0123456789abcdef`. A yes covers that text
 * only, so a command someone edits after the answer is asked about again,
 * the way Claude Code holds hook settings edited outside a session until
 * they are reviewed. Checked by `isProjectCommandTrustKey` in the config.
 */
export function projectCommandKey(workingDir: string, file: string, text: string): string {
  const path = relative(resolve(workingDir), file).split(sep).join("/");
  return `${path}#${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16)}`;
}

/** The path half of a key, for showing it. */
export function projectCommandKeyPath(key: string): string {
  const hash = key.lastIndexOf("#");
  return hash < 0 ? key : key.slice(0, hash);
}
