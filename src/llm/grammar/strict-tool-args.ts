import {
  commitArgs,
  convertArgsSchema,
  type ConvertedArgs,
  HOST_RULES,
  RuleTable,
  SchemaConversionError,
} from "./json-schema-to-gbnf.js";
import { quoteGbnf } from "./reasoning-prelude.js";
import { GRAMMAR_EXIT_TOOL } from "./tool-call-branches.js";

/**
 * Per-tool argument rules for the generic call branch (ATO-633,
 * `localModels.strictToolArgs`).
 *
 * Without it a local model is held to real tool NAMES, but the generic
 * branch (`other-call` in `grammars/tool-call.gbnf`) takes any JSON
 * object as `args`: an invented key or a missing required one is caught
 * only after generation (`tools/unknown-argument-guard.ts`), and the
 * step is spent. With it every tool the grammar admits through
 * `tool-name` that has an args schema gets its own call rule, generated
 * from that schema (`json-schema-to-gbnf.ts`), and leaves `tool-name`:
 * the sampler cannot emit a key the schema does not know, cannot leave
 * out a required one, and cannot step outside an `enum`.
 *
 * What it does not touch:
 *  - `reply` and the dedicated branches (`os.shell.run`, the `os.fs.*`
 *    file tools, ...: `DEDICATED_BRANCHES` in `tool-call-branches.ts`).
 *    They are hand-written for their tools, aliases (`fs-move-alias`)
 *    and the reply-text guard included, and stay as they are.
 *  - A tool with no schema, one whose schema does not convert, one over
 *    the size cap, or one whose rule would be the plain `object` anyway:
 *    it stays in `tool-name` on the any-object path. One tool falling
 *    back never fails the grammar.
 *  - A name the grammar does not spell as a literal (an unrecognised
 *    `tool-name` sub-rule) is left alone.
 *
 * Per request, after narrowing (`resolveStepGrammar`): the grammar rides
 * with each request outside the KV-cached prompt, the descriptors carry
 * the schemas (built-in and MCP alike), and a narrowed grammar has
 * already lost the names it does not admit. The result is cached by the
 * input grammar and the schema objects (by identity), so a session pays
 * the conversion once per tool set.
 */

export interface StrictArgsTool {
  readonly name: string;
  /** The tool's args JSON Schema; `undefined` keeps it on the any-object path. */
  readonly schema: unknown;
}

/**
 * The caps. Per tool: past them that tool falls back. Per grammar: once
 * reached, the remaining tools (in name order) fall back. Rules a tool
 * shares with one converted before it do not count.
 */
export const STRICT_ARGS_LIMITS = {
  perToolRules: 96,
  perToolChars: 12_000,
  totalRules: 800,
  totalChars: 96_000,
} as const;

/** The rule `tool-call` gains, listing every generated call rule. */
export const STRICT_CALL_RULE = "strict-args-call";

