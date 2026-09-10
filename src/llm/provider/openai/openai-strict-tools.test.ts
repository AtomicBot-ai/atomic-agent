import { describe, expect, it } from "vitest";

import {
  toStrictOpenAiTools,
  toStrictParameters,
  withoutTopLevelNullArgs,
} from "./openai-strict-tools.js";
import {
  descriptorsToOpenAiTools,
  openAiToolCallAdapter,
  withStrictNullArgumentDrop,
} from "./openai-tool-call-adapter.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../../prompt/tool-descriptors.js";

type Schema = Record<string, unknown>;

function isPlainObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeIncludes(schema: Schema, wanted: string): boolean {
  const type = schema.type;
  if (typeof type === "string") return type === wanted;
  if (Array.isArray(type)) return type.includes(wanted);
  return false;
}

/**
 * Keywords a strict schema may carry. Anything else present after the
 * transform is a keyword we failed to strip, which is what makes a
 * provider 400 the entire request rather than the one tool.
 */
const ALLOWED_KEYWORDS = new Set([
  "type",
  "enum",
  "description",
  "title",
  "$ref",
  "$defs",
  "anyOf",
  "properties",
  "items",
  "required",
  "additionalProperties",
]);

/**
 * Asserts every strict-mode rule, recursively, and returns the list of
 * violations so a failure names the exact node rather than dumping the
 * whole schema. Shared by the unit tests and by the conformance sweep
 * over every tool the agent actually registers.
 */
function strictViolations(node: unknown, path = "$"): string[] {
  if (!isPlainObject(node)) return [`${path}: not an object schema`];
  const problems: string[] = [];
  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      problems.push(`${path}: unsupported keyword "${key}"`);
    }
  }
  if (typeIncludes(node, "object")) {
    if (node.additionalProperties !== false) {
      problems.push(`${path}: additionalProperties must be false`);
    }
    const properties = isPlainObject(node.properties) ? node.properties : {};
    const keys = Object.keys(properties);
    const required = Array.isArray(node.required) ? node.required : [];
    for (const key of keys) {
      if (!required.includes(key)) {
        problems.push(`${path}: "${key}" missing from required`);
      }
      problems.push(...strictViolations(properties[key], `${path}.${key}`));
    }
    for (const name of required) {
      if (!keys.includes(String(name))) {
        problems.push(`${path}: required lists undeclared "${String(name)}"`);
      }
    }
  }
  if (typeIncludes(node, "array")) {
    if (!isPlainObject(node.items)) {
      problems.push(`${path}: array without an items schema`);
    } else {
      problems.push(...strictViolations(node.items, `${path}[]`));
    }
  }
  if (node.anyOf !== undefined) {
    if (!Array.isArray(node.anyOf) || node.anyOf.length === 0) {
      problems.push(`${path}: anyOf must be a non-empty array`);
    } else {
      node.anyOf.forEach((branch, index) => {
        problems.push(...strictViolations(branch, `${path}|${index}`));
      });
    }
  }
  if (isPlainObject(node.$defs)) {
    for (const [name, def] of Object.entries(node.$defs)) {
      problems.push(...strictViolations(def, `${path}#${name}`));
    }
  }
  return problems;
}

