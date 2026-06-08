# Starter skills

These folders are **installed automatically** into your global skills directory
(`<stateDir>/skills/<name>/`, default `<stateDir>` = `~/.atomic-agent`) on every
agent runtime boot. Existing directories with the same name are **replaced** by
the bundled copy so upgrades refresh starter `SKILL.md` files.

Override the source tree with `ATOMIC_AGENT_STARTER_SKILLS_DIR` pointing at a
directory that contains the same layout (e.g. `skill-creator/SKILL.md`).

Do not reuse a **built-in starter skill name** for unrelated custom work under
the global skills dir — it will be replaced on the next boot. Use a distinct
`name` or a project-local `.atomic-agent/skills/` tree instead.

## Bundled skills

| Folder | What it does | External requirement |
|---|---|---|
| `wttr-weather/` | Weather lookup via `wttr.in` | none |
| `currency/` | Exchange rates & conversion via the Frankfurter API | none |
| `skill-creator/` | Author or edit `SKILL.md` files | none |
| `github/` | GitHub repos / issues / PRs / Actions via the `gh` CLI | `gh` installed + `gh auth login` |
| `apple-calendar/` | Read Calendar via `icalBuddy`, create events via AppleScript | macOS + `brew install ical-buddy` + Calendar permission |
| `obsidian/` | Read / search / write notes in an Obsidian vault | `OBSIDIAN_VAULT_PATH` env var (default `~/Documents/Obsidian Vault`) |
| `apple-notes/` | Manage Apple Notes via the `memo` CLI | macOS + `brew install antoniorodr/memo/memo` + Automation permission |
| `apple-reminders/` | Manage Apple Reminders via the `remindctl` CLI | macOS + `brew install steipete/tap/remindctl` + Reminders permission |
| `notion/` | Notion REST API (pages, databases, blocks) | `NOTION_API_KEY` in `~/.atomic-agent/.env` + page sharing |
| `gog-workspace/` | Google Workspace access through the `gog` CLI | `gog` installed + OAuth client JSON added with `gog auth credentials` / `gog auth add` |
| `xurl/` | X (Twitter) API via the official `xurl` CLI | `xurl` installed + OAuth 2.0 set up by user out-of-band |
| `pdf/` | Merge / split / extract / render / OCR PDFs | `brew install qpdf poppler` (`ocrmypdf` for OCR) |
| `xlsx/` | Create / edit Excel workbooks (reads via `os.fs.read_document`) | `python3` + `openpyxl` |
| `ddgr-web-search/` | Key-less web search via the `ddgr` CLI (browser fallback) | `brew install ddgr` (optional) |
| `pandoc/` | Convert documents between formats (md/docx/html/pdf/epub) | `brew install pandoc` (+ TeX engine for PDF) |
| `ffmpeg/` | Audio / video transform: convert, trim, extract, resize, GIF | `brew install ffmpeg` |
| `imagemagick/` | Image edit / convert: resize, crop, format, montage | `brew install imagemagick` |
| `docker/` | Manage containers / images / Compose stacks via `docker` CLI | `docker` installed + daemon running |
