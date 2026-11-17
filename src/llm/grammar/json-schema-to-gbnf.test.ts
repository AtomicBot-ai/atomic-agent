import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { gbnfAccepts, parseGbnf } from "./gbnf-test-helpers.js";
import { buildRepetition } from "./json-schema-gbnf-shapes.js";
import {
  commitArgs,
  convertArgsSchema,
  HOST_RULES,
  RuleTable,
  SchemaConversionError,
  type ConvertLimits,
} from "./json-schema-to-gbnf.js";

const HOST = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../grammars/tool-call.gbnf"),
  "utf8",
);
const HOST_NAMES = new Set([...HOST.matchAll(/^([A-Za-z0-9-]+) ::= /gm)].map((m) => m[1]!));
const LIMITS: ConvertLimits = { maxRules: 200, maxChars: 50_000 };

/** Convert `schema` into a fresh table and return a matcher for its args rule. */
function compile(schema: unknown, limits: ConvertLimits = LIMITS) {
  const table = new RuleTable(HOST_NAMES);
  const converted = convertArgsSchema(schema, "args-t", table, limits);
  commitArgs(table, converted);
  const rules = [...table.rules].map(([name, body]) => `${name} ::= ${body}`).join("\n");
  const grammar = `${HOST}\n${rules}\nprobe ::= ${converted.rule}\n`;
  parseGbnf(grammar);
  const accepts = (value: unknown): boolean =>
    gbnfAccepts(grammar, "probe", typeof value === "string" ? value : JSON.stringify(value));
  return { accepts, converted, table, grammar };
}

const obj = (properties: Record<string, unknown>, required: string[] = [], extra = {}) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
  ...extra,
});

describe("json-schema-to-gbnf: objects", () => {
  const schema = obj(
    { path: { type: "string" }, limit: { type: "number" }, recursive: { type: "boolean" } },
    ["path"],
  );

  it("demands every required key and admits any in-order subset of the optional ones", () => {
    const { accepts } = compile(schema);
    expect(accepts({ path: "a" })).toBe(true);
    expect(accepts({ path: "a", limit: 3 })).toBe(true);
    expect(accepts({ path: "a", recursive: true })).toBe(true);
    expect(accepts({ path: "a", limit: 3, recursive: false })).toBe(true);
    expect(accepts('{ "path" : "a" ,\n  "limit": 1 }')).toBe(true);
    expect(accepts({})).toBe(false);
    expect(accepts({ limit: 3 })).toBe(false);
  });

  it("refuses a key the schema does not know, a repeated key and a wrong value type", () => {
    const { accepts } = compile(schema);
    expect(accepts({ path: "a", explanation: "x" })).toBe(false);
    expect(accepts('{"path":"a","limit":1,"limit":2}')).toBe(false);
    expect(accepts({ path: 1 })).toBe(false);
    expect(accepts({ path: "a", recursive: "yes" })).toBe(false);
  });

  it("puts required keys first, in schema order (the original's ordering)", () => {
    const { accepts } = compile(obj({ repo: { type: "string" }, path: { type: "string" } }, ["path"]));
    expect(accepts({ path: "p", repo: "r" })).toBe(true);
    expect(accepts({ repo: "r", path: "p" })).toBe(false);
  });

  it("an object with no properties: closed is `{}`, open is any object", () => {
    expect(compile(obj({})).accepts({})).toBe(true);
    expect(compile(obj({})).accepts({ a: 1 })).toBe(false);
    const open = compile({ type: "object" });
    expect(open.converted.rule).toBe(HOST_RULES.object);
    expect(open.accepts({ a: [1, { b: null }] })).toBe(true);
  });

  it("additionalProperties as a schema is a map of that value; true admits extra keys of any value", () => {
    const map = compile(obj({ headers: { type: "object", additionalProperties: { type: "string" } } }));
    expect(map.accepts({ headers: { a: "1", b: "2" } })).toBe(true);
    expect(map.accepts({ headers: { a: 1 } })).toBe(false);
    const open = compile({ type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: true });
    expect(open.accepts({ id: "x", anything: [1] })).toBe(true);
    expect(open.accepts({ anything: 1 })).toBe(false);
  });

  it("additionalProperties absent closes the object, as llama.cpp reads it", () => {
    const { accepts } = compile({ type: "object", properties: { q: { type: "string" } } });
    expect(accepts({ q: "x" })).toBe(true);
    expect(accepts({ q: "x", other: 1 })).toBe(false);
  });

  it("a required key the properties do not describe is still required, with any value", () => {
    const { accepts } = compile({ type: "object", properties: { a: { type: "string" } }, required: ["a", "b"] });
    expect(accepts({ a: "x", b: [1] })).toBe(true);
    expect(accepts({ a: "x" })).toBe(false);
  });

  it("nested objects and arrays of objects are held to their own schemas", () => {
    const { accepts } = compile(
      obj({
        items: {
          type: "array",
          items: obj({ step: { type: "string" }, status: { type: "string", enum: ["pending", "done"] } }, ["step", "status"]),
        },
      }, ["items"]),
    );
    expect(accepts({ items: [] })).toBe(true);
    expect(accepts({ items: [{ step: "a", status: "done" }, { step: "b", status: "pending" }] })).toBe(true);
    expect(accepts({ items: [{ step: "a" }] })).toBe(false);
    expect(accepts({ items: [{ step: "a", status: "later" }] })).toBe(false);
    expect(accepts({ items: [{ step: "a", status: "done", note: "x" }] })).toBe(false);
  });

  it("allOf merges its object members; anyOf members inside it add optional keys", () => {
    const { accepts } = compile({
      allOf: [
        obj({ a: { type: "string" } }, ["a"]),
        { anyOf: [obj({ b: { type: "number" } }, ["b"])] },
      ],
    });
    expect(accepts({ a: "x" })).toBe(true);
    expect(accepts({ a: "x", b: 1 })).toBe(true);
    expect(accepts({ b: 1 })).toBe(false);
    expect(accepts({ a: "x", c: 1 })).toBe(false);
  });
});

