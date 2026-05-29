---
name: pandoc
description: Convert documents between formats (Markdown, DOCX, HTML, PDF, RST, EPUB, LaTeX) via the `pandoc` CLI. Use to transform a document from one format to another.
version: 1.0.0
requires_tools:
  - os.shell.run
dangerous: false
---

# pandoc

Convert documents between formats with the universal
[`pandoc`](https://pandoc.org/) CLI. Input/output formats are inferred from file
extensions; override with `-f <from>` / `-t <to>` when needed.

PDF output requires a LaTeX engine (or `--pdf-engine`). Markdown/HTML/DOCX/EPUB
conversions need only `pandoc` itself.

## Setup health check (run first, every session)

Verify with **one solo step**:

```
[{ "tool": "os.shell.run", "args": { "cmd": "pandoc", "args": ["--version"] } }]
```

Outcome map:
- `exit 0` + version → ready, proceed.
- `command not found: pandoc` → enter **Setup playbook → "pandoc missing"**.
- PDF target fails with `pdflatex not found` → enter **Setup playbook → "PDF engine missing"**.

## Setup playbook (when prerequisites are missing)

### pandoc missing

Reply (solo `reply` step):

> «`pandoc` не установлен. Могу поставить: `brew install pandoc`. Поставить?»

On yes:

```
[{ "tool": "os.shell.run", "args": { "cmd": "brew", "args": ["install", "pandoc"] } }]
```

On Linux: `apt-get install pandoc`.

### PDF engine missing

PDF output needs a TeX engine. Offer the lightweight option:

> «Для экспорта в PDF нужен движок TeX. Могу поставить: `brew install --cask basictex` (или лёгкий `brew install tectonic`). Что предпочитаете?»

`tectonic` is simplest (`pandoc in.md -o out.pdf --pdf-engine=tectonic`).

## When to use

- "Convert this Markdown to DOCX / PDF / HTML", "turn this HTML into Markdown".
- "Make an EPUB from these chapters", "export notes to a Word doc".

## When NOT to use

- Reading a document's text — use `os.fs.read_document`.
- Editing PDFs structurally (merge/split) — use the `pdf` skill.
- Spreadsheet conversion — use the `xlsx` skill.

## Common operations

All examples invoke `os.shell.run` with `cmd: "pandoc"`. Outputs go to the
session working directory; the approval gate surfaces each write.

| Goal | args |
|---|---|
| Markdown → DOCX | `["notes.md", "-o", "notes.docx"]` |
| Markdown → PDF | `["notes.md", "-o", "notes.pdf", "--pdf-engine=tectonic"]` |
| Markdown → standalone HTML | `["notes.md", "-s", "-o", "notes.html"]` |
| DOCX → Markdown | `["report.docx", "-o", "report.md"]` |
| HTML → Markdown | `["page.html", "-f", "html", "-t", "gfm", "-o", "page.md"]` |
| Many MD → one EPUB | `["ch1.md", "ch2.md", "-o", "book.epub", "--toc"]` |
| With a table of contents | append `["--toc", "--toc-depth=2"]` |

## Rules

1. Always specify an explicit `-o <output>` path and report it to the user.
2. For PDF, prefer `--pdf-engine=tectonic` if installed (fewer dependencies).
3. Verify the output exists (e.g. `os.fs.list`) before claiming success.
4. Preserve the source file — pandoc writes a new file, never edit in place.
