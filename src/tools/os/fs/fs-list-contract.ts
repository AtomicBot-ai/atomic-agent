const NAME = "os.fs.list";

export const OS_FS_LIST_CONTRACT = {
  name: NAME,
  description: "List entries in a directory with optional filtering and sorting. " +
    "Args: path (required), pattern (glob like *.pdf or *foo*), " +
    "kind ('file'|'dir'), extensions (string[], e.g. ['pdf','docx']), " +
    "sort ('name'|'size'|'mtime', default 'name'), maxEntries (default 200). " +
    "Prefer this over `os.shell.run ls` when looking for specific files.",
  readonly: true,
  resourceClass: "pure_read",
  descriptor: {
    "name": "os.fs.list",
    "summary": "Non-recursive directory listing (default maxEntries=200). Header shows full totals—when matched/total is much larger than shown, narrow with extensions (e.g. [\"pdf\"]), pattern (glob-like *foo*), or sort (name|size|mtime); recurse with os.fs.glob. Do not treat the visible slice as the whole tree.",
    "argsSchema": "{ path: string, pattern?: string, kind?: \"file\" | \"dir\", extensions?: string[], sort?: \"name\" | \"size\" | \"mtime\", maxEntries?: number }"
  },
  argsJsonSchema: {
    "type": "object",
    "properties": {
      "path": {
        "type": "string"
      },
      "pattern": {
        "type": "string"
      },
      "kind": {
        "type": "string",
        "enum": [
          "file",
          "dir"
        ]
      },
      "extensions": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "sort": {
        "type": "string",
        "enum": [
          "name",
          "size",
          "mtime"
        ]
      },
      "maxEntries": {
        "type": "number"
      }
    },
    "required": [
      "path"
    ],
    "additionalProperties": false
  },
} as const;


export const DEFAULT_MAX_ENTRIES = 200;


export interface ParsedArgs {
  path: string;
  pattern: string | null;
  patternRegex: RegExp | null;
  kind: "file" | "dir" | null;
  extensions: string[] | null;
  sort: "name" | "size" | "mtime";
  maxEntries: number;
}


export function parseListArgs(raw: Record<string, unknown>): ParsedArgs {
  const path = raw.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("os.fs.list: `path` must be a non-empty string");
  }

  const maxEntries =
    typeof raw.maxEntries === "number" && Number.isFinite(raw.maxEntries)
      ? Math.max(1, Math.floor(raw.maxEntries))
      : DEFAULT_MAX_ENTRIES;

  const pattern =
    typeof raw.pattern === "string" && raw.pattern.length > 0
      ? raw.pattern
      : null;
  const patternRegex = pattern ? compileGlob(pattern) : null;

  let kind: "file" | "dir" | null = null;
  if (raw.kind === "file" || raw.kind === "dir") kind = raw.kind;

  let extensions: string[] | null = null;
  if (Array.isArray(raw.extensions)) {
    const cleaned = raw.extensions
      .filter((e): e is string => typeof e === "string" && e.length > 0)
      .map((e) => normaliseExt(e));
    if (cleaned.length > 0) extensions = cleaned;
  }

  let sort: ParsedArgs["sort"] = "name";
  if (raw.sort === "size" || raw.sort === "mtime" || raw.sort === "name") {
    sort = raw.sort;
  }

  return { path, pattern, patternRegex, kind, extensions, sort, maxEntries };
}


export function normaliseExt(input: string): string {
  return input.replace(/^\./, "").toLowerCase();
}


function compileGlob(pattern: string): RegExp {
  let body = "";
  for (const ch of pattern) {
    if (ch === "*") body += ".*";
    else if (ch === "?") body += ".";
    else body += escapeRegex(ch);
  }
  return new RegExp(`^${body}$`, "i");
}


function escapeRegex(ch: string): string {
  return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
