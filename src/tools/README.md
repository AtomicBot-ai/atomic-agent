# Tool registry and adapters

Status: current
Owner: src/tools/

This area owns tool registry and adapters. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [tool-registry.ts](tool-registry.ts)
- [tool-roles.ts](tool-roles.ts)
- [unknown-argument-guard.ts](unknown-argument-guard.ts)
- [control-marker-guard.ts](control-marker-guard.ts)
- [tool-output-spill.ts](tool-output-spill.ts)
- [untrusted-tool-output.ts](untrusted-tool-output.ts)
- [tool-output-secrets.ts](tool-output-secrets.ts)

## Ownership and dependencies

ToolRegistry owns registered definitions and invocation; role predicates and discovery determine offered schemas. OS/browser/memory/conversation tool families implement operations using explicit ToolContext dependencies. Agent dispatch owns approval, batching and progress guards; prompt owns descriptors and LLM adapters own wire schemas. A catalog change crosses these boundaries.

[Core filesystem contracts](os/fs/docs/contracts.md) group 14 operations' metadata and pure argument semantics. [Global conformance](tool-contract-conformance.test.ts) inspects actual static registrations before replacement and catalog/schema/class surfaces; [runtime composition tests](../runtime/tool-contract-composition.test.ts) pin feature gates and read-scope decoration. See [contracts](docs/contracts.md) for validation limits and existing catalog debt.

In local mode the registry hands a clipped result of an allowlisted tool (commands, listings, searches, diffs) to [the output spill](tool-output-spill.ts): the complete `fullOutput` is written to an owner-only temp folder of the session, bounded per file and per session, and the summary leads with the path so the model reads a slice with `os.fs.read` instead of re-running the command. The folder is in that session's read scope (a worker's too), is removed with the session and is swept at start once stale. Cloud mode keeps promoting the full output instead.

Before any of that, the registry masks credentials in every result except `reply` and `finish` ([tool-output-secrets.ts](tool-output-secrets.ts), ATO-1077): summary, kept full output and a thrown error's message. Vendor key shapes, bearer/basic/cookie headers, JWTs, PEM private keys, URL passwords and secret-named `NAME=value` pairs become `[redacted:<hint>]`, and so do the exact values of the agent's own `.env` variables and configured provider keys. The detector is shared with the error scrubber ([secret-detector.ts](../error-reporting/secret-detector.ts)); because masking comes first, the cloud promotion, the spill file and the untrusted framing only ever see the marker. Result `details` are not masked: the prompt does not render them.

## Task-specific reading

Read docs/contracts.md for tool additions/changes and ../agent/docs/batching.md for dispatch; adjacent tool tests for argument behavior.

## Validation

`npx vitest run src/tools`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
