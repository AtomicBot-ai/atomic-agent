/**
 * GBNF grammar constraining the reflection completion. The output is
 * either the literal string `NONE` (no durable content) or up to six
 * lines, each of which is either a `SET key=value` fact or a `NOTE body`
 * freeform observation.
 *
 * Two-channel design:
 *  - `SET key=value`  — atomic key/value facts that flow into
 *    `ProfileStore` (rendered into every prompt via `### profile`).
 *  - `NOTE body`      — freeform episodic observations that flow into
 *    `MemoryStore` (searchable via `memory.notes.recall`, never
 *    auto-rendered into the prompt).
 *
 * Note body may carry an optional trailing ` [tags=a,b,c]` marker that
 * the parser extracts post-hoc; the grammar itself does not constrain
 * the trailing tag region to keep the production tree shallow.
 *
 * The grammar is a module-level constant so it participates in the
 * reflection slot's stable prefix cache — callers must not mutate it.
 */
export const REFLECTION_GRAMMAR = `root    ::= none | entries
none    ::= "NONE" "\\n"?
entries ::= entry entry? entry? entry? entry? entry?
entry   ::= set | note
set     ::= "SET " key "=" value "\\n"
note    ::= "NOTE " body "\\n"
key     ::= [a-z] [a-z0-9_]{0,31}
value   ::= [^\\n]{1,200}
body    ::= [^\\n]{1,500}
`;