describe("toStrictParameters — the transform", () => {
  const cases: ReadonlyArray<{
    name: string;
    input: Schema;
    strict: boolean;
    expected?: Schema;
  }> = [
    {
      name: "closes an object and keeps a required scalar as it was",
      input: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      strict: true,
      expected: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "expresses an optional parameter as nullable, still required",
      input: {
        type: "object",
        properties: {
          path: { type: "string" },
          limit: { type: "integer" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      strict: true,
      expected: {
        type: "object",
        properties: {
          path: { type: "string" },
          limit: { type: ["integer", "null"] },
        },
        required: ["path", "limit"],
        additionalProperties: false,
      },
    },
    {
      name: "adds null to an optional enum's members as well as its type",
      input: {
        type: "object",
        properties: { mode: { type: "string", enum: ["a", "b"] } },
        additionalProperties: false,
      },
      strict: true,
      expected: {
        type: "object",
        properties: {
          mode: { type: ["string", "null"], enum: ["a", "b", null] },
        },
        required: ["mode"],
        additionalProperties: false,
      },
    },
    {
      name: "appends a null branch to an optional anyOf",
      input: {
        type: "object",
        properties: {
          amount: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
        required: [],
        additionalProperties: false,
      },
      strict: true,
      expected: {
        type: "object",
        properties: {
          amount: {
            anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
          },
        },
        required: ["amount"],
        additionalProperties: false,
      },
    },
    {
      name: "recurses into a nested object and closes that too",
      input: {
        type: "object",
        properties: {
          limits: {
            type: "object",
            properties: { maxEntries: { type: "integer" } },
            additionalProperties: true,
          },
        },
        required: ["limits"],
        additionalProperties: false,
      },
      strict: true,
      expected: {
        type: "object",
        properties: {
          limits: {
            type: "object",
            properties: { maxEntries: { type: ["integer", "null"] } },
            required: ["maxEntries"],
            additionalProperties: false,
          },
        },
        required: ["limits"],
        additionalProperties: false,
      },
    },
    {
      name: "recurses into an array of objects",
      input: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                goal: { type: "string" },
                files: { type: "array", items: { type: "string" } },
              },
              required: ["goal"],
            },
            minItems: 1,
            maxItems: 8,
          },
        },
        required: ["tasks"],
        additionalProperties: false,
      },
      strict: true,
      expected: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                goal: { type: "string" },
                files: { type: ["array", "null"], items: { type: "string" } },
              },
              required: ["goal", "files"],
              additionalProperties: false,
            },
          },
        },
        required: ["tasks"],
        additionalProperties: false,
      },
    },
    {
      name: "strips the value-range keywords strict mode does not accept",
      input: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, pattern: "^x", format: "uri" },
          count: { type: "integer", minimum: 1, maximum: 9, default: 3 },
        },
        required: ["text", "count"],
        additionalProperties: false,
      },
      strict: true,
      expected: {
        type: "object",
        properties: {
          text: { type: "string" },
          count: { type: "integer" },
        },
        required: ["text", "count"],
        additionalProperties: false,
      },
    },
    {
      name: "renames oneOf to the anyOf spelling strict mode documents",
      input: {
        type: "object",
        properties: { v: { oneOf: [{ type: "string" }, { type: "number" }] } },
        required: ["v"],
        additionalProperties: false,
      },
      strict: true,
      expected: {
        type: "object",
        properties: {
          v: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
        required: ["v"],
        additionalProperties: false,
      },
    },
    {
      name: "keeps a zero-argument tool strict when it is already closed",
      input: { type: "object", properties: {}, additionalProperties: false },
      strict: true,
      expected: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    {
      name: "refuses the open-object fallback rather than deleting its args",
      input: { type: "object", properties: {}, additionalProperties: true },
      strict: false,
    },
    {
      name: "refuses a typed open map — the map is the payload",
      input: {
        type: "object",
        properties: {
          headers: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["headers"],
        additionalProperties: false,
      },
      strict: false,
    },
    {
      name: "refuses composition strict mode cannot model",
      input: {
        type: "object",
        properties: { v: { allOf: [{ type: "string" }] } },
        required: ["v"],
        additionalProperties: false,
      },
      strict: false,
    },
    {
      name: "refuses tuple items",
      input: {
        type: "object",
        properties: {
          pair: { type: "array", items: [{ type: "string" }] },
        },
        required: ["pair"],
        additionalProperties: false,
      },
      strict: false,
    },
    {
      name: "refuses a non-object root",
      input: { type: "string" },
      strict: false,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = toStrictParameters(testCase.input);
      expect(result.strict).toBe(testCase.strict);
      if (testCase.expected) {
        expect(result.parameters).toEqual(testCase.expected);
        expect(strictViolations(result.parameters)).toEqual([]);
      } else {
        // A refusal must hand the schema back untouched — the tool
        // still has to work, just without constrained decoding.
        expect(result.parameters).toBe(testCase.input);
      }
    });
  }

  it("is idempotent — a second pass changes nothing", () => {
    for (const testCase of cases) {
      const once = toStrictParameters(testCase.input);
      const twice = toStrictParameters(once.parameters);
      expect(twice.strict).toBe(once.strict);
      expect(twice.parameters).toEqual(once.parameters);
    }
  });

  it("never mutates the schema it was given", () => {
    const input: Schema = {
      type: "object",
      properties: { a: { type: "string", minLength: 2 } },
      required: [],
    };
    const snapshot = structuredClone(input);
    toStrictParameters(input);
    expect(input).toEqual(snapshot);
  });
});

