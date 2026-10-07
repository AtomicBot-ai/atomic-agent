const NAME = "os.fs.trash";

export const OS_FS_TRASH_CONTRACT = {
  name: NAME,
  description: "When the user asks to delete, remove, or trash files or directories, move them to the system Trash / Recycle Bin (concrete absolute paths in paths). Prefer this over shell rm. Dangerous — always requires approval.",
  readonly: false,
  resourceClass: "approval_gated",
  descriptor: {
    name: NAME,
    summary: "When the user asks to delete, remove, erase, or trash files or directories: move them to the system Trash / Recycle Bin via absolute paths in paths (may require approval). Prefer this over os.shell.run rm.",
    argsSchema: "{ paths: string[] }"
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: {
          type: "string"
        }
      }
    },
    required: [
      "paths"
    ],
    additionalProperties: false
  }
} as const;

const MAX_PATHS_PER_CALL = 500;

export interface TrashArgs {
  paths: string[];
}

export function parseTrashArgs(rawArgs: Record<string, unknown>): TrashArgs {
  const rawPaths = rawArgs.paths;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    throw new Error(
      "os.fs.trash: `paths` must be a non-empty array of strings",
    );
  }
  if (rawPaths.length > MAX_PATHS_PER_CALL) {
    throw new Error(
      `os.fs.trash: at most ${MAX_PATHS_PER_CALL} paths per call (got ${rawPaths.length})`,
    );
  }
  const paths = rawPaths.map((v) => String(v));
  for (const p of paths) {
    if (p.length === 0) {
      throw new Error("os.fs.trash: each path must be a non-empty string");
    }
  }
  return { paths };
}
