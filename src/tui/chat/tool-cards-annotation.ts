import type { ToolCardEntry } from "../tui-state.js";

type AnnotatedCard = Pick<ToolCardEntry, "tool" | "args" | "status">;

/**
 * The gist of a turn's tool calls, split so the renderer can keep the
 * failure count on screen while only the work list gets truncated.
 *
 * - `done`: what the calls that succeeded did, e.g. `read 3 files, ran 2
 *   commands`. Empty when nothing succeeded.
 * - `failed`: calls that ended in an error. They did not do the work
 *   they were asked to, so they are left out of `done`.
 * - `unfinished`: calls with no result (a stopped or cut-off turn).
 *   Also left out of `done`.
 */
export interface ToolCardsAnnotationParts {
  done: string;
  failed: number;
  unfinished: number;
}

/**
 * One plain-language line saying what a turn's tool calls did, e.g.
 * `read 3 files, edited 1 file, ran 2 commands · 1 failed`.
 *
 * Computed from the cards alone: no model call, no I/O, so it costs
 * nothing per frame and a reloaded chat shows the same line it did live.
 * The tool cards above it already carry the detail; this is the gist a
 * reader skims before the reply.
 *
 * Returns `null` when there is nothing worth a line: fewer than
 * {@link MIN_ANNOTATED_CARDS} cards would only repeat the card itself.
 * `ChatLog` and `estimateMessageHeight` both ask this module, so the
 * row is either drawn and counted or neither.
 */
export function toolCardsAnnotationParts(
  cards: readonly AnnotatedCard[],
): ToolCardsAnnotationParts | null {
  const counted = cards.filter((card) => !UNCOUNTED_TOOLS.has(card.tool));
  if (counted.length < MIN_ANNOTATED_CARDS) return null;

  const buckets = new Map<BucketId, Bucket>();
  let failed = 0;
  let unfinished = 0;
  for (const card of counted) {
    if (card.status === "error") {
      failed += 1;
      continue;
    }
    if (card.status !== "ok") {
      unfinished += 1;
      continue;
    }
    const id = bucketOf(card.tool);
    const bucket = buckets.get(id) ?? {
      calls: 0,
      paths: new Set<string>(),
      pathless: 0,
    };
    bucket.calls += 1;
    const paths = pathsOf(card);
    if (paths.length === 0) bucket.pathless += 1;
    for (const path of paths) bucket.paths.add(path);
    buckets.set(id, bucket);
  }

  const parts: string[] = [];
  for (const id of BUCKET_ORDER) {
    const bucket = buckets.get(id);
    if (!bucket) continue;
    parts.push(PHRASES[id](countFor(id, bucket)));
  }
  return { done: parts.join(", "), failed, unfinished };
}

/**
 * The whole line as one string: the work list, then the failure and
 * unfinished counts. `null` exactly when {@link toolCardsAnnotationParts}
 * is.
 */
export function toolCardsAnnotation(
  cards: readonly AnnotatedCard[],
): string | null {
  const parts = toolCardsAnnotationParts(cards);
  if (parts === null) return null;
  const tail = annotationTail(parts);
  if (parts.done.length === 0) return tail;
  return tail.length > 0 ? `${parts.done} · ${tail}` : parts.done;
}

/** `2 failed · 1 unfinished`, or `""` when every call succeeded. */
export function annotationTail(parts: ToolCardsAnnotationParts): string {
  const tail: string[] = [];
  if (parts.failed > 0) tail.push(`${parts.failed} failed`);
  if (parts.unfinished > 0) tail.push(`${parts.unfinished} unfinished`);
  return tail.join(" · ");
}

/**
 * A single call is already its own card; the annotation starts paying
 * for its row at two.
 */
export const MIN_ANNOTATED_CARDS = 2;

/**
 * Terminal tools: `reply` is the bubble below, `finish` ends the
 * session. Neither is something the agent "did" on the way.
 */
const UNCOUNTED_TOOLS: ReadonlySet<string> = new Set(["reply", "finish"]);

type BucketId =
  | "read"
  | "search"
  | "edit"
  | "move"
  | "trash"
  | "shell"
  | "git"
  | "github"
  | "web"
  | "memory"
  | "other";

interface Bucket {
  calls: number;
  /** Distinct normalised paths, so re-reading one file reads as one. */
  paths: Set<string>;
  /** Calls that named no path we could read (a `patchPath` patch, say). */
  pathless: number;
}

const BUCKET_ORDER: readonly BucketId[] = [
  "read",
  "search",
  "edit",
  "move",
  "trash",
  "shell",
  "git",
  "github",
  "web",
  "memory",
  "other",
];

