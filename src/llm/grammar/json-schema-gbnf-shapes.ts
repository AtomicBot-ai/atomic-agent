/**
 * The object, array and integer rules of the JSON Schema to GBNF port
 * (`json-schema-to-gbnf.ts`, ATO-633).
 *
 * Ported from llama.cpp's `json-schema-to-grammar.mjs`
 * (`tools/server/public_legacy/`, tag b6000).
 * Copyright (c) 2023-2024 The ggml authors. MIT License; the full notice
 * is in THIRD-PARTY-NOTICES.md.
 */

import { quoteGbnf } from "./reasoning-prelude.js";

/** The host grammar rules (`grammars/tool-call.gbnf`) generated rules reference. */
export const HOST_RULES = {
  ws: "ws",
  value: "value",
  object: "object",
  array: "array",
  string: "string",
  nonEmptyString: "required-string",
  number: "number",
  integer: "integer",
  boolean: "boolean",
  null: "null-lit",
} as const;

/** Array bounds past this are dropped: llama.cpp expands `{m,n}` into n rules. */
export const MAX_REPEAT = 32;

export class SchemaConversionError extends Error {}

export type Schema = Record<string, unknown>;

export const isSchema = (v: unknown): v is Schema =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A JSON value as a GBNF literal: `"x"` → `"\"x\""`. */
export const literal = (value: unknown): string => quoteGbnf(JSON.stringify(value));

/** What the shape rules need from the converter. */
export interface RuleSink {
  addRule(name: string, body: string): string;
  visit(schema: unknown, name: string): string;
  resolvePointer(ref: string): unknown;
}

const WS = HOST_RULES.ws;
const SEP = `${WS} "," ${WS}`;

/**
 * An object: the required keys first, in schema order, then the optional
 * ones as the original's chain, so any subset of them may follow, in
 * schema order, each at most once. `additionalProperties` absent or
 * `false` closes the object; `true`, a schema or `patternProperties`
 * admit extra keys (any string key: a known key may repeat through it,
 * the limit `grammars/tool-call.gbnf` already documents). An object with
 * no properties and nothing closing it is the host `object`.
 */
export function objectRule(sink: RuleSink, schema: Schema, name: string): string {
  const props: Array<[string, unknown]> = isSchema(schema.properties)
    ? Object.entries(schema.properties)
    : [];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((k): k is string => typeof k === "string")
      : [],
  );
  // A required key the schema does not describe still has to be there.
  for (const key of required) if (!props.some(([k]) => k === key)) props.push([key, true]);
  const additional = schema.additionalProperties;
  const patternOpen =
    isSchema(schema.patternProperties) && Object.keys(schema.patternProperties).length > 0;
  if (props.length === 0 && (additional === undefined || additional === true) && !patternOpen) {
    return HOST_RULES.object;
  }
  const kv = new Map<string, string>();
  for (const [key, propSchema] of props) {
    const value = sink.visit(propSchema, `${name}-${key}`);
    kv.set(key, sink.addRule(`${name}-${key}-kv`, `${literal(key)} ${WS} ":" ${WS} ${value}`));
  }
  const requiredKeys = props.map(([k]) => k).filter((k) => required.has(k));
  const optionalKeys = props.map(([k]) => k).filter((k) => !required.has(k));
  if (additional === true || isSchema(additional) || patternOpen) {
    const value = isSchema(additional)
      ? sink.visit(additional, `${name}-additional-value`)
      : HOST_RULES.value;
    kv.set("*", sink.addRule(`${name}-additional-kv`, `${HOST_RULES.string} ${WS} ":" ${WS} ${value}`));
    optionalKeys.push("*");
  }
  if (requiredKeys.length === 0 && optionalKeys.length === 0) {
    return sink.addRule(name, `"{" ${WS} "}"`);
  }
  const parts = [`"{" ${WS}`];
  if (requiredKeys.length > 0) parts.push(requiredKeys.map((k) => kv.get(k)!).join(` ${SEP} `));
  if (optionalKeys.length > 0) {
    const chains = optionalKeys
      .map((_, i) => optionalChain(sink, optionalKeys.slice(i), false, kv, name))
      .join(" | ");
    parts.push(requiredKeys.length > 0 ? `( ${SEP} ( ${chains} ) )?` : `( ${chains} )?`);
  }
  parts.push(`${WS} "}"`);
  return sink.addRule(name, parts.join(" "));
}

/** The original's `getRecursiveRefs`: `keys[0]`, then any later subset, in order. */
function optionalChain(
  sink: RuleSink,
  keys: string[],
  firstIsOptional: boolean,
  kv: ReadonlyMap<string, string>,
  name: string,
): string {
  const [key, ...rest] = keys as [string, ...string[]];
  const kvRule = kv.get(key)!;
  const comma = `( ${SEP} ${kvRule} )`;
  let chain = firstIsOptional
    ? `${comma}${key === "*" ? "*" : "?"}`
    : `${kvRule}${key === "*" ? ` ${comma}*` : ""}`;
  if (rest.length > 0) {
    const restName = `${name}-${key === "*" ? "additional" : key}-rest`;
    chain += ` ${sink.addRule(restName, optionalChain(sink, rest, true, kv, name))}`;
  }
  return chain;
}

