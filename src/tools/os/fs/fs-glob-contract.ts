const NAME = "os.fs.glob";

export const OS_FS_GLOB_CONTRACT = {
  name: NAME,
  description: "Recursively find files matching one or more glob patterns. Supports `*` (any chars except `/`), `**` (any path segments), `?` (single char), and `{a,b}` brace expansion. Search root is `cwd` or `path` (same meaning; if both are set, `cwd` wins). Returns POSIX-style paths relative to that root by default. The whole tree (minus `ignore`) is walked first, then sorted (alphabetically, or by mtime when `sortByMtime=true`), then sliced to `limit` — so `limit` is always applied to the best results, not to walk-order leftovers. Pass `nocase=true` for case-insensitive matching (e.g. `**/*cv*` then matches both `CV.pdf` and `cv.pdf`).",
  readonly: true,
  resourceClass: "pure_read",
  descriptor: {
    name: NAME,
    summary: "Recursive path match under cwd or path (prefer cwd; default: session working directory). For large trees use tight patterns (e.g. **/*CV*.pdf, **/*resume*.pdf), sensible limit, sortByMtime when freshness matters; pass nocase=true to match regardless of case (covers CV/cv/Cv in one pass). Walk traverses the whole tree (minus ignore) before sorting and slicing to limit, so limit reliably gives you the best matches. Default ignore covers common caches (.cache, Library, node_modules, .cargo, __pycache__, etc.)—override with explicit ignore if you need to look there.",
    argsSchema: "{ pattern: string | string[], cwd?: string, path?: string, ignore?: string[], absolute?: boolean, limit?: number, sortByMtime?: boolean, nocase?: boolean }"
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      pattern: {
        anyOf: [
          {
            type: "string"
          },
          {
            type: "array",
            items: {
              type: "string"
            }
          }
        ]
      },
      cwd: {
        type: "string"
      },
      path: {
        type: "string"
      },
      ignore: {
        type: "array",
        items: {
          type: "string"
        }
      },
      absolute: {
        type: "boolean"
      },
      limit: {
        type: "number"
      },
      sortByMtime: {
        type: "boolean"
      },
      nocase: {
        type: "boolean"
      }
    },
    required: [
      "pattern"
    ],
    additionalProperties: false
  }
} as const;
