# Development and verification

Status: current
Owner: repository maintainers

## Environment

Use Node >=25.7 (the package/Volta floor supports ESM Node SEA) and `npm ci` with the lockfile. Unit tests set an isolated ATOMIC_AGENT_STATE_DIR; never use personal state for fixtures. Root and local AGENTS.md govern contributor work; read the affected areas explicitly even if your client does not discover them automatically.

## Check surfaces

- `npm run imports:check` validates [dependency ownership](architecture/import-boundaries.md) and rejects production runtime cycles. `npm run imports:self-test` verifies its failure cases using temporary projects.
- `npm run lint` checks production TS/TSX, not test types or style formatting.
- `npx vitest run src/<area>` or named test files runs affected existing behavior. Cross-domain changes need seam tests.
- `npm run docs:check` checks active local links, metadata, legacy pointers and instruction budgets offline. `npm run docs:check -- --self-test` exercises failures using temporary fixtures.
- `npm run build` compiles and copies starter skills; use when output/build paths matter.
- `npm test` runs the configured unit/integration suite. `npm run test:ci` uses the same suite and quarantine registry as PR CI; both former exclusions are released. See [local CI and quarantine](testing/local-ci.md).
- CI also tests a scoped document-extractor install with the optional canvas package removed. Consult the workflow rather than deleting optional dependencies in your normal working install.
- `npm run typecheck:tests` checks all src TS/TSX against concrete existing debt and rejects new errors or reduced coverage. `npm run typecheck:tests:raw` intentionally exits nonzero until that debt is eliminated; `npm run typecheck:tests:reduce` only removes resolved entries. `npx tsc -p tsconfig.scripts.json --noEmit` checks TS build scripts. These are separate from production lint.
- Runtime evals (`eval`, `eval-memory`, `eval-agents`) have their own configs, datasets and provider/server requirements. Check each harness README first; do not equate a stub run with a real model benchmark.

## Task routes

- Prompt change: [prompt instructions](../src/prompt/AGENTS.md), [assembly](../src/prompt/docs/assembly.md), [profiles](../src/llm/docs/profiles.md); run prompt and profile/grammar tests.
- Add/change tool: [tool instructions](../src/tools/AGENTS.md), [contract](../src/tools/docs/contracts.md), [batching](../src/agent/docs/batching.md); run its tests plus role/schema/resource-class tests.
- Migration/default: [config instructions](../src/config/AGENTS.md), [compatibility](../src/config/docs/compatibility.md); run schema/load-config and affected-domain tests.
- MCP UI: [TUI instructions](../src/tui/AGENTS.md), [MCP instructions](../src/mcp/AGENTS.md); [feature guide](../src/tui/mcp/README.md) locates all MCP views/state/input/tests. Run tui/mcp, shared config and HTTP route seam tests for persistence changes.
- Model download: [local model instructions](../src/local-llm/AGENTS.md), [download ownership](../src/local-llm/docs/downloads.md); run local-llm download tests and affected TUI tests.

## Documentation

Current source/tests establish behavior. Local README/docs explain it; AGENTS states constraints and reading routes. Archived rollout narratives and proposals do not establish defaults. Use Status and Owner in module guides and mechanism docs; retain named local sources/tests. Root compatibility pointers have one canonical destination list in docs/document-moves.json.

Do not mass-read the archive or every guide before a small edit. Update only relevant contracts and their links. Validate instruction discovery in a fresh invocation; current chat instructions do not reload themselves when files change.
