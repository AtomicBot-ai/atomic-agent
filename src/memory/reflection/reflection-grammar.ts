/**
 * GBNF grammar constraining the reflection completion. The output is
 * either the literal string `NONE` (no durable facts) or up to three
 * `SET key=value` lines. Keys follow a conservative snake_case subset;
 * values are opaque single-line strings capped at 200 chars.
 *
 * The grammar is a module-level constant so it participates in the
 * reflection slot's stable prefix cache — callers must not mutate it.
 */
export const REFLECTION_GRAMMAR = `root  ::= none | sets
none  ::= "NONE" "\\n"?
sets  ::= set set? set?
set   ::= "SET " key "=" value "\\n"
key   ::= [a-z] [a-z0-9_]{0,31}
value ::= [^\\n]{1,200}
`;