const READ_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.read",
  "os.fs.read_document",
  "os.fs.archive.read_entry",
  "os.fs.diff",
  "os.fs.hash",
  "vision.describe",
]);

const SEARCH_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.list",
  "os.fs.glob",
  "os.fs.grep",
  "os.fs.watch",
  "os.fs.locate_project",
  "os.fs.archive.list",
]);

const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.write",
  "os.fs.edit",
  "os.fs.patch",
  "os.fs.restore",
]);

function bucketOf(tool: string): BucketId {
  if (READ_TOOLS.has(tool)) return "read";
  if (SEARCH_TOOLS.has(tool)) return "search";
  if (EDIT_TOOLS.has(tool)) return "edit";
  if (tool === "os.fs.move") return "move";
  if (tool === "os.fs.trash") return "trash";
  if (tool === "os.shell.run") return "shell";
  if (tool.startsWith("os.git.")) return "git";
  if (tool.startsWith("github.")) return "github";
  if (
    tool.startsWith("os.web.") ||
    tool.startsWith("browser.") ||
    tool === "os.http.request"
  ) {
    return "web";
  }
  if (tool.startsWith("memory.")) return "memory";
  return "other";
}

/** Buckets whose phrase counts files rather than calls. */
const FILE_BUCKETS: ReadonlySet<BucketId> = new Set([
  "read",
  "edit",
  "move",
  "trash",
]);

/**
 * Files are counted by distinct path, so reading one file three times
 * is "read 1 file"; a call that named no path counts as one more.
 * Everything else counts calls.
 */
function countFor(id: BucketId, bucket: Bucket): number {
  if (!FILE_BUCKETS.has(id)) return bucket.calls;
  return bucket.paths.size + bucket.pathless;
}

/**
 * Every file a call names, normalised: `path`, the `paths` of a trash,
 * the sources of a move, the two sides of a diff, and the `+++`
 * headers of an inline patch.
 */
function pathsOf(card: AnnotatedCard): string[] {
  const args = card.args;
  const raw: unknown[] = [];
  if (card.tool === "os.fs.patch") {
    const patch = args["patch"];
    if (typeof patch === "string") raw.push(...patchTargets(patch));
  } else if (card.tool === "os.fs.move") {
    const moves = Array.isArray(args["moves"]) ? (args["moves"] as unknown[]) : [args];
    for (const move of moves) {
      if (typeof move === "object" && move !== null) {
        raw.push((move as Record<string, unknown>)["from"]);
      }
    }
  } else if (card.tool === "os.fs.diff") {
    raw.push(args["aPath"], args["bPath"]);
  } else if (Array.isArray(args["paths"])) {
    raw.push(...(args["paths"] as unknown[]));
  } else {
    raw.push(args["path"]);
  }
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const path = normalisePath(value);
    if (path.length > 0) out.push(path);
  }
  return out;
}

/**
 * Target files of a unified diff, from its `+++ b/<path>` (or `+++
 * <path>`) headers. `/dev/null` (a deletion) names no new file and is
 * skipped; a trailing tab-separated timestamp is dropped.
 */
export function patchTargets(patch: string): string[] {
  const targets: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("+++ ")) continue;
    const [head = ""] = line.slice(4).split("\t");
    let target = head.trim();
    if (target.length === 0 || target === "/dev/null") continue;
    if (target.startsWith("b/")) target = target.slice(2);
    targets.push(target);
  }
  return targets;
}

/**
 * Enough normalisation that one file spelled two ways counts once:
 * backslashes, repeated and trailing slashes, `.` segments and a
 * leading `./`. Relative and absolute spellings of one file still
 * count twice; the cards carry no working directory to resolve against.
 */
export function normalisePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (trimmed.length === 0) return "";
  const absolute = trimmed.startsWith("/");
  const segments = trimmed
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  const joined = segments.join("/");
  if (absolute) return `/${joined}`;
  return joined.length > 0 ? joined : ".";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const PHRASES: Record<BucketId, (n: number) => string> = {
  read: (n) => `read ${plural(n, "file", "files")}`,
  search: (n) => `ran ${plural(n, "search", "searches")}`,
  edit: (n) => `edited ${plural(n, "file", "files")}`,
  move: (n) => `moved ${plural(n, "file", "files")}`,
  trash: (n) => `moved ${plural(n, "file", "files")} to the trash`,
  shell: (n) => `ran ${plural(n, "command", "commands")}`,
  git: (n) => `ran ${plural(n, "git command", "git commands")}`,
  github: (n) => plural(n, "GitHub step", "GitHub steps"),
  web: (n) => plural(n, "web step", "web steps"),
  memory: (n) => plural(n, "memory call", "memory calls"),
  other: (n) => plural(n, "other tool call", "other tool calls"),
};
