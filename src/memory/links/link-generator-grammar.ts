/**
 * Memory-v2 phase 2. GBNF grammar for the `link-generator` reflection
 * sub-call.
 *
 * Output is either the literal `NONE` (no relations found between the
 * surfaced ids) or up to four LINK lines, each of the form
 *
 *   LINK <from_id> <to_id> [kind=<KIND>]
 *
 * where `from_id` / `to_id` are unsigned decimal integers (caller
 * verifies they belong to the surfaced allowlist — see
 * `link-generator-parser.ts`) and `<KIND>` is one of the fixed
 * `LINK_KINDS` strings.
 *
 * The four-entry cap is conservative: production traces will likely
 * tighten it further (the typical macro-turn surfaces ≤ 5 memory ids,
 * so ≥ 4 emitted links almost certainly means the LLM is fabricating
 * relations). The parser drops anything past the cap defensively.
 *
 * Keep this grammar a module-level constant so it participates in the
 * reflection slot's stable prefix cache — callers must not mutate it.
 */
export const LINK_GENERATOR_GRAMMAR = `root    ::= none | entries
none    ::= "NONE" "\\n"?
entries ::= entry entry? entry? entry?
entry   ::= "LINK " digit+ " " digit+ " [kind=" kind "]" "\\n"
kind    ::= "RELATES_TO" | "CAUSED_BY" | "REFERENCES" | "CONTRADICTS" | "DUPLICATES" | "SUPERSEDES"
digit   ::= [0-9]
`;
