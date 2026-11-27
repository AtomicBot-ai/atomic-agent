# Tool registry and adapters

Status: current
Owner: src/tools/

This area owns tool registry and adapters. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [tool-registry.ts](tool-registry.ts)
- [tool-roles.ts](tool-roles.ts)
- [unknown-argument-guard.ts](unknown-argument-guard.ts)
- [argument-aliases.ts](argument-aliases.ts)
- [control-marker-guard.ts](control-marker-guard.ts)
- [tool-output-spill.ts](tool-output-spill.ts)
- [untrusted-tool-output.ts](untrusted-tool-output.ts)
- [tool-output-secrets.ts](tool-output-secrets.ts)
- [tool-secret-use.ts](tool-secret-use.ts): the shared steps of `{{secret:NAME}}` (ATO-476, ATO-2530): known names before the approval, the reason's "uses secret" tail, values fetched after it and registered for masking. Used by `os.shell.run`, `os.http.request` headers, `skill.run_script` args/env, `verify.run` commands/env ([verify-run-secrets.ts](verify/verify-run-secrets.ts): always asks as `shell_secret`, never covered by a fan-out scope; the result shows the command line with placeholders) and MCP stdio `env`
- [describe-tool-call.ts](describe-tool-call.ts): a tool call as one readable line ("Read config.ts", "Ran npm test · failed") for the TUI, Telegram and desktop frames
- [files/](files/README.md): the "My files" index (ATO-1621) and its read-only `files.search` tool with page citations
- [research/](research/README.md): `research.deep` (ATO-2133), web research through `os.web.search` / `os.web.fetch` that keeps a finding only when its quote is on the fetched page, and writes a Markdown report
- [logbook/](logbook/logbook-query-tool.ts): read-only `logbook.query` over the local [logbook](../logbook/README.md) (ATO-2363), offered while it is on or keeps notes; asks (`logbook_cloud`) when the serving model is not on this computer
- [app/](app/index.ts): "My apps" (ATO-2459), `app.save` / `app.update` / `app.delete` / `app.list` over `<stateDir>/apps`, the folder the desktop's My apps reads ([layout](app/app-names.ts)); every change asks like a file write under the state dir, an edit keeps the replaced page as a version ([app-versions.ts](app/app-versions.ts)), a delete takes the installed launcher with it

## Ownership and dependencies

ToolRegistry owns registered definitions and invocation; role predicates and discovery determine offered schemas. OS/browser/memory/conversation tool families implement operations using explicit ToolContext dependencies. Agent dispatch owns approval, batching and progress guards; prompt owns descriptors and LLM adapters own wire schemas. A catalog change crosses these boundaries.

[Core filesystem contracts](os/fs/docs/contracts.md) group 14 operations' metadata and pure argument semantics. [Global conformance](tool-contract-conformance.test.ts) inspects actual static registrations before replacement and catalog/schema/class surfaces; [runtime composition tests](../runtime/tool-contract-composition.test.ts) pin feature gates and read-scope decoration. See [contracts](docs/contracts.md) for validation limits and existing catalog debt.

In local mode the registry hands a clipped result of an allowlisted tool (commands, listings, searches, diffs) to [the output spill](tool-output-spill.ts): the complete `fullOutput` is written to an owner-only temp folder of the session, bounded per file and per session, and the summary leads with the path so the model reads a slice with `os.fs.read` instead of re-running the command. The folder is in that session's read scope (a worker's too), is removed with the session and is swept at start once stale. Cloud mode keeps promoting the full output instead.

A channel guest's session (`ToolContext.guest`, ATO-2221) reads only inside the working directory ([guest reads](read-scope/guest-reads.ts)). Secret-looking files and folders below it ([guest secret files](read-scope/guest-secret-files.ts): `.env*`, `.envrc`, private keys, credential files such as `.netrc` or `credentials.json`, `secrets/`, `.ssh/`) are refused when a guest names one as a path, and dropped from the results of a guest's `os.fs.grep` (also excluded from ripgrep with `--iglob`), `os.fs.glob`, `os.fs.code_map`, `os.code.search` and `files.search`, judged against both the lexical and the real working directory (ATO-2703). Not covered: names in a single-folder `os.fs.list` or `os.fs.watch`, entries inside an archive (`os.fs.archive.*`, ATO-2805) and tracked files in git output (ATO-2732).

Before any of that, the registry masks credentials in every result except `reply` and `finish` ([tool-output-secrets.ts](tool-output-secrets.ts), ATO-1077): summary, kept full output, the two details the step puts in the prompt (`worldSnapshot.text`, `skillLoaded.body`) and a thrown error or value. Vendor key shapes, bearer/basic/cookie headers, JWTs, PEM private keys, URL passwords and secret-named `NAME=value` pairs become `[redacted:<hint>]`, and so do the exact values of the agent's own `.env` variables and the credentials in its config (provider keys and secret headers, the local server key, webhook secrets, MCP servers' secret env values and headers). The detector is shared with the error scrubber ([secret-detector.ts](../error-reporting/secret-detector.ts)); because masking comes first, the cloud promotion, the spill file and the untrusted framing only ever see the marker. Other `details` are left as the tool wrote them for the step's state effects; the prompt does not render them, and the copies written to disk (the trace row and the session's latest result) are masked string by string (`maskSecretsDeep`, ATO-1176). The compressor masks a summary before cutting it, so a cut cannot leave half a key. `os.fs.write` / `edit` / `patch` refuse a change that adds a marker the file did not already hold ([guard](os/fs/fs-masked-secret-guard.ts)), so a rewrite of a masked `.env` cannot replace the real keys with markers.

## Task-specific reading

Read docs/contracts.md for tool additions/changes and ../agent/docs/batching.md for dispatch; adjacent tool tests for argument behavior.

## Validation

`npx vitest run src/tools`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
