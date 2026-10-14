const NAME = "os.fs.move";

export const OS_FS_MOVE_CONTRACT = {
  name: NAME,
  description: "Move or rename files and folders, creating missing parent folders; many at once through moves. An existing file is replaced only with overwrite: true (its previous content is saved for os.fs.restore). Dangerous — always requires approval.",
  readonly: false,
  resourceClass: "approval_gated",
  descriptor: {
    name: NAME,
    summary: "Move or rename files and folders (may require approval). Creates missing folders and takes paths with spaces as they are — use it instead of shell mv/move/ren/mkdir to sort files into folders; many files go in one call via moves.",
    argsSchema: "{ from: string, to: string, overwrite?: boolean } | { moves: { from: string, to: string }[], overwrite?: boolean } /* a `to` ending in / (or \\ on Windows), or naming an existing folder, moves the item inside it */",
    tier: "rare"
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      from: {
        type: "string"
      },
      to: {
        type: "string"
      },
      moves: {
        type: "array",
        // Bounds the strict compilers cannot express: they keep this
        // tool non-strict, as the nested item object requires.
        minItems: 1,
        maxItems: 500,
        items: {
          type: "object",
          properties: {
            from: {
              type: "string"
            },
            to: {
              type: "string"
            }
          },
          required: [
            "from",
            "to"
          ],
          additionalProperties: false
        }
      },
      overwrite: {
        type: "boolean"
      }
    },
    required: [],
    additionalProperties: false
  }
} as const;

/** Same ceiling as `os.fs.trash`: one approval for a whole reorganise, not an unbounded one. */
export const MAX_MOVES_PER_CALL = 500;

export interface MoveItem {
  from: string;
  to: string;
}

export interface MoveArgs {
  moves: MoveItem[];
  overwrite: boolean;
}

/**
 * `null` and `""` count as absent: a strict native-tools provider sends
 * every unused optional field, as null or as an empty string.
 */
function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * `{ from, to }` or `{ moves: [{ from, to }, …] }`, never both: a call
 * that mixes them is ambiguous about which list is the whole job.
 */
export function parseMoveArgs(rawArgs: Record<string, unknown>): MoveArgs {
  const rawMoves = rawArgs.moves;
  const from = rawArgs.from;
  const to = rawArgs.to;
  const overwrite = rawArgs.overwrite === true;
  if (given(rawMoves)) {
    if (given(from) || given(to)) {
      throw new Error(
        "os.fs.move: pass either `from` and `to`, or `moves` — not both",
      );
    }
    if (!Array.isArray(rawMoves) || rawMoves.length === 0) {
      throw new Error(
        "os.fs.move: `moves` must be a non-empty array of { from, to }",
      );
    }
    if (rawMoves.length > MAX_MOVES_PER_CALL) {
      throw new Error(
        `os.fs.move: at most ${MAX_MOVES_PER_CALL} moves per call (got ${rawMoves.length})`,
      );
    }
    const moves = rawMoves.map((entry: unknown, index: number) => {
      const item =
        typeof entry === "object" && entry !== null
          ? (entry as Record<string, unknown>)
          : {};
      if (!nonEmptyString(item.from) || !nonEmptyString(item.to)) {
        throw new Error(
          `os.fs.move: moves[${index}] needs a non-empty \`from\` and \`to\``,
        );
      }
      return { from: item.from, to: item.to };
    });
    return { moves, overwrite };
  }
  if (!nonEmptyString(from)) {
    throw new Error(
      "os.fs.move: `from` must be a non-empty string (or pass `moves`)",
    );
  }
  if (!nonEmptyString(to)) {
    throw new Error("os.fs.move: `to` must be a non-empty string");
  }
  return { moves: [{ from, to }], overwrite };
}
