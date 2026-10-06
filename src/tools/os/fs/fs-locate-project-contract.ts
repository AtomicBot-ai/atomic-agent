const NAME = "os.fs.locate_project";

export const OS_FS_LOCATE_PROJECT_CONTRACT = {
  name: NAME,
  description: "Resolve a project directory from a short folder-name segment the user mentioned (raylib finds .../_raylib). Pass only that segment or a pasted absolute path as name, never the whole sentence. Searches only the session working dir and its ancestors, recent session dirs, and the user-configured projects.roots (one level deep). Never scans the whole disk. On multiple matches, ask the user to pick one; on no match, ask for the full path.",
  readonly: true,
  resourceClass: "pure_read",
  descriptor: {
    name: NAME,
    summary: "Resolve a project directory from a short folder-name segment the user mentioned (raylib finds .../_raylib). Pass only that segment or a pasted absolute path as name, never the whole sentence. Searches the session cwd + ancestors, recent session dirs, and configured projects.roots (one level; never a whole-disk scan). Single match: use the returned path. Multiple: ask the user to pick. None: ask for the full path.",
    argsSchema: "{ name: string, limit?: number }",
    examples: [
      "{\"name\":\"raylib\"}",
      "{\"name\":\"tasks-board\"}"
    ]
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      name: {
        type: "string"
      },
      limit: {
        type: "number"
      }
    },
    required: [
      "name"
    ],
    additionalProperties: false
  }
} as const;
