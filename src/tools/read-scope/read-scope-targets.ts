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
  // A folder to map or one file to outline; omitted = the working dir.
  ["os.fs.code_map", pathArg],
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
    // The first frame of an image-to-video clip: Core reads the file and
    // sends it to OpenRouter, so it is scoped like any read.
    "video.generate",
    (args) => {
      const image = nonEmpty(args.image);
      return image === undefined ? [] : [image];
    },
  ],
  [
    // whisper.cpp reads the recording: scoped like any read (ATO-702).
    "audio.transcribe",
    (args) => {
      const path = nonEmpty(args.path);
      return path === undefined ? [] : [path];
    },
  ],
  [
    // Not a read, but a way to one: a file moved from outside the scope
    // into the working directory could then be read without asking. Its
    // sources are checked like reads; destinations are writes, which the
    // approval ladder classifies.
    "os.fs.move",
    (args) =>
      (Array.isArray(args.moves) ? args.moves : [args])
        .map((item: unknown) =>
          typeof item === "object" && item !== null
            ? nonEmpty((item as Record<string, unknown>).from)
            : undefined,
        )
        .filter((path): path is string => path !== undefined),
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

/** Runs a command like the shell does, so its commands get the shell's checks. */
export const VERIFY_TOOL = "verify.run";

/**
 * The commands a `verify.run` call would start, in the shape the shell
 * checks read (`{cmd, args}`). Taken from the raw arguments, whatever
 * the `kind`, because this runs before the tool validates them.
 */
export function verifyRunShellCalls(
  args: Record<string, unknown>,
): Record<string, unknown>[] {
  const calls: Record<string, unknown>[] = [];
  if (typeof args.cmd === "string") calls.push({ cmd: args.cmd, args: args.args });
  const start = args.start;
  if (typeof start === "object" && start !== null) {
    const { cmd, args: startArgs } = start as Record<string, unknown>;
    if (typeof cmd === "string") calls.push({ cmd, args: startArgs });
  }
  return calls;
}

/** `https://…`, `data:…` — not a filesystem path, not this module's business. */
export const URL_LIKE = /^[a-z][a-z0-9+.-]*:(?:\/\/|[^\\/])/i;