const RULE_LINE_RE = /^([A-Za-z0-9-]+) ::= (.*)$/gm;
const TOOL_CALL_RULE_RE = /^tool-call ::= (.*)$/m;
const TOOL_NAME_RULE_RE = /^tool-name ::= (.*)$/m;
/** `"\"name\""`, the JSON string literal of a tool name inside a GBNF one. */
const NAME_LITERAL_RE = /^"\\"([^"\\]+)\\""$/;
/** `"\"os." ( "fs.read_document" | "fs.trash" ) "\""`, the static grammar's grouped form. */
const PREFIX_GROUP_RE = /^"\\"([^"\\]*)" \( ((?:"[^"\\]*"(?: \| )?)+) \) "\\""$/;

/** One `tool-name` alternative: a literal, or a sub-rule whose names we can read. */
type NameSource =
  | { kind: "literal"; name: string }
  | { kind: "flat"; rule: string; names: string[] }
  | { kind: "prefix"; rule: string; prefix: string; suffixes: string[] }
  | { kind: "opaque"; text: string };

const CACHE_PER_GRAMMAR = 32;
const CACHE_GRAMMARS = 8;
const cache = new Map<string, Map<string, string>>();
/** Schema identity for the cache key: descriptors keep their schema objects. */
const schemaIds = new WeakMap<object, number>();
let nextSchemaId = 0;

/**
 * `grammar` with a generated call rule for each of `tools` it admits
 * through `tool-name`, or `grammar` unchanged when there is nothing to
 * do (no such tool, no generic branch, a grammar without the host
 * rules the generated ones need).
 */
export function applyStrictToolArgs(grammar: string, tools: Iterable<StrictArgsTool>): string {
  const byName = new Map<string, unknown>();
  for (const tool of tools) {
    if (tool.schema !== undefined && !byName.has(tool.name)) byName.set(tool.name, tool.schema);
  }
  if (byName.size === 0) return grammar;
  const names = [...byName.keys()].sort();
  const key = names.map((name) => `${name}\u0000${schemaKey(byName.get(name))}`).join("\n");
  let perGrammar = cache.get(grammar);
  const hit = perGrammar?.get(key);
  if (hit !== undefined) return hit;
  const built = buildStrict(grammar, names, byName);
  if (perGrammar === undefined) {
    if (cache.size >= CACHE_GRAMMARS) cache.delete(cache.keys().next().value!);
    perGrammar = new Map();
    cache.set(grammar, perGrammar);
  }
  if (perGrammar.size >= CACHE_PER_GRAMMAR) perGrammar.delete(perGrammar.keys().next().value!);
  perGrammar.set(key, built);
  return built;
}

function schemaKey(schema: unknown): string {
  if (typeof schema !== "object" || schema === null) return `=${JSON.stringify(schema) ?? ""}`;
  let id = schemaIds.get(schema);
  if (id === undefined) {
    id = nextSchemaId++;
    schemaIds.set(schema, id);
  }
  return `#${id}`;
}

function buildStrict(grammar: string, names: string[], schemas: ReadonlyMap<string, unknown>): string {
  const rules = new Map<string, string>();
  for (const match of grammar.matchAll(RULE_LINE_RE)) rules.set(match[1]!, match[2]!);
  if (Object.values(HOST_RULES).some((rule) => !rules.has(rule))) return grammar;
  const toolCall = rules.get("tool-call");
  const toolName = rules.get("tool-name");
  if (toolCall === undefined || toolName === undefined) return grammar;
  const branches = toolCall.split(" | ");
  if (!branches.includes("other-call") || branches.includes(STRICT_CALL_RULE)) return grammar;

  const sources = toolName.split(" | ").map((alt) => readNameSource(alt.trim(), rules));
  const admitted = new Set(sources.flatMap(sourceNames));
  admitted.delete(GRAMMAR_EXIT_TOOL);

  const table = new RuleTable(new Set(rules.keys()));
  const callRules: string[] = [];
  const strict = new Set<string>();
  for (const name of names) {
    if (!admitted.has(name)) continue;
    if (table.rules.size >= STRICT_ARGS_LIMITS.totalRules) break;
    const converted = convertTool(name, schemas.get(name), table);
    if (converted === null) continue;
    const addedChars = converted.added.reduce((n, [, body]) => n + body.length, 0);
    if (totalChars(table) + addedChars > STRICT_ARGS_LIMITS.totalChars) continue;
    commitArgs(table, converted);
    callRules.push(converted.rule);
    strict.add(name);
  }
  if (strict.size === 0) return grammar;

  const keptSources = sources.flatMap((source) => withoutNames(source, strict));
  let out = grammar;
  for (const source of keptSources) {
    if (source.kind === "flat" || source.kind === "prefix") {
      out = replaceRule(out, source.rule, sourceBody(source));
    }
  }
  const keptAlternatives = keptSources.map(sourceText);
  const nextBranches = branches.flatMap((branch) =>
    branch === "other-call"
      ? keptAlternatives.length > 0 ? [STRICT_CALL_RULE, branch] : [STRICT_CALL_RULE]
      : [branch],
  );
  out = out.replace(TOOL_CALL_RULE_RE, () => `tool-call ::= ${nextBranches.join(" | ")}`);
  if (keptAlternatives.length > 0) {
    out = out.replace(TOOL_NAME_RULE_RE, () => `tool-name ::= ${keptAlternatives.join(" | ")}`);
  }
  const lines = [
    "# ATO-633 (localModels.strictToolArgs): per-tool args rules generated from each tool's JSON Schema.",
    // The shared `{"tool":` opens once; the alternatives start at the name.
    `${STRICT_CALL_RULE} ::= "{" ws "\\"tool\\"" ws ":" ws ( ${callRules.join(" | ")} ) ws "}"`,
    ...[...table.rules].map(([name, body]) => `${name} ::= ${body}`),
  ];
  return `${out.trimEnd()}\n${lines.join("\n")}\n`;
}

/** One tool's call and args rules, or `null` when it stays on the any-object path. */
function convertTool(name: string, schema: unknown, table: RuleTable): ConvertedArgs | null {
  try {
    const seen = { plain: false };
    const converted = convertArgsSchema(
      schema,
      `args-${name}`,
      table,
      { maxRules: STRICT_ARGS_LIMITS.perToolRules, maxChars: STRICT_ARGS_LIMITS.perToolChars },
      (sink, argsRule) => {
        seen.plain = argsRule === HOST_RULES.object;
        const ws = HOST_RULES.ws;
        return sink.addRule(
          `args-${name}-call`,
          `${quoteGbnf(`"${name}"`)} ${ws} "," ${ws} "\\"args\\"" ${ws} ":" ${ws} ${argsRule}`,
        );
      },
    );
    // A rule that is the plain object anyway gains nothing: keep the tool in `tool-name`.
    return seen.plain ? null : converted;
  } catch (error) {
    if (error instanceof SchemaConversionError) return null;
    throw error;
  }
}

function totalChars(table: RuleTable): number {
  let n = 0;
  for (const body of table.rules.values()) n += body.length;
  return n;
}

function readNameSource(alt: string, rules: ReadonlyMap<string, string>): NameSource {
  const lit = NAME_LITERAL_RE.exec(alt);
  if (lit) return { kind: "literal", name: lit[1]! };
  const body = rules.get(alt);
  if (body === undefined) return { kind: "opaque", text: alt };
  const flat = body.split(" | ").map((part) => NAME_LITERAL_RE.exec(part.trim()));
  if (flat.every((m) => m !== null)) {
    return { kind: "flat", rule: alt, names: flat.map((m) => m![1]!) };
  }
  const grouped = PREFIX_GROUP_RE.exec(body);
  if (grouped) {
    const suffixes = grouped[2]!.split(" | ").map((s) => s.trim().slice(1, -1));
    return { kind: "prefix", rule: alt, prefix: grouped[1]!, suffixes };
  }
  return { kind: "opaque", text: alt };
}

function sourceNames(source: NameSource): string[] {
  switch (source.kind) {
    case "literal":
      return [source.name];
    case "flat":
      return source.names;
    case "prefix":
      return source.suffixes.map((s) => source.prefix + s);
    case "opaque":
      return [];
  }
}

/** `source` minus `strict` names; none left drops it from `tool-name`. */
function withoutNames(source: NameSource, strict: ReadonlySet<string>): NameSource[] {
  switch (source.kind) {
    case "literal":
      return strict.has(source.name) ? [] : [source];
    case "flat": {
      const names = source.names.filter((n) => !strict.has(n));
      return names.length === 0 ? [] : [{ ...source, names }];
    }
    case "prefix": {
      const suffixes = source.suffixes.filter((s) => !strict.has(source.prefix + s));
      return suffixes.length === 0 ? [] : [{ ...source, suffixes }];
    }
    case "opaque":
      return [source];
  }
}

function sourceText(source: NameSource): string {
  switch (source.kind) {
    case "literal":
      return quoteGbnf(`"${source.name}"`);
    case "flat":
    case "prefix":
      return source.rule;
    case "opaque":
      return source.text;
  }
}

function sourceBody(source: Extract<NameSource, { kind: "flat" | "prefix" }>): string {
  if (source.kind === "flat") return source.names.map((n) => quoteGbnf(`"${n}"`)).join(" | ");
  const group = source.suffixes.map((s) => `"${s}"`).join(" | ");
  return `${quoteGbnf(`"${source.prefix}`)} ( ${group} ) ${quoteGbnf('"')}`;
}

function replaceRule(grammar: string, rule: string, body: string): string {
  return grammar.replace(new RegExp(`^${rule} ::= .*$`, "m"), () => `${rule} ::= ${body}`);
}
