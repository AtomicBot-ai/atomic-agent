type Schema = Record<string, unknown>;

/**
 * Where a `response_format` schema breaks the structural rules OpenAI
 * Structured Outputs enforces under `strict: true`, as readable paths;
 * empty when it keeps them.
 *
 * The provider compiles the schema before the model runs and refuses
 * the whole request when it cannot, so a violation here is not a
 * degraded answer but a 400 on every call. The rules checked:
 *   - the root is an object schema;
 *   - every object closes itself with `additionalProperties: false`;
 *   - every object lists every key of `properties` in `required`, and
 *     nothing else — strict has no optional keys, at any depth.
 * Nested objects are reached through `properties`, `items`, `anyOf`
 * branches and `$defs`.
 *
 * Keyword support is a separate question and not checked here: the
 * bounds our sub-call schemas use (`maxItems`, `minimum`, `maxLength`)
 * are accepted by the provider. `toStrictJsonSchema` answers a
 * different question too — it rewrites tool schemas and refuses bounds
 * outright — so it cannot serve as this check.
 */
export function findStrictSchemaViolations(schema: unknown): string[] {
  const root = asObject(schema);
  if (!root || !isObjectNode(root)) {
    return ["(root): must be an object schema"];
  }
  const violations: string[] = [];
  visit(root, "(root)", violations);
  return violations;
}

function visit(node: Schema, path: string, out: string[]): void {
  if (isObjectNode(node)) checkObject(node, path, out);
  const properties = asObject(node.properties);
  if (properties) {
    for (const [key, child] of Object.entries(properties)) {
      visitChild(child, `${path}.${key}`, out);
    }
  }
  if (node.items !== undefined) visitChild(node.items, `${path}[]`, out);
  if (Array.isArray(node.anyOf)) {
    node.anyOf.forEach((branch, index) => {
      visitChild(branch, `${path}.anyOf[${index}]`, out);
    });
  }
  const defs = asObject(node.$defs);
  if (defs) {
    for (const [key, child] of Object.entries(defs)) {
      visitChild(child, `${path}.$defs.${key}`, out);
    }
  }
}

function checkObject(node: Schema, path: string, out: string[]): void {
  if (node.additionalProperties !== false) {
    out.push(`${path}: additionalProperties must be false`);
  }
  const keys = Object.keys(asObject(node.properties) ?? {});
  const required = Array.isArray(node.required) ? node.required : [];
  for (const key of keys) {
    if (!required.includes(key)) {
      out.push(`${path}: required is missing '${key}'`);
    }
  }
  for (const key of required) {
    if (!keys.includes(key as string)) {
      out.push(`${path}: required names unknown key '${String(key)}'`);
    }
  }
}

function visitChild(value: unknown, path: string, out: string[]): void {
  const child = asObject(value);
  if (!child) {
    out.push(`${path}: must be a schema object`);
    return;
  }
  visit(child, path, out);
}

function isObjectNode(node: Schema): boolean {
  const type = node.type;
  if (type === "object") return true;
  if (Array.isArray(type) && type.includes("object")) return true;
  return node.properties !== undefined;
}

function asObject(value: unknown): Schema | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Schema)
    : null;
}
