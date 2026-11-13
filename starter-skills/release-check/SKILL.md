---
name: release-check
description: "Only when the user explicitly asks to prepare a release, publish or ship a package: run a separate release check (clean build, package contents, stubs and secrets, edge cases) tied to one commit hash. Use for /release-check."
version: 1.0.0
requires_tools:
  - os.shell.run
  - verify.run
  - os.fs.grep
  - os.git.status
  - os.git.log
dangerous: false
---

# release-check

Green tests written by the same model that wrote the code are not proof
that a project is ready to publish. Real projects that passed their own
tests still shipped placeholder URLs in package metadata, the wrong
license, a CI step installing a dependency that does not exist, tests with
empty bodies and numeric edge cases nobody tried. This skill is a separate
pass, run after the work is done, that looks for exactly those things.

It is a review aid, not a certification. Say so in the final report.

## When it applies

Run it only when the user explicitly asks for it: "prepare a release",
"get this ready to publish", "check before I push to npm / PyPI /
crates.io", "is this ready to ship", or `/release-check`.

Do not run it for normal coding work, for a plain commit or push, or
because a task happens to touch a version number. Normal work stays as
fast as it was. If you think a release check would help, offer it in one
sentence and wait.

## The verdict belongs to one commit

1. Before checking anything, run `os.git.status`. If there are uncommitted
   changes, say so and ask the user to commit them (or to let you commit
   them) first: a check of a dirty tree proves nothing about what gets
   published.
2. Record the commit hash with `os.git.log` (or `git rev-parse HEAD`).
   Every result below is for that hash only.
3. If any file changes after that point (your fix, the user's edit, a
   formatter), the verdict is void. Say so, record the new hash and run
   the checks again. Never carry a PASS over to a newer commit.

## The checks

Run every step that applies to the project's ecosystem. Read the
manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, ...)
first; never guess the commands.

1. **Clean build from a fresh checkout.** `verify.run` works in a copy of
   the working directory, but that copy keeps the existing
   `node_modules`, virtualenv and build output, so it is not a clean
   install on its own. Make a fresh checkout of the recorded commit in a
   temp directory (for example `git clone --no-local . <tmp>/release-check`
   then `git -C <tmp>/release-check checkout <hash>` with `os.shell.run`),
   and run the install, build and test commands there with `cwd` set to
   it: `npm ci && npm run build && npm test`, `pip install . && pytest`,
   `cargo build --locked && cargo test`. Turn on warnings as errors where
   the toolchain supports it. Quote the exit code of each.
2. **What actually ships.** List the package contents without publishing:
   `npm pack --dry-run`, `python -m build` then list the wheel and sdist,
   `cargo package --list`. Check that the files the package needs are in,
   and that tests, fixtures, `.env` files, local paths and large junk are
   out.
3. **Metadata.** Name, version, description, repository and homepage
   URLs (no `example.com`, no `TODO`, no placeholders), license field
   matching the `LICENSE` file, author, entry points or `bin` pointing at
   files that exist, every command in the README actually working, CI
   installing only extras and dependencies that are declared.
4. **Stubs and placeholders.** `os.fs.grep` for `TODO`, `FIXME`, `XXX`,
   `placeholder`, `lorem`, `not implemented`, `NotImplementedError`,
   `throw new Error("TODO")`. Look at the tests themselves: empty test bodies, tests
   with no assertion, `skip` or `only` left in, assertions that compare a
   value with itself.
5. **Secrets and private data.** `os.fs.grep` the tracked files for API
   keys, tokens, private keys, passwords, `.env` contents, home directory
   paths and internal hostnames. Report the file and line, never the
   secret value itself.
6. **Edge cases.** Read the core logic and list inputs the tests do not
   cover: empty input, zero, negative numbers, very large and very small
   values, `NaN` and infinity, Unicode, missing files, a network that is
   down. Where it is cheap, run a few with `verify.run` and quote the
   output. Treat a crash, a silent wrong number or non-standard output
   (for example `NaN` inside JSON) as a blocker.

## A second reviewer (optional, ask first)

The checks above are still done by you, the model that may have written
the code. A second opinion helps, but code must not leave the machine or
go to another provider without the user's say-so.

- In fusion mode, `fusion.delegate` can hand an edge-case review to a
  worker, and a `review` role model may be configured for it. Offer this
  as an option. Before using it, tell the user which model and provider
  would read the code. If it is not the same local model the user is
  already working with, wait for an explicit yes naming that provider.
- Asking to publish is not permission to send the code anywhere. Never
  paste the repository into another model, a web service or an external
  hook on your own.
- If no second reviewer is available or the user declines, write
  "second review: not done" in the report. Do not review your own work twice and
  call it independent.

## Rules

- Do not publish, tag, push or upload anything as part of this check. It
  only reports. Publishing stays a separate step the user asks for.
- Every finding must come from a command you ran or a line you read in
  this check. Quote the command, the output or the `path:line`.
- A check you could not run (no toolchain, needs a credential, needs a
  device) is reported as "not checked" with the reason, never as passed.
- A failed check is a blocker, even if every test is green. Do not hide
  it behind a passing test count.

## The report

End with a short report:

- **Commit:** the hash every result applies to.
- **Implementation complete / tests passing / release-ready:** three
  separate answers. "Release-ready" is yes only when every applicable
  check passed and nothing changed since the hash was recorded.
- **Blockers:** each failed check with its evidence.
- **Not checked:** each skipped step and why, including the second
  review.
- One line saying this is an assisted review, not a guarantee, and that
  any edit after this point means the check must run again.
