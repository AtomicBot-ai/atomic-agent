const NAME = "os.fs.patch";

export const OS_FS_PATCH_CONTRACT = {
  name: NAME,
  description: "Apply a unified diff to files on disk. `apply=false` (default) does a DRY-RUN: it parses the patch, attempts to apply each hunk, and returns a preview report without touching the filesystem. `apply=true` writes the result — requires approval.",
  readonly: false,
  resourceClass: "approval_gated",
  descriptor: {
    name: NAME,
    summary: "Preview (default) or apply a unified-diff patch (apply=true may require approval).",
    argsSchema: "{ patch?: string, patchPath?: string, apply?: boolean, rootDir?: string, fuzzFactor?: number, stripComponents?: number }",
    tier: "rare"
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      patch: {
        type: "string"
      },
      patchPath: {
        type: "string"
      },
      apply: {
        type: "boolean"
      },
      rootDir: {
        type: "string"
      },
      fuzzFactor: {
        type: "number"
      },
      stripComponents: {
        type: "number"
      }
    },
    required: [],
    additionalProperties: false
  }
} as const;
