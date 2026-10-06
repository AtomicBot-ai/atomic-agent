const NAME = "os.fs.diff";

export const OS_FS_DIFF_CONTRACT = {
  name: NAME,
  description: "Generate a git-style unified diff between two files (aPath vs bPath) or two inline strings (aText vs bText). Read-only. Use labels to customise the +++/--- headers.",
  readonly: true,
  resourceClass: "pure_read",
  descriptor: {
    "name": "os.fs.diff",
    "summary": "Unified diff: files and/or inline strings. Read-only.",
    "argsSchema": "{ aPath?: string, aText?: string, aLabel?: string, bPath?: string, bText?: string, bLabel?: string, context?: number, ignoreWhitespace?: boolean }",
    "tier": "rare"
  },
  argsJsonSchema: {
    "type": "object",
    "properties": {
      "aPath": {
        "type": "string"
      },
      "aText": {
        "type": "string"
      },
      "aLabel": {
        "type": "string"
      },
      "bPath": {
        "type": "string"
      },
      "bText": {
        "type": "string"
      },
      "bLabel": {
        "type": "string"
      },
      "context": {
        "type": "number"
      },
      "ignoreWhitespace": {
        "type": "boolean"
      }
    },
    "required": [],
    "additionalProperties": false
  },
} as const;


/**
 * Inputs for `os.fs.diff`. Either provide two paths (diff on disk) or two
 * inline strings (diff arbitrary snippets without touching the filesystem).
 * Path/string modes cannot be mixed within a single "side": setting both
 * `aPath` and `aText` (or both `bPath` and `bText`) is rejected.
 */
export interface DiffArgs {
  aPath?: string;
  aText?: string;
  aLabel: string;
  bPath?: string;
  bText?: string;
  bLabel: string;
  context: number;
  ignoreWhitespace: boolean;
}


const DEFAULT_CONTEXT = 3;


export function parseDiffArgs(rawArgs: Record<string, unknown>, basename: (path: string) => string): DiffArgs {
  const { aPath, aText } = parseSide(rawArgs.aPath, rawArgs.aText, "a");
  const { aPath: bPath, aText: bText } = parseSide(
    rawArgs.bPath,
    rawArgs.bText,
    "b",
  );
  const aLabel = parseLabel(rawArgs.aLabel, aPath, "a", basename);
  const bLabel = parseLabel(rawArgs.bLabel, bPath, "b", basename);
  const context = parsePositiveInt(rawArgs.context, DEFAULT_CONTEXT, "context");
  const ignoreWhitespace = rawArgs.ignoreWhitespace === true;
  return {
    aPath,
    aText,
    aLabel,
    bPath: bPath,
    bText: bText,
    bLabel,
    context,
    ignoreWhitespace,
  };
}


function parseSide(
  rawPath: unknown,
  rawText: unknown,
  side: string,
): { aPath?: string; aText?: string } {
  const hasPath = typeof rawPath === "string" && rawPath.length > 0;
  const hasText = typeof rawText === "string";
  if (!hasPath && !hasText) {
    throw new Error(
      `os.fs.diff: side ${side} requires either \`${side}Path\` or \`${side}Text\``,
    );
  }
  if (hasPath && hasText) {
    throw new Error(
      `os.fs.diff: side ${side} must not set both \`${side}Path\` and \`${side}Text\``,
    );
  }
  return hasPath ? { aPath: rawPath as string } : { aText: rawText as string };
}


function parseLabel(
  raw: unknown,
  path: string | undefined,
  side: string,
  basename: (path: string) => string,
): string {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (path) return basename(path);
  return side;
}


function parsePositiveInt(
  raw: unknown,
  fallback: number,
  field: string,
): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new Error(`os.fs.diff: \`${field}\` must be a non-negative number`);
  }
  return Math.floor(raw);
}