describe("toStrictOpenAiTools", () => {
  it("marks a convertible function strict and leaves the rest of the entry alone", () => {
    const [tool] = toStrictOpenAiTools([
      {
        type: "function",
        function: {
          name: "os__fs__read",
          description: "read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ]);
    expect(tool).toEqual({
      type: "function",
      function: {
        name: "os__fs__read",
        description: "read a file",
        strict: true,
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    });
  });

  it("marks an unconvertible function strict:false and keeps its schema", () => {
    const parameters = {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
    const [tool] = toStrictOpenAiTools([
      { type: "function", function: { name: "mystery", parameters } },
    ]);
    expect((tool.function as Schema).strict).toBe(false);
    expect((tool.function as Schema).parameters).toBe(parameters);
  });

  it("passes through an entry that is not a function tool", () => {
    const entry = { type: "custom", custom: { name: "x" } };
    expect(toStrictOpenAiTools([entry])[0]).toBe(entry);
  });
});

/**
 * The test that says this will not 400 in the field.
 *
 * Every descriptor the agent registers goes through the same adapter a
 * real turn uses, then through the transform, and every resulting
 * schema is checked against every strict-mode rule recursively. A new
 * tool whose schema uses a keyword we do not strip fails here rather
 * than at the provider, where the whole request dies — not just that
 * tool.
 */
describe("strict-tool conformance over every registered tool", () => {
  const tools = descriptorsToOpenAiTools(DEFAULT_TOOL_DESCRIPTORS);
  const strictTools = toStrictOpenAiTools(tools);

  it("sweeps the real catalog, not a handful of fixtures", () => {
    expect(DEFAULT_TOOL_DESCRIPTORS.length).toBeGreaterThan(50);
    // The adapter dedupes escaped names and appends reply/finish, so
    // this is the tool array a turn actually sends, one for one.
    expect(strictTools.length).toBe(tools.length);
    expect(tools.length).toBeGreaterThan(50);
  });

  for (const tool of strictTools) {
    const fn = tool.function as Schema;
    const name = String(fn.name);
    it(`${name}: schema conforms, or is honestly marked non-strict`, () => {
      if (fn.strict !== true) {
        // The only sanctioned refusals are free-form maps: a tool whose
        // arguments cannot be enumerated. Closing one would silently
        // strip the payload, so it travels unconstrained instead.
        expect(fn.strict).toBe(false);
        return;
      }
      expect(strictViolations(fn.parameters)).toEqual([]);
    });
  }

  it("refuses only the free-form-map tools, and marks everything else strict", () => {
    const refused = strictTools
      .filter((tool) => (tool.function as Schema).strict !== true)
      .map((tool) => String((tool.function as Schema).name));
    // `os.http.request` carries a free-form header map and a free-form
    // JSON body; `mcp.prompt.get` forwards a server-defined argument
    // map. Both are the tool's actual payload, so neither can be closed.
    expect(refused).toEqual(["os__http__request", "mcp__prompt__get"]);
  });

  it("is idempotent across the whole catalog", () => {
    expect(toStrictOpenAiTools(strictTools)).toEqual(strictTools);
  });
});

describe("withoutTopLevelNullArgs — the response side of strict mode", () => {
  it("drops a top-level null so a presence check still reads 'absent'", () => {
    // `os.git.init` branches on `args.userName !== undefined`; under
    // strict mode the model sends an explicit null instead of omitting
    // the key, which would otherwise take the configure-identity branch
    // with nothing to configure.
    expect(
      withoutTopLevelNullArgs({
        path: "/repo",
        userName: null,
        userEmail: null,
      }),
    ).toEqual({ path: "/repo" });
  });

  it("keeps a null nested inside an argument — that is data", () => {
    expect(
      withoutTopLevelNullArgs({ body: { note: null }, items: [null] }),
    ).toEqual({ body: { note: null }, items: [null] });
  });

  it("keeps falsy-but-present values", () => {
    const args = { count: 0, flag: false, text: "" };
    expect(withoutTopLevelNullArgs(args)).toBe(args);
  });

  it("returns the same object when there is nothing to drop", () => {
    const args = { path: "/repo" };
    expect(withoutTopLevelNullArgs(args)).toBe(args);
  });
});

describe("withStrictNullArgumentDrop", () => {
  const call = (args: Record<string, unknown>) => [
    {
      id: "call_1",
      type: "function" as const,
      function: { name: "os__git__init", arguments: JSON.stringify(args) },
    },
  ];

  it("strips nulls from every call in the batch", () => {
    const wrapped = withStrictNullArgumentDrop(openAiToolCallAdapter);
    const batch = wrapped.toolCallsToBatch(
      call({ path: "/repo", userName: null }),
    );
    expect(batch.calls[0]).toEqual({
      tool: "os.git.init",
      args: { path: "/repo" },
    });
  });

  it("leaves the unwrapped adapter's behaviour alone", () => {
    const batch = openAiToolCallAdapter.toolCallsToBatch(
      call({ path: "/repo", userName: null }),
    );
    expect(batch.calls[0].args).toEqual({ path: "/repo", userName: null });
  });
});
