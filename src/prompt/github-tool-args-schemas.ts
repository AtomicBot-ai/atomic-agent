/**
 * JSON Schemas for the git write tools and the `github.*` tools, spread
 * into `DEFAULT_TOOL_ARGS_SCHEMAS`. Same conventions as the main file
 * (`additionalProperties: false`, enums verbatim, shape not bounds).
 */

type Schema = Record<string, unknown>;

const stringSchema: Schema = { type: "string" };
const stringArraySchema: Schema = { type: "array", items: { type: "string" } };
const numberSchema: Schema = { type: "number" };
const booleanSchema: Schema = { type: "boolean" };
const stateSchema: Schema = { type: "string", enum: ["open", "closed", "all"] };

function obj(
  properties: Record<string, Schema>,
  required: readonly string[] = [],
): Schema {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

export const GITHUB_TOOL_ARGS_SCHEMAS: readonly [string, Schema][] = [
  [
    "os.git.checkout",
    obj(
      {
        branch: stringSchema,
        create: booleanSchema,
        startPoint: stringSchema,
        repo: stringSchema,
      },
      ["branch"],
    ),
  ],
  [
    "os.git.commit",
    obj(
      {
        message: stringSchema,
        paths: stringArraySchema,
        all: booleanSchema,
        repo: stringSchema,
      },
      ["message"],
    ),
  ],
  [
    "os.git.push",
    obj({
      remote: stringSchema,
      branch: stringSchema,
      setUpstream: booleanSchema,
      repo: stringSchema,
    }),
  ],

  // ── github ───────────────────────────────────────────────────────────────
  ["github.whoami", obj({})],
  [
    "github.pr.list",
    obj({
      repo: stringSchema,
      state: stateSchema,
      limit: numberSchema,
    }),
  ],
  [
    "github.pr.create",
    obj(
      {
        title: stringSchema,
        body: stringSchema,
        head: stringSchema,
        base: stringSchema,
        draft: booleanSchema,
        repo: stringSchema,
      },
      ["title"],
    ),
  ],
  [
    "github.issue.list",
    obj({
      repo: stringSchema,
      state: stateSchema,
      labels: stringArraySchema,
      limit: numberSchema,
    }),
  ],
  [
    "github.issue.create",
    obj(
      {
        title: stringSchema,
        body: stringSchema,
        labels: stringArraySchema,
        repo: stringSchema,
      },
      ["title"],
    ),
  ],
  [
    "github.issue.comment",
    obj(
      {
        number: numberSchema,
        body: stringSchema,
        repo: stringSchema,
      },
      ["number", "body"],
    ),
  ],

];
