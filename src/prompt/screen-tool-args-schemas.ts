/**
 * JSON Schemas for `os.screen.*` (ATO-525), spread into
 * `DEFAULT_TOOL_ARGS_SCHEMAS`. Same conventions as the main file
 * (`additionalProperties: false`, enums verbatim, shape not bounds) and
 * no keyword the strict-mode rewrite refuses, so all four convert.
 */

type Schema = Record<string, unknown>;

const numberSchema: Schema = { type: "number" };

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

export const SCREEN_TOOL_ARGS_SCHEMAS: readonly [string, Schema][] = [
  [
    "os.screen.capture",
    obj({
      region: obj(
        { x: numberSchema, y: numberSchema, width: numberSchema, height: numberSchema },
        ["x", "y", "width", "height"],
      ),
    }),
  ],
  [
    "os.screen.click",
    obj(
      {
        x: numberSchema,
        y: numberSchema,
        button: { type: "string", enum: ["left", "right"] },
        double: { type: "boolean" },
        scale: numberSchema,
      },
      ["x", "y"],
    ),
  ],
  [
    "os.screen.type",
    obj({ text: { type: "string" }, via: { type: "string", enum: ["keys", "paste"] } }, ["text"]),
  ],
  ["os.screen.key", obj({ keys: { type: "string" } }, ["keys"])],
];
