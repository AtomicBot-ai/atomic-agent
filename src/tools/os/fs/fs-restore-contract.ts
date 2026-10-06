const NAME = "os.fs.restore";

export const OS_FS_RESTORE_CONTRACT = {
  name: NAME,
  description: "Bring back the previous content of a file that os.fs.write / os.fs.edit / os.fs.patch replaced or shrank in this working directory — by this session or another (a fusion worker's included); the copy is saved automatically. Dangerous — always requires approval.",
  readonly: false,
  resourceClass: "approval_gated",
  descriptor: {
    name: NAME,
    summary: "Bring back the previous content of a file that os.fs.write / os.fs.edit / os.fs.patch replaced or shrank in this working directory, by this session or another — the result of that call said it was saved (may require approval).",
    argsSchema: "{ path: string }",
    tier: "rare"
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string"
      }
    },
    required: [
      "path"
    ],
    additionalProperties: false
  }
} as const;

export interface RestoreArgs {
  path: string;
}

export function parseRestoreArgs(rawArgs: Record<string, unknown>): RestoreArgs {
  const path = rawArgs.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("os.fs.restore: `path` must be a non-empty string");
  }
  return { path };
}
