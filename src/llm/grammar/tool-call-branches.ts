import { quoteGbnf } from "./reasoning-prelude.js";

/**
 * The `tool-call` rule of the static grammar and how a per-request
 * grammar narrows it. Split out of `build-grammar.ts`, which keeps the
 * per-request cache and calls `narrowToolCallRules` on a cache miss.
 */

/** The one rule a per-request grammar rewrites for the generic branch. */
const TOOL_NAME_RULE_RE = /^tool-name ::= .*$/m;

/** Terminal verb every restricted grammar keeps: a step must be able to exit. */
export const GRAMMAR_EXIT_TOOL = "reply";

/**
 * Tools whose calls have their own branch of `tool-call`, outside
 * `tool-name`, because their args have required fields the generic
 * `object` rule cannot enforce (`grammars/tool-call.gbnf`): `os.shell.run`
 * needs a non-empty `cmd`, `os.fs.read` a non-empty `path`, `os.fs.write`
 * a non-empty `path` and a `content` string. Listed in the order the
 * branches appear in the rule.
 */
const DEDICATED_BRANCHES: ReadonlyArray<{ tool: string; rule: string }> = [
  { tool: "os.shell.run", rule: "shell-call" },
  { tool: "os.fs.read", rule: "fs-read-call" },
  { tool: "os.fs.write", rule: "fs-write-call" },
];

/**
 * The split `tool-call` rule of a grammar whose `reply` has its own branch
 * (#681): `reply-call` carries reply with the guarded text rule, then the
 * dedicated branches the grammar has, then `other-call` (the generic
 * branch over `tool-name`, which lists none of them). An older grammar
 * without the split keeps `reply` in `tool-name`; one from before a
 * dedicated branch existed simply lacks it and still narrows.
 */
const SPLIT_TOOL_CALL_RULE_RE = new RegExp(
  `^tool-call ::= reply-call((?: \\| (?:${[...DEDICATED_BRANCHES.map((b) => b.rule), "other-call"].join("|")}))*)$`,
  "m",
);

/**
 * The per-request rewrite of a base grammar's call rules for `names`
 * (sorted, deduplicated, `reply` included). A split grammar keeps `reply`
 * on its own branch, keeps each dedicated branch the base defines and the
 * request admits, and lists the other names in `tool-name`. A branch with
 * nothing to carry is dropped from `tool-call` (an empty alternation is
 * not valid GBNF); `tool-name` is then left as it was, an unreferenced
 * rule llama.cpp still parses. A grammar without the split gets every
 * name in `tool-name`.
 */
export function narrowToolCallRules(grammar: string, names: string[]): string {
  if (!SPLIT_TOOL_CALL_RULE_RE.test(grammar)) return replaceToolNameRule(grammar, names);
  const branches = ["reply-call"];
  const carried = new Set([GRAMMAR_EXIT_TOOL]);
  for (const { tool, rule } of DEDICATED_BRANCHES) {
    if (!new RegExp(`^${rule} ::= `, "m").test(grammar)) continue;
    carried.add(tool);
    if (names.includes(tool)) branches.push(rule);
  }
  const others = names.filter((name) => !carried.has(name));
  if (others.length > 0) branches.push("other-call");
  const narrowed = grammar.replace(SPLIT_TOOL_CALL_RULE_RE, `tool-call ::= ${branches.join(" | ")}`);
  return others.length > 0 ? replaceToolNameRule(narrowed, others) : narrowed;
}

function replaceToolNameRule(grammar: string, names: string[]): string {
  const rule = `tool-name ::= ${names.map(quoteToolNameLiteral).join(" | ")}`;
  return TOOL_NAME_RULE_RE.test(grammar)
    ? grammar.replace(TOOL_NAME_RULE_RE, rule)
    : // A base without the rule (an older grammar file): a later
      // definition wins in GBNF, so appending still restricts.
      `${grammar.trimEnd()}\n${rule}\n`;
}

/**
 * The tool names a grammar admits when its `tool-name` rule is a flat
 * alternation of literals (the shape `buildGrammarForTools` writes),
 * sorted, with `reply` and every dedicated branch the `tool-call` rule
 * lists included. `null` for the static base grammar, whose rule is
 * composed of sub-rules. A test helper more than a runtime one.
 */
export function grammarToolNames(grammar: string): string[] | null {
  const split = grammar.match(SPLIT_TOOL_CALL_RULE_RE);
  const branches = split ? split[1]!.split(" | ").filter((b) => b.length > 0) : null;
  const names: string[] = [];
  if (branches === null || branches.includes("other-call")) {
    const match = grammar.match(TOOL_NAME_RULE_RE);
    if (!match) return null;
    const body = match[0].slice("tool-name ::= ".length);
    for (const alt of body.split("|")) {
      const literal = alt.trim().match(/^"\\"(.*)\\""$/);
      if (!literal) return null;
      names.push(literal[1]!);
    }
  }
  if (branches !== null) {
    names.push(GRAMMAR_EXIT_TOOL);
    for (const { tool, rule } of DEDICATED_BRANCHES) {
      if (branches.includes(rule)) names.push(tool);
    }
  }
  return Array.from(new Set(names)).sort();
}

/** `os.fs.read` → `"\"os.fs.read\""` — a JSON string literal inside a GBNF one. */
function quoteToolNameLiteral(name: string): string {
  return quoteGbnf(`"${name}"`);
}
