---
name: xlsx
description: Create and edit Excel .xlsx workbooks (sheets, cells, formulas, formatting) via Python `openpyxl`. Use to generate spreadsheets or write/update cells. Reading is via os.fs.read_document.
version: 1.0.1
requires_tools:
  - os.shell.run
  - os.fs.read_document
dangerous: false
---

# xlsx

Create and modify `.xlsx` workbooks with the `openpyxl` Python library.
**Reading** an existing spreadsheet to plain text is best done with the built-in
`os.fs.read_document` tool (no install). Use the scripts below to **write**:
new workbooks, cell values, formulas, and basic formatting.

The pattern is `python3 -c "<inline script>"` (or `python3 script.py` for longer
logic). Keep scripts short and idempotent; always write to a fresh output path.

## Setup health check (run first, every session)

Verify with **one solo step**:

```
[{ "tool": "os.shell.run", "args": { "cmd": "python3", "args": ["-c", "import openpyxl; print(openpyxl.__version__)"] } }]
```

Outcome map:
- `exit 0` + version → ready, proceed.
- `ModuleNotFoundError: openpyxl` → enter **Setup playbook → "openpyxl missing"**.
- `command not found: python3` → reply that Python 3 is required and stop.

## Setup playbook (when prerequisites are missing)

### openpyxl missing

Reply (solo `reply` step):

> "The `openpyxl` library is not installed. I can install it: `python3 -m pip install --user openpyxl`. Install it?"

On yes:

```
[{ "tool": "os.shell.run", "args": { "cmd": "python3", "args": ["-m", "pip", "install", "--user", "openpyxl"] } }]
```

If `pip` is externally managed (PEP 668), use `pipx run --spec openpyxl python` or
a venv; ask the user which they prefer.

## When to use

- "Create an Excel file with these rows", "build a budget spreadsheet".
- "Add a column / formula", "update cell B2", "add a second sheet".
- Generating reports/exports as `.xlsx`.

## When NOT to use

- Reading an `.xlsx` to summarise — use `os.fs.read_document`.
- CSV-only work — prefer plain `os.fs.write` with comma-separated text.
- Charts / pivot tables / macros — out of scope on v1.

## Common operations

Create a workbook with a header row and two data rows:

```
[{ "tool": "os.shell.run", "args": { "cmd": "python3", "args": ["-c", "import openpyxl; wb=openpyxl.Workbook(); ws=wb.active; ws.title='Report'; ws.append(['Name','Amount']); ws.append(['Coffee',4.5]); ws.append(['Tea',3]); ws['B4']='=SUM(B2:B3)'; wb.save('report.xlsx'); print('wrote report.xlsx')"] } }]
```

Append rows to an existing workbook:

```
[{ "tool": "os.shell.run", "args": { "cmd": "python3", "args": ["-c", "import openpyxl; wb=openpyxl.load_workbook('report.xlsx'); ws=wb.active; ws.append(['Juice',5]); wb.save('report.xlsx'); print('appended')"] } }]
```

For anything longer than a couple of statements, write a `.py` file with
`os.fs.write` first, then run it with `python3 script.py`.

## Rules

1. Always `wb.save(<new path>)` and report the path; never silently overwrite.
2. Formulas go in as strings starting with `=` (e.g. `'=SUM(A1:A9)'`).
3. Quote numbers as numbers, not strings, so Excel treats them numerically.
4. For reads, defer to `os.fs.read_document` — do not reinvent parsing.
