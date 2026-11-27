import type { ConversationTurn } from "../session/conversation-turn.js";

/**
 * Which files a transcript turn says a file tool read or changed, as the
 * paths the tool was given (ATO-2247, ATO-2443). Used only to decide which
 * path-scoped project rules apply, so a miss means a rule attaches later,
 * never a wrong write. Pure and cheap: nothing here reads the disk, so a
 * patch named by `patchPath` is not opened.
 */

type Args = Record<string, unknown>;

/** File tools whose arguments name the file they read or change. */
const pathArgs: Record<string, (args: Args) => unknown[]> = {
  "os.fs.read": args => [args.path],
  "os.fs.read_document": args => [args.path],
  "os.fs.write": args => [args.path],
  "os.fs.edit": args => [args.path],
  "os.fs.move": args => [args.from, args.to, ...(Array.isArray(args.moves)
    ? args.moves.flatMap(move => move && typeof move === "object" ? [(move as Args).from, (move as Args).to] : [])
    : [])],
  // ATO-2443: a patch names its files inside the text, relative to `rootDir`.
  "os.fs.patch": args => patchTargets(args),
  // A single-file rewrite names it; a folder rewrite lists its files in the result (below).
  "os.code.rewrite": args => [args.path],
};

/** Paths one turn names, as given (relative to the session folder or absolute). */
export function turnTargetPaths(turn: ConversationTurn): string[] {
  if (turn.kind === "assistant_tool_call") {
    const pick = pathArgs[turn.tool];
    if (!pick) return [];
    return pick(turn.args ?? {}).filter((value): value is string => typeof value === "string");
  }
  if (turn.kind === "tool_result" && turn.tool === "os.code.rewrite") return rewriteResultFiles(turn.summary);
  return [];
}

/**
 * The files of an `os.fs.patch` call, for both formats the tool reads:
 * `*** Add/Update/Delete File:` (and `*** Move to:`) lines of the envelope,
 * or the `+++` / `---` headers of a unified diff with `stripComponents`
 * leading parts removed (default 1, the `a/` `b/` of `git diff`), the
 * way `pickTargetPath` reads them. A dry run counts too: it read the files.
 */
export function patchTargets(args: Args): string[] {
  const text = typeof args.patch === "string" ? args.patch : "";
  if (!text) return [];
  const strip =
    typeof args.stripComponents === "number" && Number.isFinite(args.stripComponents) && args.stripComponents >= 0
      ? Math.floor(args.stripComponents)
      : 1;
  const out: string[] = [];
  const lines = text.split(/\r?\n/).map(line => line.trimEnd());
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const envelope = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line.trimStart());
    if (envelope) {
      out.push(envelope[1]!.trim());
      continue;
    }
    // A file header is a `--- old` line right before a `+++ new` line; a lone
    // `--- x` inside a hunk is a removed line that started with "-- ".
    const next = lines[i + 1];
    if (!line.startsWith("--- ") || next === undefined || !next.startsWith("+++ ")) continue;
    const oldName = headerName(line);
    const newName = headerName(next);
    const name = newName !== null && newName !== "/dev/null" ? newName : oldName;
    if (name !== null && name !== "/dev/null") out.push(stripParts(name, strip));
    i += 1;
  }
  const rootDir = typeof args.rootDir === "string" && args.rootDir.trim() ? args.rootDir.trim() : null;
  return [...new Set(out)].map(path => rootDir && !isAbsolutePath(path) ? `${rootDir.replace(/[\\/]+$/, "")}/${path}` : path);
}

/** The file lines of an `os.code.rewrite` result: `  ✓ src/a.ts  2 matches`. */
export function rewriteResultFiles(summary: string): string[] {
  const out: string[] = [];
  for (const line of summary.split(/\r?\n/)) {
    const match = /^\s+[✓✗] (.+?) {2}\d+ match(?:es)?\b/.exec(line);
    if (match) out.push(match[1]!.trim());
  }
  return out;
}

/** The path of a `--- ` / `+++ ` header, without the tab-separated timestamp. */
function headerName(line: string): string | null {
  const name = line.slice(4).split("\t")[0]!.trim();
  return name.length > 0 ? name : null;
}

function stripParts(path: string, n: number): string {
  if (n <= 0) return path;
  const parts = path.split(/[\\/]/);
  return parts.slice(Math.min(n, parts.length - 1)).join("/");
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}
