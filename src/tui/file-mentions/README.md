# File mentions in the composer

Status: current
Owner: src/tui/file-mentions/

Typing `@` in the composer (at the start of the buffer or after a space) opens a palette of the working directory's files; the typed text after `@` filters it with fuzzysort. Up and Down move, Tab, Enter or Right complete the highlighted path, Esc closes the palette until the buffer changes.

- [File index](file-index.ts): `git ls-files` (tracked and untracked, `.gitignore` respected) inside a repository, otherwise a breadth-first walk that skips dependency and build folders. Capped at 20 000 paths and a 200 ms walk budget; one cached list per working directory, refreshed in the background after 15 s. Paths with whitespace are left out, since a mention ends at whitespace.
- [Palette state](use-file-mentions.ts) is composer-local React state, not reducer state. [Palette view](file-mention-palette.tsx) is drawn by TuiApp where the slash palette sits.
- [Expansion](expand-mentions.ts) runs on an idle submit (`submit-handler.ts`, through the `expandFileMentions` callback). Each `@path` that is a file inside the working directory is inlined; anything else stays plain text. Paths outside the folder are never read, checked on the written path and again after symlinks. Caps: 32 KB per file, 96 KB and 8 files per message; binary files are listed but not inlined, and a cut is stated in the message.
- [Block format](mention-block.ts): appended after the typed text. The chat bubble and input history show the typed text (plus one line per file in the bubble); the transcript keeps the full message the model saw.

Steered and queued messages (sent while a turn runs) are not expanded: their `@path` reaches the model as text, which it can read with its own file tools.

Tests: [query](mention-query.test.ts), [block](mention-block.test.ts), [expansion](expand-mentions.test.ts), [index](file-index.test.ts), [ranking](rank-mention-files.test.ts), [palette](file-mention-palette.test.tsx).
