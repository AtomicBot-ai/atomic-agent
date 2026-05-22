/**
 * Memory-v2 phase 7a. GBNF grammar for the `vote-runner` reflection
 * sub-call.
 *
 * Output is either the literal `NONE` (the model judged the surfaced
 * items not worth voting on) or up to 8 vote lines, each of the form
 *
 *   UPVOTE   <kind>:<id>
 *   DOWNVOTE <kind>:<id>
 *
 * where `<kind>` is one of `memory`, `lesson`, `profile` and `<id>`
 * is an unsigned decimal integer. The caller's parser drops any
 * `<kind>:<id>` pair not in this turn's surfaced allowlist
 * (cross-phase invariant 18 in MEMORY_FABRIC_V2.md §13.7.4) — the
 * grammar deliberately does **not** try to embed the allowlist into
 * the GBNF because the per-turn id list would invalidate the
 * reflection-slot KV-cache on every turn.
 *
 * The eight-entry cap matches the reflection prompt's allowlist
 * window — surfaced items are at most 8 by construction
 * (`recallInjection.k=3 lessons + recallInjection.k=3 notes + ~2
 * profile facts gated by keywords`). The parser drops anything past
 * the cap defensively.
 *
 * EDIT markers from §6.4 of the spec are intentionally absent from
 * this grammar — they were deferred per scope decision for the
 * Phase 7a slice. Re-enable by adding an `edit` alternative branch
 * once §6.4 EDIT semantics are implemented.
 *
 * Keep this grammar a module-level constant so it participates in
 * the reflection slot's stable prefix cache — callers must not
 * mutate it.
 */
// IMPORTANT: alternatives are ordered `entries | none` (not the
// other way around). GBNF samplers exhibit a strong first-token
// bias toward the first alternative — putting `none` first caused
// production traces to default to `NONE` on small models (Qwen-3.5
// 9B in particular) even when surfaced items were clearly relevant.
// The mirror of the array-only tool-call root in AGENTS.md.
export const VOTE_GRAMMAR = `root    ::= entries | none
none    ::= "NONE" "\\n"?
entries ::= entry entry? entry? entry? entry? entry? entry? entry?
entry   ::= verb " " kind ":" digit+ "\\n"
verb    ::= "UPVOTE" | "DOWNVOTE"
kind    ::= "memory" | "lesson" | "profile" | "procedure"
digit   ::= [0-9]
`;
