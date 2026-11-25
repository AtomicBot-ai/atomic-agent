import { quoteGbnf } from "./reasoning-prelude.js";

/**
 * GBNF for a caller's JSON Schema, so a grammar (llama-server) link can
 * only sample JSON of the schema's shape (ATO-699, `browser.extract`).
 *
 * The grammar follows the schema's structure: object properties in the
 * order they are declared (required ones always present, optional ones
 * may be left out, no other keys), array items, `enum` / `const`
 * literals, `type` (one or a list), `anyOf` / `oneOf` as alternatives,
 * and a string's length when it is small. Anything it does not shape
 * (`pattern`, numeric bounds, `allOf`, `not`, `maxItems`...) falls back
 * to the plain JSON rule for that part: the caller validates the parsed
 * value against the full schema afterwards, so the grammar only has to
 * be no stricter than the schema, never exact.
 */

/** Shared JSON primitives (the llama.cpp `json.gbnf` shape, whitespace bounded). */
const PRIMITIVES = String.raw`ws ::= [ \t\n]{0,20}
json-char ::= [^"\\\x7F\x00-\x1F] | "\\" ( ["\\/bfnrt] | "u" [0-9a-fA-F]{4} )
json-string ::= "\"" json-char* "\""
json-integer ::= "-"? ( [0-9] | [1-9] [0-9]{0,15} )
json-number ::= json-integer ( "." [0-9]{1,16} )? ( [eE] [-+]? [0-9]{1,4} )?
json-boolean ::= "true" | "false"
json-null ::= "null"
json-value ::= json-object | json-array | json-string | json-number | json-boolean | json-null
json-object ::= "{" ws ( json-string ws ":" ws json-value ( ws "," ws json-string ws ":" ws json-value )* )? ws "}"
json-array ::= "[" ws ( json-value ( ws "," ws json-value )* )? ws "]"`;

/** Longest string bound written out as a repetition; longer ones stay open. */
const MAX_SHAPED_STRING_LENGTH = 500;

export interface JsonSchemaGbnfOptions {
  /** Deepest nesting shaped; deeper parts fall back to `json-value`. */
  maxDepth?: number;
  /** Most rules generated; the conversion throws past it. */
  maxRules?: number;
}

type Schema = Record<string, unknown>;

export class JsonSchemaGbnfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonSchemaGbnfError";
  }
}

/** The whole grammar: `root` is the schema's value, nothing before or after it. */
export function jsonSchemaToGbnf(schema: Schema, options: JsonSchemaGbnfOptions = {}): string {
  const maxDepth = options.maxDepth ?? 12;
  const maxRules = options.maxRules ?? 400;
  const rules: string[] = [];

  const add = (body: string): string => {
    if (rules.length >= maxRules) {
      throw new JsonSchemaGbnfError(`schema is too large for a grammar (over ${maxRules} rules)`);
    }
    const name = `s${rules.length + 1}`;
    rules.push(`${name} ::= ${body}`);
    return name;
  };

  const visit = (node: unknown, depth: number): string => {
    if (!isRecord(node) || depth > maxDepth) return "json-value";
    if (Object.hasOwn(node, "const")) return add(literal(node.const));
    if (Array.isArray(node.enum)) {
      if (node.enum.length === 0) throw new JsonSchemaGbnfError("`enum` must not be empty");
      return add(node.enum.map(literal).join(" | "));
    }
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (Array.isArray(branches) && branches.length > 0) {
        return add(branches.map((branch) => visit(branch, depth + 1)).join(" | "));
      }
    }
    const types = typesOf(node);
    if (types.length === 0) return "json-value";
    if (types.length > 1) {
      return add(types.map((type) => visitType(node, type, depth)).join(" | "));
    }
    return visitType(node, types[0]!, depth);
  };

  const visitType = (node: Schema, type: string, depth: number): string => {
    switch (type) {
      case "string":
        return stringRule(node, add);
      case "integer":
        return "json-integer";
      case "number":
        return "json-number";
      case "boolean":
        return "json-boolean";
      case "null":
        return "json-null";
      case "array":
        return arrayRule(node, depth);
      case "object":
        return objectRule(node, depth);
      default:
        return "json-value";
    }
  };

  const arrayRule = (node: Schema, depth: number): string => {
    const item = node.items === undefined ? "json-value" : visit(node.items, depth + 1);
    const atLeastOne = typeof node.minItems === "number" && node.minItems >= 1;
    const list = `${item} ( ws "," ws ${item} )*`;
    return add(`"[" ws ${atLeastOne ? list : `( ${list} )?`} ws "]"`);
  };

  const objectRule = (node: Schema, depth: number): string => {
    const properties = isRecord(node.properties) ? node.properties : {};
    const required = new Set(
      Array.isArray(node.required) ? node.required.filter((key): key is string => typeof key === "string") : [],
    );
    const keys = [...Object.keys(properties)];
    for (const key of required) if (!keys.includes(key)) keys.push(key);
    if (keys.length === 0) return "json-object";
    const pair = new Map<string, string>();
    for (const key of keys) {
      const value = Object.hasOwn(properties, key) ? visit(properties[key], depth + 1) : "json-value";
      pair.set(key, add(`${literal(key)} ws ":" ws ${value}`));
    }
    const req = keys.filter((key) => required.has(key));
    const opt = keys.filter((key) => !required.has(key));
    const optTail = (list: readonly string[]): string =>
      list.map((key) => ` ( ws "," ws ${pair.get(key)!} )?`).join("");
    let body: string;
    if (req.length > 0) {
      body = req.map((key) => pair.get(key)!).join(` ws "," ws `) + optTail(opt);
    } else {
      // Every key optional: whichever comes first opens the list, the
      // keys declared after it may follow. Quadratic in the key count,
      // bounded by `maxRules` through the pair rules above.
      body = `( ${opt.map((key, index) => `${pair.get(key)!}${optTail(opt.slice(index + 1))}`).join(" | ")} )?`;
    }
    return add(`"{" ws ${body} ws "}"`);
  };

  const root = visit(schema, 0);
  return [`root ::= ${root}`, ...rules, PRIMITIVES, ""].join("\n");
}

function stringRule(node: Schema, add: (body: string) => string): string {
  const min = typeof node.minLength === "number" ? Math.max(0, Math.floor(node.minLength)) : 0;
  const max = typeof node.maxLength === "number" ? Math.floor(node.maxLength) : undefined;
  if (max !== undefined && max >= min && max <= MAX_SHAPED_STRING_LENGTH) {
    return add(`"\\"" json-char{${min},${max}} "\\""`);
  }
  if (min > 0 && min <= MAX_SHAPED_STRING_LENGTH) {
    return add(`"\\"" json-char{${min},} "\\""`);
  }
  return "json-string";
}

function typesOf(node: Schema): string[] {
  if (typeof node.type === "string") return [node.type];
  if (Array.isArray(node.type)) return node.type.filter((type): type is string => typeof type === "string");
  // Shape keywords without `type` imply it.
  if (isRecord(node.properties) || Array.isArray(node.required)) return ["object"];
  if (node.items !== undefined) return ["array"];
  return [];
}

/** A JSON value as a GBNF literal: its compact JSON text, quoted. */
function literal(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new JsonSchemaGbnfError("`enum` / `const` values must be JSON");
  return quoteGbnf(text);
}

function isRecord(value: unknown): value is Schema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
