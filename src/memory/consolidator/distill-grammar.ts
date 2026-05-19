/**
 * Memory-v2 phase 5. GBNF grammar constraining the distill LLM call
 * to one `LESSON` line.
 *
 * Shape:
 *
 *   LESSON activation="<text>"; principle="<text>"[; tags=a,b,c]\n
 *
 * Strings are double-quoted with a minimal printable-ASCII charset
 * (`tab` + `\x20-\x7e` minus `"`). The text itself never contains
 * embedded double quotes; the parser further trims and enforces
 * length caps. Tags are lowercase ASCII identifiers, 1..6 items
 * comma-separated. The terminating newline mirrors the reflection
 * grammar shape so the same llama-server stop tokens work.
 *
 * The grammar is intentionally tiny — phase 7b will compose this
 * with a sibling `PROCEDURE` line in `lesson-and-procedure-grammar`
 * (invariant 21: one distill LLM call covers both shapes).
 *
 * Tag count tightening (E4 audit, 2026-05-18): when the model emits
 * `; tags=...` the list must contain at least 3 tags. The abstain
 * sentinel (`LESSON activation="(no consensus)"; principle="(no
 * durable advice)"`) carries no tags and stays well-formed because
 * `opt-tags` itself remains optional — the {2,5} lower bound only
 * applies inside the \`tags=\` block.
 *
 * Tag charset tightening (E4 follow-up, 2026-05-18): \`tagid\` no
 * longer accepts \`_\` and is capped at 24 chars. Earlier runs showed
 * the model bypassing the {2,5} count by emitting a single
 * \`lint_precommit_tool_file\` token instead of four CSV tags. The
 * parser remains permissive on \`_\` for replay of historical
 * lessons, but new model output is now forced into "single concept
 * words, multi-word concepts joined with a hyphen".
 */
export const DISTILL_GRAMMAR = `root ::= lesson "\\n"
lesson ::= "LESSON activation=" qstr "; principle=" qstr opt-tags
opt-tags ::= ("; tags=" taglist)?
taglist ::= tagid ("," tagid){2,5}
tagid ::= [a-z][a-z0-9\\-]{0,23}
qstr ::= "\\"" qchar+ "\\""
qchar ::= [\\t\\x20-\\x21] | [\\x23-\\x7e]
`;

/**
 * Memory-v2 phase 7b. Combined grammar producing one mandatory
 * `LESSON` line plus one **optional** `PROCEDURE` line, both
 * emitted by a single distillation LLM call (invariant 21: still
 * ONE inference per cluster, regardless of whether the model
 * chooses to add a procedure or not).
 *
 * Shape:
 *
 *   LESSON activation="<text>"; principle="<text>"[; tags=a,b,c]\n
 *   [PROCEDURE activation="<text>"; steps="<step1>; <step2>; ..."[; tags=...]\n]
 *
 * Decision: the procedure shares the same surface charset as the
 * lesson. Steps are encoded as a single quoted string with `; `
 * separators between 2..8 entries; each step is `description` or
 * `description@toolhint`. The semicolon-and-space delimiter keeps
 * GBNF tiny: a step body is plain `qchar` text with `@` allowed.
 *
 * The parser further normalises: trims whitespace, strips empty
 * step entries, validates the `@toolhint` against the procedure
 * store's `TOOL_HINT_PATTERN`, and rejects oversize step bodies.
 * Same abstain sentinel as the lesson — if the model only emits
 * the LESSON line, the parser returns `procedure: null`.
 *
 * **One inference per cluster.** This grammar is plugged into the
 * existing `DistillRunner.distill(...)` codepath: the runner makes
 * one `llmComplete` call, the response is parsed into both shapes
 * together. There is no second LLM round-trip for the procedure
 * (scenario 7b.A.6 / 7b.B.3 pin invariant 21).
 */
export const DISTILL_WITH_PROCEDURE_GRAMMAR = `root ::= lesson "\\n" opt-procedure
lesson ::= "LESSON activation=" qstr "; principle=" qstr opt-tags
opt-procedure ::= ("PROCEDURE activation=" qstr "; steps=" qstr opt-tags "\\n")?
opt-tags ::= ("; tags=" taglist)?
taglist ::= tagid ("," tagid){2,5}
tagid ::= [a-z][a-z0-9\\-]{0,23}
qstr ::= "\\"" qchar+ "\\""
qchar ::= [\\t\\x20-\\x21] | [\\x23-\\x7e]
`;
