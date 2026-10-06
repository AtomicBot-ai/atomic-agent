const NAME = "os.fs.edit";

export const OS_FS_EDIT_CONTRACT = {
  name: NAME,
  description: "Surgically replace an exact substring in a UTF-8 text file. Requires `oldString` to be unique unless `replaceAll=true`. Atomic (temp-file + rename). Dangerous — always requires approval.",
  readonly: false,
  resourceClass: "approval_gated",
  descriptor: {
    "name": "os.fs.edit",
    "summary": "Surgical string replace; oldString must be unique unless replaceAll (may require approval).",
    "argsSchema": "{ path: string, oldString: string, newString: string, replaceAll?: boolean }"
  },
  argsJsonSchema: {
    "type": "object",
    "properties": {
      "path": {
        "type": "string"
      },
      "oldString": {
        "type": "string"
      },
      "newString": {
        "type": "string"
      },
      "replaceAll": {
        "type": "boolean"
      }
    },
    "required": [
      "path",
      "oldString",
      "newString"
    ],
    "additionalProperties": false
  },
} as const;


export interface EditArgs {
  path: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}


export function parseEditArgs(rawArgs: Record<string, unknown>): EditArgs {
  const path = rawArgs.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("os.fs.edit: `path` must be a non-empty string");
  }
  const oldString = rawArgs.oldString;
  if (typeof oldString !== "string" || oldString.length === 0) {
    throw new Error("os.fs.edit: `oldString` must be a non-empty string");
  }
  const newString = rawArgs.newString;
  if (typeof newString !== "string") {
    throw new Error("os.fs.edit: `newString` must be a string");
  }
  if (oldString === newString) {
    throw new Error("os.fs.edit: `newString` must differ from `oldString`");
  }
  const replaceAll = rawArgs.replaceAll === true;
  return { path, oldString, newString, replaceAll };
}
