/**
 * Which registered tools READ the filesystem, and which of their
 * arguments name what they read. Shared by the session read scope and
 * the narrower fusion-worker one (`read-scope.ts`).
 */

export type ReadTargetsOf = (args: Record<string, unknown>) => string[];

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const pathArg: ReadTargetsOf = (args) => {
  const path = nonEmpty(args.path);
  return path === undefined ? [] : [path];
};

/**
 * The read-class filesystem tools and the argument(s) naming what they
 * read. A search tool's omitted root is the working directory, which is
 * inside by definition, so it contributes nothing to check.
 */
export const READ_TOOL_TARGETS: ReadonlyMap<string, ReadTargetsOf> = new Map<
  string,
  ReadTargetsOf
>([
  ["os.fs.read", pathArg],
  ["os.fs.list", pathArg],
  ["os.fs.hash", pathArg],
  ["os.fs.watch", pathArg],
  ["os.fs.read_document", pathArg],
  ["os.fs.archive.list", pathArg],
  ["os.fs.archive.read_entry", pathArg],
  ["os.fs.grep", pathArg],
  [
    "os.fs.glob",
    // `cwd` wins over `path` inside the tool; either names the root.
    (args) => {
      const root = nonEmpty(args.cwd) ?? nonEmpty(args.path);
      return root === undefined ? [] : [root];
    },
  ],
  [
    "os.fs.diff",
    (args) =>
      [nonEmpty(args.aPath), nonEmpty(args.bPath)].filter(
        (path): path is string => path !== undefined,
      ),
  ],
  [
    "vision.describe",
    (args) =>
      [
        nonEmpty(args.path),
        ...(Array.isArray(args.paths) ? args.paths.map(nonEmpty) : []),
      ].filter((path): path is string => path !== undefined),
  ],
  [
    // A syntax check reads every file it is handed.
    "verify.syntax",
    (args) =>
      (Array.isArray(args.files) ? args.files.map(nonEmpty) : []).filter(
        (path): path is string => path !== undefined,
      ),
  ],
]);

/** The shell tool, checked by token rather than by a named argument. */
export const SHELL_TOOL = "os.shell.run";

/** `https://…`, `data:…` — not a filesystem path, not this module's business. */
export const URL_LIKE = /^[a-z][a-z0-9+.-]*:(?:\/\/|[^\\/])/i;