describe("json-schema-to-gbnf: values", () => {
  it("enum and const admit exactly their literals", () => {
    const { accepts } = compile(obj({ mode: { enum: ["full", "diff", 3, null] }, v: { const: "x" } }, ["mode"]));
    for (const mode of ["full", "diff", 3, null]) expect(accepts({ mode }), String(mode)).toBe(true);
    expect(accepts({ mode: "text" })).toBe(false);
    expect(accepts({ mode: "full", v: "x" })).toBe(true);
    expect(accepts({ mode: "full", v: "y" })).toBe(false);
  });

  it("anyOf, oneOf, a type list and nullable are unions", () => {
    const { accepts } = compile(
      obj({
        amount: { anyOf: [{ type: "string", enum: ["page", "half"] }, { type: "number" }] },
        body: { oneOf: [{ type: "string" }, { type: "object" }] },
        id: { type: ["integer", "null"] },
        note: { type: "string", nullable: true },
      }),
    );
    expect(accepts({ amount: "page" })).toBe(true);
    expect(accepts({ amount: 2.5 })).toBe(true);
    expect(accepts({ amount: "most" })).toBe(false);
    expect(accepts({ body: "x" })).toBe(true);
    expect(accepts({ body: { a: 1 } })).toBe(true);
    expect(accepts({ body: 1 })).toBe(false);
    expect(accepts({ id: 3 })).toBe(true);
    expect(accepts({ id: null })).toBe(true);
    expect(accepts({ id: "3" })).toBe(false);
    expect(accepts({ note: null })).toBe(true);
  });

  it("integers refuse fractions; a floor of 1 or 0 is kept", () => {
    const { accepts } = compile(obj({ n: { type: "integer" }, pos: { type: "integer", minimum: 1 }, nat: { type: "integer", minimum: 0 } }));
    expect(accepts({ n: -4 })).toBe(true);
    expect(accepts({ n: 1.5 })).toBe(false);
    expect(accepts({ pos: 7 })).toBe(true);
    expect(accepts({ pos: 0 })).toBe(false);
    expect(accepts({ pos: -1 })).toBe(false);
    expect(accepts({ nat: 0 })).toBe(true);
    expect(accepts({ nat: -1 })).toBe(false);
  });

  it("array bounds are enforced up to MAX_REPEAT", () => {
    const { accepts } = compile(obj({ paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 } }));
    expect(accepts({ paths: [] })).toBe(false);
    expect(accepts({ paths: ["a"] })).toBe(true);
    expect(accepts({ paths: ["a", "b", "c"] })).toBe(true);
    expect(accepts({ paths: ["a", "b", "c", "d"] })).toBe(false);
    expect(accepts({ paths: [1] })).toBe(false);
    const wide = compile(obj({ xs: { type: "array", items: { type: "number" }, maxItems: 1000 } }));
    expect(wide.accepts({ xs: Array.from({ length: 40 }, (_, i) => i) })).toBe(true);
  });

  it("tuples (prefixItems) are item by item", () => {
    const { accepts } = compile(obj({ pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] } }));
    expect(accepts({ pair: ["a", 1] })).toBe(true);
    expect(accepts({ pair: [1, "a"] })).toBe(false);
  });

  it("pattern, format and length bounds are loosened to a plain string, minLength 1 to a non-empty one", () => {
    const { accepts } = compile(obj({
      sha: { type: "string", pattern: "^[0-9a-f]{40}$" },
      when: { type: "string", format: "date-time" },
      name: { type: "string", minLength: 1, maxLength: 3 },
    }));
    expect(accepts({ sha: "not-a-sha" })).toBe(true);
    expect(accepts({ when: "yesterday" })).toBe(true);
    expect(accepts({ name: "a long name" })).toBe(true);
    expect(accepts({ name: "" })).toBe(false);
  });

  it("an empty schema and `true` are any value", () => {
    const { accepts } = compile(obj({ a: {}, b: true }));
    expect(accepts({ a: [1, "x"], b: { c: null } })).toBe(true);
  });
});

