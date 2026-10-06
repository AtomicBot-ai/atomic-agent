const NAME = "os.fs.watch";

export const OS_FS_WATCH_CONTRACT = {
  name: NAME,
  description: "Watch a file or directory for changes for up to `timeoutMs` (default 5s, cap 60s). Returns a list of events. This is a one-shot, blocking watch — use when you know a change is imminent.",
  readonly: true,
  resourceClass: "pure_read",
  descriptor: {
    name: NAME,
    summary: "One-shot file/dir watch up to timeoutMs. Read-only.",
    argsSchema: "{ path: string, timeoutMs?: number, recursive?: boolean, events?: ('add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir')[], ignoreInitial?: boolean, maxEvents?: number, stopAfterFirst?: boolean }",
    tier: "rare"
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string"
      },
      timeoutMs: {
        type: "number"
      },
      recursive: {
        type: "boolean"
      },
      events: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "add",
            "change",
            "unlink",
            "addDir",
            "unlinkDir"
          ]
        }
      },
      ignoreInitial: {
        type: "boolean"
      },
      maxEvents: {
        type: "number"
      },
      stopAfterFirst: {
        type: "boolean"
      }
    },
    required: [
      "path"
    ],
    additionalProperties: false
  }
} as const;
