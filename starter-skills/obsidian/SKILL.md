---
name: obsidian
description: Read, search, and create Markdown notes inside an Obsidian vault on disk.
version: 1.2.0
requires_tools:
  - os.fs.read
  - os.fs.glob
  - os.fs.grep
  - os.fs.write
  - os.fs.list
  - os.shell.run
dangerous: false
---

# obsidian

Operate on the user's Obsidian vault as plain Markdown files. Obsidian itself does not need to be running — the vault is just a directory tree of `.md` files.

## Setup check (lazy — resolve path once, don't re-probe)

The vault path resolves as `$OBSIDIAN_VAULT_PATH` env var → fallback
`~/Documents/Obsidian Vault`. Resolve it **once** when you first need it
this conversation; do not re-probe `printenv` on every turn. Operate on the
resolved path directly and map failures:

- `os.fs.list` / read errors with `ENOENT` / "no such file or directory" → **Setup playbook → "Vault path does not exist"**.
- the path exists but holds no `.md` files → **Setup playbook → "Resolved path is not a real vault"**.

Vault paths often contain spaces — pass them through `os.fs.*` tools verbatim, no quoting needed.

## Setup playbook (when prerequisites are missing)

When a check fails, the agent's job is to OFFER concrete help and EXECUTE the fix itself — not to dump setup instructions on the user. Use this dialogue shape:

1. State plainly what is missing.
2. Offer the most direct remediation the agent can perform via tools.
3. Wait for the user's reply.
4. Execute the fix via tools.
5. Retry the original command; only then proceed.

### Vault path does not exist

Reply:

> «Я не нашёл Obsidian vault ни в `$OBSIDIAN_VAULT_PATH`, ни в `~/Documents/Obsidian Vault`. Пришлите мне абсолютный путь к вашему vault — я проверю и сохраню его в `~/.atomic-agent/.env`, чтобы в будущем находить автоматически.»

When the user replies with a path, verify it exists:

```
[{ "tool": "os.fs.list", "args": { "path": "<user-supplied-path>" } }]
```

If it lists `.md` files, persist the choice:

```
[{ "tool": "os.fs.write", "args": {
   "path": "~/.atomic-agent/.env",
   "mode": "append",
   "content": "\nOBSIDIAN_VAULT_PATH=<user-supplied-path>\n"
} }]
```

Then reply: «Vault найден и сохранён. Перезапустите агента, чтобы env-переменная подхватилась — после рестарта я продолжу. (Для текущей сессии путь уже использую.)» Continue using the path in-memory for the current session — no need to wait for restart to serve the user's request.

If the path does NOT contain `.md` files, ask once more before persisting: «По этому пути нет markdown-файлов. Точно vault там, или другой путь?»

### Resolved path is not a real vault

Same playbook as above, but skip the "not found" framing — just say: «Папка по умолчанию (`~/Documents/Obsidian Vault`) существует, но похоже это не Obsidian vault — markdown-файлов нет. Пришлите правильный путь.»

## When to use

- The user asks to read, list, search, create, or append to notes in their Obsidian vault.
- Markdown-native knowledge management with `[[wikilinks]]` between notes.

## When NOT to use

- Apple Notes (cross-device iCloud) — use the `apple-notes` skill instead.
- Agent-internal scratch notes that don't need to live in the vault — use the `memory.notes.store` tool.

## Common operations

### List notes

All Markdown files in the vault:

```
os.fs.glob { patterns: ["**/*.md"], cwd: "<vault>" }
```

Notes in a specific subfolder:

```
os.fs.glob { patterns: ["Daily/**/*.md"], cwd: "<vault>" }
```

### Read a note

```
os.fs.read { path: "<vault>/Note Name.md" }
```

For very long notes, use `offset` / `limit` to page through.

### Search by filename

```
os.fs.glob { patterns: ["**/*keyword*.md"], cwd: "<vault>" }
```

### Search by content

```
os.fs.grep { pattern: "keyword", path: "<vault>", glob: ["*.md"] }
```

Use `outputMode: "files_with_matches"` to get just the file list.

### Create a new note

```
os.fs.write { path: "<vault>/New Note.md", content: "# Title\n\nBody here.\n" }
```

### Append to an existing note

```
os.fs.write { path: "<vault>/Existing Note.md", content: "\nAppended line.\n", mode: "append" }
```

## Notes

- Wikilinks use the `[[Note Name]]` syntax (no `.md` extension). Use them when creating notes that should link to other notes — Obsidian will render them as clickable links and surface backlinks automatically.
- Daily notes typically live under `Daily/YYYY-MM-DD.md` — confirm the user's pattern before assuming.
- Do not edit `.obsidian/` config files unless the user explicitly asks; they hold the vault's plugin and theme settings.
