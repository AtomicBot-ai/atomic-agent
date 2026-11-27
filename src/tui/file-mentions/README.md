# File mentions in the composer

Status: current
Owner: src/tui/file-mentions/

Typing `@` in the composer (at the start of the buffer or after a space) opens a palette of the working directory's files and folders; the typed text after `@` filters it with fuzzysort. Up and Down move, Tab, Enter or Right complete the highlighted path, Esc closes the palette until the buffer changes. Above the files the [rows](mention-rows.ts) offer `diff`, `git:5` and `problems` for a matching prefix, and keep a typed range (`src/a.ts:10-20`), `git:N` or link as the top row (ATO-2472). A folder completes without a space, so the palette goes on inside it. What each mention inlines is the shared [mentions](../../mentions/README.md) area.

- [File index](file-index.ts): `git ls-files` (tracked and untracked, `.gitignore` respected) inside a repository, otherwise a breadth-first walk that skips dependency and build folders. Capped at 20 000 paths and a 200 ms walk budget; one cached list per working directory, refreshed in the background after 15 s. Paths with whitespace are left out, since a mention ends at whitespace.
- [Palette state](use-file-mentions.ts) is composer-local React state, not reducer state. [Palette view](file-mention-palette.tsx) is drawn by TuiApp where the slash palette sits.
- Expansion runs on an idle submit (`submit-handler.ts`, through the `expandFileMentions` callback, [sender](mention-sender.ts)): plain file mentions are inlined at once; a message with `@diff`, `@git:N`, a range, a folder, a link or `@problems` goes to `runtime.mentions.expand` and is sent when it is read. [Ordered send](ordered-send.ts) keeps a steer, queued message or approval reply typed meanwhile behind it.
- [Block format](../../mentions/mention-block.ts): appended after the typed text. The chat bubble and input history show the typed text (plus one line per mention in the bubble); the transcript keeps the full message the model saw.
- The file list's `git ls-files` runs with the same safe prefix as every mention git call (no fsmonitor, hooks, pager or signature program).

Steered and queued messages (sent while a turn runs) are not expanded: their `@path` reaches the model as text, which it can read with its own file tools.

Tests: [query](mention-query.test.ts), [rows](mention-rows.test.ts), [order](ordered-send.test.ts), [sender](mention-sender.test.ts), [index](file-index.test.ts), [ranking](rank-mention-files.test.ts), [palette](file-mention-palette.test.tsx).
