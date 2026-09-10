import { describe, it, expect } from "vitest";
import {
  strictWidenedProperties,
  toStrictJsonSchema,
} from "./strict-tool-schema.js";
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

  it("adds the `required` a descriptor left implicit", () => {
    expect(
      toStrictJsonSchema({
        type: "object",
        properties: { text: { type: "string", description: "why" } },
        additionalProperties: false,
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

  it("accepts every spelling of an already-nullable property", () => {
    // The three shapes a real schema uses for `Optional[str]`. All must
    // survive, and none may be widened a second time.
    const strict = toStrictJsonSchema({
      type: "object",
      properties: {
        union: { anyOf: [{ type: "string" }, { type: "null" }] },
        listed: { type: ["string", "null"] },
        onlyNull: { type: "null" },
        widenedEnum: { type: ["string", "null"], enum: ["a", null] },
      },
      required: [],
      additionalProperties: false,
    });
    expect(strict?.properties).toEqual({
      union: { anyOf: [{ type: "string" }, { type: "null" }] },
      listed: { type: ["string", "null"] },
      onlyNull: { type: "null" },
      widenedEnum: { type: ["string", "null"], enum: ["a", null] },
    });
  });

  it("keeps a nullable member the caller declared required", () => {
    // A third-party MCP tool that genuinely wants `null` for a required
    // argument. Nothing here may narrow it, and nothing downstream may
    // delete the key — see the adapter's per-tool null drop.
    expect(
      toStrictJsonSchema({
        type: "object",
        properties: {
          key: { type: "string" },
          value: { type: ["string", "null"] },
        },
        required: ["key", "value"],
        additionalProperties: false,
      }),
    ).toEqual({
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: ["string", "null"] },
      },
      required: ["key", "value"],
      additionalProperties: false,
    });
  });

  it("drops the annotations the strict compiler has no rule for", () => {
    // pydantic/FastMCP puts `default` and `title` on nearly every
    // property. `title` is harmless and rides along; `default` states
    // something a strict decode cannot honour (there is no absent key
    // to fill) so it is dropped rather than gambled on.
    expect(
      toStrictJsonSchema({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          q: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
          n: { type: "integer", default: 10, title: "N" },
        },
        required: ["q"],
        additionalProperties: false,
      }),
    ).toEqual({
      type: "object",
      properties: {
        q: { anyOf: [{ type: "string" }, { type: "null" }] },
        n: { type: ["integer", "null"], title: "N" },
      },
      required: ["q", "n"],
      additionalProperties: false,
    });
  });

  it("keeps a property named __proto__ instead of eating it", () => {
    // `out[name] = ...` on an object literal would set the prototype
    // and drop the key, leaving a function marked strict whose schema
    // silently forbids an argument the tool declares.
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"},' +
        '"ok":{"type":"string"}},"required":["ok"],' +
        '"additionalProperties":false}',
    ) as Record<string, unknown>;
    const strict = toStrictJsonSchema(schema);
    expect(JSON.stringify(strict)).toBe(
      '{"type":"object","properties":{"__proto__":{"type":["string","null"]},' +
        '"ok":{"type":"string"}},"required":["__proto__","ok"],' +
        '"additionalProperties":false}',
    );
  });

  it("is idempotent over its own output", () => {
    // Its own output is a legal input, which is also what lets it run
    // on an MCP server that already ships strict-shaped schemas.
    for (const name of DEFAULT_TOOL_NAMES) {
      const once = toStrictJsonSchema(getDefaultArgsJsonSchema(name));
      if (!once) continue;
      expect(
        JSON.stringify(toStrictJsonSchema(once)),
        `${name} does not survive a second pass`,
      ).toBe(JSON.stringify(once));
    }
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

    it("refuses an object that never said it was closed", () => {
      // An absent `additionalProperties` is the JSON Schema default and
      // it means OPEN. Closing it is the same silent narrowing as the
      // explicit `true` above — harmless on our own descriptors, which
      // all spell `additionalProperties: false` out, and wrong on a
      // third-party MCP schema that left it off on purpose.
      expect(
        toStrictJsonSchema({
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        }),
      ).toBeNull();
      // The zero-property MCP tool is the same case, and the one where
      // closing it looks most innocent: it would be marked strict as a
      // tool that takes no arguments at all.
      expect(toStrictJsonSchema({ type: "object", properties: {} })).toBeNull();
    });

    it("refuses a union it cannot attribute to one branch", () => {
      expect(
        toStrictJsonSchema({
          type: "object",
          properties: { x: { type: ["array", "object"] } },
          required: ["x"],
          additionalProperties: false,
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
      expect(
        toStrictJsonSchema({ type: "object", additionalProperties: false }),
      ).toBeNull();
      // `$defs` / `$ref` is the one common MCP shape still refused: a
      // pydantic model nested inside another one. Resolving references
      // faithfully is a separate change.
      expect(
        toStrictJsonSchema({
          type: "object",
          $defs: { Ref: { type: "string" } },
          properties: { ref: { type: "string" } },
          required: ["ref"],
          additionalProperties: false,
        }),
      ).toBeNull();
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

    /**
     * The same two failures spelled through `anyOf`. The bound counts a
     * union branch as a level like any other; recursing into branches at
     * the caller's depth left this path unbounded, so the cycle still
     * overflowed the stack and the chain still converted.
     */
    it("bounds the union path as well as the object and array ones", () => {
      const cyclic: Record<string, unknown> = { anyOf: [] };
      (cyclic.anyOf as unknown[]).push(cyclic);
      const wrapped = {
        type: "object",
        properties: { x: cyclic },
        required: ["x"],
        additionalProperties: false,
      };
      expect(() => toStrictJsonSchema(wrapped)).not.toThrow();
      expect(toStrictJsonSchema(wrapped)).toBeNull();

      const chain = (levels: number): Record<string, unknown> => {
        let node: Record<string, unknown> = { type: "string" };
        for (let i = 0; i < levels; i += 1) node = { anyOf: [node] };
        return {
          type: "object",
          properties: { x: node },
          required: ["x"],
          additionalProperties: false,
        };
      };
      // The property is level 1, so four more union levels fit and a
      // fifth does not.
      expect(toStrictJsonSchema(chain(4))).not.toBeNull();
      expect(toStrictJsonSchema(chain(5))).toBeNull();
    });

    /**
     * Every emitted node is a spread of the node that came in, so an
     * allowlisted keyword the node's SHAPE has no rule for would ride
     * out unconverted into a schema we then mark strict. `convertScalar`
     * always refused its own; these are the other three shapes.
     */
    it("refuses an allowlisted keyword its node shape cannot convert", () => {
      const wrap = (x: Record<string, unknown>) => ({
        type: "object",
        properties: { x },
        required: ["x"],
        additionalProperties: false,
      });
      const emptyObject = {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      };
      // `enum` on an object node: its members are whole sub-values this
      // module never converts, and it emitted them verbatim.
      expect(
        toStrictJsonSchema(wrap({ ...emptyObject, enum: [{}] })),
      ).toBeNull();
      // `items` on an object node, and the object keywords on an array
      // node: unconverted either way.
      expect(
        toStrictJsonSchema(wrap({ ...emptyObject, items: { type: "string" } })),
      ).toBeNull();
      expect(
        toStrictJsonSchema(
          wrap({
            type: "array",
            items: { type: "string" },
            additionalProperties: false,
          }),
        ),
      ).toBeNull();
      expect(
        toStrictJsonSchema(
          wrap({ type: "array", items: { type: "string" }, enum: [[]] }),
        ),
      ).toBeNull();
      // ...and on a union node, where none of them belong at all.
      expect(
        toStrictJsonSchema(
          wrap({
            anyOf: [{ type: "string" }],
            properties: { y: { type: "string" } },
          }),
        ),
      ).toBeNull();
      // The scalar spelling of `enum` is the one that stays legal.
      expect(
        toStrictJsonSchema(wrap({ type: "string", enum: ["a", "b"] })),
      ).not.toBeNull();
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
    // 82 registered schemas, 77 of them strict. Pinned as a number so
    // the sample cannot quietly shrink.
    expect(DEFAULT_TOOL_NAMES.length).toBe(82);
    expect(converted).toBe(77);
  });

  /**
   * What the null-drop on the way back in is keyed to. It has to be the
   * properties the rewrite MOVED, not the tools it converted: an
   * argument that was already required is emitted byte-identical,
   * nullable or not, so its null is the model answering the tool's own
   * schema.
   */
  it("names the properties whose optionality the rewrite erased", () => {
    const schema = {
      type: "object",
      properties: {
        key: { type: "string" },
        // Already required AND already nullable — the shape
        // `z.string().nullable()` produces through the MCP SDK.
        value: { anyOf: [{ type: "string" }, { type: "null" }] },
        note: { type: "string" },
      },
      required: ["key", "value"],
      additionalProperties: false,
    };
    expect(toStrictJsonSchema(schema)).not.toBeNull();
    expect([...strictWidenedProperties(schema)]).toEqual(["note"]);
    // Nothing optional, nothing widened.
    expect(
      strictWidenedProperties({
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      }).size,
    ).toBe(0);
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
  // The nine from `github-tool-args-schemas.ts`, spread into the same
  // registry. Left out of this list, a bound added to one of them would
  // have joined the refusal set silently — the exact surprise the pin
  // exists to prevent, and `github.pr.list` is the schema AGENTS.md
  // cites for the widened-enum note.
  "os.git.checkout",
  "os.git.commit",
  "os.git.push",
  "github.whoami",
  "github.pr.list",
  "github.pr.create",
  "github.issue.list",
  "github.issue.create",
  "github.issue.comment",
  "reply",
  "finish",
].sort();
