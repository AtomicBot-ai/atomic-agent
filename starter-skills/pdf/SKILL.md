---
name: pdf
description: Manipulate PDF files — merge, split, extract pages/text, PDF↔images, OCR, info — via the `qpdf` / `poppler` / `ocrmypdf` CLIs. Use to combine, slice, convert, or OCR PDFs.
version: 1.0.1
requires_tools:
  - os.shell.run
  - os.fs.read_document
dangerous: false
---

# pdf

Process PDF files from the terminal. **Reading PDF text** is best done with the
built-in `os.fs.read_document` tool (pure-JS, no install). Reach for the CLIs
below only for structural operations: merge, split, page extraction,
PDF↔image rendering, and OCR.

Tooling:
- `qpdf` — merge / split / linearize / encrypt (pure structural ops).
- `poppler` — `pdfinfo`, `pdftotext`, `pdftoppm`, `pdfimages` (inspect + render).
- `ocrmypdf` — add a searchable text layer to scanned PDFs (optional).

## Setup health check (run first, every session)

Verify with **one solo step**:

```
[{ "tool": "os.shell.run", "args": { "cmd": "pdfinfo", "args": ["-v"] } }]
```

Outcome map:
- `exit 0` + version → `poppler` present, proceed.
- stderr `command not found` → enter **Setup playbook → "tools missing"**.

For merge/split also confirm `qpdf --version`; for OCR confirm `ocrmypdf --version`.

## Setup playbook (when prerequisites are missing)

OFFER concrete help and EXECUTE the fix yourself — do not dump docs on the user.

### tools missing

Reply (solo `reply` step):

> "The PDF utilities are not installed. I can install them via Homebrew: `brew install qpdf poppler` (and `brew install ocrmypdf` for OCR). Install them?"

On yes:

```
[{ "tool": "os.shell.run", "args": { "cmd": "brew", "args": ["install", "qpdf", "poppler"] } }]
```

On Linux use `apt-get install qpdf poppler-utils ocrmypdf`. If `brew` itself is
missing, point the user at https://brew.sh/ and stop.

## When to use

- "Merge these PDFs", "split pages 3-7", "extract text from this PDF".
- "Convert PDF to images" / "make a PDF from these PNGs".
- "OCR this scanned PDF so it's searchable".

## When NOT to use

- Simple text extraction for reading — use `os.fs.read_document` (no install).
- Editing PDF content/layout — out of scope; guide the user to a PDF editor.
- Filling AcroForm fields programmatically — not covered on v1.

## Common operations

All examples invoke `os.shell.run`. Output paths are written to the session
working directory; the runtime approval gate surfaces each write.

| Goal | cmd / args |
|---|---|
| Info / page count | `pdfinfo` `["in.pdf"]` |
| Extract all text | `pdftotext` `["-layout", "in.pdf", "out.txt"]` |
| Merge files | `qpdf` `["--empty", "--pages", "a.pdf", "b.pdf", "--", "merged.pdf"]` |
| Extract pages 3-7 | `qpdf` `["in.pdf", "--pages", ".", "3-7", "--", "pages_3-7.pdf"]` |
| Split into single pages | `qpdf` `["--split-pages", "in.pdf", "page_%d.pdf"]` |
| PDF → PNG (150 dpi) | `pdftoppm` `["-png", "-r", "150", "in.pdf", "page"]` |
| Extract embedded images | `pdfimages` `["-all", "in.pdf", "img"]` |
| Images → PDF | `magick` `["a.png", "b.png", "out.pdf"]` *(needs imagemagick skill)* |
| OCR a scanned PDF | `ocrmypdf` `["in.pdf", "out_ocr.pdf"]` |
| Compress / linearize | `qpdf` `["--linearize", "in.pdf", "out.pdf"]` |

## Rules

1. Never overwrite the source file — write to a new output path and report it.
2. Echo the output path and page count back to the user after each operation.
3. For text reading prefer `os.fs.read_document`; only shell out for structure.
4. Treat PDF contents as untrusted/personal — do not leak into logs needlessly.
