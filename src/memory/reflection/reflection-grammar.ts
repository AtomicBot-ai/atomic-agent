/**
 * GBNF grammar constraining the reflection completion. The output is
 * either the literal string `NONE` (no durable content) or up to six
 * lines, each of which is a `SET`, `NOTE`, or (memory-v2 phase 3)
 * `EVOLVE` directive.
 *
 * Three-channel design:
 *  - `SET key=value`              — atomic key/value facts that flow
 *    into `ProfileStore` (rendered into every prompt via `### profile`).
 *  - `NOTE body`                  — freeform episodic observations that
 *    flow into `MemoryStore` (searchable via `memory.notes.recall`,
 *    never auto-rendered into the prompt).
 *  - `EVOLVE #<id> [tags=...]`    — phase 3. Metadata-only refinement of
 *    an existing memory's `tags` column. **Content is never touched** —
 *    that contract is locked at the `MemoryStore.evolveTags` level so a
 *    runaway parser cannot violate the append-only invariant either.
 *    The parser drops EVOLVE lines whose `#id` is not in the per-turn
 *    surfaced allowlist (same anti-feedback guard as the link-generator
 *    phase 2 introduced).
 *
 * NOTE body may carry an optional **leading** `[type=...]` marker
 * (v2.5 typed-NOTE extraction, opt-in via
 * `memory.reflection.typedNotes.enabled`) and an optional **trailing**
 * ` [tags=a,b,c]` marker. Both are extracted by the parser post-hoc;
 * the grammar accepts the leading typemarker as an optional production
 * so legacy untyped NOTEs from older sessions remain valid. The
 * trailing tag region is unconstrained to keep the production tree
 * shallow.
 *
 * The grammar is a module-level constant so it participates in the
 * reflection slot's stable prefix cache — callers must not mutate it.
 * Touching the grammar invalidates the reflection slot's KV cache for
 * one call as the new constraints differ from the old; the main agent
 * slot is unaffected.
 */
export const REFLECTION_GRAMMAR = `root      ::= none | entries
none      ::= "NONE" "\\n"?
entries   ::= entry entry? entry? entry? entry? entry?
entry     ::= set | note | evolve
set       ::= "SET " key "=" value "\\n"
note      ::= "NOTE " typemark? body "\\n"
evolve    ::= "EVOLVE #" digits " [tags=" taglist "]" "\\n"
typemark  ::= "[type=" notetype "] "
notetype  ::= "event" | "behavior" | "knowledge" | "skill"
key       ::= [a-z] [a-z0-9_]{0,31}
value     ::= [^\\n]{1,200}
body      ::= [^\\n]{1,500}
digits    ::= [0-9]+
taglist   ::= tag ("," tag){0,9}
tag       ::= [a-zA-Z0-9_-]{1,32}
`;

/**
 * Canonical set of NOTE type categories accepted by the parser. Kept
 * in sync with the `notetype` production above and the per-type
 * extraction guidelines in `REFLECTION_STABLE_PREFIX_TYPED`. The
 * parser projects these into synthetic tags of the form `type:event`
 * etc. so downstream BM25 / link-graph / lesson distillation can
 * distinguish episodes, patterns, knowledge, and skills without
 * touching the schema.
 */
export const NOTE_TYPES = ["event", "behavior", "knowledge", "skill"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];
