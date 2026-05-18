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
