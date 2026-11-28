import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

import { USAGE_NO_PROJECT_KEY, type UsageProjectRef } from "./usage-history-types.js";

/**
 * How `usage-history.json` names a project and a session (ATO-2442)
 * without storing a path or an id: a project is its folder's own name
 * plus the first 12 hex of a SHA-256 of the full path (two folders
 * called `app` stay apart), a session is the first 12 hex of a SHA-256
 * of its id (enough to count distinct sessions per day).
 *
 * The path is resolved first and, on Windows, compared without case,
 * so `C:\Code\App` and `c:\code\app\` are one project.
 */
export function usageProjectRef(workingDir: string | null | undefined): UsageProjectRef {
  if (typeof workingDir !== "string" || workingDir.trim() === "") return noProject();
  const full = resolve(workingDir);
  const label = basename(full) || full;
  const canonical = process.platform === "win32" ? full.toLowerCase() : full;
  return { key: shortHash(canonical), label };
}

export function usageSessionKey(sessionId: string): string {
  return shortHash(`session:${sessionId}`);
}

export function noProject(): UsageProjectRef {
  return { key: USAGE_NO_PROJECT_KEY, label: "(no project)" };
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
