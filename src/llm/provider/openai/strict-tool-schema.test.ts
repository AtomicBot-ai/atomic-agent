import { describe, it, expect } from "vitest";
import { toStrictJsonSchema } from "./strict-tool-schema.js";
import { getDefaultArgsJsonSchema } from "../../../prompt/default-tool-args-schemas.js";

describe("toStrictJsonSchema", () => {
  it("closes the object and promotes every property into required", () => {
    expect(
      toStrictJsonSchema({
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "number" } },
        required: ["path"],
        additionalProperties: false,
      }),
    ).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: ["number", "null"] },
      },
      required: ["path", "limit"],
      additionalProperties: false,
    });
  });

  it("adds the closing keywords a descriptor left implicit", () => {
    expect(
      toStrictJsonSchema({
        type: "object",
        properties: { text: { type: "string", description: "why" } },
      }),
    ).toEqual({
      type: "object",
      properties: {
        text: { type: ["string", "null"], description: "why" },
      },
      required: ["text"],
      additionalProperties: false,
    });
  });

  it("widens an optional enum's members as well as its type", () => {
    const strict = toStrictJsonSchema({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["replace", "append"] },
      },
      required: [],
      additionalProperties: false,
    });
    // A widened `type` with an un-widened `enum` contradicts itself and
    // nothing validates, so `null` has to join the members too.
    expect(strict?.properties).toEqual({
      mode: { type: ["string", "null"], enum: ["replace", "append", null] },
    });
  });

  it("makes an optional union nullable by adding a branch", () => {
    const strict = toStrictJsonSchema({
      type: "object",
      properties: {
        pattern: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
      },
      additionalProperties: false,
    });
    expect(strict?.properties).toEqual({
      pattern: {
        anyOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
          { type: "null" },
        ],
      },
    });
  });

  it("recurses into arrays and nested objects", () => {
    const strict = toStrictJsonSchema({
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, note: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    });
    expect(strict?.properties).toEqual({
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            note: { type: ["string", "null"] },
          },
          required: ["id", "note"],
          additionalProperties: false,
        },
      },
    });
  });

  it("never mutates the schema it was handed", () => {
    const source = {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "number" } },
      required: ["path"],
    };
    const snapshot = JSON.stringify(source);
    toStrictJsonSchema(source);
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  describe("refuses what it cannot rewrite faithfully", () => {
    it("refuses the open-object fallback", () => {
      // Closing this would silently turn every unschema'd tool into a
      // zero-argument tool.
      expect(
        toStrictJsonSchema({
          type: "object",
          properties: {},
          additionalProperties: true,
        }),
      ).toBeNull();
    });

    it("refuses a keyword the strict compiler does not implement", () => {
      expect(
        toStrictJsonSchema({
          type: "object",
          properties: { text: { type: "string", minLength: 1 } },
          required: ["text"],
          additionalProperties: false,
        }),
      ).toBeNull();
      expect(
        toStrictJsonSchema({
          type: "object",
          properties: {
            files: { type: "array", items: { type: "string" }, maxItems: 4 },
          },
          additionalProperties: false,
        }),
      ).toBeNull();
    });

    it("refuses a map-shaped object", () => {
      expect(
        toStrictJsonSchema({
          type: "object",
          properties: {
            headers: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          required: ["headers"],
          additionalProperties: false,
        }),
      ).toBeNull();
    });

    it("refuses schema shapes it has no rule for", () => {
      expect(toStrictJsonSchema({ type: "string" })).toBeNull();
      expect(toStrictJsonSchema(undefined)).toBeNull();
      expect(toStrictJsonSchema({ type: "object" })).toBeNull();
      expect(
        toStrictJsonSchema({
          type: "object",
          properties: { ref: { $ref: "#/$defs/Ref" } },
          additionalProperties: false,
        }),
      ).toBeNull();
      expect(
        toStrictJsonSchema({
          type: "object",
          properties: { x: { oneOf: [{ type: "string" }] } },
          additionalProperties: false,
        }),
      ).toBeNull();
      // `required` naming a property that does not exist is rejected by
      // the compiler and is a descriptor bug either way.
      expect(
        toStrictJsonSchema({
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a", "b"],
          additionalProperties: false,
        }),
      ).toBeNull();
    });

    /**
     * `anyOf` next to a sibling `type` is a shape the module declines to
     * guess at, and it is not academic: a strict compiler reads the two
     * as contradicting each other, and passing it through would emit a
     * node no provider can compile — a 400 on the whole request, not on
     * this one tool. Nothing pinned the refusal, so inverting the test
     * for it was a silent mutation.
     */
    it("refuses a union that also declares a sibling type", () => {
      expect(
        toStrictJsonSchema({
          type: "object",
          properties: {
            x: {
              type: "string",
              anyOf: [{ type: "string" }, { type: "number" }],
            },
          },
          required: ["x"],
          additionalProperties: false,
        }),
      ).toBeNull();
    });

    /**
     * The bound on nesting. Built-in descriptors reach two levels, so
     * only a third-party MCP `inputSchema` gets anywhere near this —
     * which is exactly the input nobody controls. Past the ceiling the
     * tool keeps the definition it ships today instead of taking every
     * other tool's definition down with it in a rejected request.
     */
    it("refuses a schema nested deeper than the strict ceiling", () => {
      const nest = (levels: number): Record<string, unknown> => {
        let node: Record<string, unknown> = { type: "string" };
        for (let i = 0; i < levels; i += 1) {
          node = {
            type: "object",
            properties: { p: node },
            required: ["p"],
            additionalProperties: false,
          };
        }
        return node;
      };
      expect(toStrictJsonSchema(nest(5))).not.toBeNull();
      expect(toStrictJsonSchema(nest(6))).toBeNull();
      // Arrays count as a level too. `rows` is one, its `items` a
      // second, so four more object wrappers overrun a ceiling that the
      // same four would clear one level higher.
      const inArray = (levels: number): Record<string, unknown> => ({
        type: "object",
        properties: { rows: { type: "array", items: nest(levels) } },
        required: ["rows"],
        additionalProperties: false,
      });
      expect(toStrictJsonSchema(inArray(3))).not.toBeNull();
      expect(toStrictJsonSchema(inArray(4))).toBeNull();
    });

    /**
     * A self-referential descriptor cannot come off the wire — MCP
     * schemas arrive through `JSON.parse` — but it can be built in
     * process, and the recursion used to answer it with a `RangeError`
     * that escaped `descriptorsToOpenAiTools` and killed the step. A
     * refusal is the only acceptable answer to a schema we cannot
     * express.
     */
    it("refuses a cyclic schema instead of overflowing the stack", () => {
      const cyclic: Record<string, unknown> = {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      };
      (cyclic.properties as Record<string, unknown>).self = cyclic;
      (cyclic.required as string[]).push("self");
      expect(() => toStrictJsonSchema(cyclic)).not.toThrow();
      expect(toStrictJsonSchema(cyclic)).toBeNull();
    });
  });

  /**
   * The coverage the feature actually buys, pinned. If a new default
   * tool ships a schema this cannot convert, that is a decision to make
   * knowingly — either the schema loses a bound it does not need, or
   * the tool joins this list.
   */
  it("converts all but five of the sampled built-in tool schemas", () => {
    const refused: string[] = [];
    let converted = 0;
    for (const name of DEFAULT_TOOL_NAMES) {
      const schema = getDefaultArgsJsonSchema(name);
      expect(schema, `${name} has no registered schema`).toBeDefined();
      if (toStrictJsonSchema(schema)) converted += 1;
      else refused.push(name);
    }
    expect(refused).toEqual([
      // minItems / maxItems on the task list.
      "fusion.delegate",
      // `arguments` is a map of arbitrary string keys.
      "mcp.prompt.get",
      // `limits` is deliberately an open object.
      "os.fs.archive.extract",
      // `headers` is a map; `body` may be any object.
      "os.http.request",
      // maxItems on `paths`.
      "vision.describe",
    ]);
    expect(converted).toBe(DEFAULT_TOOL_NAMES.length - refused.length);
    expect(converted).toBeGreaterThan(60);
  });
});