describe("json-schema-to-gbnf: $ref", () => {
  it("resolves local $defs / definitions pointers", () => {
    const { accepts } = compile({
      type: "object",
      properties: { from: { $ref: "#/$defs/point" }, to: { $ref: "#/definitions/point" } },
      required: ["from"],
      additionalProperties: false,
      $defs: { point: obj({ x: { type: "number" }, y: { type: "number" } }, ["x", "y"]) },
      definitions: { point: obj({ x: { type: "number" }, y: { type: "number" } }, ["x", "y"]) },
    });
    expect(accepts({ from: { x: 1, y: 2 } })).toBe(true);
    expect(accepts({ from: { x: 1, y: 2 }, to: { x: 0, y: 0 } })).toBe(true);
    expect(accepts({ from: { x: 1 } })).toBe(false);
  });

  it("throws on a recursive, remote or unresolved $ref", () => {
    const recursive = {
      type: "object",
      properties: { node: { $ref: "#/$defs/node" } },
      $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } },
    };
    expect(() => compile(recursive)).toThrow(SchemaConversionError);
    expect(() => compile(obj({ a: { $ref: "#" } }))).toThrow(SchemaConversionError);
    expect(() => compile(obj({ a: { $ref: "https://example.com/s.json" } }))).toThrow(SchemaConversionError);
    expect(() => compile(obj({ a: { $ref: "#/$defs/missing" } }))).toThrow(SchemaConversionError);
  });
});

describe("json-schema-to-gbnf: what falls back", () => {
  it.each([
    ["a root that is not an object", { type: "string" }],
    ["a non-object schema", "nope"],
    ["an unknown type", obj({ a: { type: "date" } })],
    ["an empty enum", obj({ a: { enum: [] } })],
    ["a false schema", obj({ a: false })],
    ["maxItems below minItems", obj({ a: { type: "array", minItems: 3, maxItems: 1 } })],
  ])("throws SchemaConversionError on %s", (_label, schema) => {
    expect(() => compile(schema)).toThrow(SchemaConversionError);
  });

  it("throws past the per-tool size cap, and leaves the table untouched", () => {
    const wide = obj(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, { type: "string" }])));
    const table = new RuleTable(HOST_NAMES);
    expect(() => convertArgsSchema(wide, "args-wide", table, { maxRules: 20, maxChars: 50_000 })).toThrow(
      SchemaConversionError,
    );
    expect(() => convertArgsSchema(wide, "args-wide", table, { maxRules: 500, maxChars: 200 })).toThrow(
      SchemaConversionError,
    );
    expect(table.rules.size).toBe(0);
  });
});

describe("json-schema-to-gbnf: rule names", () => {
  it("shares identical rules across tools and never reuses a host rule name", () => {
    const table = new RuleTable(HOST_NAMES);
    const a = convertArgsSchema(obj({ repo: { type: "string" } }), "args-os.git.status", table, LIMITS);
    commitArgs(table, a);
    const b = convertArgsSchema(obj({ repo: { type: "string" }, limit: { type: "number" } }), "args-os.git.log", table, LIMITS);
    // `repo` is already a rule: tool b adds only what is new.
    expect(b.added.map(([name]) => name)).not.toContain("args-os-git-status-repo-kv");
    expect(b.added.some(([, body]) => body.includes("args-os-git-status-repo-kv"))).toBe(true);
    commitArgs(table, b);
    for (const name of table.rules.keys()) {
      expect(HOST_NAMES.has(name), name).toBe(false);
      expect(name).toMatch(/^[A-Za-z0-9-]+$/);
    }
    // A host-name collision gets a suffix instead.
    const clash = convertArgsSchema(obj({ a: { enum: ["x"] } }), "value", table, LIMITS);
    expect(clash.added.every(([name]) => !HOST_NAMES.has(name))).toBe(true);
  });

  it("buildRepetition matches the original's shapes", () => {
    const sep = 'ws "," ws';
    expect(buildRepetition("x", 0, 1, sep)).toBe("x?");
    expect(buildRepetition("x", 0, undefined, sep)).toBe(`( x ( ${sep} x )* )?`);
    expect(buildRepetition("x", 1, undefined, sep)).toBe(`x ( ${sep} x )*`);
    expect(buildRepetition("x", 1, 1, sep)).toBe("x");
    expect(buildRepetition("x", 2, 4, sep)).toBe(`x ( ${sep} x ){1,3}`);
    expect(buildRepetition("x", 0, 0, sep)).toBe("");
  });
});