/**
 * The properties of an `allOf` merged into one object, as the original
 * does: members are objects (a `$ref` is followed), `anyOf` members
 * contribute optional keys. Open when a member admits extra keys.
 */
export function mergeAllOf(sink: RuleSink, members: unknown[], name: string): Schema {
  const properties: Schema = {};
  const required = new Set<string>();
  let open = false;
  const add = (member: unknown, isRequired: boolean): void => {
    const resolved =
      isSchema(member) && typeof member.$ref === "string"
        ? sink.resolvePointer(member.$ref)
        : member;
    if (!isSchema(resolved) || (resolved.type !== undefined && resolved.type !== "object")) {
      throw new SchemaConversionError(`allOf member is not an object at ${name}`);
    }
    if (isSchema(resolved.properties)) Object.assign(properties, resolved.properties);
    if (isRequired && Array.isArray(resolved.required)) {
      for (const key of resolved.required) if (typeof key === "string") required.add(key);
    }
    if (resolved.additionalProperties !== undefined && resolved.additionalProperties !== false) {
      open = true;
    }
  };
  for (const member of members) {
    if (isSchema(member) && Array.isArray(member.anyOf)) {
      for (const alt of member.anyOf) add(alt, false);
    } else {
      add(member, true);
    }
  }
  return {
    type: "object",
    properties,
    required: [...required],
    ...(open ? { additionalProperties: true } : {}),
  };
}

/**
 * An array: a tuple (`prefixItems`, or `items` as a list) item by item;
 * otherwise `items` repeated between `minItems` and `maxItems`, a bound
 * past `MAX_REPEAT` dropped (looser, and the tool still checks it). No
 * `items` and no bounds is the host `array`.
 */
export function arrayRule(sink: RuleSink, schema: Schema, name: string): string {
  const tuple = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items)
      ? schema.items
      : null;
  if (tuple !== null) {
    if (tuple.length === 0) return sink.addRule(name, `"[" ${WS} "]"`);
    const items = tuple.map((item, i) => sink.visit(item, `${name}-tuple-${i}`));
    return sink.addRule(name, `"[" ${WS} ${items.join(` ${SEP} `)} ${WS} "]"`);
  }
  const bounded = typeof schema.minItems === "number" || typeof schema.maxItems === "number";
  if (schema.items === undefined && !bounded) return HOST_RULES.array;
  const item =
    schema.items === undefined ? HOST_RULES.value : sink.visit(schema.items, `${name}-item`);
  const rawMin = typeof schema.minItems === "number" ? Math.floor(schema.minItems) : 0;
  const min = Math.min(Math.max(0, rawMin), MAX_REPEAT);
  const rawMax = typeof schema.maxItems === "number" ? Math.floor(schema.maxItems) : undefined;
  const max = rawMax !== undefined && rawMax <= MAX_REPEAT ? rawMax : undefined;
  if (max !== undefined && max < min) {
    throw new SchemaConversionError(`maxItems < minItems at ${name}`);
  }
  if (max === 0) return sink.addRule(name, `"[" ${WS} "]"`);
  return sink.addRule(name, `"[" ${WS} ${buildRepetition(item, min, max, SEP)} ${WS} "]"`);
}

/**
 * An integer. A floor of 1 or 0 (`minimum`, `exclusiveMinimum`) is kept,
 * as positive or natural digits; any other bound loosens to the host
 * `integer`. (The original's full range generator is not ported: no
 * schema here needs more, and looser is always safe.)
 */
export function integerRule(sink: RuleSink, schema: Schema, name: string): string {
  const floor =
    typeof schema.minimum === "number"
      ? schema.minimum
      : typeof schema.exclusiveMinimum === "number"
        ? schema.exclusiveMinimum + 1
        : undefined;
  if (floor !== undefined && floor >= 1) {
    return sink.addRule(`${name}-positive`, `[1-9] [0-9]{0,15}`);
  }
  if (floor !== undefined && floor >= 0) {
    return sink.addRule(`${name}-natural`, `"0" | [1-9] [0-9]{0,15}`);
  }
  return HOST_RULES.integer;
}

/** The original's `_buildRepetition`. */
export function buildRepetition(
  item: string,
  min: number,
  max: number | undefined,
  separator?: string,
): string {
  if (max === 0) return "";
  if (min === 0 && max === 1) return `${item}?`;
  if (separator === undefined) {
    if (min === 1 && max === undefined) return `${item}+`;
    if (min === 0 && max === undefined) return `${item}*`;
    return `${item}{${min},${max ?? ""}}`;
  }
  const tail = buildRepetition(
    `( ${separator} ${item} )`,
    min > 0 ? min - 1 : 0,
    max !== undefined ? max - 1 : undefined,
  );
  const result = `${item} ${tail}`.trimEnd();
  return min === 0 ? `( ${result} )?` : result;
}
