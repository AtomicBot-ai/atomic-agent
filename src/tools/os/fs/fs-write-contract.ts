const NAME = "os.fs.write";

export const OS_FS_WRITE_CONTRACT = {
  name: NAME,
  description: "Write text content to a file (creating parents). Dangerous — always requires approval.",
  readonly: false,
  resourceClass: "approval_gated",
  descriptor: {
    name: NAME,
    summary: "Write or append to a file (may require approval). The result says when it replaced a pre-existing file and with what line counts; a replaced pre-existing file can be brought back with os.fs.restore. A file the request names as an input is refused without overwrite: true — edit it in place instead.",
    argsSchema: "{ path: string, content: string, mode?: \"replace\" | \"append\", overwrite?: boolean /* only when the user asked for that named file to be replaced */ }"
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string"
      },
      content: {
        type: "string"
      },
      mode: {
        type: "string",
        enum: [
          "replace",
          "append"
        ]
      },
      overwrite: {
        type: "boolean"
      }
    },
    required: [
      "path",
      "content"
    ],
    additionalProperties: false
  }
} as const;

export interface WriteArgs {
  path: string;
  content: string;
  mode: "append" | "replace";
  overwrite: boolean;
}

export function parseWriteArgs(rawArgs: Record<string, unknown>): WriteArgs {
  const path = rawArgs.path;
  const content = rawArgs.content;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("os.fs.write: `path` must be a non-empty string");
  }
  if (typeof content !== "string") {
    throw new Error("os.fs.write: `content` must be a string");
  }
  const mode =
    typeof rawArgs.mode === "string" && rawArgs.mode === "append"
      ? "append"
      : "replace";
  const overwrite = rawArgs.overwrite === true;
  return { path, content, mode, overwrite };
}
