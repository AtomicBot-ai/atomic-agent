# atomic-agent: contributor instructions

This is the repository-wide contract. Detailed implementation documents are read only for the task at hand. User working agreements still apply.

## Purpose and invariants

- A local operator runtime with CLI, TUI and NDJSON sidecar. Inference connects to external local/cloud providers; model/server/browser binaries are separate assets.
- Session state, durable memory, world snapshots and compressed observations live outside the model. The prompt is a bounded slice of that state.
- Keep stable-prefix bytes stable within the session/role scope. Put step-mutable data after conversation; per-request grammar does not belong in the cached prefix.
- One inference per step. Production grammar emits an array, even for one tool; runtime drives tool execution and subsequent steps.
- Grammar, prompt profile, stream parser and transport must agree. Keep reasoning bounds and terminal-step variants.
- A session is multi-turn chat: reply ends a turn, finish ends the session. Public frontends use runtime.runTurn; the sidecar's already-locked executeTurn seam must not enqueue recursively.
- Pass dependencies explicitly. getConfig is the established cache exception; preserve documented lifecycle exceptions rather than inventing new global state.
- Keep approval, read scope, input-file protection and cancellation enforced at dispatch. Never bypass them through prompt wording.

## Working in an area

Before editing, read the local AGENTS.md for each touched area and for both sides of an interface change. Read its README, then only the linked mechanism documents relevant to the task. Do not assume every client loads nested instructions from the root automatically. Code and tests establish shipped behavior; archive/proposal documents do not override it.

- `agent/`: [agent instructions](src/agent/AGENTS.md); [module guide](src/agent/README.md).
- `runtime/`: [runtime instructions](src/runtime/AGENTS.md); [module guide](src/runtime/README.md).
- `config/`: [config instructions](src/config/AGENTS.md); [module guide](src/config/README.md).
- `prompt/`: [prompt instructions](src/prompt/AGENTS.md); [module guide](src/prompt/README.md).
- `session/`: [session instructions](src/session/AGENTS.md); [module guide](src/session/README.md).
- `llm/`: [llm instructions](src/llm/AGENTS.md); [module guide](src/llm/README.md).
- `local-llm/`: [local-llm instructions](src/local-llm/AGENTS.md); [module guide](src/local-llm/README.md).
- `memory/`: [memory instructions](src/memory/AGENTS.md); [module guide](src/memory/README.md).
- `tools/`: [tools instructions](src/tools/AGENTS.md); [module guide](src/tools/README.md).
- `tui/`: [tui instructions](src/tui/AGENTS.md); [module guide](src/tui/README.md).
- `channels/`: [channels instructions](src/channels/AGENTS.md); [module guide](src/channels/README.md).
- `mcp/`: [mcp instructions](src/mcp/AGENTS.md); [module guide](src/mcp/README.md).
- `skills/`: [skills instructions](src/skills/AGENTS.md); [module guide](src/skills/README.md).
- `tasks/`: [tasks instructions](src/tasks/AGENTS.md); [module guide](src/tasks/README.md).
- `http/`: [http instructions](src/http/AGENTS.md); [module guide](src/http/README.md).
- `tracing/`: [tracing instructions](src/tracing/AGENTS.md); [module guide](src/tracing/README.md).
- `approval/`: [approval instructions](src/approval/AGENTS.md); [module guide](src/approval/README.md).
- `scripts/`: [instructions](scripts/AGENTS.md); [packaging/checks](scripts/README.md).

Other area entry points (use their underlying domain instructions for shared contracts):

- [analytics](src/analytics/README.md).
- [atomic-mail](src/atomic-mail/README.md).
- [composio](src/composio/README.md).
- [compressor](src/compressor/README.md).
- [error-reporting](src/error-reporting/README.md).
- [github](src/github/README.md).
- [import](src/import/README.md).
- [integrations](src/integrations/README.md).
- [native](src/native/README.md).
- [notifications](src/notifications/README.md).
- [replay](src/replay/README.md).
- [sandbox](src/sandbox/README.md).
- [scheduler](src/scheduler/README.md).
- [uninstall](src/uninstall/README.md).
- [update](src/update/README.md).
- [cli](src/cli/README.md).
- [sidecar](src/sidecar/README.md).
## Development and checks

Use Node >=25.7 and the lockfile: `npm ci` for setup. Tests isolate ATOMIC_AGENT_STATE_DIR; use disposable fixtures, not personal agent data.

- `npm run imports:check`: production dependency boundaries and runtime cycles; include `imports:self-test` for checker edits.
- `npm run lint`: production TypeScript only; excludes test files.
- `npm run typecheck:tests`: full src TS/TSX against explicit diagnostic debt; no new errors. After fixing debt use `typecheck:tests:reduce`; never add allowances for a new error.
- `npx vitest run <affected-area-or-files>`: focused existing behavior checks. Include seam tests for a changed interface.
- `npm run docs:check`: active documentation, pointers and instruction budgets.
- `npm test`: full configured Vitest suite, without quarantine exclusions.
- `npm run test:ci`: the PR suite using the quarantine registry, currently with no active exclusions.
- `npm run build`: compile and copy starter skills when build/output paths change.

[Development guide](docs/development.md) records test-typecheck debt, CI exclusions, eval requirements and task routes. Do not report those skipped checks as passing. Runtime evals may require servers, datasets or paid providers; unit tests are a separate surface. Do not publish releases as a verification step.

## Organization and documentation

Use feature ownership and descriptive kebab-case names. Keep tests beside source. Large files are a refactoring signal, not permission to broaden a small change; there is no absolute 300-line/two-level limit. index.ts is an intentional named-export API, not mandatory in every folder. Preserve public behavior during mechanical moves.

Current module guides and local docs own implementation contracts; root docs own architecture, development, user guides and plans. Update the relevant guide when changing a documented contract. Do not duplicate the same defaults or section order across guides. Secrets belong in the validated config/credential paths, never logs or durable prompt facts.

Instruction budgets: root <=8 KiB, each local <=4 KiB, ancestor chain <=24 KiB. Details belong in README/docs, not automatic instructions. Historical material is opt-in: [archive](docs/archive/2026-10-06/README.md). [Migration map](docs/agent-context-migration.md) preserves the previous guide's sections. [Roadmap](docs/plans/project-reorganization.md) separates this migration from later code refactors.
