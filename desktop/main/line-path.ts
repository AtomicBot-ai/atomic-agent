/**
 * ATO-2445: where a `path:line` a reply names is (renderer/reply-line-links.js).
 *
 *   absolute or `~/…`  that file, when it is one;
 *   relative           the chat's working folder joined with it, never
 *                      climbing out of that folder with `..`;
 *   else               the one file in the folder's listing (the @-mention
 *                      index: `git ls-files`, or the bounded walk) whose path
 *                      ends with it, so `api.py:42` finds `src/api.py`; when
 *                      several do, the shallowest.
 *
 * This only answers where the file is. The preview then reads it through its
 * own root check (file-preview.ts), so a path outside the roots still shows
 * "outside the folders the preview can read", whatever this said.
 *
 * Pure but for `stat`: no Electron import, so the unit suite loads it from
 * `out/main`.
 */

import { stat } from "node:fs/promises";

import { expandHome, isAbsoluteOn, isUnder, pathFor, type Platform } from "./platform.js";

export const LINE_PATH_MAX = 1024;

export type LinePathResult = { ok: true; path: string } | { ok: false; reason: "missing" | "remote" | "bad-path" };

const isFile = async (p: string): Promise<boolean> => (await stat(p).catch(() => null))?.isFile() === true;

/** The file a reply's `raw` path stands for, looked up from `dir` (the chat's folder) when it is relative. */
export async function resolveLinePath(
  raw: unknown,
  dir: string | null | undefined,
  home: string,
  platform: Platform,
  list?: (root: string) => Promise<readonly string[]>,
): Promise<LinePathResult> {
  if (typeof raw !== "string") return { ok: false, reason: "bad-path" };
  const s = raw.trim();
  if (!s || s.length > LINE_PATH_MAX || /[\0\r\n]/.test(s) || /:\/\//.test(s)) return { ok: false, reason: "bad-path" };
  const P = pathFor(platform);
  const expanded = s === "~" ? home : expandHome(platform, s, home);
  if (isAbsoluteOn(platform, expanded)) {
    const abs = P.resolve(expanded);
    return (await isFile(abs)) ? { ok: true, path: abs } : { ok: false, reason: "missing" };
  }
  if (!dir) return { ok: false, reason: "missing" };
  const root = P.resolve(dir);
  const joined = P.resolve(root, s);
  if (isUnder(platform, root, joined) && (await isFile(joined))) return { ok: true, path: joined };
  if (!list) return { ok: false, reason: "missing" };
  const tail = s.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  if (!tail || tail.startsWith("../")) return { ok: false, reason: "missing" };
  const files = await list(root).catch((): readonly string[] => []);
  const hit = pickByTail(files, tail);
  if (!hit) return { ok: false, reason: "missing" };
  const abs = P.resolve(root, hit);
  return isUnder(platform, root, abs) && (await isFile(abs)) ? { ok: true, path: abs } : { ok: false, reason: "missing" };
}

/** The listed path that is `tail` or ends with `/tail`; the shallowest, then the shortest, when there are several. */
export function pickByTail(files: readonly string[], tail: string): string | null {
  let best: string | null = null;
  let bestDepth = Infinity;
  for (const f of files) {
    const p = f.replace(/\\/g, "/");
    if (p !== tail && !p.endsWith("/" + tail)) continue;
    const depth = p.split("/").length;
    if (depth < bestDepth || (depth === bestDepth && best !== null && p.length < best.length)) {
      best = f;
      bestDepth = depth;
    }
  }
  return best;
}
