/**
 * JSON Schemas for `os.screen.*` (ATO-525), spread into
 * `DEFAULT_TOOL_ARGS_SCHEMAS`. Same conventions as the main file
 * (`additionalProperties: false`, enums verbatim, shape not bounds) and
 * no keyword the strict-mode rewrite refuses, so the first four convert;
 * `os.screen.point` nests its marks and stays non-strict on purpose.
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
    // The region is flat (all four or none): no strict-converted schema
    // nests an object (openai-tool-call-adapter.test.ts pins it).
    obj({ x: numberSchema, y: numberSchema, width: numberSchema, height: numberSchema }),
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
  [
    "os.screen.point",
    // The marks nest an object, so the item bounds keep this one off
    // the strict path (like `fusion.delegate`): a strict form would nest.
    obj(
      {
        marks: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: obj(
            {
              kind: { type: "string", enum: ["arrow", "box", "label"] },
              x: numberSchema,
              y: numberSchema,
              width: numberSchema,
              height: numberSchema,
              text: { type: "string" },
              step: { type: "integer" },
            },
            ["kind", "x", "y"],
          ),
        },
        coords: { type: "string", enum: ["image", "points"] },
        seconds: numberSchema,
      },
      ["marks"],
    ),
  ],
];
