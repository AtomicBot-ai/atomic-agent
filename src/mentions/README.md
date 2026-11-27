# `@` mentions

Status: current
Owner: src/mentions/

One implementation of the composer's `@` mentions for every surface (ATO-2472, after ATO-665 in the terminal and ATO-2241 in the desktop). The terminal calls it in process through `runtime.mentions`; the desktop sends the message text to `POST /api/mentions/expand` and reads `GET /api/problems` ([routes](../http/route-mentions.ts)).

| Typed | What is inlined | Precedent |
|---|---|---|
| `@src/app.ts` | the file ([file mentions](expand-file-mentions.ts)) | Claude Code `@file` |
| `@src/app.ts:10-20`, `:10`, `#L10-20`, `#L10` | those lines, numbered ([local](mention-local.ts)) | Claude Code `@file#L10-20` |
| `@src/` | the folder's file list, up to 200 paths | Claude Code folders, Cursor `@Folders` |
| `@diff` | `git diff HEAD` under the folder ([git](mention-git.ts)) | Cursor `@Git` |
| `@git:N` | the last N commits (1 to 20) with stat and patch | Cursor `@Commit` |
| `@https://...` | the page as text ([url](mention-url.ts)) | Cursor `@Web` / `@Link` |
| `@problems` | the language servers' errors and warnings ([problems](mention-problems.ts)) | Continue `@Problems`, the VS Code Problems panel |

- Parsing of the words and the palette rows is [mention-kinds.ts](mention-kinds.ts); a word that is a real file always stays a file mention.
- Everything goes into one `<mentioned-files>` block after the typed text ([block](mention-block.ts)), under shared caps: 8 entries, 32 KB each, 96 KB per message. A cut or a skip is stated in the block.
- Scope: a file, range or folder must be inside the working folder on the path as written and after symlinks. The agent's key and trust files (`getStateSecretPaths`) are named, never inlined. Git runs with `--relative -- .` and the desktop's ATO-2532 list (`--no-pager`, `--no-optional-locks`, `core.fsmonitor=false`, `core.untrackedCache=false`, `core.hooksPath` to the null device, `log.showSignature=false`, `protocol.ext.allow=never`), no external diff or textconv, and the shell tool's environment without provider keys or an inherited `GIT_DIR`. Links are http(s) only, 8 s and 512 KB, every redirect is followed by hand: for a public link each hop is resolved and checked with the web tools' [SSRF guard](../tools/os/web/web-fetch-ssrf-guard.ts) and the connection pinned to the checked addresses before it is made, so a redirect to a local address is refused without being asked ([hops](mention-url-hops.ts), ATO-2797; with a proxy the hops are checked but not pinned). A local link typed as such (by its text: `localhost`, a private IP, a `.local` name) is read, redirects included. A typed name whose lookup fails is not read; a typed name whose answer holds a local address gets its first request as typed and every redirect checked. Offline mode refuses them.
- `@problems` ([collector](../tools/os/fs/lsp/lsp-workspace-problems.ts)) reads the tools' language-server pool (`tools.lsp.enabled`): what running servers published for files in the folder, plus a fresh check of the files git says changed (at most 20, 8 s in all). It never asks to start a server: one starts only where it may start unasked. With servers off, or none running for the folder, the block says so in a plain sentence; with none reported, "No problems found.". At most 100 problems are listed, errors first.
- [Services](mention-services.ts) tie it to the runtime: `expandNow` answers at once for plain files, `expand` reads the rest.

Tests: [kinds](mention-kinds.test.ts), [expansion](context-mentions.test.ts), [files](expand-file-mentions.test.ts), [block](mention-block.test.ts), [git](mention-git.test.ts), [links](mention-url.test.ts), [redirects](mention-url-hops.test.ts), [problems](mention-problems.test.ts), [services](mention-services.test.ts).
