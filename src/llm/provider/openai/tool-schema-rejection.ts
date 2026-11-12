/**
 * A server that refused the request over one tool's JSON Schema
 * (ATO-1399), and which tool that was.
 *
 * llama.cpp and LM Studio validate every function's `parameters` and
 * answer one schema they cannot turn into a grammar with an error for
 * the whole request, often a 500: "JSON schema error at
 * #/$defs/RecordSource/oneOf/1/properties/evidence: schema must be an
 * object". `tool-schema-booleans.ts` removes the known cause before the
 * send; this is the net for anything else a third-party tool carries.
 *
 * The answer is deterministic, so it is neither retried as-is (see
 * `isRetryableOpenAiError`) nor guessed at: a tool is named only when
 * the error's JSON pointer resolves inside its schema, and for "must be
 * an object" only where the pointer lands on something that is not an
 * object. No unique match means no drop, and the original error goes
 * back to the caller. `reply` and `finish` are never dropped.
 *
 * A leaf with no imports, so the HTTP client and the provider can both
 * read it without a cycle.
 */

/** The wording llama.cpp / LM Studio use for an unusable tool schema. */
const SCHEMA_ERROR = /JSON schema error|schema must be/i;

/** "must be an object": the pointer names a non-object subschema. */
const MUST_BE_OBJECT = /must be an object/i;

/** The pointer after `at #` (or a bare `#/...`), up to `:` or whitespace. */
const POINTER = /#(\/[^\s:'",]*)/;

/** A pointer into the request body rather than into one tool's schema. */
const BODY_POINTER = /^\/tools\/(\d+)\/function\/parameters(\/.*)?$/;

/** The turn's own terminal tools; without them a turn cannot end. */
const PROTECTED_TOOLS: ReadonlySet<string> = new Set(["reply", "finish"]);

/** Whether an error message is a server refusing a tool's JSON Schema. */
export function isToolSchemaErrorText(text: string): boolean {
  return SCHEMA_ERROR.test(text);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeSegment(segment: string): string {
  let text = segment;
  try {
    text = decodeURIComponent(segment);
  } catch {
    // Not percent-encoded after all; use it as written.
  }
  return text.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Walks a JSON pointer; `{ found: false }` when any step is missing. */
function resolvePointer(
  root: unknown,
  segments: readonly string[],
): { found: true; value: unknown } | { found: false } {
  let node = root;
  for (const segment of segments) {
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= node.length) return { found: false };
      node = node[index];
    } else if (isPlainObject(node)) {
      if (!Object.hasOwn(node, segment)) return { found: false };
      node = node[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: node };
}

function functionOf(tool: Record<string, unknown>): {
  name: string;
  parameters: unknown;
} | null {
  const fn = tool.function;
  if (!isPlainObject(fn) || typeof fn.name !== "string") return null;
  return { name: fn.name, parameters: fn.parameters };
}

export interface ToolSchemaCulprit {
  /** Index into the tools array the error was matched against. */
  index: number;
  /** The function name as it went on the wire (escaped). */
  name: string;
  /** The JSON pointer the server named, for the warning. */
  pointer: string;
}

/**
 * The one tool a schema error is about, or null when the text is not a
 * schema error or no single tool can be named from it. `schemas` are
 * the tools as sent; `alternates` (same order) are the tools before any
 * rewrite, consulted too because a pointer the server computed on one
 * may still resolve only on the other.
 */
export function findToolBehindSchemaError(
  text: string,
  tools: ReadonlyArray<Record<string, unknown>>,
  alternates: ReadonlyArray<Record<string, unknown>> = [],
): ToolSchemaCulprit | null {
  if (!isToolSchemaErrorText(text)) return null;
  const match = POINTER.exec(text);
  if (!match) return null;
  const pointer = match[1]!;
  const body = BODY_POINTER.exec(pointer);
  if (body) {
    const index = Number(body[1]);
    const fn = tools[index] ? functionOf(tools[index]!) : null;
    if (!fn || PROTECTED_TOOLS.has(fn.name)) return null;
    return { index, name: fn.name, pointer };
  }
  const segments = pointer.split("/").slice(1).map(decodeSegment);
  const needsNonObject = MUST_BE_OBJECT.test(text);
  const hits: number[] = [];
  tools.forEach((tool, index) => {
    const fn = functionOf(tool);
    if (!fn || PROTECTED_TOOLS.has(fn.name)) return;
    const candidates = [fn.parameters];
    const alt = alternates[index] ? functionOf(alternates[index]!) : null;
    if (alt && alt.name === fn.name) candidates.push(alt.parameters);
    const matches = candidates.some((schema) => {
      const resolved = resolvePointer(schema, segments);
      if (!resolved.found) return false;
      return needsNonObject ? !isPlainObject(resolved.value) : true;
    });
    if (matches) hits.push(index);
  });
  if (hits.length !== 1) return null;
  const index = hits[0]!;
  return { index, name: functionOf(tools[index]!)!.name, pointer };
}
