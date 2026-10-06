# Tool registry and adapters

Scope: `src/tools/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- When adding a tool, update registration, prompt descriptor, argsJsonSchema, runtime parsing, resource class and applicable roles. Preserve catalog order and schema teaching.
- Read-only and approval posture are contracts. Unknown resource classes fail closed in multi-call batches. Do not make an approval-gated operation batchable to avoid a solo step.
- Keep rare/out-of-role discovery via tool.view and loaded-tools; preserve per-role wire schemas and grammar membership.
- Preserve input-file guards, restore behavior, read roots and shell-job semantics. A default shell timeout can detach a job rather than kill it.
- Validate reply attachments before ending a turn, emit resolved paths, and preserve delivery through every consumer.

## Read when relevant

Read docs/contracts.md for tool additions/changes and ../agent/docs/batching.md for dispatch; adjacent tool tests for argument behavior.

## Checks

Run `npx vitest run src/tools` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
