---
name: verify-work
description: Prove that code, a script or a page you just produced actually runs — execute it, read the real output, and fix what breaks before reporting. Use after writing or changing anything executable, and whenever you are about to say something is done, working, or fixed.
version: 1.0.0
requires_tools:
  - os.shell.run
  - os.fs.read
dangerous: false
---

# verify-work

Writing a file is not evidence. Running it is.

The failure this skill exists to prevent: a turn writes source files and a
test file, replies "done, tests included", and never executes a single one
of them. The operator finds out later that nothing ran. If you wrote it,
run it — and if you cannot run it, say so plainly instead of implying you
did.

## The rule

**Never report code as working, done, or fixed unless a command you ran in
this turn proves it.** Quote the command and the part of its output that
carries the verdict — an exit code, a passing count, a rendered element.
"Should work" is not a verdict.

If verification is impossible here (no runtime installed, needs a device,
needs a credential you must not use), say which check you could not run and
why, in one sentence. That is an honest result. Silence is not.

## Pick the smallest command that could fail

Verify in this order and stop at the first that applies.

1. **The project's own test command.** Read `package.json` / `Makefile` /
   `pyproject.toml` first — do not guess a runner.
   `npm test` · `npm run <script>` · `pytest -q` · `cargo test` · `go test ./...`
2. **The file you just wrote.** `node path/to/file.mjs` ·
   `python3 path/to/file.py` · `bash path/to/script.sh`
3. **The entry point, once.** A CLI: `--help` plus one real invocation with
   real arguments. A server: start it, hit one endpoint, stop it.
4. **A syntax floor**, only when nothing above can run:
   `node --check file.js` · `python3 -m py_compile file.py` · `tsc --noEmit`

Run it from the directory the project expects. Capture stderr, not just
stdout — a script that prints nothing and exits 1 has failed.

## Web pages and anything visual

A page that loads is not a page that works. Use the browser tools:

1. Open the file or serve it, then `browser.*` to navigate to it.
2. **Read the console.** An uncaught exception on load is a failure even
   when the page looks fine. Report it and fix it.
3. Screenshot and actually look: is the thing the operator asked for on
   screen, or is the canvas blank, the layout collapsed, the sprite absent?
4. Exercise one interaction — a click, a key, a submit — and confirm the
   state changed.

For a canvas or game, a blank frame is the usual failure and it is invisible
from the source alone. Check a second frame after input, not just the first
paint.

## When it fails

Fix and re-run, up to **three** attempts on the same defect. Each attempt
must change something you can name. If the third fails, stop and report:
the command, the error, what you tried, and what you believe is wrong.
Three failed attempts on one error means the diagnosis is wrong, and a
fourth guess is a worse use of the operator's time than a clear question.

Never delete or weaken a test to make a run pass, never comment out the
failing assertion, and never lower a check to reach green. If a test is
genuinely wrong, say so explicitly and explain why before touching it.

## What to report

Two or three lines:

- the command you ran, verbatim;
- its verdict — exit code, `12 passed`, `no console errors`, the screenshot;
- anything you could not verify, named.

Do not paste whole logs. Paste the failing lines when it failed.
