/**
 * ATO-672. GBNF grammar for the note-reconcile sub-call (local models).
 *
 * Output is the literal `NONE` (the new note and the older ones can all
 * stay) or up to two decision lines:
 *
 *   SUPERSEDE <id>   the new note makes older note <id> outdated
 *   DUPLICATE <id>   the new note only repeats older note <id>
 *
 * The parser drops ids outside the candidate allowlist.
 */
export const NOTE_RECONCILE_GRAMMAR = `root    ::= none | entries
none    ::= "NONE" "\\n"?
entries ::= entry entry?
entry   ::= action " " digit+ "\\n"
action  ::= "SUPERSEDE" | "DUPLICATE"
digit   ::= [0-9]
`;
