const NAME = "os.fs.grep";

export const OS_FS_GREP_CONTRACT = {
  name: NAME,
  description: "Fast regex search across files using bundled ripgrep (`literal: true` searches for the pattern as a fixed string). Supports three output modes (`content`, `files_with_matches`, `count`), glob filtering, file-type filtering, multiline mode, context lines, and pagination. Read-only.",
  readonly: true,
  resourceClass: "pure_read",
  descriptor: {
    name: NAME,
    summary: "Regex ripgrep for text search (content, files_with_matches, count). Best on source/text trees. Avoid tree-wide runs with glob *.pdf (or similar) over huge dirs—slow, binary-heavy, often flaky; prefer os.fs.glob by filename + os.fs.read_document on a small candidate set.",
    argsSchema: "{ pattern: string, path?: string, glob?: string | string[], type?: string, literal?: boolean, caseInsensitive?: boolean, multiline?: boolean, outputMode?: 'content' | 'files_with_matches' | 'count', contextBefore?: number, contextAfter?: number, contextAround?: number, headLimit?: number, offset?: number, showLineNumbers?: boolean, timeoutMs?: number }"
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string"
      },
      path: {
        type: "string"
      },
      glob: {
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
      type: {
        type: "string"
      },
      literal: {
        type: "boolean"
      },
      caseInsensitive: {
        type: "boolean"
      },
      multiline: {
        type: "boolean"
      },
      outputMode: {
        type: "string",
        enum: [
          "content",
          "files_with_matches",
          "count"
        ]
      },
      contextBefore: {
        type: "number"
      },
      contextAfter: {
        type: "number"
      },
      contextAround: {
        type: "number"
      },
      headLimit: {
        type: "number"
      },
      offset: {
        type: "number"
      },
      showLineNumbers: {
        type: "boolean"
      },
      timeoutMs: {
        type: "number"
      }
    },
    required: [
      "pattern"
    ],
    additionalProperties: false
  }
} as const;
