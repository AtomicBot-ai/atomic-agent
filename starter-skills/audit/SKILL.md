---
name: audit
description: Security audit of a code project in two passes. The first pass collects candidate vulnerabilities, the second tries to refute every one of them, and only findings that survive go into the report. Use when the user runs /audit or asks to check a repository, folder or change for security problems, vulnerabilities or leaked secrets.
version: 1.0.0
requires_tools:
  - os.fs.code_map
  - os.fs.grep
  - os.fs.read
dangerous: false
---

# audit

A security review that lists every suspicion is a chore for the reader: they
have to sort the real holes from the noise themselves. This skill does the
sorting. One pass hunts, a second pass argues against each candidate, and the
report carries only what the second pass could not knock down.

The whole audit is read-only. Do not edit files, run the code under test, send
requests to live systems or try an exploit. If the user wants fixes, offer
them after the report, as a separate step.

## Scope

- No argument: the working directory. A path or a list of files: only that.
- `/audit diff` or "audit my changes": the files in `os.git.diff` against the
  default branch, plus whatever those files call into.
- Skip `node_modules/`, `vendor/`, build output, lockfiles, minified bundles
  and test fixtures, unless the user points at them.

## Pass 1: find candidates

1. **Map first.** Call `os.fs.code_map` on the scope. Note the entry points:
   HTTP routes, CLI arguments, message handlers, file uploads, webhooks, IPC,
   anything that reads input a stranger can control.
2. **Hunt by category.** For each one, search with `os.fs.grep`, then read
   the hits with `os.fs.read`:
   - injection: shell commands built from strings, SQL or NoSQL built by
     concatenation, `eval`, template rendering of raw input;
   - path traversal: user-controlled paths joined to a base directory
     without a containment check, archive extraction (zip slip);
   - auth and access: routes without an auth check, ownership checks
     missing on id lookups, admin actions behind a client-side flag;
   - secrets: keys, tokens and passwords in source, config or history,
     secrets written to logs or error messages;
   - unsafe input handling: unsafe deserialization, XML with external
     entities, regexes that can hang on crafted input, unchecked redirects;
   - web: XSS from unescaped output, missing CSRF protection on state
     changes, permissive CORS with credentials, SSRF from user-supplied URLs;
   - crypto: home-made crypto, MD5 or SHA-1 for passwords, fixed IVs or
     salts, `Math.random()` for tokens;
   - dependencies: only when a lockfile pins a version with a widely known
     advisory you are sure of. Never guess CVE numbers.
3. **Write each candidate down** with: a short id (`F1`, `F2`…), the file
   and line, the category, where the untrusted input enters, where it lands
   (the dangerous call), and one sentence on how an attacker would use it.

Keep at most 15 candidates. If you have more, keep the ones with the
clearest path from untrusted input to a dangerous call.

## Pass 2: try to refute every candidate

Switch sides. For each candidate your job is now to prove it is **not** a
real problem. Read the code again from the entry point. Do not reuse your
pass-1 reasoning: re-read the lines.

**If `fusion.delegate` is available** (run mode is fusion), hand pass 2 to a
worker, one task per candidate or a few candidates per task. Each task's
instructions say: "Here is a suspected vulnerability. Try to refute it.
Look for validation, escaping, an auth check, a type that rules the input
out, the code being unreachable from untrusted input, test-only code, or a
framework default that already protects it. Answer CONFIRMED, REFUTED or
UNSURE, and quote the lines that decide it." Pass the candidate's file in
`files`. A worker that fails or times out counts as UNSURE for its
candidates.

**Otherwise** run pass 2 yourself, one candidate at a time, with the same
instructions.

Check at least these before accepting a candidate:

- Is the input really attacker-controlled, or does it come from config,
  the operator, or a constant?
- Is there a guard anywhere on the path: a validator, an allowlist, an
  escape, parameterised queries, a middleware, a schema?
- Is the code reachable in production, or only from tests, scripts or dead
  code?
- Does the framework already protect it by default (auto-escaping
  templates, ORM bindings)?

Verdicts:

- **CONFIRMED**: you traced untrusted input to the dangerous call and found
  no guard. You can quote the entry line and the sink line.
- **REFUTED**: you found the guard or the reason it cannot happen. Quote it.
- **UNSURE**: the path depends on something outside the scope (another
  service, runtime config) or you could not finish the trace.

Only CONFIRMED findings go into the report. Nothing is promoted to
CONFIRMED because it "looks dangerous".

## Report

Start with one line: how many candidates pass 1 found and how many survived.

Then, for each confirmed finding, most severe first:

- **Title** in plain words, with severity: critical, high, medium or low.
- **Where**: `path/to/file.ts:42`.
- **What can happen**: one or two sentences an outsider can follow.
- **Why it holds**: the entry line and the sink line, quoted briefly, and
  what pass 2 looked for and did not find.
- **Fix**: the smallest change that closes it.

After the confirmed list, one line: "Dropped: N refuted, M unsure." List
the UNSURE ones by id and file only if the user asks, or if one of them
would be critical if real. In that case say exactly what is missing to
decide it.

If nothing survived, say so plainly. "No confirmed findings in this scope"
is a valid result. Do not pad the report with general advice.

## Rules

- Never print a secret you found in full. Show the first four characters
  and the file and line, and tell the user to rotate it.
- Never claim a finding is exploitable unless pass 2 confirmed it.
- Do not run scanners, install packages or touch the network as part of
  the audit unless the user asks for that explicitly.
- A small local model can be weak at pass 2. When the run is not in fusion
  mode and the model is local, say in the report that a second opinion on
  critical findings is worth getting.
