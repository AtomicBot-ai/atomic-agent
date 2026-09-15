/**
 * The reasoning prelude of a grammar-served thinking model: the rules
 * that admit a think block ahead of the tool-call array, and the two
 * per-request variants a step swaps in (F49).
 *
 * The base grammar carries the BOUNDED prelude: `think-body ::=
 * think-char{0,N}` with `N = localModels.reasoningBudgetTokens × 4`. Past
 * N matches the sampler admits only the close sentinel, so the model is
 * forced to close the block and emit the call. llama.cpp expands `{0,N}`
 * into N nested optional rules server-side — the string sent stays
 * small; the expansion is linear in N and parses in milliseconds at the
 * default (6,000 rules). The unbounded form (`budgetChars === 0`) is the
 * pre-F49 text, kept byte-identical.
 */

/** `think-body ::= think-char{0,N}` — the line the bounded base grammar carries. */
const BOUNDED_BODY_RE = /^([a-z]+)-body ::= ([a-z]+)-char\{0,\d+\}$/m;

/** `root ::= think-prelude tool-call-array` — the root of a reasoning profile's grammar. */
const PRELUDE_ROOT_RE = /^root ::= [a-z-]+-prelude tool-call-array$/m;

/**
 * The prelude rules for `sentinel` (the reasoning close tag), routed
 * into `tool-call-array`. `openSentinel` leads the prelude when the
 * model emits its own open tag (Gemma 4 turn framing); otherwise the
 * prompt prefilled it. `budgetChars` bounds the body; `0` leaves it
 * unbounded.
 */
export function buildReasoningPreludeRules(
  ruleStem: string,
  sentinel: string,
  openSentinel: string | undefined,
  budgetChars: number,
): string {
  const preludeRule = `${ruleStem}-prelude`;
  const bodyRule = `${ruleStem}-body`;
  const bounded = budgetChars > 0;
  // Bounded: one character per repetition (a `<`-led alternative still
  // spans its whole prefix), so `{0,N}` is a bound in characters.
  // Unbounded: today's greedy `[^<]+` fragment, byte for byte.
  const unitRule = bounded ? `${ruleStem}-char` : `${ruleStem}-fragment`;
  const first = escapeCharClass(sentinel[0]!);
  const fragments = [bounded ? `[^${first}]` : `[^${first}]+`];
  const openLiteral =
    openSentinel !== undefined ? `${quoteGbnf(openSentinel)} ` : "";

  for (let idx = 0; idx < sentinel.length - 1; idx += 1) {
    const prefix = sentinel.slice(0, idx + 1);
    const nextChar = sentinel[idx + 1]!;
    fragments.push(`${quoteGbnf(prefix)} [^${escapeCharClass(nextChar)}]`);
  }

  // Bounded trailing whitespace between the reasoning-close sentinel and
  // the start of `tool-call-array` (`[`). The global `ws` rule is
  // unbounded (`[ \t\n\r]*`) which is fine inside JSON but on this seam
  // it lets small reasoning-capable models (e.g. Gemma 4 26B-A4B) slide
  // into a whitespace-only degenerate loop after a long `<think>` /
  // `<|channel>thought` block: the sampler keeps emitting newlines until
  // `max_tokens` instead of converging on the `[`. Eight characters is
  // enough for any natural " " / "\n" / "  " gap and short enough to
  // bound the failure mode.
  return [
    `${preludeRule} ::= ${openLiteral}${bodyRule} ${quoteGbnf(sentinel)} prelude-trail-ws`,
    `${bodyRule} ::= ${bounded ? `${unitRule}{0,${budgetChars}}` : `${unitRule}*`}`,
    `${unitRule} ::= ${fragments.join(" | ")}`,
    `prelude-trail-ws ::= ( [ \\t\\n\\r] ){0,8}`,
  ].join("\n");
}

/**
 * The grammar with its reasoning bound lifted: `think-char{0,N}` becomes
 * `think-char*`, every other byte identical. For the forced final step
 * (`reply` / `finish`), which is never cut mid-thought. A grammar
 * without a bounded body (plain profile, budget 0) is returned as is —
 * the same string, so the per-request cache keys on it unchanged.
 */
export function withUnboundedReasoningPrelude(grammar: string): string {
  return BOUNDED_BODY_RE.test(grammar)
    ? grammar.replace(BOUNDED_BODY_RE, "$1-body ::= $2-char*")
    : grammar;
}

/**
 * The grammar with the plain root — `root ::= tool-call-array`, no
 * prelude — for `localModels.thinking: "off"` on the hand-built prompt
 * path, where the prompt ends with the template's own disabled marker
 * and the completion starts outside any think block. The prelude rules
 * stay defined but unreferenced (harmless in GBNF, and the rest of the
 * grammar stays byte-stable). A plain grammar is returned as is.
 */
export function withoutReasoningPrelude(grammar: string): string {
  return PRELUDE_ROOT_RE.test(grammar)
    ? grammar.replace(PRELUDE_ROOT_RE, "root ::= tool-call-array")
    : grammar;
}

export function quoteGbnf(text: string): string {
  return `"${text
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"')}"`;
}

function escapeCharClass(char: string): string {
  return char.replace(/\\/g, "\\\\").replace(/]/g, "\\]").replace(/-/g, "\\-");
}
