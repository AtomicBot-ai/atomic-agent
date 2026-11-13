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

## Skill Lab tasks (`evals/`)

Some starters ship an `evals/` folder: a `tasks.yaml` with fixtures and check
scripts for `atomic-agent skill eval <name>` (with the skill vs without it).
The seeder does **not** copy `evals/` into the global skills dir, so the model
never sees the expected answers; `skill eval` reads them from this tree. See
`src/skills/eval/README.md`. Only these packaged tasks run without `--tasks`;
an installed skill's own tasks file has to be named with `--tasks`.

## Bundled skills

| Folder | What it does | External requirement |
|---|---|---|
| `wttr-weather/` | Weather lookup via `wttr.in` | none |
| `currency/` | Exchange rates & conversion via the Frankfurter API | none |
| `skill-creator/` | Author or edit `SKILL.md` files | none |
| `code-graph/` | Who calls what, where a feature lives, how two parts connect, with `path:line` per link (built on `os.fs.code_map`) | none |
| `verify-work/` | Run what you just wrote and prove it works before reporting | none |
| `github/` | GitHub repos / issues / PRs / Actions via the `gh` CLI | `gh` installed + `gh auth login` |
| `publish-site/` | Put a static site the agent built online on the user's own GitHub Pages (or Cloudflare Pages / Netlify), with a read-only secrets preflight, versions and rollback; always asks before publishing | `gh` signed in (or `wrangler` / `netlify-cli` signed in) |
| `audit/` | `/audit`: security review in two passes, only findings that survive a refutation pass are reported | none |
| `apple-calendar/` | Read Calendar via `icalBuddy`, create events via AppleScript | macOS + `brew install ical-buddy` + Calendar permission |
| `obsidian/` | Read / search / write notes in an Obsidian vault | `OBSIDIAN_VAULT_PATH` env var (default `~/Documents/Obsidian Vault`) |
| `apple-notes/` | Manage Apple Notes via the `memo` CLI | macOS + `brew install antoniorodr/memo/memo` + Automation permission |
| `apple-reminders/` | Manage Apple Reminders via the `remindctl` CLI | macOS + `brew install steipete/tap/remindctl` + Reminders permission |
| `notion/` | Notion REST API (pages, databases, blocks) | `NOTION_API_KEY` in `~/.atomic-agent/.env` + page sharing |
| `gog-workspace/` | Google Workspace access through the `gog` CLI | `gog` installed + OAuth client JSON added with `gog auth credentials` / `gog auth add` |
| `pdf/` | Merge / split / extract / render / OCR PDFs | `brew install qpdf poppler` (`ocrmypdf` for OCR) |
| `xlsx/` | Create / edit Excel workbooks (reads via `os.fs.read_document`) | `python3` + `openpyxl` |
| `pandoc/` | Convert documents between formats (md/docx/html/pdf/epub) | `brew install pandoc` (+ TeX engine for PDF) |
| `plain-writing/` | Rewrite text and landing pages without AI tells (long dashes, stock phrases, template layouts), meaning kept | none |
| `post-drafts/` | Draft a Reddit / LinkedIn / X / Hacker News post within the platform's limits, the subreddit's rules and your `brand-context.md` voice; draft only, never publishes | none (bundled Node scripts fetch subreddit rules and lint the draft) |
| `ffmpeg/` | Audio / video transform: convert, trim, extract, resize, GIF | `brew install ffmpeg` |
| `imagemagick/` | Image edit / convert: resize, crop, format, montage | `brew install imagemagick` |
| `audio-transcribe/` | Transcribe speech in audio files (mp3, m4a, wav, ogg, flac, webm) to text with the local `whisper` CLI | `brew install openai-whisper ffmpeg` |
| `docker/` | Manage containers / images / Compose stacks via `docker` CLI | `docker` installed + daemon running |
| `seo-rank-report/` | Weekly Telegram report of Google positions for a keyword list, with week-over-week moves; history in local SQLite (`scripts/rank_history.py`) | `python3`; data from Google Search Console (Composio or signed-in browser), or the user's own DataForSEO key / Ahrefs or SE Ranking MCP |
| `seo-audit/` | "Check my site": polite read-only crawl from the sitemap (robots.txt obeyed, 20-page cap, delay between requests) plus PageSpeed Core Web Vitals, reported as quick wins vs strategic with affected URLs | none (`PAGESPEED_API_KEY` optional, see the skill) |
| `mention-monitor/` | New mentions on Reddit + Hacker News (read-only, seen once), competitor page change diffs, daily digest to Telegram via `tasks.cron` | none (X only via `xurl` if the user set it up) |
| `meeting-notes/` | Minutes of a meeting from a transcript or recording: summary, decisions, action items, saved as `<name>.notes.md` next to it; reminders on request | none (`whisper` for recordings, see `audio-transcribe/`) |
| `pre-push-check/` | Before pushing code the agent wrote, asks three questions about it (what changed, what could break, how to check); `/skill disable pre-push-check` turns it off | none |
| `release-check/` | Only on an explicit "prepare a release" request: clean build from a fresh checkout, package contents, metadata, stubs and secrets, edge cases, verdict tied to one commit hash; never sends code to another provider without asking | none |
| `traffic-analytics/` | "Why did traffic drop" and other reports from your own GA4, Search Console and PostHog; never invents numbers | Your own Google service account key and/or PostHog personal API key in `~/.atomic-agent/traffic-analytics.json` |
| `lead-research/` | Companies and business contacts from open sources (websites, GitHub, Apify with your key), one source per row; GDPR-safe, never scrapes LinkedIn or X | none (Apify only with your own key) |
| `email-drafts/` | Outreach and follow-up emails as drafts only (Gmail via `gog`, or local files for Atomic Mail); never sends | `gog` signed in for Gmail drafts |
| `landing-cro-review/` | Landing page review from a browser screenshot against a conversion checklist | a vision-capable model for the screenshot part |
| `ad-copy/` | Google Ads RSA and Meta ad text variants, every length checked by a script | none |
| `motion/` | Short MP4s from code with no video credits: release announcement, big number, logo reveal (HTML templates + frame capture + ffmpeg) | Chrome / Chromium / Edge + `brew install ffmpeg` (or the agent's HTML-to-MP4 tool when present) |
