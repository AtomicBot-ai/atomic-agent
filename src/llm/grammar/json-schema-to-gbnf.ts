/**
 * JSON Schema to GBNF for one tool's `args` object (ATO-633).
 *
 * Ported to TypeScript from llama.cpp's `json-schema-to-grammar.mjs`
 * (`tools/server/public_legacy/`, tag b6000).
 * Copyright (c) 2023-2024 The ggml authors. MIT License; the full notice
 * is in THIRD-PARTY-NOTICES.md. The object, array and integer rules are
 * in `json-schema-gbnf-shapes.ts`.
 *
 * Kept from the original: the object rule (required keys first, then any
 * subset of the optional ones, in schema order, each at most once), the
 * array repetition, `anyOf` / `oneOf` / type-list unions, `enum` /
 * `const` literals, local `$ref`, `allOf` merging, rule names by property
 * path with identical rules shared, and `additionalProperties` absent
 * meaning a closed object (the point here: no invented keys).
 *
 * Changed, and why:
 *  - The leaves are the host grammar's rules (`string`, `value`,
 *    `number`, ... in `grammars/tool-call.gbnf`) and `ws` separates
 *    tokens, not the original's own primitives and `space`. A reasoning
 *    profile rewrites the host `chars` rule against control markers
 *    (F37, `build-grammar.ts`); a string through a rule of its own would
 *    bypass that guard.
 *  - Rules are shared by BODY across every tool of the grammar, so
 *    `"\"repo\"" ws ":" ws string` is one rule however many tools have
 *    a `repo`.
 *  - What only narrows a value further (`pattern`, `format`, string
 *    lengths other than a minimum of 1, number bounds, most integer
 *    bounds, array bounds past `MAX_REPEAT`) is LOOSENED to the plain
 *    rule, not translated. A looser grammar is always safe and the tool's
 *    validator stays the bar; turning a regex into GBNF inside the
 *    hardened string automaton is not done by hand.
 *  - What cannot be expressed faithfully (a remote or recursive `$ref`,
 *    an unknown `type`, an empty `enum`, a `false` schema, a root that is
 *    not an object, the size cap) throws `SchemaConversionError`, and
 *    the caller keeps that ONE tool on the any-object path.
 */

import {
  arrayRule,
  HOST_RULES,
  integerRule,
  isSchema,
  literal,
  mergeAllOf,
  objectRule,
  SchemaConversionError,
  type RuleSink,
  type Schema,
} from "./json-schema-gbnf-shapes.js";

export { HOST_RULES, MAX_REPEAT, SchemaConversionError } from "./json-schema-gbnf-shapes.js";

/** The generated rules of one grammar, shared by every tool converted into it. */
export class RuleTable {
  readonly rules = new Map<string, string>();
  readonly byBody = new Map<string, string>();
  /** `reserved`: the host grammar's rule names, never reused. */
  constructor(readonly reserved: ReadonlySet<string>) {}

  taken(name: string): boolean {
    return this.reserved.has(name) || this.rules.has(name);
  }
}

export interface ConvertLimits {
  /** New rules one tool may add (rules it shares are free). */
  readonly maxRules: number;
  /** Characters of new rule bodies one tool may add. */
  readonly maxChars: number;
}

export interface ConvertedArgs {
  /** The rule a whole `args` object matches. */
  readonly rule: string;
  /** Rules this tool adds to the table, in creation order. */
  readonly added: ReadonlyArray<readonly [name: string, body: string]>;
}

/** A GBNF-safe rule name: `os.git.log` → `os-git-log`. */
export const ruleSafe = (name: string): string => name.replace(/[^\dA-Za-z-]+/g, "-");

/**
 * Convert `schema` (a tool's args schema) into rules named under
 * `baseName`. Nothing reaches `table` until the caller commits the
 * result with `commitArgs`, so a tool that throws leaves no trace.
 * `extra` adds rules of the caller's own (the call rule) under the same
 * naming, sharing and cap; what it returns is the result's `rule`.
 */
export function convertArgsSchema(
  schema: unknown,
  baseName: string,
  table: RuleTable,
  limits: ConvertLimits,
  extra?: (sink: Pick<RuleSink, "addRule">, argsRule: string) => string,
): ConvertedArgs {
  const converter = new ToolConverter(schema, ruleSafe(baseName), table, limits);
  const argsRule = converter.root();
  const rule = extra ? extra(converter, argsRule) : argsRule;
  return { rule, added: [...converter.pending] };
}

/** Add a successful conversion's rules to the shared table. */
export function commitArgs(table: RuleTable, converted: ConvertedArgs): void {
  for (const [name, body] of converted.added) {
    table.rules.set(name, body);
    if (!table.byBody.has(body)) table.byBody.set(body, name);
  }
}

class ToolConverter implements RuleSink {
  readonly pending = new Map<string, string>();
  private readonly pendingByBody = new Map<string, string>();
  private chars = 0;
  private readonly refRules = new Map<string, string>();
  private readonly resolving = new Set<string>(["#"]);

  constructor(
    private readonly schema: unknown,
    private readonly base: string,
    private readonly table: RuleTable,
    private readonly limits: ConvertLimits,
  ) {}