/**
 * A spread of the registered names, wide enough that the count above
 * means something. Kept literal rather than reflected out of the map so
 * a typo in a schema key cannot silently shrink the sample.
 */
const DEFAULT_TOOL_NAMES: readonly string[] = [
  "browser.navigate",
  "browser.click",
  "browser.type",
  "browser.read_aria",
  "browser.search",
  "browser.tabs",
  "browser.scroll",
  "os.shell.run",
  "os.fs.read",
  "os.fs.write",
  "os.fs.trash",
  "os.fs.list",
  "os.fs.glob",
  "os.fs.locate_project",
  "os.fs.grep",
  "os.fs.edit",
  "os.fs.read_document",
  "os.fs.archive.list",
  "os.fs.archive.read_entry",
  "os.fs.archive.extract",
  "os.fs.hash",
  "os.fs.diff",
  "os.fs.patch",
  "os.fs.watch",
  "os.git.status",
  "os.git.log",
  "os.git.diff",
  "os.git.show",
  "os.git.blame",
  "os.git.branch",
  "os.git.init",
  "os.git.add",
  "os.git.remote",
  "os.git.fetch",
  "os.git.pull",
  "os.git.clone",
  "os.proc.list",
  "os.proc.kill",
  "os.http.request",
  "os.web.search",
  "os.web.fetch",
  "os.clipboard.read",
  "os.clipboard.write",
  "os.window.list",
  "os.window.focus",
  "os.notify",
  "os.email.inbox",
  "os.email.send",
  "skill.view",
  "tool.view",
  "skill.run_script",
  "memory.profile.set",
  "memory.profile.remove",
  "memory.profile.list",
  "memory.profile.history",
  "memory.notes.store",
  "memory.notes.recall",
  "memory.notes.forget",
  "memory.lessons.recall",
  "memory.procedures.recall",
  "tasks.schedule",
  "tasks.cron",
  "tasks.list",
  "tasks.cancel",
  "tasks.show",
  "vision.describe",
  "mcp.resource.list",
  "mcp.resource.read",
  "mcp.prompt.list",
  "mcp.prompt.get",
  "fusion.delegate",
  "reply",
  "finish",
].sort();
