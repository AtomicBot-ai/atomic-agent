# CLI frontend

Status: current
Owner: src/cli/

Owns command parsing and terminal entry points. User turns enter runtime.runTurn; preserve exit semantics, state-dir selection and separation from release scripts.

Entry point: [index.ts](index.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Skill list/show/enable/disable accept `--workspace <dir>` for cloud project scope; `skill project on|off --workspace <dir>` controls all project sources. Without the flag enable/disable remain global. See [cloud skill controls](../skills/docs/cloud-workspace.md).

`run` reads stdin through one line queue ([stdin-line-queue.ts](stdin-line-queue.ts)): every line is kept in arrival order, a line written while a turn runs becomes the next message, and an approval prompt takes its answer from the same queue. A driver can pipe the task, a `y` and the next message at once. The prompt takes only a line shaped like an answer (`y`, `yes`, `n`, `no`, `s`, `a`, or an empty line); any other line denies and stays queued as the next message, so piping "task" and "continue" without an answer loses nothing. EOF before an answer denies, and a prompt that fails denies without stopping later input (ATO-781, ATO-802). Because a piped multi-line prompt still runs one turn per line, the first time a second piped line becomes its own turn `run` prints a one-line notice to stderr; a terminal session gets no notice (ATO-910).

`config get --with-sha256` prints `{"sha256": "<hex>", "config": {...}}`: the normalised config and the lowercase sha256 of the raw `config.json` bytes it was parsed from, from one read (the empty-string hash when the file is missing). `config set - --expect-sha256 <hex>` writes the stdin payload only while the file still hashes to `<hex>`; otherwise it writes nothing, prints exactly `config changed since it was read` to stderr and exits 3. Without the flag `set -` is unchanged. This is the compare-and-swap the desktop uses since it shares the terminal agent's state dir (ATO-416); see [config-sha256.ts](config-sha256.ts).

On a Windows console, startup switches the code page to UTF-8 (65001) so non-ASCII text and the output of console programs the agent runs are not garbled, and restores the original page on exit. It skips a non-TTY stdout (the desktop app reads through pipes), a console already on UTF-8, and macOS and Linux; a failing `chcp` never stops startup. See [windows-console-utf8.ts](windows-console-utf8.ts) (ATO-221).

## Desktop state merge

`import atomic-desktop --source <dir> [--json]` merges the desktop app's former state dir (`~/.atomic-agent-desktop`) into the current one (`ATOMIC_AGENT_STATE_DIR`, default `~/.atomic-agent`) when the desktop moves onto the shared dir (ATO-416). The desktop runs it once and moves the plain files (config.json, .env, skills, traces, models) itself; this command handles only the databases:

- sessions and tasks keep their ids and are inserted only where the id is absent, so the target wins. A live turn arrives ended as interrupted, a running task arrives pending, and neither carries an owner mark.
- memory notes are added through `MemoryStore` unless the same text is already stored; profile facts through `ProfileStore` unless the target has any row for the key.
- lessons, procedures, votes, note links and embeddings are not copied; the embedding backfill or `memory reindex` rebuilds vectors.

Each source database is read from a private snapshot (a byte copy after a clean close, otherwise SQLite's online backup over a read-only connection), so the source is never written and nothing is deleted. Writes are short transactions that wait on the target's locks, so a TUI or `serve` may keep the target open. A re-run imports nothing new. `--json` prints one object, `{ok, sessions:{imported,skipped}, tasks, notes, profileFacts, warnings, error?}`; exit 0 only when every part imported. Implementation: [atomic-desktop importer](../import/atomic-desktop/atomic-desktop-importer.ts).

Checks: `npx vitest run src/cli` when tests are present; `npm run lint`; `npm run docs:check`.