  root(): string {
    const s = this.schema;
    if (!isSchema(s)) throw new SchemaConversionError("args schema is not an object");
    if (s.type !== undefined && s.type !== "object") {
      throw new SchemaConversionError(`args schema type ${JSON.stringify(s.type)} is not "object"`);
    }
    const rule = this.visit(s, this.base);
    return rule === HOST_RULES.value ? HOST_RULES.object : rule;
  }

  /** A rule name for `body`, reusing any rule (shared or this tool's) with that body. */
  addRule(name: string, body: string): string {
    const existing = this.table.byBody.get(body) ?? this.pendingByBody.get(body);
    if (existing !== undefined) return existing;
    const stem = ruleSafe(name);
    let key = stem;
    for (let i = 0; this.table.taken(key) || this.pending.has(key); i += 1) key = `${stem}${i}`;
    this.pending.set(key, body);
    this.pendingByBody.set(body, key);
    this.chars += body.length;
    if (this.pending.size > this.limits.maxRules || this.chars > this.limits.maxChars) {
      throw new SchemaConversionError("args grammar over the size cap");
    }
    return key;
  }

  visit(schema: unknown, name: string): string {
    if (schema === true) return HOST_RULES.value;
    if (!isSchema(schema)) throw new SchemaConversionError(`unsupported schema at ${name}`);
    if (schema.$ref !== undefined) {
      if (typeof schema.$ref !== "string") throw new SchemaConversionError(`bad $ref at ${name}`);
      return this.visitRef(schema.$ref);
    }
    const alternatives = schema.oneOf ?? schema.anyOf;
    if (alternatives !== undefined) {
      if (!Array.isArray(alternatives) || alternatives.length === 0) {
        throw new SchemaConversionError(`empty anyOf/oneOf at ${name}`);
      }
      // `oneOf` is read as `anyOf`: exclusivity is the tool's to check.
      return this.union(name, alternatives.map((alt, i) => this.visit(alt, `${name}-${i}`)));
    }
    const type = schema.type;
    if (Array.isArray(type)) {
      if (type.length === 0) throw new SchemaConversionError(`empty type list at ${name}`);
      return this.union(name, type.map((t, i) => this.visit({ ...schema, type: t }, `${name}-${i}`)));
    }
    if (schema.nullable === true) {
      const rest: Schema = { ...schema };
      delete rest.nullable;
      return this.union(name, [this.visit(rest, `${name}-0`), HOST_RULES.null]);
    }
    if ("const" in schema) return this.addRule(name, literal(schema.const));
    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
        throw new SchemaConversionError(`empty enum at ${name}`);
      }
      return this.addRule(name, [...new Set(schema.enum.map(literal))].join(" | "));
    }
    if (Array.isArray(schema.allOf) && (type === undefined || type === "object")) {
      return objectRule(this, mergeAllOf(this, schema.allOf, name), name);
    }
    switch (type) {
      case undefined:
        return this.visitUntyped(schema, name);
      case "object":
        return objectRule(this, schema, name);
      case "array":
        return arrayRule(this, schema, name);
      case "string":
        return typeof schema.minLength === "number" && schema.minLength >= 1
          ? HOST_RULES.nonEmptyString
          : HOST_RULES.string;
      case "number":
        return HOST_RULES.number;
      case "integer":
        return integerRule(this, schema, name);
      case "boolean":
        return HOST_RULES.boolean;
      case "null":
        return HOST_RULES.null;
      default:
        throw new SchemaConversionError(`unsupported type ${JSON.stringify(type)} at ${name}`);
    }
  }

  resolvePointer(ref: string): unknown {
    if (!ref.startsWith("#")) throw new SchemaConversionError(`remote $ref ${ref}`);
    let target: unknown = this.schema;
    for (const raw of ref.slice(1).split("/").slice(1)) {
      const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isSchema(target) || !(key in target)) {
        throw new SchemaConversionError(`unresolved $ref ${ref}`);
      }
      target = target[key];
    }
    return target;
  }

  private union(name: string, alternatives: string[]): string {
    const distinct = [...new Set(alternatives)];
    return distinct.length === 1 ? distinct[0]! : this.addRule(name, distinct.join(" | "));
  }

  /** No `type`: read it from the keywords, as the original does; none is any value. */
  private visitUntyped(schema: Schema, name: string): string {
    if ("properties" in schema || "required" in schema || "patternProperties" in schema ||
        ("additionalProperties" in schema && schema.additionalProperties !== true)) {
      return objectRule(this, schema, name);
    }
    if ("items" in schema || "prefixItems" in schema) return arrayRule(this, schema, name);
    if ("pattern" in schema || "minLength" in schema || "maxLength" in schema || "format" in schema) {
      return this.visit({ ...schema, type: "string" }, name);
    }
    return HOST_RULES.value;
  }

  /** A local `$ref`, converted once per schema; a cycle falls back. */
  private visitRef(ref: string): string {
    const known = this.refRules.get(ref);
    if (known !== undefined) return known;
    if (this.resolving.has(ref)) throw new SchemaConversionError(`recursive $ref ${ref}`);
    const target = this.resolvePointer(ref);
    this.resolving.add(ref);
    const rule = this.visit(target, `${this.base}-${ref.split("/").pop() || "ref"}`);
    this.resolving.delete(ref);
    this.refRules.set(ref, rule);
    return rule;
  }
}
