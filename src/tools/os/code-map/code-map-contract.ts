const NAME = "os.fs.code_map";

/**
 * `os.fs.code_map` (ATO-652): a ranked, token-budgeted outline of a
 * project, or the skeleton of one file. Import-free like the fs
 * contracts, so the prompt catalog and the schema map read it without
 * pulling the tool in.
 */
export const OS_FS_CODE_MAP_CONTRACT = {
  name: NAME,
  description:
    "Outline a code project within a token budget: the most-referenced files first, each with its top-level symbols (classes, functions, types, exported names) and line numbers. With path set to one file, list that file's whole skeleton (every class, function and method with its line). Reads TS/JS, Python, Go, Rust and Java. Read-only.",
  readonly: true,
  resourceClass: "pure_read",
  descriptor: {
    name: NAME,
    summary:
      "Map a code project before reading files: most-referenced files first, each with its key symbols and line numbers, within maxTokens. path = a folder (default: working dir) or one file (its full skeleton with lines, then os.fs.read with offset). focus = file paths or symbol names to centre the map on.",
    argsSchema: "{ path?: string, maxTokens?: number /* 200..8000 */, focus?: string[] }",
    examples: [
      "{}",
      "{\"path\":\"src/agent\",\"focus\":[\"AgentLoop\"]}",
      "{\"path\":\"src/agent/agent-loop.ts\"}",
    ],
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      maxTokens: { type: "number" },
      focus: { type: "array", items: { type: "string" } },
    },
    required: [],
    additionalProperties: false,
  },
} as const;

export const CODE_MAP_MIN_TOKENS = 200;
export const CODE_MAP_MAX_TOKENS = 8_000;
